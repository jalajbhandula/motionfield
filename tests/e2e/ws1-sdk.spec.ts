import { expect, request, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MotionField, verifyWebhook } from "../../packages/sdk-ts/src/index";

/**
 * SDK end-to-end against the live dev server:
 * UI signup → create a key in the settings panel → a job driven by the
 * TypeScript SDK (webhook verified with the SDK's own verifier) → a second job
 * driven by the Python SDK in a `python3 -I -B` child process → four parallel
 * sign-ups each land exactly one profile and one signup bonus.
 */

const ENDPOINT = "motionfield/z-image-turbo/text-to-image";

test("TS SDK: signup → panel key → submit → wait → download → signed webhook", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const email = `ws1sdk-${Date.now()}@e2e.test`;

  // UI sign-up
  await page.goto("/signup");
  await page.getByPlaceholder("Display name").fill("SDK E2E");
  await page.getByPlaceholder("you@email.com").fill(email);
  await page.getByPlaceholder("Password (8+ chars)").fill("e2e-password-123");
  await page.getByRole("button", { name: /Get 50 credits/ }).click();
  await page.waitForURL("**/onboarding", { timeout: 30_000 });

  // key through the panel
  await page.goto("/settings/keys");
  await page.getByTestId("key-label").fill("sdk e2e");
  await page.getByTestId("create-key").click();
  await expect(page.getByTestId("show-once")).toBeVisible();
  const apiKey = await page.getByTestId("key-value").innerText();
  const webhookSecret = await page.getByTestId("secret-value").innerText();

  // local webhook receiver
  const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  const receiver: Server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: b });
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const hookUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/hook`;

  try {
    const of = new MotionField({ baseUrl: baseURL!, apiKey });

    const models = await of.models();
    const m = models.find((x) => x.id === ENDPOINT);
    expect(m, "z-image-turbo listed").toBeTruthy();
    expect(m!.license.class).toBe("open");
    expect(m!.estimate.credits).toBeGreaterThan(0);

    const est = await of.estimate(ENDPOINT, { prompt: "sdk e2e" });
    expect(est.credits).toBeGreaterThan(0);

    const created = await of.submit(ENDPOINT, { prompt: "sdk e2e" }, { webhookUrl: hookUrl });
    const done = await of.wait(created.id, { intervalMs: 1000, timeoutMs: 120_000 });
    expect(done.status).toBe("completed");
    expect(done.outputs[0].type).toMatch(/^image\//);

    const { bytes, contentType } = await of.download(done.id);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(contentType).toMatch(/^image\//);

    // exactly one signed job.completed delivery, verifiable with the SDK
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !received.length) await new Promise((r) => setTimeout(r, 250));
    expect(received.length).toBe(1);
    const evt = received[0];
    expect(evt.headers["x-motionfield-signature"]).toBeTruthy();
    expect(verifyWebhook(webhookSecret, evt.headers["x-motionfield-signature"] as string, evt.body)).toBe(true);
    const parsed = JSON.parse(evt.body);
    expect(parsed.type).toBe("job.completed");
    expect(parsed.data.id).toBe(done.id);
    expect(parsed.data.outputs[0].type).toMatch(/^image\//);
  } finally {
    await new Promise((r) => receiver.close(r));
  }
});

test("Python SDK drives the same flow in a python3 -I -B child", async ({ baseURL }) => {
  test.setTimeout(180_000);
  const api = await request.newContext({ baseURL });
  const email = `ws1pysdk-${Date.now()}@e2e.test`;
  const su = await api.post("/api/auth/sign-up/email", {
    data: { email, password: "e2e-password-123", name: "PY SDK E2E" },
  });
  expect(su.ok(), `signup: ${await su.text()}`).toBeTruthy();
  const k = await api.post("/api/keys", { data: { label: "py sdk e2e" } });
  expect(k.status()).toBe(201);
  const { key, webhook_secret } = await k.json();

  const script = join(mkdtempSync(join(tmpdir(), "of-sdkpy-e2e-")), "run.py");
  writeFileSync(script, `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(process.cwd(), "packages/sdk-py"))})
from motionfield import Client, verify_webhook

c = Client(${JSON.stringify(baseURL)}, ${JSON.stringify(key)})
models = c.models()
job = c.submit(${JSON.stringify(ENDPOINT)}, {"prompt": "sdk-py e2e"})
done = c.wait(job["id"], interval=1.0, timeout=120)
data = c.download(done["id"])

# the SDK also verifies a header we sign for it on this side
import hmac, hashlib, time
secret = ${JSON.stringify(webhook_secret)}
body = b'{"probe":true}'
t = int(time.time())
sig = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
ok = verify_webhook(secret, f"t={t},v1={sig}", body)

print(json.dumps({"status": done["status"], "mime": done["outputs"][0]["type"],
                  "bytes": len(data), "verify": ok, "n_models": len(models)}))
`);
  const out = execFileSync("python3", ["-I", "-B", script], { encoding: "utf8", timeout: 150_000 });
  const result = JSON.parse(out.trim().split("\n").pop()!);
  expect(result.status).toBe("completed");
  expect(result.mime).toMatch(/^image\//);
  expect(result.bytes).toBeGreaterThan(0);
  expect(result.verify).toBe(true);
  expect(result.n_models).toBeGreaterThan(0);
});

test("four parallel sign-ups each get exactly one profile + signup bonus", async ({ baseURL }) => {
  test.setTimeout(120_000);
  const tag = Date.now();
  const signups = await Promise.all(
    Array.from({ length: 4 }, async (_, i) => {
      const ctx = await request.newContext({ baseURL });
      const res = await ctx.post("/api/auth/sign-up/email", {
        data: { email: `ws1par-${tag}-${i}@e2e.test`, password: "e2e-password-123", name: `Par ${i}` },
      });
      return { ctx, res };
    }),
  );
  for (const { ctx, res } of signups) {
    expect(res.status(), `signup: ${await res.text()}`).toBe(200);
    const me = await (await ctx.get("/api/me")).json();
    expect(me.profile, "profile exists").toBeTruthy();
    // 50 signup bonus (+10 daily grant for free-plan users - idempotent per 20h)
    expect(Number(me.profile.credits)).toBeGreaterThanOrEqual(50);
    const ledger = await (await ctx.get("/api/me/ledger")).json();
    const bonuses = (ledger.entries as { kind: string }[]).filter((e) => e.kind === "signup_bonus");
    expect(bonuses).toHaveLength(1);
  }
});
