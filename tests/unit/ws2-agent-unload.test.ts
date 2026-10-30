import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "@/db";

beforeAll(() => {
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws2-unload-"));
  process.env.BETTER_AUTH_SECRET = "test-secret-ws2-0123456789abcdef0123456789ab";
  process.env.GENERATION_PROVIDER = "mock";
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
}, 60_000);

const LLM_ENV = [
  "LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY",
  "LLM_TASK_PLANNER", "LLM_TASK_WRITER", "LLM_TASK_VISION",
  "LLM_TASK_CODER", "LLM_TASK_ENHANCER", "LLM_TASK_JUDGE",
];
afterEach(() => {
  for (const k of LLM_ENV) delete process.env[k];
  vi.restoreAllMocks();
});

async function makeUser(id: string) {
  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$2,$3,true)`, [id, id, `${id}@test.dev`]);
  const { ensureProfile } = await import("@/lib/profiles");
  await ensureProfile(id, `${id}@test.dev`, id);
}

type StubReq = { path: string; body: Record<string, unknown> };

const VIDEO_PLAN = {
  title: "video plan",
  steps: [{
    id: "s1", title: "Generate video",
    endpoint_id: "motionfield/wan-2.1/text-to-video",
    params: { prompt: "a neon city at night", resolution: "480p", duration: 3 },
    depends_on: [],
  }],
};

/** LLM stub: chat calls reply the plan JSON (unless plan is null → plain
 *  "done", which fails chatJson and exercises the deterministic fallback).
 *  Records every request, including the keep_alive:0 unload probe. */
function stubLlm(wire: "ollama" | "openai", plan: unknown = VIDEO_PLAN) {
  const reqs: StubReq[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      reqs.push({ path: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/generate") { res.end("{}"); return; } // unload probe
      const content = plan === null ? "done" : JSON.stringify(plan);
      if (wire === "ollama") {
        res.end(JSON.stringify({ message: { content } }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      }
    });
  });
  return { server, reqs };
}

describe("ws2: planner-turn unload (C8) - fires after a media run is created", () => {
  it("posts keep_alive:0 exactly once to a local Ollama route after a media run", async () => {
    const { server, reqs } = stubLlm("ollama");
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    process.env.LLM_PROVIDER = "ollama";
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.LLM_MODEL = "m";
    try {
      await makeUser("u-unl-1");
      const { createSession, postUserMessage } = await import("@/lib/agent");
      const s = await createSession("u-unl-1");
      await postUserMessage("u-unl-1", s.id, "make a video of a neon city at night");
      const unloads = reqs.filter((r) => r.path === "/api/generate" && r.body.keep_alive === 0);
      expect(unloads).toHaveLength(1);
      expect(unloads[0].body.model).toBe("m");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30000);

  it("sends nothing for a cloud (non-ollama) route", async () => {
    const { server, reqs } = stubLlm("openai");
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    process.env.LLM_PROVIDER = "custom";
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.LLM_MODEL = "m";
    try {
      await makeUser("u-unl-2");
      const { createSession, postUserMessage } = await import("@/lib/agent");
      const s = await createSession("u-unl-2");
      await postUserMessage("u-unl-2", s.id, "make a video of a neon city at night");
      expect(reqs.filter((r) => r.path === "/api/generate")).toHaveLength(0);
      // the plan did get created - the turn went through chatJson
      expect(reqs.filter((r) => r.path === "/v1/chat/completions").length).toBeGreaterThanOrEqual(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30000);

  it("sends nothing when the turn created no run", async () => {
    const { server, reqs } = stubLlm("ollama", null);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    process.env.LLM_PROVIDER = "ollama";
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.LLM_MODEL = "m";
    try {
      await makeUser("u-unl-3");
      const { createSession, postUserMessage } = await import("@/lib/agent");
      const s = await createSession("u-unl-3");
      await postUserMessage("u-unl-3", s.id, "hi");
      expect(reqs.filter((r) => r.path === "/api/generate")).toHaveLength(0);
      expect(reqs.some((r) => r.path === "/api/chat")).toBe(true); // the turn ran
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30000);
});
