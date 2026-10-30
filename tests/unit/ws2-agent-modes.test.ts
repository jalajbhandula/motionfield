/**
 * [OF-0595] Session mode is a real control: in offline mode a remote-route
 * stub LLM (https://api.example.com) gets 0 requests - the call is refused
 * before any network work; the fallback shows the offline notice text and
 * records via "built-in planner".
 *
 * Step 4 update: planner turns produce a Plan that becomes a durable run
 * (agent_runs/run_steps) - the stubs below answer chatJson with plan JSON
 * instead of create_job tool calls, and refusals surface as tool_result
 * errors emitted by the run engine's validatePlan.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

// The agent's opt-in seam consumes license-gate's hasCurrentOptIn - WS3
// exports it from there; the test supplies the real check (same table +
// version contract) until the owner file lands.
vi.mock("@/lib/catalog/license-gate", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/lib/catalog/license-gate")>();
  return {
    ...m,
    hasCurrentOptIn: async (userId: string) => {
      const { sql } = await import("@/db");
      const { LICENSE_VERSION } = await import("@/lib/catalog/licenses");
      const rows = await sql<{ version: string }>(
        `SELECT version FROM license_optins WHERE user_id = $1`, [userId]);
      return rows[0]?.version === LICENSE_VERSION;
    },
  };
});
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "@/db";

beforeAll(() => {
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws2-modes-"));
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

describe("[OF-0595] offline session mode", () => {
  it("a remote-route LLM gets 0 requests; the notice text is shown; via is recorded", async () => {
    process.env.LLM_BASE_URL = "https://api.example.com/v1";
    process.env.LLM_MODEL = "m";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await makeUser("u-mode-1");
    const { createSession, postUserMessage, getMessages } = await import("@/lib/agent");
    const s = await createSession("u-mode-1");
    await postUserMessage("u-mode-1", s.id, "make a video of a neon city at night", [], "offline");

    // the wire call was refused before any network work
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes("api.example.com"))).toHaveLength(0);

    const msgs = await getMessages(s.id) as { kind: string; content: Record<string, unknown> }[];
    const bodies = msgs.map((m) => m.content as { text?: string; question?: string; via?: string });
    expect(bodies.some((c) => c.text === "offline: using the built-in planner")).toBe(true);
    expect(bodies.some((c) => c.via === "built-in planner")).toBe(true);
    // the fallback still planned a real run+job on an open endpoint
    const rows = await sql<{ endpoint_id: string }>(`SELECT endpoint_id FROM jobs WHERE user_id = $1`, ["u-mode-1"]);
    expect(rows.some((r) => r.endpoint_id === "motionfield/wan-2.1/text-to-video")).toBe(true);
    const runs = await sql(`SELECT id FROM agent_runs WHERE user_id = $1`, ["u-mode-1"]);
    expect(runs).toHaveLength(1);
  }, 30000);
});

/** The wire fields the assertions actually read - parsed JSON, typed to the
 *  OpenAI/ollama chat shape rather than `any`. */
type WireReq = {
  messages?: { role?: string; content?: unknown }[];
};
type StubReq = { path: string; body: WireReq };

/** first captured chat request's system prompt (the endpoint listing lives there) */
function chatReads(reqs: StubReq[]) {
  const chat = reqs.find((r) => r.path === "/v1/chat/completions" || r.path === "/api/chat");
  return { sysPrompt: String(chat?.body.messages?.[0]?.content ?? "") };
}

/** Endpoint ids the planner was allowed to name - only the listing section,
 *  never the rules prose (which cites endpoint ids as examples). */
function listedEndpoints(sysPrompt: string): string[] {
  const listing = sysPrompt.split(/\nRules:/)[0];
  return [...new Set(listing.match(/motionfield\/[\w.-]+\/[\w.-]+/g) ?? [])];
}

const planOf = (endpointId: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  title: "stub plan",
  steps: [{ id: "s1", title: "step", endpoint_id: endpointId, params, depends_on: [], ...extra }],
});

/** LLM stub: every chat call replies `plan` as JSON (or the plain text
 *  "done" when plan is undefined - exercises the chatJson repair/failure
 *  path). Every request is recorded. */
