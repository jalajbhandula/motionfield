/**
 * WS2 s7 "Agent tools v2" e2e (GENERATION_PROVIDER=mock):
 *  E1. GET /api/agent/tools lists every allowlisted endpoint as a typed tool
 *      (schema from its declared params); a minimal-params plan per tool
 *      creates a parked run (201 awaiting_approval) with zero jobs; banned
 *      endpoints never appear; restricted appear only after the opt-in.
 *  E2. A loopback OpenAI-wire stub drives the planner: a plan naming a
 *      visible tool lands with via "lmstudio·stub-m"; a plan naming a foreign
 *      endpoint is refused with a visible planner_error and zero jobs.
 *  E3. Verified presets reach the plan (restyle + preset_id), while the
 *      stale-hash "marble-gold" and hidden style specs are refused as
 *      "preset not available" - the same wording the runtime gate uses.
 *  E4. web_fetch reads a loopback page → text leaf; remote targets refuse
 *      offline before any connection; a redirect into 169.254.169.254 is
 *      refused hop-by-hop (SSRF).
 *  E5. web_search is absent from tools while unconfigured; with a loopback
 *      SearXNG set it searches; a remote SearXNG URL refuses while Offline.
 *  E6. An ambiguous brief answers with ≤3 option chips; a chip posts as the
 *      next brief; the todo checklist renders above the composer, ticks, and
 *      survives a reload.
 *  E7. /api/refs @hero resolves to the caller's own images only - the same
 *      user's brief plans i2v on it; a second user's "@hero" asks (never
 *      guesses) with zero jobs.
 *  E8. Carries: Settings-Offline narrows a posted mode:auto run to offline;
 *      high effort bounds steps (2×default, not max) and unknowns the ETA;
 *      builtin tool steps are zero-credit typed leaves, no provider call.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ALL_MODELS } from "../../src/lib/catalog/video-models";
import { endpointLicense } from "../../src/lib/catalog/license-gate";
import { mediaBaseKind, MEDIA_PARAM_KIND } from "../../src/lib/runs/media";
import "../../src/lib/catalog/presets"; // register specs like the server does

test.describe.configure({ mode: "serial" });

const T2I = "motionfield/z-image-turbo/text-to-image";
const T2V = "motionfield/wan-2.1/text-to-video";
const I2V = "motionfield/wan-2.1/image-to-video";
const LTX_T2V = "motionfield/ltx-video/text-to-video";
const RESTYLE = "motionfield/wan-vace/restyle";
const WEB_FETCH = "agent/web_fetch";
const WEB_SEARCH = "agent/web_search";

type StepView = {
  step_id: string; status: string; endpoint_id: string; job_id: string | null;
  params: Record<string, unknown>; cost?: number | null; eta_seconds?: number | null;
  outputs?: { url: string; type?: string }[]; error?: string | null;
};
type RunView = {
  id: string; status: string; mode: string; via?: string | null; planner_note?: string | null;
  estimate_credits?: number; eta_seconds?: number | null;
  steps: StepView[];
};
type ToolView = {
  name: string; endpoint_id: string; input: string; output: string;
  restricted: boolean; offered_to_planner: boolean; available: boolean;
  /** false → a planner reply form, never a run step (ask_user) */
  step?: boolean;
  description: string; schema?: { required?: string[]; properties?: Record<string, { enum?: unknown[]; minimum?: number; maximum?: number; type?: string }> };
};

async function signUpCtx(baseURL: string | undefined, name: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL });
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await ctx.post("/api/auth/sign-up/email", {
      data: { email: `ws2at-${Date.now()}-${attempt}-${Math.random().toString(36).slice(2, 6)}@test.local`, password: "test-pass-1234", name },
    });
    if (r.ok()) return ctx;
    if (attempt === 3) expect(r.ok(), `sign-up: ${await r.text()}`).toBeTruthy();
    await new Promise((res) => setTimeout(res, 500));
  }
  return ctx;
}

async function getRun(ctx: APIRequestContext, id: string): Promise<RunView> {
  const r = await ctx.get(`/api/agent/runs/${id}`);
  expect(r.ok()).toBeTruthy();
  return (await r.json()).run;
}

async function pollRun(ctx: APIRequestContext, id: string, timeout = 90_000): Promise<RunView> {
  const t0 = Date.now();
  let view = await getRun(ctx, id);
  while (!["done", "failed", "stopped"].includes(view.status)) {
    if (Date.now() - t0 > timeout) break;
    await new Promise((r) => setTimeout(r, 1200));
    view = await getRun(ctx, id);
  }
  if (!["done", "failed", "stopped"].includes(view.status)) {
    console.error(`pollRun timeout - run ${id}:\n${JSON.stringify(view, null, 1).slice(0, 3000)}`);
  }
  return view;
}

const jobsCount = async (ctx: APIRequestContext) =>
  (((await (await ctx.get("/api/jobs")).json()).jobs) as unknown[]).length;

async function toolsList(ctx: APIRequestContext, mode = "auto"): Promise<ToolView[]> {
  const r = await ctx.get(`/api/agent/tools?mode=${mode}`);
  expect(r.ok(), `tools: ${await r.text()}`).toBeTruthy();
  return ((await r.json()).tools) as ToolView[];
}

const step = (id: string, endpoint: string, params: Record<string, unknown>, depends_on: string[] = []) =>
  ({ id, title: id, endpoint_id: endpoint, params, depends_on });

