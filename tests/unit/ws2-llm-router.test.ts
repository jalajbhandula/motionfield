import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { chat, chatJson, resolveRoute, unloadLocalModel, WIRES } from "@/lib/llm/index";
import { isLoopbackUrl, offlineMode } from "@/lib/llm/offline";
import { llmConfigured, llmEnvConfigured, SUGGESTED_ROUTE } from "@/lib/llm/router";
import { PROVIDERS, providerById } from "@/lib/llm/providers";
import { LlmUnavailable, OfflineBlocked } from "@/lib/llm/types";
import { llmChat, llmOn, chatJson as facadeChatJson } from "@/lib/llm";
import { encryptSecret } from "@/lib/llm/crypto";
import { sql } from "@/db";

/** Router + offline-guard tests. Env is scrubbed around every test - the LLM
 *  must stay OFF unless something is explicitly configured. */

const ENV_KEYS = ["LLM_PROVIDER", "LLM_MODEL", "LLM_BASE_URL", "LLM_API_KEY", "LLM_WIRE",
  "LLM_API_KEY_LMSTUDIO", "LLM_API_KEY_CUSTOM",
  "LLM_TASK_PLANNER", "LLM_TASK_WRITER", "LLM_TASK_VISION", "LLM_TASK_CODER",
  "LLM_TASK_ENHANCER", "LLM_TASK_JUDGE", "MOTIONFIELD_OFFLINE"];

