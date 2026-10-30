import { expect, request, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import crypto from "node:crypto";

/**
 * WS1 settings → API keys → signed webhook, end to end:
 * signup → create key in the UI (one-time key + webhook secret) → submit a job
 * with webhook_url over the bearer API → complete it (mock provider) → exactly
 * one signed job.completed POST → a second user's key gets 404s → revoke in
 * the UI → the key is dead.
 */

function verifySignature(secret: string, header: string, body: string): boolean {
  const fields = new Map(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(fields.get("t"));
  const v1 = fields.get("v1") ?? "";
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const fresh = Math.abs(Math.floor(Date.now() / 1000) - t) <= 300;
  return fresh && /^[0-9a-f]{64}$/.test(v1) &&
    crypto.timingSafeEqual(Buffer.from(v1, "hex"), Buffer.from(expected, "hex"));
}

test("settings → API keys → webhook e2e", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const email = `ws1ui-${Date.now()}@e2e.test`;
  const password = "e2e-password-123";

  // ── signup ────────────────────────────────────────────────────────────
  await page.goto("/signup");
  await page.getByPlaceholder("Display name").fill("WS1 E2E");
  await page.getByPlaceholder("you@email.com").fill(email);
  await page.getByPlaceholder("Password (8+ chars)").fill(password);
  await page.getByRole("button", { name: /Get 50 credits/ }).click();
  await page.waitForURL("**/onboarding", { timeout: 30_000 });

  // ── create a key in the UI ────────────────────────────────────────────
  await page.goto("/settings/keys");
  await page.getByTestId("key-label").fill("e2e key");
  await page.getByTestId("create-key").click();
  const oncePanel = page.getByTestId("show-once");
  await expect(oncePanel).toBeVisible();
  const apiKey = await page.getByTestId("key-value").innerText();
  const webhookSecret = await page.getByTestId("secret-value").innerText();
  expect(apiKey).toMatch(/^of_[A-Za-z0-9]{12}_/);
  expect(webhookSecret).toMatch(/^ofwh_/);
  await oncePanel.getByRole("button", { name: /Done/ }).click();

  const api = await request.newContext({ baseURL });

  // ── local receiver for the webhook ────────────────────────────────────
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
    // ── a restricted-license endpoint is a 403 and charges nothing ───────
    const meBefore = await (await page.context().request.get(`${baseURL}/api/me`)).json();
    const deniedJob = await api.post("/api/v1/jobs", {
      headers: { authorization: `Bearer ${apiKey}` },
      data: { endpoint: "motionfield/ltx-video/text-to-video", params: { prompt: "license gate e2e" } },
    });
    expect(deniedJob.status(), await deniedJob.text()).toBe(403);
    const deniedBody = await deniedJob.json();
    expect(deniedBody.error.code).toBe("restricted_license");
    expect(deniedBody.error.license).toContain("LTX-2.x Community");
    expect(deniedBody.error.enable_at).toBe("/settings/licenses");
    const meAfter = await (await page.context().request.get(`${baseURL}/api/me`)).json();
    expect(Number(meAfter.profile.credits)).toBe(Number(meBefore.profile.credits));

    // ── submit a job with the bearer key + webhook_url ──────────────────
    const create = await api.post("/api/v1/jobs", {
      headers: { authorization: `Bearer ${apiKey}` },
      data: {
        endpoint: "motionfield/z-image-turbo/text-to-image",
        params: { prompt: "e2e webhook test" },
        webhook_url: hookUrl,
      },
    });
    expect(create.status(), await create.text()).toBe(202);
    const job = await create.json();
    const jobId = job.id as string;
    expect(job.links.self).toBe(`/api/v1/jobs/${jobId}`);

    // ── poll until the mock provider completes it ───────────────────────
    let view: { status: string; outputs?: { url: string; type?: string }[] } = { status: "" };
    for (let i = 0; i < 90; i++) {
      const res = await api.get(`/api/v1/jobs/${jobId}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.status()).toBe(200);
      view = await res.json();
      if (!["queued", "in_progress"].includes(view.status)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(view.status).toBe("completed");
    expect(view.outputs?.length).toBeGreaterThan(0);
    expect(view.outputs?.[0].type).toMatch(/^[\w.-]+\/[\w.+-]+$/);

    // result endpoint streams the output bytes
    const result = await api.get(`/api/v1/jobs/${jobId}/result`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(result.status()).toBe(200);
    expect(result.headers()["content-type"]).toMatch(/^image\//);
    expect((await result.body()).length).toBeGreaterThan(0);

    // ── exactly one signed job.completed delivery (async sweep - poll) ──
    await expect.poll(() => received.length, { timeout: 15_000 }).toBe(1);
    const ev = received[0];
    expect(ev.headers["user-agent"]).toBe("MotionField-Webhooks/1");
    const evt = JSON.parse(ev.body);
    expect(evt.type).toBe("job.completed");
    expect(evt.id).toBe(ev.headers["x-motionfield-event-id"]);
    expect(evt.data.id).toBe(jobId);
    expect(evt.data.status).toBe("completed");
    expect(
      verifySignature(webhookSecret, String(ev.headers["x-motionfield-signature"]), ev.body),
    ).toBe(true);

    // ── a second user's key gets 404 on every view of this job ──────────
    const u2 = `ws1ui-b-${Date.now()}@e2e.test`;
    const sign = await api.post("/api/auth/sign-up/email", {
      data: { email: u2, password, name: "WS1 E2E B" },
    });
    expect(sign.status()).toBe(200);
    const keyRes = await api.post("/api/keys", {
      headers: { cookie: sign.headers()["set-cookie"] ?? "" },
      data: { label: "u2" },
    });
    expect(keyRes.status(), await keyRes.text()).toBe(201);
    const key2 = (await keyRes.json()).key as string;
    const auth2 = { authorization: `Bearer ${key2}` };
    for (const probe of [
      api.get(`/api/v1/jobs/${jobId}`, { headers: auth2 }),
      api.post(`/api/v1/jobs/${jobId}/cancel`, { headers: auth2 }),
      api.get(`/api/v1/jobs/${jobId}/result`, { headers: auth2 }),
    ]) {
      const res = await probe;
      expect(res.status(), `${res.url()} should 404 for another user's key`).toBe(404);
    }

    // ── revoke in the UI, then the key is dead ──────────────────────────
    await page.goto("/settings/keys");
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Revoke" }).first().click();
    await expect(page.getByText("revoked")).toBeVisible();
    const denied = await api.get("/api/v1/models", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(denied.status()).toBe(401);

    // ── docs + openapi are up ───────────────────────────────────────────
    const spec = await api.get("/api/v1/openapi.json");
    expect(spec.status()).toBe(200);
    expect((await spec.json()).openapi).toMatch(/^3\.1\./);
    await page.goto("/docs/api");
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByText("motionfield/z-image-turbo/text-to-image").first()).toBeVisible();
  } finally {
    receiver.close();
    await api.dispose();
  }
});