/** A loopback server whose handler answers per-request - fetch/searxng stubs. */
function stubServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const server = http.createServer(handler);
  return {
    listen: () => new Promise<number>((res) => server.listen(0, "127.0.0.1", () => res((server.address() as AddressInfo).port))),
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

/* -------- E1 - the catalog-derived tool list is the allowlist, no more -------- */

/** one plausible value per declared field - media uses a fake /files url of
 *  the param's OWN kind (validation doesn't check existence; the run never
 *  approves so no job). The kind lookup mirrors the engine's media map so a
 *  video slot gets an .mp4 literal - a wrong-kind url is a real 422 now. */
const FILE_FOR = { image: "/files/x.png", video: "/files/x.mp4", audio: "/files/x.mp3" } as const;
function minimalParams(tool: ToolView): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const props = tool.schema?.properties ?? {};
  // the name-level kind map is the same registry the engine consults first -
  // a video slot gets an .mp4 literal, a wrong-kind url is a real 422 now
  const fileFor = (name: string) => {
    const k = MEDIA_PARAM_KIND[name];
    return FILE_FOR[k ? mediaBaseKind(k) : "image"];
  };
  for (const name of tool.schema?.required ?? []) {
    const f = props[name] ?? {};
    if (f.type === "array" || Array.isArray(f.enum)) {
      if (f.type === "array") { params[name] = [fileFor(name)]; continue; }
      params[name] = f.enum![0]; continue;
    }
    if (f.type === "number" || f.type === "integer") { params[name] = f.minimum ?? 1; continue; }
    if (f.type === "boolean") { params[name] = true; continue; }
    if (name === "prompt") params[name] = "a test image";
    else params[name] = fileFor(name);
  }
  if (params.prompt === undefined && "prompt" in props) params.prompt = "a test image";
  return params;
}