function stubPlanner(wire: "ollama" | "openai", plan?: unknown) {
  const reqs: StubReq[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) as WireReq : {};
      reqs.push({ path: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      const content = plan === undefined ? "done" : JSON.stringify(plan);
      if (wire === "ollama") res.end(JSON.stringify({ message: { content } }));
      else res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return { server, reqs };
}

async function listen(server: http.Server) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

describe("planner endpoint allowlist", () => {
  it("offers no restricted endpoint and no ltx '- fast' line to a user without opt-in", async () => {
    const { server, reqs } = stubPlanner("openai");
    const port = await listen(server);
    process.env.LLM_PROVIDER = "custom";
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.LLM_MODEL = "m";
    try {
      await makeUser("u-allow-1");
      const { createSession, postUserMessage } = await import("@/lib/agent");
      const s = await createSession("u-allow-1");
      await postUserMessage("u-allow-1", s.id, "make a video of a neon city at night");

      const { sysPrompt } = chatReads(reqs);
      expect(sysPrompt.length).toBeGreaterThan(0);
      const listed = listedEndpoints(sysPrompt);
      expect(listed.length).toBeGreaterThan(0);

      const { findEndpoint } = await import("@/lib/catalog/video-models");
      const { endpointLicense } = await import("@/lib/catalog/license-gate");
      for (const id of listed) {
        const found = findEndpoint(id);
        expect(found, `listed id ${id} not in catalog`).toBeTruthy();
        expect(endpointLicense(found!.workflow).class, `listed id ${id} is not open`).toBe("open");
      }
      // ws3: the director endpoint is open (Wan VACE) - it may be listed; the
      // restricted check above is what keeps ltx/lens out without opt-in
      expect(listed.some((id) => /ltx|lens/.test(id))).toBe(false);
      // no ltx line may carry the "- fast" hint the prompt tells the model to prefer
      expect(sysPrompt).not.toMatch(/ltx[^\n]*[-\u2014]\s*fast/);
      expect(sysPrompt).not.toContain("ltx-video");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30000);

  it("a plan naming a restricted endpoint creates 0 jobs and 0 plan messages", async () => {
    const { server } = stubPlanner("openai", planOf("motionfield/ltx-video/text-to-video", { prompt: "a neon city" }));
    const port = await listen(server);
    process.env.LLM_PROVIDER = "custom";
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.LLM_MODEL = "m";
    try {
      await makeUser("u-allow-2");
      const { createSession, postUserMessage, getMessages } = await import("@/lib/agent");
      const s = await createSession("u-allow-2");
      await postUserMessage("u-allow-2", s.id, "make a video of a neon city at night");

      const jobs = await sql(`SELECT id FROM jobs WHERE user_id = $1`, ["u-allow-2"]);
      expect(jobs).toHaveLength(0);
      const runs = await sql(`SELECT id FROM agent_runs WHERE user_id = $1`, ["u-allow-2"]);
      expect(runs).toHaveLength(0);
      const msgs = await getMessages(s.id) as { kind: string; content: Record<string, unknown> }[];
      expect(msgs.filter((m) => m.kind === "plan")).toHaveLength(0);
      const err = msgs.find((m) => m.kind === "tool_result" && typeof m.content.error === "string");
      expect(String(err?.content.error ?? "")).toMatch(/opt-in|isn't available/i);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30000);

  it("an offline turn naming a heavy endpoint creates 0 jobs", async () => {
    const { server } = stubPlanner("ollama", planOf("motionfield/wan-2.1/image-to-video", {
      prompt: "a neon city", image_url: "/files/a.png",
    }));
    const port = await listen(server);
    process.env.LLM_PROVIDER = "ollama";
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.LLM_MODEL = "m";
    try {
      await makeUser("u-allow-3");
      const { createSession, postUserMessage, getMessages } = await import("@/lib/agent");
      const s = await createSession("u-allow-3");
      await postUserMessage("u-allow-3", s.id, "make a video of a neon city at night", [], "offline");

      const jobs = await sql(`SELECT id FROM jobs WHERE user_id = $1`, ["u-allow-3"]);
      expect(jobs).toHaveLength(0);
      const msgs = await getMessages(s.id) as { kind: string; content: Record<string, unknown> }[];
      const err = msgs.find((m) => m.kind === "tool_result" && typeof m.content.error === "string");
      expect(String(err?.content.error ?? "")).toMatch(/offline/i);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30000);
});

describe("persisted offline pref", () => {
  it("applies to the very next turn even when the session is in Auto mode", async () => {
    process.env.LLM_BASE_URL = "https://api.example.com/v1";
    process.env.LLM_MODEL = "m";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await makeUser("u-pref-1");
    const { setPrefs } = await import("@/lib/llm/settings");
    await setPrefs("u-pref-1", true); // OFF - saved before the session exists

    const { createSession, postUserMessage } = await import("@/lib/agent");
    const s = await createSession("u-pref-1", { mode: "auto" });
    await postUserMessage("u-pref-1", s.id, "make a video of a neon city at night");

    // the remote route got 0 requests - the pref rode the turn anyway
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes("api.example.com"))).toHaveLength(0);
    const jobs = await sql(`SELECT endpoint_id FROM jobs WHERE user_id = $1`, ["u-pref-1"]);
    expect(jobs.length).toBeGreaterThan(0); // fallback still produced real work
  }, 30000);

  it("a session created under the pref starts in Offline mode", async () => {
    await makeUser("u-pref-2");
    const { setPrefs } = await import("@/lib/llm/settings");
    await setPrefs("u-pref-2", true);
    const { createSession } = await import("@/lib/agent");
    const s = await createSession("u-pref-2");
    expect((s.context as { mode?: string }).mode).toBe("offline");
  });
});

describe("restricted endpoints + opt-in", () => {
  it("a param picking ltx is refused with opt-in wording and no plan/run rows", async () => {
    // explainer's own endpoint is open - the refusal must come from the PARAM
    const { server } = stubPlanner("openai", planOf("motionfield/explainer/video",
      { prompt: "an explainer about tide pools", motion_model: "ltx" }));
    const port = await listen(server);
    process.env.LLM_PROVIDER = "custom";
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.LLM_MODEL = "m";
    try {
      await makeUser("u-opt-1");
      const { createSession, postUserMessage, getMessages } = await import("@/lib/agent");
      const s = await createSession("u-opt-1");
      await postUserMessage("u-opt-1", s.id, "make an explainer about tide pools");

      const msgs = await getMessages(s.id) as { kind: string; content: Record<string, unknown> }[];
      const err = msgs.find((m) => m.kind === "tool_result" && typeof m.content.error === "string");
      expect(String(err?.content.error ?? "")).toMatch(/opt-in/i);
      const jobs = await sql(`SELECT id FROM jobs WHERE user_id = $1`, ["u-opt-1"]);
      expect(jobs).toHaveLength(0);
      const runs = await sql(`SELECT id FROM agent_runs WHERE user_id = $1`, ["u-opt-1"]);
      expect(runs).toHaveLength(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30000);

  it("with an opt-in row the ltx endpoint appears tagged and submits", async () => {
    const { server, reqs } = stubPlanner("openai", planOf("motionfield/ltx-video/text-to-video", { prompt: "a neon city" }));
    const port = await listen(server);
    process.env.LLM_PROVIDER = "custom";
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.LLM_MODEL = "m";
    try {
      await makeUser("u-opt-2");
      const { LICENSE_VERSION } = await import("@/lib/catalog/licenses");
      await sql(`INSERT INTO license_optins (user_id, version) VALUES ($1,$2)`, ["u-opt-2", LICENSE_VERSION]);

      const { createSession, postUserMessage } = await import("@/lib/agent");
      const s = await createSession("u-opt-2");
      await postUserMessage("u-opt-2", s.id, "make a video of a neon city at night");

      const { sysPrompt } = chatReads(reqs);
      const listed = listedEndpoints(sysPrompt);
      expect(listed).toContain("motionfield/ltx-video/text-to-video");
      expect(sysPrompt).toMatch(/ltx[^\n]*- restricted \(opt-in\)/);
      // re-edit stays out even for opted-in users
      expect(listed).not.toContain("motionfield/re-edit/v1.0");

      const jobs = await sql<{ endpoint_id: string }>(`SELECT endpoint_id FROM jobs WHERE user_id = $1`, ["u-opt-2"]);
      expect(jobs.some((j) => j.endpoint_id === "motionfield/ltx-video/text-to-video")).toBe(true);
      const runs = await sql<{ status: string }>(`SELECT status FROM agent_runs WHERE user_id = $1`, ["u-opt-2"]);
      expect(runs.length).toBe(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30000);
});
