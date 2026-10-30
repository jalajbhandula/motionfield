/**
 * /api/llm/test backing: resolveProviderRoute + testConnection over stub
 * servers, and narrationScript's LLM/verbatim split. No provider is ever
 * "probed" without a real call - ok:false carries a truthful, secret-free
 * reason.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { narrationScript, resolveProviderRoute, testConnection } from "@/lib/llm/service";
import { putProviderRow, putTaskRoute, setPrefs } from "@/lib/llm/settings";

beforeAll(() => {
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws2-test-"));
  process.env.BETTER_AUTH_SECRET = "test-secret-ws2-0123456789abcdef0123456789ab";
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
}, 60_000);

const ENV_KEYS = ["MOTIONFIELD_HOSTED", "MOTIONFIELD_OFFLINE", "LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "LLM_TASK_WRITER"];
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

let n = 0;
async function uid() {
  const id = `u-test-${++n}`;
  const { sql } = await import("@/db");
  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$2,$3,true)`, [id, id, `${id}@test.dev`]);
  return id;
}

const OAI_OK = { choices: [{ message: { role: "assistant", content: "ok" } }] };

async function stubChat(handler: (body: string | null) => { status?: number; body: unknown }) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url}`);
      const out = handler(raw || null);
      res.writeHead(out.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("testConnection", () => {
  it("ok:true against a stub OpenAI-compatible server", async () => {
    const u = await uid();
    const stub = await stubChat(() => ({ body: OAI_OK }));
    try {
      await putProviderRow(u, "custom", { baseUrl: `${stub.url}/v1`, apiKey: "k" });
      const r = await testConnection(u, { providerId: "custom", model: "m-x" });
      expect(r.ok).toBe(true);
      expect(r.provider).toBe("Custom self-hosted endpoint");
      expect(r.model).toBe("m-x");
      expect(stub.seen.some((s) => s.includes("/chat/completions"))).toBe(true);
    } finally {
      await stub.close();
    }
  });

  it("a task test resolves the user's saved route", async () => {
    const u = await uid();
    const stub = await stubChat(() => ({ body: OAI_OK }));
    try {
      await putProviderRow(u, "custom", { baseUrl: `${stub.url}/v1`, apiKey: "k" });
      await putTaskRoute(u, "writer", { providerId: "custom", model: "route-model" });
      const r = await testConnection(u, { task: "writer" });
      expect(r.ok).toBe(true);
      expect(r.model).toBe("route-model");
    } finally {
      await stub.close();
    }
  });

  it("failures are truthful: unreachable host, unconfigured provider, HTTP error", async () => {
    const u = await uid();
    // nothing configured at all
    const missing = await testConnection(u, { providerId: "custom" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/base URL|model|unreachable/i);

    // dead port → unreachable, never a raw stack/secret
    const stub = await stubChat(() => ({ body: OAI_OK }));
    const deadUrl = `${stub.url}/v1`;
    await stub.close();
    await putProviderRow(u, "custom", { baseUrl: deadUrl, apiKey: "k" });
    const dead = await testConnection(u, { providerId: "custom", model: "m" });
    expect(dead.ok).toBe(false);
    expect(dead.error).not.toContain("k");

    // 4xx → status surfaced; the saved key is a long distinctive string that
    // must appear NOWHERE in the result (status + host only, no echo)
    const err = await stubChat(() => ({ status: 401, body: { error: "bad key" } }));
    try {
      const DISTINCT_KEY = "sk-DISTINCTIVE-401-PROBE-9f8e7d6c5b4a";
      await putProviderRow(u, "custom", { baseUrl: `${err.url}/v1`, apiKey: DISTINCT_KEY });
      const bad = await testConnection(u, { providerId: "custom", model: "m" });
      expect(bad.ok).toBe(false);
      expect(bad.error).toContain("401");
      expect(bad.error).not.toContain("bad key");
      expect(JSON.stringify(bad)).not.toContain(DISTINCT_KEY);
    } finally {
      await err.close();
    }
  });

  it("a user in offline mode gets the refusal instead of a remote call", async () => {
    const u = await uid();
    // remote base URL - refused before any network work (no stub needed)
    await putProviderRow(u, "custom", { baseUrl: "https://llm.example.test/v1", apiKey: "k" });
    await setPrefs(u, true);
    const r = await testConnection(u, { providerId: "custom", model: "m" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/offline/);
    // and a loopback route still works offline (local models are offline-safe)
    const stub = await stubChat(() => ({ body: OAI_OK }));
    try {
      await putProviderRow(u, "custom", { baseUrl: `${stub.url}/v1`, apiKey: "k" });
      const ok = await testConnection(u, { providerId: "custom", model: "m" });
      expect(ok.ok).toBe(true);
    } finally {
      await stub.close();
    }
  });
});

describe("narrationScript", () => {
  it("returns the writer's spoken script when a route exists", async () => {
    const stub = await stubChat(() => ({ body: { choices: [{ message: { role: "assistant", content: '{"script":"spoken version"}' } }] } }));
    try {
      const u = await uid();
      await putProviderRow(u, "custom", { baseUrl: `${stub.url}/v1`, apiKey: "k" });
      await putTaskRoute(u, "writer", { providerId: "custom", model: "m" });
      const r = await narrationScript(u, "make an intro about waffles");
      expect(r).toEqual({ script: "spoken version", byLlm: true });
    } finally {
      await stub.close();
    }
  });

  it("reads the user's text verbatim when no LLM is configured or it fails", async () => {
    const u = await uid();
    expect(await narrationScript(u, "say this")).toEqual({ script: "say this", byLlm: false });

    // configured but dead → still verbatim, never an exception
    const stub = await stubChat(() => ({ status: 500, body: {} }));
    try {
      await putProviderRow(u, "custom", { baseUrl: `${stub.url}/v1`, apiKey: "k" });
      await putTaskRoute(u, "writer", { providerId: "custom", model: "m" });
      expect(await narrationScript(u, "say this")).toEqual({ script: "say this", byLlm: false });
    } finally {
      await stub.close();
    }
  });
});