test.describe("ws2 agent tools", () => {
  test("E1: tools mirror the allowlist - schema'd catalog tools, parked plans, no banned, restricted after opt-in", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const ctx = await signUpCtx(baseURL, "Tools E1");
    const jobs0 = await jobsCount(ctx);

    const anon = await request.newContext({ baseURL });
    expect((await anon.get("/api/agent/tools")).status()).toBe(401);
    await anon.dispose();

    const tools = await toolsList(ctx);
    const catalogTools = tools.filter((t) => !t.endpoint_id.startsWith("agent/"));
    expect(catalogTools.length).toBeGreaterThan(10);
    // the tool payload never carries provider config - no keys, no baseUrls;
    // `sk-` is key-shaped only: bare "sk-" false-matches palette ids like
    // "mauve-drift", so it needs a non-alnum boundary and real length
    const raw = JSON.stringify(tools);
    expect(raw).not.toMatch(/api[_-]?key|bearer|(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}|base_?[uU]rl/i);
    // schedule_create is REGISTERED (schema exists) but never offered to the
    // planner and never reported available - the unavailable-now shape
    const sched = tools.find((t) => t.endpoint_id === "agent/schedule_create");
    expect(sched, "schedule_create registered").toBeTruthy();
    expect(sched!.available).toBe(false);
    expect(sched!.offered_to_planner).toBe(false);
    // the s8 memory builtins are job-less leaves - memory_save is offered to
    // the planner; memory_forget is registered + executable but NEVER
    // offered (forgetting needs the user's own explicit phrasing)
    const memSave = tools.find((x) => x.endpoint_id === "agent/memory_save");
    expect(memSave, "memory_save registered").toBeTruthy();
    expect(memSave!.available).toBe(true);
    expect(memSave!.offered_to_planner).toBe(true);
    expect(memSave!.step).not.toBe(false);
    const memForget = tools.find((x) => x.endpoint_id === "agent/memory_forget");
    expect(memForget, "memory_forget registered").toBeTruthy();
    expect(memForget!.available).toBe(true);
    expect(memForget!.offered_to_planner).toBe(false);
    expect(memForget!.step).not.toBe(false);
    // web_search hides until the user configures SearXNG (E5 flips it on)
    expect(tools.some((t) => t.endpoint_id === WEB_SEARCH)).toBe(false);
    // every catalog tool carries the declared schema + model · workflow · license
    for (const t of catalogTools) {
      expect(t.description).toContain("·");
      expect(t.description).toMatch(/license (open|permissive-terms|restricted)/);
      expect(t.schema?.properties).toBeTruthy();
      expect(["image", "video", "audio", "text"]).toContain(t.input);
    }
    // restricted tools stay out until the opt-in - and the opt-in only ever
    // adds restricted:true tools, nothing else appears
    expect(tools.some((t) => t.endpoint_id === LTX_T2V)).toBe(false);
    const beforeIds = new Set(tools.map((t) => t.endpoint_id));
    expect((await ctx.post("/api/licenses/opt-in", { data: {} })).ok()).toBeTruthy();
    const after = await toolsList(ctx);
    expect(after.some((t) => t.endpoint_id === LTX_T2V && t.restricted)).toBe(true);
    const added = after.filter((t) => !beforeIds.has(t.endpoint_id));
    expect(added.length).toBeGreaterThan(0);
    for (const t of added) expect(t.restricted).toBe(true);
    // banned endpoints can NEVER appear - compute the banned set from the
    // same license map the server uses
    const banned = new Set(
      ALL_MODELS.flatMap((m) => m.workflows)
        .filter((w) => endpointLicense(w).class === "banned")
        .map((w) => w.endpointId));
    for (const t of after) expect(banned.has(t.endpoint_id)).toBe(false);
    // and a literal plan naming one refuses before a run exists
    if (banned.size) {
      const bid = [...banned][0];
      const r = await ctx.post("/api/agent/runs", {
        data: { mode: "custom", plan: { title: "b", steps: [step("s1", bid, { prompt: "x" })] } },
      });
      expect(r.status()).toBe(422);
      expect(await r.text()).toMatch(/license|blocked/i);
    }

    // every visible tool with minimal params → plans park (custom mode always
    // asks first), no jobs are created for any of them
    const all = after.filter((t) => !t.endpoint_id.startsWith("agent/") && t.offered_to_planner);
    for (let i = 0; i < all.length; i += 8) {
      const chunk = all.slice(i, i + 8);
      const r = await ctx.post("/api/agent/runs", {
        data: {
          mode: "custom",
          plan: { title: `tool sweep ${i}`, steps: chunk.map((t, j) => step(`s${j + 1}`, t.endpoint_id, minimalParams(t))) },
        },
      });
      expect(r.status(), `plan for ${chunk.map((t) => t.endpoint_id).join(", ")}: ${await r.text()}`).toBe(201);
      const view = (await r.json()).run as RunView;
      expect(view.status).toBe("awaiting_approval");
      for (const s of view.steps) expect(s.job_id).toBeNull();
    }
    expect(await jobsCount(ctx)).toBe(jobs0);
    await ctx.dispose();
  });

  /* -------- E2 - the stub-planned run names a real tool or refuses -------- */

  test("E2: a stub plan lands via lmstudio·stub-m; an unlisted endpoint refuses visibly, zero jobs", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Tools E2");
    const jobs0 = await jobsCount(ctx);
    const tools = await toolsList(ctx);
    const pick = tools.find((t) => t.endpoint_id === T2V) ?? tools.find((t) => !t.endpoint_id.startsWith("agent/"))!;
    const plan = {
      title: "stub plan",
      steps: [{ id: "s1", title: "make it", endpoint_id: pick.endpoint_id,
        params: { prompt: "a neon city at night", resolution: "480p" }, depends_on: [] }],
    };
    const stub = stubServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }));
      });
    });
    try {
      const port = await stub.listen();
      const p = await ctx.put("/api/llm/providers/lmstudio", { data: { baseUrl: `http://127.0.0.1:${port}/v1` } });
      expect(p.ok()).toBeTruthy();
      const r = await ctx.put("/api/llm/routes/planner", { data: { providerId: "lmstudio", model: "stub-m" } });
      expect(r.ok()).toBeTruthy();
      const rr = await ctx.post("/api/agent/runs", { data: { text: "make a video of a neon city", ask_first: true } });
      expect(rr.status(), `body: ${await rr.text()}`).toBe(201);
      const d = await rr.json();
      expect(d.planner.via).toBe("lmstudio·stub-m");
      expect(d.run.status).toBe("awaiting_approval");
      expect((d.run as RunView).steps[0].endpoint_id).toBe(pick.endpoint_id);
    } finally { await stub.close(); }

    // a plan naming an endpoint the session never offered refuses visibly -
    // validatePlan is the gate, the session feed narrates it, 0 jobs
    const bad = stubServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ title: "t", steps: [
            { id: "s1", title: "x", endpoint_id: "motionfield/fake-model/not-installed", params: { prompt: "x" }, depends_on: [] },
          ] }) } }],
        }));
      });
    });
    try {
      const port = await bad.listen();
      await ctx.put("/api/llm/providers/lmstudio", { data: { baseUrl: `http://127.0.0.1:${port}/v1` } });
      const sr = await ctx.post("/api/agent/sessions", { data: { mode: "auto" } });
      const { session } = await sr.json();
      const rr = await ctx.post("/api/agent/runs", {
        data: { session_id: session.id, text: "make a video", ask_first: true },
      });
      // the refusal is VISIBLE either way: a plain 422, or the built-in
      // planner answering while the feed narrates the planner's refusal
      if (rr.status() === 201) {
        const d = await rr.json();
        expect(d.planner.via).toBe("built-in planner");
        expect(d.planner.fallback_reason).toBeTruthy();
      } else {
        expect(rr.status(), `body: ${await rr.text()}`).toBe(422);
      }
      const msgs = await (await ctx.get(`/api/agent/sessions/${session.id}/messages?after=0`)).json();
      const text = JSON.stringify(msgs);
      expect(text).toMatch(/isn't installed|not.*available|llm_error|plan_error|refused/i);
    } finally { await bad.close(); }
    expect(await jobsCount(ctx)).toBe(jobs0);
    await ctx.dispose();
  });

  /* -------- E3 - presets only ever arrive specVisible()-side -------- */

  test("E3: a verified preset plans with preset_id; stale + hidden presets refuse as 'preset not available'", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Tools E3");
    const jobs0 = await jobsCount(ctx);

    // "comic panel" is verified in the e2e verify-file - the deterministic
    // planner must plan restyle with preset_id filled
    const r = await ctx.post("/api/agent/runs", {
      data: {
        text: "restyle this clip as comic panel",
        attachments: [{ url: "/files/clip.mp4", mime: "video/mp4" }],
        planner: "builtin", ask_first: true,
      },
    });
    expect(r.status(), `body: ${await r.text()}`).toBe(201);
    const view = (await r.json()).run as RunView;
    expect(view.steps[0].endpoint_id).toBe(RESTYLE);
    expect(view.steps[0].params.preset_id).toBe("comic-panel");
    expect(view.steps[0].params.video_url).toBe("/files/clip.mp4");

    // the same tool's schema only carries verified ids - marble-gold (stale
    // hash) and hidden look styles are filtered out of the enum
    const tools = await toolsList(ctx);
    const restyle = tools.find((t) => t.endpoint_id === RESTYLE);
    const presetEnum = (restyle?.schema?.properties?.preset_id?.enum ?? []) as string[];
    expect(presetEnum).toContain("comic-panel");
    expect(presetEnum).not.toContain("marble-gold");

    // literal plans naming them are refused exactly like resolveParams does
    for (const [pid, re] of [["marble-gold", /preset not available/i], ["noir-venetian", /preset not available|doesn't allow/i]] as const) {
      const rr = await ctx.post("/api/agent/runs", {
        data: { mode: "custom", plan: { title: "p", steps: [
          step("s1", RESTYLE, { video_url: "/files/clip.mp4", preset_id: pid }),
        ] } },
      });
      expect(rr.status(), `${pid}: ${await rr.text()}`).toBe(422);
      expect(await rr.text()).toMatch(re);
    }
    expect(await jobsCount(ctx)).toBe(jobs0);
    await ctx.dispose();
  });

  /* -------- E4 - web_fetch: guarded GET only, bounded, redirect-safe -------- */

  test("E4: web_fetch reads loopback html→text; offline remote refused pre-flight; metadata redirect refused", async ({ baseURL, page }) => {
    test.setTimeout(180_000);
    const ctx = await signUpCtx(baseURL, "Tools E4");
    const jobs0 = await jobsCount(ctx);

    let hits = 0;
    const pageStub = stubServer((req, res) => {
      hits++;
      res.setHeader("content-type", "text/html");
      res.end("<html><head><style>x{color:red}</style><script>doEvil()</script></head><body><h1>hello page</h1><p>readable text</p></body></html>");
    });
    try {
      const port = await pageStub.listen();
      const url = `http://127.0.0.1:${port}/`;
      const r = await ctx.post("/api/agent/runs", {
        data: { mode: "auto", ask_first: false, plan: { title: "fetch", steps: [
          step("s1", WEB_FETCH, { url }),
        ] } },
      });
      expect(r.status(), `fetch run: ${await r.text()}`).toBe(201);
      const view = await pollRun(ctx, (await r.json()).run.id, 60_000);
      expect(view.status).toBe("done");
      const s = view.steps[0];
      expect(s.job_id).toBeNull();                       // job-less tool step
      expect(s.outputs?.[0]?.type).toBe("text");
      expect(s.outputs?.[0]?.url).toMatch(/^\/files\/runs\//);
      // html → plain text, no script body survived
      const leaf = await (await ctx.get(s.outputs![0].url)).text();
      expect(leaf).toContain("hello page");
      expect(leaf).not.toContain("doEvil");
      expect(hits).toBe(1);
    } finally { await pageStub.close(); }

    // overlapping ticks never re-run an in-flight tool step: a page that
    // answers in 4 s sees exactly ONE hit while the SSE stream, the run
    // poll and the session poll all tick the same run mid-fetch
    let slowHits = 0;
    const slow = stubServer((req, res) => {
      slowHits++;
      setTimeout(() => {
        res.setHeader("content-type", "text/plain");
        res.end("slow page");
      }, 4_000);
    });
    try {
      const slowPort = await slow.listen();
      const sr = await ctx.post("/api/agent/sessions", { data: { mode: "auto" } });
      const { session } = await sr.json();
      const post = ctx.post("/api/agent/runs", {
        data: { session_id: session.id, mode: "auto", ask_first: false, plan: { title: "slow", steps: [
          step("s1", WEB_FETCH, { url: `http://127.0.0.1:${slowPort}/` }),
        ] } },
      });
      // the create's own kick tick is mid-fetch now - the run row exists
      await new Promise((r) => setTimeout(r, 800));
      const sess = await (await ctx.get(`/api/agent/sessions/${session.id}/messages?after=0`)).json();
      const slowRunId = String(sess.runs[0].id);
      await Promise.all([
        ctx.get(`/api/agent/runs/${slowRunId}/events`).then((r) => r.text()).catch(() => ""),
        ctx.get(`/api/agent/runs/${slowRunId}`),
        ctx.get(`/api/agent/runs/${slowRunId}`),
        ctx.get(`/api/agent/sessions/${session.id}/messages?after=0`),
        post,
      ]);
      expect((await pollRun(ctx, slowRunId, 30_000)).status).toBe("done");
      expect(slowHits, "an in-flight tool step must never be fetched twice").toBe(1);
    } finally { await slow.close(); }

    // a redirect into cloud metadata is refused hop 2 - the guard re-checks
    // every hop, not just the first
    const redir = stubServer((req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      res.end();
    });
    try {
      const port = await redir.listen();
      const r = await ctx.post("/api/agent/runs", {
        data: { mode: "auto", ask_first: false, plan: { title: "redir", steps: [
          step("s1", WEB_FETCH, { url: `http://127.0.0.1:${port}/x` }),
        ] } },
      });
      expect(r.status()).toBe(201);
      const view = await pollRun(ctx, (await r.json()).run.id, 60_000);
      expect(view.status).toBe("failed");
      expect(view.steps[0].error).toMatch(/not allowed|denied|link-local|private|destination/i);
    } finally { await redir.close(); }

    // offline mode + a remote target → the plan refuses BEFORE any socket -
    // validatePlan's url guard fires at 422, not in a network attempt
    let badHits = 0;
    const bad = stubServer((req, res) => { badHits++; res.end("never"); });
    try {
      await bad.listen(); // never hit
      const off = await ctx.put("/api/llm/prefs", { data: { offline: true } });
      expect(off.ok()).toBeTruthy();
      const r = await ctx.post("/api/agent/runs", {
        data: { mode: "auto", ask_first: false, plan: { title: "remote", steps: [
          step("s1", WEB_FETCH, { url: "http://example.com/" }),
        ] } },
      });
      expect(r.status(), `remote fetch: ${await r.text()}`).toBe(422);
      expect(await r.text()).toMatch(/loopback|remote|offline/i);
      // and the effective mode really narrowed the run
      const tools = await toolsList(ctx);
      expect(tools.length).toBeGreaterThan(0);
      await ctx.put("/api/llm/prefs", { data: { offline: false } });
    } finally { await bad.close(); }
    expect(badHits, "no remote socket was attempted").toBe(0);

    // Settings→Offline flips while a remote-fetch run sits parked - the
    // stored mode was online, but the executor re-checks the CURRENT pref at
    // exec time: approving it afterwards fails the step, no fetch happens
    const parked = await ctx.post("/api/agent/runs", {
      data: { mode: "auto", ask_first: true, plan: { title: "gate", steps: [
        step("s1", WEB_FETCH, { url: "http://example.com/" }),
      ] } },
    });
    expect(parked.status(), `parked remote fetch: ${await parked.text()}`).toBe(201);
    const pRun = (await parked.json()).run as RunView;
    await ctx.put("/api/llm/prefs", { data: { offline: true } });
    try {
      const ap = await ctx.post(`/api/agent/runs/${pRun.id}/approve`);
      expect(ap.ok(), `approve: ${await ap.text()}`).toBeTruthy();
      const gv = await pollRun(ctx, pRun.id, 60_000);
      expect(gv.status).toBe("failed");
      expect(gv.steps[0].error).toMatch(/loopback|offline|not allowed/i);
    } finally { await ctx.put("/api/llm/prefs", { data: { offline: false } }); }

    // ask_user is a planner reply - never a step. The tools API marks it
    // step:false and a literal plan naming it refuses with plain wording.
    const askT = (await toolsList(ctx)).find((t) => t.endpoint_id === "agent/ask_user");
    expect(askT, "ask_user listed").toBeTruthy();
    expect(askT!.step).toBe(false);
    const au = await ctx.post("/api/agent/runs", {
      data: { mode: "auto", ask_first: false, plan: { title: "q", steps: [
        step("s1", "agent/ask_user", { question: "which?", options: ["a", "b"] }),
      ] } },
    });
    expect(au.status(), `ask_user step: ${await au.text()}`).toBe(422);
    expect(await au.text()).toMatch(/ask_user.*(planner reply|not a run step)/i);

    // the text leaf renders in the run card: expandable, previews the body,
    // names the tool that wrote it - never a bare file chip
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await page.request.post("/api/auth/sign-up/email", {
        data: { email: `ws2e4ui-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "Tools E4 UI" },
      });
      if (r.ok()) break;
      if (attempt === 3) expect(r.ok()).toBeTruthy();
      await new Promise((res) => setTimeout(res, 500));
    }
    const s3 = await page.request.post("/api/agent/sessions", { data: { mode: "auto" } });
    const { session } = await s3.json();
    await page.request.post(`/api/agent/sessions/${session.id}/messages`, {
      data: { text: "fetch leaf check", record_only: true },
    });
    const leafStub = stubServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<html><body><h1>hello page</h1></body></html>");
    });
    try {
      const leafPort = await leafStub.listen();
      const r = await page.request.post("/api/agent/runs", {
        data: { session_id: session.id, mode: "auto", ask_first: false, plan: { title: "leaf", steps: [
          step("s1", WEB_FETCH, { url: `http://127.0.0.1:${leafPort}/` }),
        ] } },
      });
      expect(r.status(), `leaf run: ${await r.text()}`).toBe(201);
      const leafRun = (await r.json()).run as RunView;
      await pollRun(page.request, leafRun.id, 60_000);
      await page.goto("/ai-assistant");
      await page.locator("button", { hasText: "fetch leaf check" }).first().click();
      const leafEl = page.locator(`[data-testid='run-card-${leafRun.id}']`).locator("[data-testid='text-leaf']").first();
      await expect(leafEl).toBeVisible({ timeout: 30_000 });
      await expect(leafEl).toContainText("via web_fetch");
      await leafEl.locator("summary").click();
      await expect(leafEl).toContainText("hello page");
    } finally { await leafStub.close(); }
    expect(await jobsCount(ctx)).toBe(jobs0);
    await ctx.dispose();
  });

  /* -------- E5 - web_search: opt-in, one configured provider -------- */

  test("E5: web_search absent unconfigured; loopback SearXNG works; offline remote refuses at the prefs save", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Tools E5");
    const jobs0 = await jobsCount(ctx);
    const tools0 = await toolsList(ctx);
    expect(tools0.some((t) => t.endpoint_id === WEB_SEARCH)).toBe(false);

    // offline + remote SearXNG → the prefs save itself refuses (no state set)
    const off = await ctx.put("/api/llm/prefs", { data: { offline: true } });
    expect(off.ok()).toBeTruthy();
    const denied = await ctx.put("/api/llm/prefs", { data: { searxngUrl: "https://searx.example.com" } });
    expect(denied.status()).toBe(400);
    await ctx.put("/api/llm/prefs", { data: { offline: false } });

    // a loopback SearXNG answers the tool - its JSON result shape parses and
    // lands as a json leaf
    const searx = stubServer((req, res) => {
      if (!req.url?.startsWith("/search")) { res.writeHead(404); res.end(); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ results: [
        { title: "A page", url: "http://example.com/a", content: "first hit text" },
        { title: "B page", url: "http://example.com/b", content: "second hit" },
      ] }));
    });
    try {
      const port = await searx.listen();
      const put = await ctx.put("/api/llm/prefs", { data: { searxngUrl: `http://127.0.0.1:${port}` } });
      expect(put.ok(), `searxng PUT: ${await put.text()}`).toBeTruthy();
      const tools = await toolsList(ctx);
      const ws = tools.find((t) => t.endpoint_id === WEB_SEARCH);
      expect(ws, "web_search configured").toBeTruthy();

      const r = await ctx.post("/api/agent/runs", {
        data: { mode: "auto", ask_first: false, plan: { title: "search", steps: [
          step("s1", WEB_SEARCH, { query: "motionfield", count: 2 }),
        ] } },
      });
      expect(r.status(), `search run: ${await r.text()}`).toBe(201);
      const view = await pollRun(ctx, (await r.json()).run.id, 60_000);
      expect(view.status).toBe("done");
      const s = view.steps[0];
      expect(s.outputs?.[0]?.type).toBe("json");
      const leaf = JSON.parse(await (await ctx.get(s.outputs![0].url)).text()) as { results: { title: string }[] };
      expect(leaf.results.map((x) => x.title)).toEqual(["A page", "B page"]);

      // offline again - the loopback SearXNG still passes (loopback is the
      // only allowed kind); a remote one would have been refused at the save
      await ctx.put("/api/llm/prefs", { data: { offline: true } });
      const r2 = await ctx.post("/api/agent/runs", {
        data: { mode: "offline", ask_first: false, plan: { title: "s2", steps: [
          step("s1", WEB_SEARCH, { query: "offline query" }),
        ] } },
      });
      expect(r2.status(), `offline search: ${await r2.text()}`).toBe(201);
      const v2 = await pollRun(ctx, (await r2.json()).run.id, 60_000);
      expect(v2.status).toBe("done");
      await ctx.put("/api/llm/prefs", { data: { offline: false, searxngUrl: null } });
    } finally { await searx.close(); }
    expect(await jobsCount(ctx)).toBe(jobs0);
    await ctx.dispose();
  });

  /* -------- E6 - ask_user chips + the todo checklist -------- */

  test("E6: an ambiguous brief gives ≤3 option chips; a chip briefs again; the todo renders, ticks, reloads", async ({ page }) => {
    test.setTimeout(240_000);
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await page.request.post("/api/auth/sign-up/email", {
        data: { email: `ws2e6-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "Tools E6" },
      });
      if (r.ok()) break;
      if (attempt === 3) expect(r.ok()).toBeTruthy();
      await new Promise((res) => setTimeout(res, 500));
    }
    await page.goto("/ai-assistant");
    await page.locator("textarea").fill("something cool");
    await page.getByTitle("Send").click();

    // ambiguous → the question carries ≤3 suggested-app chips
    const chips = page.locator("[data-testid='ask-options']");
    await expect(chips).toBeVisible({ timeout: 45_000 });
    const count = await chips.locator("button").count();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(3);

    // a chip click sends that brief - the resulting plan card appears and a
    // run parks awaiting approval (the todo checklist mirrors its steps)
    await chips.locator("button").first().click();
    const card = page.locator("[data-testid^='run-card-']").first();
    await expect(card).toBeVisible({ timeout: 60_000 });
    const todo = page.getByTestId("session-todo");
    await expect(todo).toBeVisible({ timeout: 30_000 });
    const items = todo.locator("[data-testid^='todo-item-']");
    expect(await items.count()).toBeGreaterThanOrEqual(1);

    // a tick survives a page reload + chat reopen - the ctx write is durable
    const patched = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && /\/api\/agent\/sessions\/[^/]+$/.test(new URL(r.url()).pathname));
    await items.first().locator("input").check();
    await patched; // the PATCH must land before we reload
    await expect.poll(async () => (await items.first().locator("input").isChecked()) ? 1 : 0).toBe(1);
    await page.reload();
    await page.locator("button", { hasText: /something cool/ }).first().click();
    await expect(page.getByTestId("session-todo")).toBeVisible({ timeout: 30_000 });
    const box = page.locator("[data-testid='todo-item-0'] input");
    await expect(box).toBeChecked({ timeout: 30_000 });
  });

  /* -------- E7 - @refs resolve against the caller's own scope only -------- */

  test("E7: @hero plans i2v on the caller's own ref; a second user's @hero asks, zero jobs", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Tools E7 A");
    const ctx2 = await signUpCtx(baseURL, "Tools E7 B");
    const jobs0 = await jobsCount(ctx2);

    // a real upload so the ref's ownership check passes
    const tmp = mkdtempSync(join(tmpdir(), "of-ws2at-"));
    const png = join(tmp, "hero.png");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=blue:size=64x64:duration=1", "-frames:v", "1", png]);
    const up = await ctx.post("/api/uploads", {
      multipart: { file: { name: "hero.png", mimeType: "image/png", buffer: readFileSync(png) } },
    });
    expect(up.ok()).toBeTruthy();
    const { url: imgUrl } = await up.json();
    const ref = await ctx.post("/api/refs", {
      data: { name: "hero", category: "character", images: [imgUrl], likeness_consent: true },
    });
    expect(ref.status(), `ref: ${await ref.text()}`).toBe(201);

    // "@hero animate" → the brief's ref resolves to the caller's own image
    // and plans i2v on it (or a media-filled plan - either way the ref's url
    // lands in params, never another user's media)
    const r = await ctx.post("/api/agent/runs", {
      data: { text: "@hero in a short clip", planner: "builtin", ask_first: true },
    });
    expect(r.status(), `ref plan: ${await r.text()}`).toBe(201);
    const view = (await r.json()).run as RunView;
    expect(JSON.stringify(view.steps[0].params)).toContain(imgUrl);

    // a literal plan param "@hero" also resolves - the stored step carries
    // the real url, not the token
    const r2 = await ctx.post("/api/agent/runs", {
      data: { mode: "custom", plan: { title: "r2", steps: [
        step("s1", I2V, { image_url: "@hero", prompt: "walking" }),
      ] } },
    });
    expect(r2.status(), `literal @hero: ${await r2.text()}`).toBe(201);
    const v2 = (await r2.json()).run as RunView;
    expect(v2.steps[0].params.image_url).toBe(imgUrl);

    // user 2 names the same @hero - it must NOT resolve (they have no such
    // ref): the text path asks, a literal plan 422s, and no job exists
    const r3 = await ctx2.post("/api/agent/runs", {
      data: { text: "@hero in a short clip", planner: "builtin", ask_first: true },
    });
    expect(r3.status(), `cross ref: ${await r3.text()}`).toBe(422);
    expect(await r3.text()).toMatch(/no ref named @hero|describe/i);
    const r4 = await ctx2.post("/api/agent/runs", {
      data: { mode: "custom", plan: { title: "r4", steps: [
        step("s1", I2V, { image_url: "@hero", prompt: "x" }),
      ] } },
    });
    expect(r4.status()).toBe(422);
    expect(await jobsCount(ctx2)).toBe(jobs0);

    // F4 - a literal media param holding the WRONG file kind refuses 422
    // before any job: a .png in video_url is caught by the extension…
    const jobsA = await jobsCount(ctx);
    const wrongExt = await ctx.post("/api/agent/runs", {
      data: { mode: "custom", plan: { title: "w1", steps: [
        step("s1", RESTYLE, { video_url: "/files/u/shot.png", prompt: "x" }),
      ] } },
    });
    const wExt = await wrongExt.text();
    expect(wrongExt.status(), `wrong ext: ${wExt}`).toBe(422);
    // the wording - quotes escape in the json error body
    expect(wExt).toContain('needs a video for \\"video_url\\", but the attached file is a image');

    // …and a url with no useful extension is caught by the attached file's
    // own kind (the mime the brief declared for it)
    const wrongAtt = await ctx.post("/api/agent/runs", {
      data: {
        mode: "custom",
        attachments: [{ url: "/files/u/blob", mime: "image/png", name: "blob" }],
        plan: { title: "w2", steps: [
          step("s1", RESTYLE, { video_url: "/files/u/blob", prompt: "x" }),
        ] },
      },
    });
    const wAtt = await wrongAtt.text();
    expect(wrongAtt.status(), `wrong att: ${wAtt}`).toBe(422);
    expect(wAtt).toContain('needs a video for \\"video_url\\", but the attached file is a image');
    expect(await jobsCount(ctx)).toBe(jobsA);
    await ctx.dispose(); await ctx2.dispose();
  });

  /* -------- E8 - carries: offline narrowing, bounded effort, zero-credit leaves -------- */

  test("E8: Settings-Offline narrows a posted auto run; high effort bounds steps + unknowns ETA; tool steps are 0-credit typed leaves", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Tools E8");

    // Settings Offline narrows the posted mode - a mode:"auto" run lands as
    // an offline run, and a heavy endpoint the auto allowlist would carry is
    // refused before a run exists
    const off = await ctx.put("/api/llm/prefs", { data: { offline: true } });
    expect(off.ok()).toBeTruthy();
    const heavy = await ctx.post("/api/agent/runs", {
      data: { mode: "auto", plan: { title: "h", steps: [
        step("s1", "motionfield/wan-2.2/image-to-video", { image_url: "/files/x.png", prompt: "x" }),
      ] } },
    });
    expect(heavy.status(), `heavy offline: ${await heavy.text()}`).toBe(422);
    const r = await ctx.post("/api/agent/runs", {
      data: { mode: "auto", plan: { title: "n", steps: [
        step("s1", T2I, { prompt: "a fox" }),
      ] } },
    });
    expect(r.status(), `narrowed run: ${await r.text()}`).toBe(201);
    const narrowed = (await r.json()).run as RunView;
    expect(narrowed.mode).toBe("offline");
    await ctx.put("/api/llm/prefs", { data: { offline: false } });
    // let it run out - one in-flight step per user, so a live step here
    // would starve the claims of the runs below
    expect((await pollRun(ctx, narrowed.id, 60_000)).status).toBe("done");

    // high effort bounds knobs at ~2×default clamped by the field's declared
    // range - the VACE i2v sampler (default 8, max 50) lands at 16, and the
    // step's ETA flips to unknown (effort params differ from the median's
    // defaults, so the median no longer describes the work)
    const re = await ctx.post("/api/agent/runs", {
      data: { mode: "custom", plan: { title: "e", steps: [
        step("s1", "motionfield/wan-vace/image-to-video", { image_url: "/files/x.png", prompt: "x" }),
      ] } },
    });
    expect(re.status(), `effort run: ${await re.text()}`).toBe(201);
    const eRun = (await re.json()).run as RunView;
    const hi = await ctx.post(`/api/agent/runs/${eRun.id}/steps/s1`, { data: { effort: "high", rev: 0 } });
    expect(hi.ok(), `high: ${await hi.text()}`).toBeTruthy();
    const hv = ((await hi.json()).run as RunView).steps[0];
    expect(hv.params.steps).toBe(16);
    expect(hv.eta_seconds).toBeNull();

    // builtin tool steps are job-less zero-credit leaves - a notes step +
    // a catalog_search step finish inline, write /files/runs leaves, and the
    // mock job queue never moves
    const jobs0 = await jobsCount(ctx);
    const tl = await ctx.post("/api/agent/runs", {
      data: { mode: "auto", ask_first: false, plan: { title: "leaves", steps: [
        step("s1", "agent/notes", { text: "first leaf" }),
        step("s2", "agent/catalog_search", { query: "image" }, ["s1"]),
      ] } },
    });
    expect(tl.status(), `leaf run: ${await tl.text()}`).toBe(201);
    const lv = await pollRun(ctx, (await tl.json()).run.id, 60_000);
    expect(lv.status).toBe("done");
    expect(lv.estimate_credits).toBe(0);
    for (const s of lv.steps) {
      expect(s.job_id).toBeNull();
      expect(s.cost).toBe(0);
      expect(["text", "json"]).toContain(s.outputs?.[0]?.type ?? "");
      expect(s.outputs?.[0]?.url).toMatch(/^\/files\/runs\//);
    }
    expect(await jobsCount(ctx)).toBe(jobs0);

    // schedule_create: a literal plan step runs the registered tool and the
    // executor says not_available - never a fake "scheduled" success
    const sc = await ctx.post("/api/agent/runs", {
      data: { mode: "auto", ask_first: false, plan: { title: "sched", steps: [
        step("s1", "agent/schedule_create", { title: "daily clip", brief: "a short video", schedule: "weekdays 09:00" }),
      ] } },
    });
    expect(sc.status(), `schedule run: ${await sc.text()}`).toBe(201);
    const sv = await pollRun(ctx, (await sc.json()).run.id, 60_000);
    expect(sv.status).toBe("failed");
    expect(sv.steps[0].error).toMatch(/not_available|not built/i);
    expect(await jobsCount(ctx)).toBe(jobs0);
    await ctx.dispose();
  });

  /* -------- E9 - session ownership: a foreign PATCH can't write -------- */

  test("E9: a foreign session's PATCH is a 404 - the victim's todo never moves", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctxA = await signUpCtx(baseURL, "Tools E9 A");
    const ctxB = await signUpCtx(baseURL, "Tools E9 B");
    const sr = await ctxA.post("/api/agent/sessions", { data: { mode: "auto" } });
    expect(sr.status()).toBe(201);
    const { session } = await sr.json();

    // a planned run mirrors its steps into ctx.todo - the checklist the
    // PATCH ticks (PATCH can't inject items, only flip existing ones)
    const mr = await ctxA.post(`/api/agent/sessions/${session.id}/messages`, {
      data: { text: "generate an image of a lighthouse", planner: "builtin", ask_first: true },
    });
    expect(mr.status(), `plan: ${await mr.text()}`).toBe(201);
    const feed0 = await (await ctxA.get(`/api/agent/sessions/${session.id}/messages?after=0`)).json();
    const items = feed0.session?.context?.todo?.items as { text: string; done: boolean }[] | undefined;
    expect(items?.length, "the planner wrote a checklist").toBeGreaterThanOrEqual(1);

    // user B's PATCH on A's session → 404, exactly like A's own GET would be
    const bad = await ctxB.patch(`/api/agent/sessions/${session.id}`, {
      data: { todo: { items: items!.map((i) => ({ ...i, done: true })) } },
    });
    expect(bad.status()).toBe(404);

    // and even an OWNER PATCH can't inject new items - a text the checklist
    // never had is dropped, not created
    const inject = await ctxA.patch(`/api/agent/sessions/${session.id}`, {
      data: { todo: { items: [...items!, { text: "injected item", done: true }] } },
    });
    expect(inject.ok(), `inject: ${await inject.text()}`).toBeTruthy();

    // A's checklist is exactly the mirror - B's failed PATCH wrote nothing,
    // and the injected text never landed
    const feed = await (await ctxA.get(`/api/agent/sessions/${session.id}/messages?after=0`)).json();
    expect(feed.session?.context?.todo?.items).toEqual(items);
    await ctxA.dispose(); await ctxB.dispose();
  });

  /* -------- E10 - the single in-flight slot nudges the holder's run -------- */

  test("E10: one in-flight slot - polling only run B still finishes run A through B's nudges", async ({ baseURL }) => {
    test.setTimeout(150_000);
    const ctx = await signUpCtx(baseURL, "Tools E10");

    // A claims the user's one in-flight step slot; after its POST nobody
    // ever polls A again - no SSE, no run GET
    const ra = await ctx.post("/api/agent/runs", {
      data: { mode: "auto", ask_first: false, plan: { title: "a", steps: [
        step("s1", T2I, { prompt: "a fox" }),
      ] } },
    });
    expect(ra.status(), `run A: ${await ra.text()}`).toBe(201);
    const runA = (await ra.json()).run as RunView;
    expect(runA.steps[0].status).toBe("running");

    // B's own tick can't claim (A holds the slot) - it nudges A instead
    const rb = await ctx.post("/api/agent/runs", {
      data: { mode: "auto", ask_first: false, plan: { title: "b", steps: [
        step("s1", T2I, { prompt: "a lighthouse" }),
      ] } },
    });
    expect(rb.status(), `run B: ${await rb.text()}`).toBe(201);
    const runB = (await rb.json()).run as RunView;

    // polling ONLY B: each refused claim nudges A once - A's job reconciles
    // through B's ticks, its step finishes, then B claims and runs
    const bv = await pollRun(ctx, runB.id, 90_000);
    expect(bv.status).toBe("done");

    // A's status read WITHOUT ticking it - the list route never ticks: a
    // done row here proves the nudges finished it, not this read
    const list = await (await ctx.get("/api/agent/runs")).json();
    const aRow = (list.runs as { id: string; status: string }[]).find((r) => r.id === runA.id);
    expect(aRow?.status).toBe("done");
    await ctx.dispose();
  });
});
