/**
 * WS2 s4 run engine e2e (GENERATION_PROVIDER=mock):
 *  1. ask-first session turn → plan card parked at awaiting_approval →
 *     approve releases the step job;
 *  2. over-cap estimate parks even without ask_first; approve is idempotent;
 *  3. refused plans answer 422 with plain wording and create nothing;
 *  4. sequential execution: step 2 only submits after step 1 is done and
 *     receives its $step output url verbatim;
 *  5. stop cancels the live job + every pending step; the run never resumes;
 *     mid-run, a done step keeps its charge and the canceled one refunds;
 *  6. ownership + auth: another user's run is invisible (404), anonymous is 401,
 *     and a malformed run id is a 404 not a uuid-column 500;
 *  7. the LLM planner (stubbed OpenAI wire via the Settings route) repairs one
 *     invalid reply into a run, and is refused plainly for restricted
 *     endpoints and dependency cycles - falling back to the built-in planner
 *     with a visible reason when the provider errors.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect, request, type APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const T2I = "motionfield/z-image-turbo/text-to-image";
const IMG2IMG = "motionfield/z-image-turbo/img2img";
const T2V = "motionfield/wan-2.1/text-to-video";
const I2V = "motionfield/wan-2.1/image-to-video";
const LTX = "motionfield/ltx-video/text-to-video";

type RunView = {
  id: string; status: string; estimate_credits: number; eta_seconds: number | null;
  steps: { step_id: string; status: string; endpoint_id: string; job_id: string | null;
           input_hash: string | null; outputs: { url: string; type: string }[]; error: string | null }[];
};

async function signUpCtx(baseURL: string | undefined, name: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL });
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await ctx.post("/api/auth/sign-up/email", {
      data: { email: `ws2run-${Date.now()}-${attempt}-${Math.random().toString(36).slice(2, 6)}@test.local`, password: "test-pass-1234", name },
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
    await new Promise((r) => setTimeout(r, 1500));
    view = await getRun(ctx, id);
  }
  return view;
}

const step = (id: string, endpoint: string, params: Record<string, unknown>, depends_on: string[] = []) =>
  ({ id, title: id, endpoint_id: endpoint, params, depends_on });

test.describe("ws2 run engine", () => {
  test("[OF-0536][OF-0584] ask-first parks the plan; approve releases it; run completes", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Runs AskFirst");

    const sr = await ctx.post("/api/agent/sessions", { data: { mode: "auto" } });
    const { session } = await sr.json();
    const pr = await ctx.post(`/api/agent/sessions/${session.id}/messages`, {
      data: { text: "generate an image of a lighthouse", ask_first: true },
    });
    expect(pr.status()).toBe(201);

    const mr = await ctx.get(`/api/agent/sessions/${session.id}/messages?after=0`);
    const { runs } = await mr.json();
    const run = runs[0] as RunView;
    expect(run.status).toBe("awaiting_approval");
    expect(run.steps[0].status).toBe("pending");
    expect(run.steps[0].job_id).toBeNull();
    expect(run.estimate_credits).toBeGreaterThan(0);

    // nothing may run before the approve
    const jr = await ctx.get(`/api/agent/runs/${run.id}`);
    expect(jr.ok()).toBeTruthy();
    expect(((await jr.json()).run as RunView).steps[0].job_id).toBeNull();

    const ar = await ctx.post(`/api/agent/runs/${run.id}/approve`);
    expect(ar.ok()).toBeTruthy();
    const after = (await ar.json()).run as RunView;
    expect(after.status).toBe("running");
    expect(after.steps[0].job_id).toBeTruthy();

    const done = await pollRun(ctx, run.id);
    expect(done.status).toBe("done");
    expect(done.steps[0].status).toBe("done");
    expect(done.steps[0].outputs[0]?.url).toBeTruthy();
    const job = (await (await ctx.get(`/api/jobs/${done.steps[0].job_id}`)).json()).job;
    expect(job.endpointId).toBe(T2I);
    expect(job.status).toBe("completed");
    await ctx.dispose();
  });

  test("[OF-0584][OF-0587] over-cap estimate parks without ask_first; approve is idempotent", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Runs Cap");
    const r = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "cap", steps: [step("s1", T2V, { prompt: "city", resolution: "720p", duration: 5 })] } },
    });
    expect(r.status()).toBe(201);
    const run = (await r.json()).run as RunView;
    expect(run.estimate_credits).toBeGreaterThan(5);
    expect(run.status).toBe("awaiting_approval");

    // approve twice - the second is a no-op returning the same live run
    for (let i = 0; i < 2; i++) {
      const a = await ctx.post(`/api/agent/runs/${run.id}/approve`);
      expect(a.ok()).toBeTruthy();
    }
    const view = await getRun(ctx, run.id);
    expect(view.status).toBe("running");
    const done = await pollRun(ctx, run.id);
    expect(done.status).toBe("done");
    expect(done.steps[0].input_hash).toMatch(/^[0-9a-f]{64}$/);
    await ctx.dispose();
  });

  test("refused plans answer 422 with plain wording and create nothing", async ({ baseURL }) => {
    const ctx = await signUpCtx(baseURL, "Runs Refuse");
    // restricted endpoint without opt-in
    const r1 = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "bad", steps: [step("s1", LTX, { prompt: "x" })] } },
    });
    expect(r1.status()).toBe(422);
    expect(await r1.text()).toMatch(/opt-in/i);

    // $step ref without depends_on
    const r2 = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "bad", steps: [
        step("s1", T2I, { prompt: "a" }),
        step("s2", IMG2IMG, { prompt: "b", image_url: "$step:s1.outputs[0]" }),
      ] } },
    });
    expect(r2.status()).toBe(422);
    expect(await r2.text()).toMatch(/depend/i);

    // missing required param
    const r3 = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "bad", steps: [step("s1", IMG2IMG, { prompt: "b" })] } },
    });
    expect(r3.status()).toBe(422);
    expect(await r3.text()).toMatch(/image_url/);

    // an undeclared param → refused plainly
    const r4 = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "bad", steps: [step("s1", T2I, { prompt: "a", not_a_param: 1 })] } },
    });
    expect(r4.status()).toBe(422);
    expect(await r4.text()).toMatch(/doesn't take/);

    // a select value outside its declared enum → refused plainly
    const r5 = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "bad", steps: [step("s1", T2I, { prompt: "a", resolution: "8K" })] } },
    });
    expect(r5.status()).toBe(422);
    expect(await r5.text()).toMatch(/doesn't allow|pick one of/i);

    const list = await ctx.get("/api/agent/runs");
    expect(((await list.json()).runs as unknown[]).length).toBe(0);
    await ctx.dispose();
  });

  test("[OF-0536][OF-0585] steps run sequentially; step 2 receives step 1's output url", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Runs Chain");
    const r = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "chain", steps: [
        step("s1", T2I, { prompt: "a lighthouse at dusk" }),
        step("s2", IMG2IMG, { prompt: "sepia grade", image_url: "$step:s1.outputs[0]" }, ["s1"]),
      ] } },
    });
    expect(r.status()).toBe(201);
    const run = (await r.json()).run as RunView;
    expect(run.status).toBe("running");
    // s1 running, s2 gated - sequential by construction
    expect(run.steps[0].status).toBe("running");
    expect(run.steps[1].status).toBe("pending");
    expect(run.steps[1].job_id).toBeNull();

    const done = await pollRun(ctx, run.id);
    expect(done.status).toBe("done");
    const [s1, s2] = done.steps;
    expect(s1.status).toBe("done");
    expect(s2.status).toBe("done");
    const s1Url = s1.outputs[0].url;
    const s2Job = (await (await ctx.get(`/api/jobs/${s2.job_id}`)).json()).job;
    expect(s2Job.endpointId).toBe(IMG2IMG);
    expect(s2Job.params.image_url).toBe(s1Url);
    await ctx.dispose();
  });

  test("[OF-0588] stop cancels the live job and every pending step; the run never resumes", async ({ baseURL }) => {
    const ctx = await signUpCtx(baseURL, "Runs Stop");
    const r = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "stop", steps: [
        step("s1", T2I, { prompt: "a" }),
        step("s2", T2I, { prompt: "b" }, ["s1"]),
      ] } },
    });
    expect(r.status()).toBe(201);
    const run = (await r.json()).run as RunView;
    const jobId = run.steps[0].job_id;
    expect(jobId).toBeTruthy();

    const sr = await ctx.post(`/api/agent/runs/${run.id}/stop`);
    expect(sr.ok()).toBeTruthy();
    const stopped = (await sr.json()).run as RunView;
    expect(stopped.status).toBe("stopped");
    expect(stopped.steps[0].status).toBe("canceled");
    expect(stopped.steps[1].status).toBe("canceled");

    const job = (await (await ctx.get(`/api/jobs/${jobId}`)).json()).job;
    expect(job.status).toBe("canceled");

    // terminal: further ticks and a second stop are no-ops
    const again = await getRun(ctx, run.id);
    expect(again.status).toBe("stopped");
    const sr2 = await ctx.post(`/api/agent/runs/${run.id}/stop`);
    expect(((await sr2.json()).run as RunView).status).toBe("stopped");
    await ctx.dispose();
  });

  test("another user's run is invisible; malformed ids 404; anonymous calls are 401", async ({ baseURL }) => {
    const owner = await signUpCtx(baseURL, "Runs Owner");
    const other = await signUpCtx(baseURL, "Runs Other");
    const anon = await request.newContext({ baseURL });

    const r = await owner.post("/api/agent/runs", {
      data: { plan: { title: "mine", steps: [step("s1", T2I, { prompt: "a" })] }, ask_first: true },
    });
    expect(r.status()).toBe(201);
    const run = (await r.json()).run as RunView;

    for (const call of [
      () => other.get(`/api/agent/runs/${run.id}`),
      () => other.post(`/api/agent/runs/${run.id}/approve`),
      () => other.post(`/api/agent/runs/${run.id}/stop`),
    ]) {
      const res = await call();
      expect(res.status()).toBe(404);
    }
    // owner still sees it parked
    expect((await getRun(owner, run.id)).status).toBe("awaiting_approval");

    // malformed ids are 404s - never a 500 on the uuid column
    for (const call of [
      () => owner.get("/api/agent/runs/not-a-uuid"),
      () => owner.post(`/api/agent/runs/${run.id.slice(0, -2)}/approve`),
      () => owner.post("/api/agent/runs/nope/stop"),
    ]) {
      expect((await call()).status()).toBe(404);
    }

    for (const call of [
      () => anon.post("/api/agent/runs", { data: { plan: { steps: [step("s1", T2I, { prompt: "a" })] } } }),
      () => anon.get("/api/agent/runs"),
      () => anon.get(`/api/agent/runs/${run.id}`),
      () => anon.post(`/api/agent/runs/${run.id}/approve`),
    ]) {
      const res = await call();
      expect(res.status()).toBe(401);
    }
    await owner.dispose(); await other.dispose(); await anon.dispose();
  });

  test("[OF-0588] stop after step 1 completes: step 2's job is canceled + refunded, step 1 stays charged", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Runs Stop Mid");
    const credits = async () =>
      Number((((await (await ctx.get("/api/me")).json()).profile) as { credits: number }).credits);
    const jobs = async () =>
      (((await (await ctx.get("/api/jobs")).json()).jobs) as unknown[]).length;
    const start = await credits();

    const r = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "chain", steps: [
        step("s1", T2I, { prompt: "a lighthouse at dusk" }),
        step("s2", I2V, { prompt: "animate it", image_url: "$step:s1.outputs[0]", resolution: "480p", duration: 3 }, ["s1"]),
      ] } },
    });
    expect(r.status()).toBe(201);
    const run = (await r.json()).run as RunView;

    // wait until s1 is done and s2's job is live, then stop
    let view = run;
    const t0 = Date.now();
    while (!(view.steps[0].status === "done" && view.steps[1].status === "running")) {
      expect(Date.now() - t0, "s1 never finished / s2 never started").toBeLessThan(60_000);
      await new Promise((r) => setTimeout(r, 400));
      view = await getRun(ctx, run.id);
    }
    expect(view.steps[1].job_id).toBeTruthy();

    const sr = await ctx.post(`/api/agent/runs/${run.id}/stop`);
    expect(sr.ok()).toBeTruthy();
    const stopped = (await sr.json()).run as RunView;
    expect(stopped.status).toBe("stopped");
    expect(stopped.steps[0].status).toBe("done");
    expect(stopped.steps[1].status).toBe("canceled");
    const s2Job = (await (await ctx.get(`/api/jobs/${stopped.steps[1].job_id}`)).json()).job;
    expect(s2Job.status).toBe("canceled");

    // no new jobs, and a later tick never resumes a stopped run
    const n0 = await jobs();
    await getRun(ctx, run.id);
    expect(await jobs()).toBe(n0);

    // charged for s1 only (0.08 cr) - s2's cancel refunded its 3 credits
    expect(await credits()).toBeCloseTo(start - 0.08, 4);
    await ctx.dispose();
  });

  test("[OF-0583][OF-0584][OF-0588] assistant UI: run card parks, approve runs to done, stop halts a live run", async ({ page }) => {
    test.setTimeout(180_000);
    // sign up through the page's own context so the cookie jar is shared
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await page.request.post("/api/auth/sign-up/email", {
        data: { email: `ws2ui-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "Runs UI" },
      });
      if (r.ok()) break;
      if (attempt === 3) expect(r.ok(), `sign-up: ${await r.text()}`).toBeTruthy();
      await new Promise((res) => setTimeout(res, 500));
    }
    const jobs = async () =>
      (((await (await page.request.get("/api/jobs")).json()).jobs) as unknown[]).length;
    const jobs0 = await jobs();

    await page.goto("/ai-assistant");
    // ask-first is on by default - send the brief through the real composer
    await page.locator("textarea").fill("generate an image of a lighthouse");
    await page.getByTitle("Send").click();

    const card = page.locator("[data-testid^='run-card-']").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("awaiting approval");
    await expect(card).toContainText("cr total");
    await expect(card).toContainText("ETA unknown");
    await expect(card).toContainText(/\d+\.\d+ cr/); // per-step catalog cost
    // nothing may run before the approve - no job exists yet
    expect(await jobs()).toBe(jobs0);

    await page.locator("[data-testid^='run-approve-']").click();
    await expect(card).toContainText("running", { timeout: 15_000 });
    await expect(card.getByText("✓")).toBeVisible({ timeout: 90_000 });
    await expect(card).toContainText("done");

    // second run: approve then stop while the step is in flight - while a job
    // is live the composer shows Stop, so wait for Send to come back first
    await expect(page.getByTitle("Send")).toBeVisible({ timeout: 30_000 });
    await page.locator("textarea").fill("generate an image of a fox");
    await page.getByTitle("Send").click();
    const card2 = page.locator("[data-testid^='run-card-']").nth(1);
    await expect(card2).toBeVisible({ timeout: 30_000 });
    await page.locator("[data-testid^='run-approve-']").click();
    await expect(card2).toContainText("running", { timeout: 15_000 });
    await page.locator("[data-testid^='run-stop-']").click();
    await expect(card2).toContainText("stopped", { timeout: 15_000 });
  });
});

/* -------- the LLM planner over a stubbed OpenAI wire (Settings → routes) -------- */