// migrate once up front - dbRoute() lookups run against a real schema, and a
// tmp PGLITE_DIR keeps the singleton off ./.data/pglite in the worktree
beforeAll(() => {
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws2-router-"));
  process.env.BETTER_AUTH_SECRET = "test-secret-ws2-0123456789abcdef0123456789ab";
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
}, 60_000);

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function withStub(
  respond: (n: number, body: any) => { status?: number; body: unknown },
  fn: (baseUrl: string, seen: any[]) => Promise<void>,
) {
  const seen: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ headers: req.headers, method: req.method, url: req.url, ...(body ?? {}) });
      const out = respond(seen.length, body);
      res.writeHead(out.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try { await fn(`http://127.0.0.1:${port}`, seen); }
  finally {
    (server as any).closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const OAI_OK = { choices: [{ message: { role: "assistant", content: "hi" } }] };

describe("route resolution order", () => {
  it("rejects LlmUnavailable with nothing configured - before ANY fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      // no implicit route: every entry point fails fast, zero network calls
      await expect(resolveRoute("planner")).rejects.toBeInstanceOf(LlmUnavailable);
      await expect(chat("planner", { messages: [{ role: "user", content: "hi" }] }))
        .rejects.toBeInstanceOf(LlmUnavailable);
      await expect(llmChat([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(LlmUnavailable);
      await expect(facadeChatJson(z.object({ x: z.string() }), [{ role: "user", content: "hi" }]))
        .rejects.toBeInstanceOf(LlmUnavailable);
      expect(spy).not.toHaveBeenCalled();
      expect(llmOn()).toBe(false);
      expect(llmEnvConfigured()).toBe(false);
      // the suggested local starter route exists for docs/Settings only
      expect(SUGGESTED_ROUTE).toEqual({ providerId: "ollama", model: "qwen3.5:9b" });
    } finally {
      spy.mockRestore();
    }
  });

  it("back-compat: bare LLM_BASE_URL+LLM_MODEL resolves to openai-chat", async () => {
    process.env.LLM_BASE_URL = "http://127.0.0.1:9/v1/";
    process.env.LLM_MODEL = "m";
    process.env.LLM_API_KEY = "k";
    const r = await resolveRoute("planner");
    expect(r.wire).toBe("openai-chat");
    expect(r.baseUrl).toBe("http://127.0.0.1:9/v1");
    expect(r.model).toBe("m");
    expect(r.apiKey).toBe("k");
    expect(r.source).toBe("env");
    expect(llmOn()).toBe(true);
  });

  it("LLM_PROVIDER preset + LLM_MODEL wins over the legacy vars' wire", async () => {
    process.env.LLM_PROVIDER = "ollama";
    process.env.LLM_MODEL = "qwen-x";
    process.env.LLM_API_KEY = "k2";
    const r = await resolveRoute("writer");
    expect(r.wire).toBe("ollama");
    expect(r.baseUrl).toBe("http://127.0.0.1:11434");
    expect(r.model).toBe("qwen-x");
    expect(r.source).toBe("env");
  });

  it("LLM_TASK_<TASK> overrides the global provider for that task only", async () => {
    process.env.LLM_PROVIDER = "ollama";
    process.env.LLM_MODEL = "qwen3.5:9b";
    process.env.LLM_TASK_PLANNER = "vllm:llama-x";
    const planner = await resolveRoute("planner");
    expect(planner.providerId).toBe("vllm");
    expect(planner.model).toBe("llama-x");
    expect(planner.source).toBe("env-task");
    const writer = await resolveRoute("writer");
    expect(writer.providerId).toBe("ollama");
    expect(writer.source).toBe("env");
    expect(llmOn()).toBe(true);
  });

  it("task spec keeps colons inside the model name (ollama:qwen3.5:9b)", async () => {
    process.env.LLM_TASK_VISION = "ollama:qwen3.5:9b";
    const r = await resolveRoute("vision");
    expect(r.providerId).toBe("ollama");
    expect(r.model).toBe("qwen3.5:9b");
  });

  it("never sends LLM_API_KEY to a different provider's task route", async () => {
    process.env.LLM_PROVIDER = "custom";
    process.env.LLM_BASE_URL = "https://llm.example.test/v1";
    process.env.LLM_MODEL = "m";
    process.env.LLM_API_KEY = "k-custom";
    process.env.LLM_TASK_VISION = "lmstudio:vision-x";
    const vision = await resolveRoute("vision");
    expect(vision.providerId).toBe("lmstudio");
    expect(vision.apiKey).toBeUndefined(); // the custom endpoint's key must not leak to LM Studio
    await withStub(
      () => ({ body: OAI_OK }),
      async (base, seen) => {
        await WIRES[vision.wire as keyof typeof WIRES].call(
          { baseUrl: base, apiKey: vision.apiKey, model: vision.model, label: vision.label },
          { messages: [{ role: "user", content: "hi" }] },
        );
        expect(seen).toHaveLength(1);
        expect(seen[0].headers.authorization).toBeUndefined();
      },
    );
    // a dedicated per-provider key does reach that route
    process.env.LLM_API_KEY_LMSTUDIO = "k2";
    expect((await resolveRoute("vision")).apiKey).toBe("k2");
  });

  it("unknown task provider throws a clear error", async () => {
    process.env.LLM_TASK_CODER = "nope:m";
    await expect(resolveRoute("coder")).rejects.toThrow(/unknown provider/);
  });

  it("LLM_BASE_URL alone (no model, no provider) is not configured", async () => {
    process.env.LLM_BASE_URL = "http://127.0.0.1:9/v1";
    expect(llmOn()).toBe(false);
    await expect(resolveRoute("planner")).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it("llmConfigured(userId, task) is task-scoped - vision-only config doesn't enable the planner", async () => {
    process.env.LLM_TASK_VISION = "ollama:qwen3.5:9b";
    expect(await llmConfigured("u1", "vision")).toBe(true);
    expect(await llmConfigured("u1", "planner")).toBe(false);
    expect(await llmConfigured("u1")).toBe(true); // task-less = any route
  });

  it("llmEnvConfigured counts only LLM_TASK_<known task> vars", async () => {
    process.env.LLM_TASK_NOTAREAL = "ollama:m";
    try {
      expect(llmEnvConfigured()).toBe(false);
      expect(await llmConfigured("u1")).toBe(false);
      process.env.LLM_TASK_JUDGE = "ollama:m";
      expect(llmEnvConfigured()).toBe(true);
    } finally {
      delete process.env.LLM_TASK_NOTAREAL; // not in the scrub list - clean by hand
    }
  });

  it("`local` reflects the base URL actually used, not the preset's class", async () => {
    // ollama preset is local - but pointed at a remote URL it must not stay "local"
    process.env.LLM_PROVIDER = "ollama";
    process.env.LLM_BASE_URL = "https://ollama.example.com";
    expect((await resolveRoute("planner")).local).toBe(false);
    // the custom (non-local) preset pointed at a loopback URL IS local
    process.env.LLM_PROVIDER = "custom";
    process.env.LLM_BASE_URL = "http://127.0.0.1:8317/v1";
    process.env.LLM_MODEL = "m";
    expect((await resolveRoute("planner")).local).toBe(true);
  });

  it("provider presets are self-hosted runtimes with documented defaults", () => {
    expect(providerById("ollama")?.defaultModel).toBe("qwen3.5:9b");
    expect(providerById("custom")?.baseUrl).toBe(""); // the user brings their own server
    for (const p of PROVIDERS) {
      expect(p.doc.length).toBeGreaterThan(0);
      if (p.id !== "custom") expect(isLoopbackUrl(p.baseUrl)).toBe(true);
    }
  });
});

describe("offline guard", () => {
  it("flags loopback correctly", () => {
    expect(isLoopbackUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.9:1")).toBe(true);
    expect(isLoopbackUrl("http://localhost:1234/v1")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8080")).toBe(true);
    expect(isLoopbackUrl("http://[0:0:0:0:0:0:0:1]:1234")).toBe(true);
    expect(isLoopbackUrl("https://api.example.com")).toBe(false);
    expect(isLoopbackUrl("https://example.com:11434")).toBe(false);
    // no suffix rules: *.localhost subdomains are NOT loopback
    expect(isLoopbackUrl("http://app.localhost:3000")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });

  it("MOTIONFIELD_OFFLINE=1 blocks a remote route before any fetch", async () => {
    process.env.MOTIONFIELD_OFFLINE = "1";
    process.env.LLM_BASE_URL = "https://api.example.com/v1";
    process.env.LLM_MODEL = "m";
    expect(offlineMode()).toBe(true);
    await expect(chat("planner", { messages: [{ role: "user", content: "hi" }] }))
      .rejects.toBeInstanceOf(OfflineBlocked);
    // OfflineBlocked is an LlmUnavailable - agent/notice handling covers it
    await expect(chat("planner", { messages: [{ role: "user", content: "hi" }] }))
      .rejects.toBeInstanceOf(LlmUnavailable);
  });

  it("MOTIONFIELD_OFFLINE=1 still allows loopback providers", async () => {
    process.env.MOTIONFIELD_OFFLINE = "1";
    await withStub(() => ({ body: OAI_OK }), async (base, seen) => {
      process.env.LLM_BASE_URL = `${base}/v1`;
      process.env.LLM_MODEL = "m";
      const res = await chat("planner", { messages: [{ role: "user", content: "hi" }] });
      expect(res.text).toBe("hi");
      expect(seen).toHaveLength(1);
    });
  });

  it("a request flagged offline is blocked even without the env var", async () => {
    process.env.LLM_BASE_URL = "https://api.example.com/v1";
    process.env.LLM_MODEL = "m";
    await expect(chat("planner", {
      messages: [{ role: "user", content: "hi" }], offline: true,
    })).rejects.toBeInstanceOf(OfflineBlocked);
  });
});

describe("facade through the new layer", () => {
  it("llmChat stall-then-success: exactly one retry", async () => {
    const seen: any[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push(raw ? JSON.parse(raw) : null);
        if (seen.length === 1) return; // stall past the client timeout
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(OAI_OK));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
      process.env.LLM_MODEL = "m";
      const msg = await llmChat([{ role: "user", content: "hi" }], { temperature: 0.4, timeoutMs: 1_000 });
      expect(msg?.content).toBe("hi");
      expect(seen).toHaveLength(2); // one timeout, one success - retry got a fresh signal
    } finally {
      (server as any).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("facade chatJson sends response_format and zod-validates", async () => {
    await withStub((_n) => ({ body: { choices: [{ message: { content: '{"x":"ok"}' } }] } }),
      async (base, seen) => {
        process.env.LLM_BASE_URL = `${base}/v1`;
        process.env.LLM_MODEL = "m";
        const out = await facadeChatJson(z.object({ x: z.string() }), [{ role: "user", content: "go" }]);
        expect(out).toEqual({ x: "ok" });
        expect(seen).toHaveLength(1);
        expect(seen[0].response_format?.type).toBe("json_schema");
      });
  });

  it("facade chatJson sends no wire constraint for an array-root schema", async () => {
    // Anthropic's forced tool needs input_schema.type "object" - an array root
    // would 400 there; on strict OpenAI it wastes a call. One request, no knob.
    await withStub(
      () => ({ body: { choices: [{ message: { content: '[{"x":"ok"}]' } }] } }),
      async (base, seen) => {
        process.env.LLM_BASE_URL = `${base}/v1`;
        process.env.LLM_MODEL = "m";
        const out = await facadeChatJson(z.array(z.object({ x: z.string() })), [{ role: "user", content: "go" }]);
        expect(out).toEqual([{ x: "ok" }]);
        expect(seen).toHaveLength(1);
        expect(seen[0].response_format).toBeUndefined();
      },
    );
  });

  it("facade chatJson tolerates schemas z.toJSONSchema can't express (transform)", async () => {
    await withStub(
      () => ({ body: { choices: [{ message: { content: '{"x":"ok"}' } }] } }),
      async (base, seen) => {
        process.env.LLM_BASE_URL = `${base}/v1`;
        process.env.LLM_MODEL = "m";
        const out = await facadeChatJson(
          z.object({ x: z.string().transform((s) => s.length) }),
          [{ role: "user", content: "go" }],
        );
        expect(out).toEqual({ x: 2 }); // zod still applies the transform
        expect(seen).toHaveLength(1);
        expect(seen[0].response_format).toBeUndefined();
      },
    );
  });

  it("facade chatJson issues exactly one repair turn on a bad reply", async () => {
    await withStub(
      (n) => ({ body: { choices: [{ message: { content: n === 1 ? "not json" : '{"x":"fixed"}' } }] } }),
      async (base, seen) => {
        process.env.LLM_BASE_URL = `${base}/v1`;
        process.env.LLM_MODEL = "m";
        const out = await facadeChatJson(z.object({ x: z.string() }), [{ role: "user", content: "go" }]);
        expect(out).toEqual({ x: "fixed" });
        expect(seen).toHaveLength(2);
        // repair turn echoes the bad assistant reply + the validation nudge
        const msgs = seen[1].messages;
        expect(msgs.at(-2).role).toBe("assistant");
        expect(msgs.at(-1).content).toMatch(/failed validation/);
      },
    );
  });

  it("drops the wire schema on 501/4xx schema errors - and keeps it dropped on repair", async () => {
    // first schema'd call 501s (wire can't express it); clean calls return
    // a bad reply then a fixed one - exercises schema-drop + repair together
    await withStub(
      (n, body) => {
        if (body.response_format) {
          return { status: 501, body: { error: "structured output is unavailable" } };
        }
        const content = n === 2 ? "junk" : '{"x":"recovered"}';
        return { body: { choices: [{ message: { content } }] } };
      },
      async (base, seen) => {
        process.env.LLM_BASE_URL = `${base}/v1`;
        process.env.LLM_MODEL = "m";
        const { data: out } = await chatJson("writer", z.object({ x: z.string() }), {
          messages: [{ role: "user", content: "go" }],
        });
        expect(out).toEqual({ x: "recovered" });
        // 1 schema'd call + 2 clean calls (first bad -> repair) - schema stays dropped
        expect(seen).toHaveLength(3);
        expect(seen[0].response_format).toBeTruthy();
        expect(seen[1].response_format).toBeUndefined();
        expect(seen[2].response_format).toBeUndefined();
      },
    );
  });

  it("a dropped schema constraint stays dropped for that provider+model", async () => {
    await withStub(
      (_n, body) => {
        if (body.response_format) return { status: 501, body: { error: "structured output is unavailable" } };
        return { body: { choices: [{ message: { content: '{"x":"ok"}' } }] } };
      },
      async (base, seen) => {
        process.env.LLM_BASE_URL = `${base}/v1`;
        process.env.LLM_MODEL = "m-dropcache";
        const S = z.object({ x: z.string() });
        const r = { messages: [{ role: "user" as const, content: "go" }] };
        const { data: a } = await chatJson("writer", S, r);
        expect(a).toEqual({ x: "ok" });
        const seenAfterFirst = seen.length; // schema'd call + dropped clean call
        expect(seenAfterFirst).toBe(2);
        // second chatJson on the same provider+model skips the wasted 501
        const { data: b } = await chatJson("writer", S, r);
        expect(b).toEqual({ x: "ok" });
        expect(seen.length).toBe(seenAfterFirst + 1); // exactly one clean call
        expect(seen[seen.length - 1].response_format).toBeUndefined();
      },
    );
  });

  it("layer chatJson: same, via task route", async () => {
    await withStub(
      () => ({ body: { choices: [{ message: { content: '{"x":1}' } }] } }),
      async (base) => {
        process.env.LLM_BASE_URL = `${base}/v1`;
        process.env.LLM_MODEL = "m";
        const { data: out } = await chatJson("writer", z.object({ x: z.number() }), { messages: [{ role: "user", content: "go" }] });
        expect(out).toEqual({ x: 1 });
      },
    );
  });

  it("facade chatJson fits the MotionDeps shape - resolves to the parsed object", async () => {
    // ws5's render pipeline builds { chatJson, llmOn } as its deps - chatJson
    // must resolve to the zod-parsed data itself, not a routed wrapper.
    type MotionDeps = {
      chatJson: <S extends z.ZodType>(
        schema: S,
        msgs: { role: string; content: string }[],
        opts?: { signal?: AbortSignal; temperature?: number },
      ) => Promise<z.infer<S>>;
      llmOn: () => boolean;
    };
    await withStub(
      () => ({ body: { choices: [{ message: { content: '{"x":"ok"}' } }] } }),
      async (base, seen) => {
        process.env.LLM_BASE_URL = `${base}/v1`;
        process.env.LLM_MODEL = "m";
        const deps: MotionDeps = { chatJson: facadeChatJson, llmOn };
        const draft = await deps.chatJson(z.object({ x: z.string() }), [{ role: "user", content: "go" }]);
        expect(draft).toEqual({ x: "ok" });
        expect(deps.llmOn()).toBe(true);
        expect(seen).toHaveLength(1);
      },
    );
  });
});

describe("unloadLocalModel", () => {
  it("POSTs keep_alive:0 to a local ollama /api/generate; skips remote/non-ollama", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      await unloadLocalModel({ providerId: "custom", local: false, baseUrl: "https://llm.example.test/v1", model: "m" });
      await unloadLocalModel({ providerId: "ollama", local: false, baseUrl: "https://ollama.example.com", model: "m" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    await withStub(() => ({ body: {} }), async (base, seen) => {
      await unloadLocalModel({ providerId: "ollama", local: true, baseUrl: `${base}/v1`, model: "qwen3.5:9b" });
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe("/api/generate"); // /v1 stripped
      expect(seen[0].model).toBe("qwen3.5:9b");
      expect(seen[0].keep_alive).toBe(0);
    });
    // unreachable local endpoint - best-effort, must not throw
    await unloadLocalModel({ providerId: "ollama", local: true, baseUrl: "http://127.0.0.1:9", model: "m" });
  });
});

describe("per-user db route", () => {
  it("db route wins over env and carries its decrypted key", async () => {
    await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$1,$2,true)`, ["u-routes", "u-routes@test.dev"]);
    await sql(
      `INSERT INTO llm_provider_settings (user_id, provider_id, base_url, api_key_enc) VALUES ($1,$2,$3,$4)`,
      ["u-routes", "custom", "http://127.0.0.1:9000/v1", encryptSecret("sk-live")],
    );
    await sql(
      `INSERT INTO llm_task_routes (user_id, task, provider_id, model) VALUES ($1,$2,$3,$4)`,
      ["u-routes", "writer", "custom", "db-model"],
    );
    process.env.LLM_PROVIDER = "ollama"; // env fallback exists but must lose
    process.env.LLM_MODEL = "env-model";
    const r = await resolveRoute("writer", "u-routes");
    expect(r.source).toBe("db");
    expect(r.providerId).toBe("custom");
    expect(r.model).toBe("db-model");
    expect(r.baseUrl).toBe("http://127.0.0.1:9000/v1");
    expect(r.apiKey).toBe("sk-live");
    // another task with no row falls through to env
    expect((await resolveRoute("planner", "u-routes")).model).toBe("env-model");
  });

  it("a broken db route surfaces as LlmUnavailable - never falls through to another provider", async () => {
    await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$1,$2,true)`, ["u-corrupt", "u-corrupt@test.dev"]);
    await sql(
      `INSERT INTO llm_task_routes (user_id, task, provider_id, model) VALUES ($1,$2,$3,$4)`,
      ["u-corrupt", "planner", "custom", "m"],
    );
    await sql(
      `INSERT INTO llm_provider_settings (user_id, provider_id, api_key_enc) VALUES ($1,$2,$3)`,
      ["u-corrupt", "custom", "not-a-real-encrypted-key"],
    );
    process.env.LLM_PROVIDER = "ollama"; // an env route exists - still must NOT be used
    process.env.LLM_MODEL = "m";
    await expect(resolveRoute("planner", "u-corrupt")).rejects.toBeInstanceOf(LlmUnavailable);
    expect(await llmConfigured("u-corrupt", "planner")).toBe(false);
  });
});
