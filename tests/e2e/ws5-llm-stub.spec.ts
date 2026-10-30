import { expect, request as playwrightRequest, test, type APIRequestContext } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A3 acceptance - a provider saved in Settings (no LLM_* env at all) is
 * enough for the spec writer. The proof runs against a stub OpenAI-compatible
 * server on 127.0.0.1: it records every chat call, so a green 201 means the
 * request actually took the per-user Settings route, not an env fallback.
 */

const base = `http://localhost:${process.env.PORT || "3100"}`;

test.describe.configure({ mode: "serial" });

/** minimal valid MotionDraft - strictObject: exactly these keys, ≥2 params */
const DRAFT = {
  background: { color: "#101018" },
  camera: { keyframes: [{ t: 0, position: [0, 0, 8], target: [0, 0, 0] }] },
  layers: [
    { id: "block", type: "box", props: { width: 2, height: 2, depth: 1, color: "#ff6600" } },
  ],
  params: [
    { id: "scale", label: "Scale", min: 0.5, max: 2, step: 0.1, default: 1, bind: "block.scale" },
    { id: "hue", label: "Hue", min: 0, max: 360, step: 1, default: 30, bind: "block.props.hue" },
  ],
};

async function signup(ctx: APIRequestContext, label: string) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const password = "test-pass-1234";
  for (let i = 0; i < 5; i++) {
    try {
      if ((await ctx.post("/api/auth/sign-up/email", { data: { email, password, name: "WS5 Stub" } })).ok()
        || (await ctx.post("/api/auth/sign-in/email", { data: { email, password } })).ok()) return;
    } catch { /* ECONNRESET under load - retry */ }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw new Error("signup failed");
}

test("[A3] a Settings-saved provider (LLM_* unset) writes specs - stub server sees the chat call", async () => {
  test.setTimeout(180_000); // first-contact with several cold-compiled API routes
  const calls: { url: string | undefined; body: string }[] = [];
  const stub = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        calls.push({ url: req.url, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify(DRAFT) } }],
          usage: { prompt_tokens: 40, completion_tokens: 60 },
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const stubPort = (stub.address() as AddressInfo).port;

  try {
    const ctx = await playwrightRequest.newContext({
      baseURL: base, extraHTTPHeaders: { origin: base },
    });
    await signup(ctx, "ws5a3");

    // the user saves a Custom endpoint in Settings - the same writes the
    // settings page performs; the key material itself is optional (stub
    // takes anything), but the route has to exist per-user
    const prov = await ctx.put("/api/llm/providers/custom", {
      data: { baseUrl: `http://127.0.0.1:${stubPort}/v1` },
    });
    expect(prov.status(), await prov.text()).toBe(200);
    const route = await ctx.put("/api/llm/routes/writer", {
      data: { providerId: "custom", model: "stub-1" },
    });
    expect(route.status(), await route.text()).toBe(200);

    // generate: with only a Settings provider the route must resolve the
    // per-user writer task (env-only llmOn() would 503)
    const gen = await ctx.post("/api/render/motion", {
      data: { prompt: "a bold launch card" },
    });
    expect(gen.status(), await gen.text()).toBe(201);
    const data = await gen.json();
    expect(data.spec.version).toBe(1);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // the stub saw an OpenAI-chat-shaped request for the saved model
    const payload = JSON.parse(calls[0].body) as { model?: string; messages?: unknown[] };
    expect(payload.model).toBe("stub-1");
    expect(Array.isArray(payload.messages)).toBe(true);

    // refine on the same spec also routes through the user's provider
    // (retry only on thrown transport errors - never on an HTTP status)
    const specId = data.id;
    let rf: Awaited<ReturnType<APIRequestContext["post"]>> | undefined;
    for (let i = 0; i < 3; i++) {
      try {
        rf = await ctx.post(`/api/render/motion/${specId}/refine`, {
          data: { instruction: "make the accent warmer" },
        });
        break;
      } catch (e) { if (i === 2) throw e; }
    }
    expect(rf!.status(), await rf!.text()).toBe(201);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    await ctx.dispose();
  } finally {
    stub.close();
  }
});