type StubReply = { content: string } | { status: number; body: string };

type StubBody = { messages?: { role?: string; content?: string }[] };

/** A loopback /chat/completions stub; replyFor(callIndex) → content or HTTP error. */
function stubPlanner(replyFor: (n: number) => StubReply) {
  let calls = 0;
  const bodies: StubBody[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try { bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as StubBody); }
      catch { bodies.push({}); }
      const reply = replyFor(calls++);
      if ("status" in reply) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(reply.body);
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: reply.content } }] }));
      }
    });
  });
  return {
    calls: () => calls,
    bodies: () => bodies,
    listen: () => new Promise<number>((res) => server.listen(0, "127.0.0.1", () => res((server.address() as AddressInfo).port))),
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

/** Point this user's planner route at a loopback base URL via the Settings API. */
async function routePlannerTo(ctx: APIRequestContext, baseUrl: string) {
  const p = await ctx.put("/api/llm/providers/custom", { data: { baseUrl } });
  expect(p.ok(), `provider PUT: ${await p.text()}`).toBeTruthy();
  const r = await ctx.put("/api/llm/routes/planner", { data: { providerId: "custom", model: "stub-m" } });
  expect(r.ok(), `route PUT: ${await r.text()}`).toBeTruthy();
}

test.describe("ws2 llm planner e2e", () => {
  test("invalid first reply → repair → valid plan → run; provider errors surface + fall back", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Runs LLM");
    const goodPlan = {
      title: "stub plan",
      steps: [{ id: "s1", title: "make it", endpoint_id: T2I, params: { prompt: "a lighthouse" }, depends_on: [] }],
    };

    // first reply is not a plan at all → the repair round must fix it
    const stub = stubPlanner((n) =>
      n === 0
        ? { content: "sure, here's your plan: [not json" }
        : { content: JSON.stringify(goodPlan) });
    try {
      const port = await stub.listen();
      await routePlannerTo(ctx, `http://127.0.0.1:${port}/v1`);
      const r = await ctx.post("/api/agent/runs", {
        data: { text: "make an image of a lighthouse", ask_first: true },
      });
      expect(r.status(), `body: ${await r.text()}`).toBe(201);
      const d = await r.json();
      expect(d.planner.via).toBe("custom·stub-m");
      expect(stub.calls()).toBe(2); // the repair round actually happened
      expect(d.run.status).toBe("awaiting_approval");
    } finally {
      await stub.close();
    }

    // provider errors are visible: run still lands via the built-in planner,
    // planner.fallback_reason says why, and a session-bound run narrates it
    const dead = stubPlanner(() => ({ status: 400, body: JSON.stringify({ error: "bad request" }) }));
    try {
      const port = await dead.listen();
      await routePlannerTo(ctx, `http://127.0.0.1:${port}/v1`);
      const sr = await ctx.post("/api/agent/sessions", { data: { mode: "auto" } });
      const { session } = await sr.json();
      const r = await ctx.post("/api/agent/runs", {
        data: { session_id: session.id, text: "generate an image of a lighthouse", ask_first: true },
      });
      expect(r.status(), `body: ${await r.text()}`).toBe(201);
      const d = await r.json();
      expect(d.planner.via).toBe("built-in planner");
      expect(d.planner.fallback_reason).toBeTruthy();
      const mr = await ctx.get(`/api/agent/sessions/${session.id}/messages?after=0`);
      expect(JSON.stringify(await mr.json())).toContain("llm_error:");
      expect(dead.calls()).toBeGreaterThanOrEqual(1);
    } finally {
      await dead.close();
    }
    await ctx.dispose();
  });

  test("a plan with an undeclared param gets one correction round → valid plan → 201", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Runs LLM Repair");
    // wan-2.1 text-to-video declares no `steps` - validatePlan refuses the
    // first reply, the planner retries once, and the second plan lands
    const refused = {
      title: "stub plan",
      steps: [{ id: "s1", title: "make it", endpoint_id: T2V,
        params: { prompt: "a neon city at night", steps: 6 }, depends_on: [] }],
    };
    const good = {
      title: "stub plan",
      steps: [{ id: "s1", title: "make it", endpoint_id: T2V,
        params: { prompt: "a neon city at night", resolution: "480p", duration: 3 }, depends_on: [] }],
    };
    const stub = stubPlanner((n) => ({ content: JSON.stringify(n === 0 ? refused : good) }));
    try {
      const port = await stub.listen();
      await routePlannerTo(ctx, `http://127.0.0.1:${port}/v1`);
      const r = await ctx.post("/api/agent/runs", {
        data: { text: "make a short video of a neon city at night", ask_first: true },
      });
      expect(r.status(), `body: ${await r.text()}`).toBe(201);
      const d = await r.json();
      expect(d.planner.via).toBe("custom·stub-m");
      expect(d.run.status).toBe("awaiting_approval");
      expect(stub.calls()).toBe(2); // exactly one correction round
      // the first system prompt listed every declared param - wan-2.1's
      // resolution enum carries both draft values
      const sys = stub.bodies()[0]?.messages?.find((m) => m.role === "system")?.content ?? "";
      const wanLine = sys.split("\n").find((l) => l.includes(T2V)) ?? "";
      expect(wanLine).toContain("480p");
      expect(wanLine).toContain("720p");
      // the correction round carries the refused plan + the refusal itself -
      // the model corrects off the reason, not a bare "try again"
      const fix = stub.bodies()[1]?.messages ?? [];
      expect(fix.some((m) => m.role === "assistant" && (m.content ?? "").includes(T2V))).toBe(true);
      // the correction message (a later user turn, not the original brief)
      // carries the refusal wording - the model corrects off the reason
      const asks = fix.filter((m) => m.role === "user" && /refused/i.test(m.content ?? ""));
      expect(asks.length).toBeGreaterThan(0);
      expect(asks[0]?.content ?? "").toMatch(/steps/); // the validator's "doesn't take" wording reaches the model
    } finally {
      await stub.close();
    }
    await ctx.dispose();
  });

  test("llm plan naming a restricted endpoint or a cycle → plain 422, zero runs and zero jobs", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Runs LLM Refuse");
    const jobs = async () => (((await (await ctx.get("/api/jobs")).json()).jobs) as unknown[]).length;
    const runs = async () => (((await (await ctx.get("/api/agent/runs")).json()).runs) as unknown[]).length;

    // a plan naming LTX without an opt-in → the opt-in refusal, not a run
    const ltx = stubPlanner(() => ({
      content: JSON.stringify({ title: "t", steps: [
        { id: "s1", title: "x", endpoint_id: LTX, params: { prompt: "city at night" }, depends_on: [] },
      ] }),
    }));
    try {
      const port = await ltx.listen();
      await routePlannerTo(ctx, `http://127.0.0.1:${port}/v1`);
      const r = await ctx.post("/api/agent/runs", { data: { text: "make a video of a city" } });
      expect(r.status()).toBe(422);
      expect(await r.text()).toMatch(/opt-in/i);
      expect(ltx.calls()).toBeGreaterThanOrEqual(1); // the refusal came from the LLM's own plan
    } finally {
      await ltx.close();
    }

    // a dependency cycle → refused plainly, nothing created
    const cyc = stubPlanner(() => ({
      content: JSON.stringify({ title: "t", steps: [
        { id: "s1", title: "a", endpoint_id: T2I, params: { prompt: "x" }, depends_on: ["s2"] },
        { id: "s2", title: "b", endpoint_id: T2I, params: { prompt: "y" }, depends_on: ["s1"] },
      ] }),
    }));
    try {
      const port = await cyc.listen();
      await routePlannerTo(ctx, `http://127.0.0.1:${port}/v1`);
      const r = await ctx.post("/api/agent/runs", { data: { text: "make two images" } });
      expect(r.status()).toBe(422);
      expect(await r.text()).toMatch(/depend|earlier/i);
    } finally {
      await cyc.close();
    }

    expect(await jobs()).toBe(0);
    expect(await runs()).toBe(0);
    await ctx.dispose();
  });
});
