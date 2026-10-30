/**
 * WS2 s5 run control + task tree e2e (GENERATION_PROVIDER=mock):
 *  1. pause parks new submissions while an in-flight job still reconciles;
 *     resume continues the run to done;
 *  2. pause then stop - pending steps cancel, the paused run never resumes;
 *  3. editing a pending step bumps rev, snapshots the old spec, and the
 *     approved run submits the edited params;
 *  4. step edit refuses 409 on running steps/live runs/stale revs, 422 on
 *     invalid specs, 404 cross-user/unknown step ids, 401 anonymous;
 *  5. the SSE events route streams the full lifecycle - snapshot →
 *     run_created/approved → step_* → run_done → done - and closes;
 *  6. SSE resume via ?after + ownership: another user's stream is a 404,
 *     anonymous a 401;
 *  7. assistant UI: the task tree renders status, dep markers and the
 *     pause/resume/approve/stop controls;
 *  8. planner pick: "builtin" runs the deterministic table; a bad pick
 *     narrates planner_error and still falls back visibly;
 *  9. editing a done run re-runs the step + transitive descendants only -
 *     ancestors keep their jobs, superseded specs land in revisions;
 * 10. stale rev → 409 carrying the current rev;
 * 11. the edit re-gates on the pending delta - ask_first parks, cheap
 *     deltas reopen straight to running;
 * 12. a live run refuses edits; a paused run's in-flight step too - and a
 *     pending-step edit on a paused run keeps it parked (resume runs it);
 * 13. SSE emits exactly one digest-gated `run` frame before `done`;
 * 14. the run card shows mode, planner route + fallback note, per-step
 *     model/cost/ETA, attachments, output leaves, earlier versions and
 *     the param-form editor;
 * 15. an errored EventSource falls back to the session poll;
 * 16. a stopped run's edit reopens it - the CANCELED ancestor re-runs too;
 * 17. a $step-linked done descendant re-runs and re-resolves its media ref
 *     to the fresh output;
 * 18. a re-run submits a fresh job under a rev-scoped idempotency key - the
 *     old key can't replay it;
 * 19. re-editing the same step stacks both earlier specs in revisions.
 * 20. editing the middle of a chain re-runs exactly the step + its
 *     descendants and charges only their cost; a step that completes in
 *     flight under a pause stays charged.
 * 21. +N more expanders - the run strip overflows past three outputs
 *     mid-run, and a step's own output group expands past three.
 * 22. 'Run without asking' starts with no Approve control; 'Confirm before
 *     running' parks the next brief again.
 * 23. a pending-step edit on a paused run stays paused; resume finishes the
 *     run with outputs.
 * 24. 'now animate it' plans image-to-video off the session's last output.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, request } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const T2I = "motionfield/z-image-turbo/text-to-image";
const IMG2IMG = "motionfield/z-image-turbo/img2img";

const I2V = "motionfield/wan-vace/image-to-video";

type RunView = {
  id: string; status: string; estimate_credits: number; eta_seconds: number | null;
  mode?: string; via?: string | null; planner_note?: string | null; session_id?: string | null;
  steps: { id: string; step_id: string; status: string; endpoint_id: string; job_id: string | null;
           params: Record<string, unknown>; depends_on: string[]; rev: number;
           outputs: { url: string; type: string }[]; error: string | null;
           cost?: number | null; input_hash?: string | null; model_label?: string | null;
           revisions?: { rev: number; outputs: { url: string; type: string }[];
                         job_id: string | null; created_at: string }[] }[];
};

async function signUpCtx(baseURL: string | undefined, name: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL });
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await ctx.post("/api/auth/sign-up/email", {
      data: { email: `ws2tree-${Date.now()}-${attempt}-${Math.random().toString(36).slice(2, 6)}@test.local`, password: "test-pass-1234", name },
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
  return view;
}

const step = (id: string, endpoint: string, params: Record<string, unknown>, depends_on: string[] = []) =>
  ({ id, title: id, endpoint_id: endpoint, params, depends_on });

test.describe("ws2 run control + task tree", () => {
  test("pause parks pending steps while the in-flight job reconciles; resume finishes the run", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Tree Pause");
    const jobs = async () => (((await (await ctx.get("/api/jobs")).json()).jobs) as unknown[]).length;

    const r = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "pause", steps: [
        step("s1", T2I, { prompt: "one" }),
        step("s2", T2I, { prompt: "two" }, ["s1"]),
      ] } },
    });
    expect(r.status()).toBe(201);
    const run = (await r.json()).run as RunView;

    const pr = await ctx.post(`/api/agent/runs/${run.id}/pause`);
    expect(pr.ok()).toBeTruthy();
    let view = (await pr.json()).run as RunView;
    expect(view.status).toBe("paused");

    // wait for s1's job to reconcile, then verify no new submissions while parked
    const t0 = Date.now();
    while (view.steps[0].status !== "done" && view.steps[0].status !== "canceled") {
      expect(Date.now() - t0, "s1 never reconciled while paused").toBeLessThan(60_000);
      await new Promise((res) => setTimeout(res, 800));
      view = await getRun(ctx, run.id);
      if (view.status !== "paused") break;
    }
    expect(view.status).toBe("paused");
    const parkedJobs = await jobs();
    await getRun(ctx, run.id); // another lazy tick - must not submit s2
    await new Promise((res) => setTimeout(res, 2500));
    expect((await getRun(ctx, run.id)).steps[1].job_id).toBeNull();
    expect(await jobs()).toBe(parkedJobs);

    const rr = await ctx.post(`/api/agent/runs/${run.id}/resume`);
    expect(rr.ok()).toBeTruthy();
    expect(((await rr.json()).run as RunView).status).toBe("running");
    const done = await pollRun(ctx, run.id);
    expect(done.status).toBe("done");
    expect(done.steps.every((s) => s.status === "done")).toBe(true);
    await ctx.dispose();
  });

  test("stop from paused cancels pending steps; the run never resumes", async ({ baseURL }) => {
    test.setTimeout(90_000);
    const ctx = await signUpCtx(baseURL, "Tree PauseStop");
    const r = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "ps", steps: [
        step("s1", T2I, { prompt: "one" }),
        step("s2", T2I, { prompt: "two" }, ["s1"]),
      ] } },
    });
    const run = (await r.json()).run as RunView;
    await ctx.post(`/api/agent/runs/${run.id}/pause`);
    const sr = await ctx.post(`/api/agent/runs/${run.id}/stop`);
    expect(sr.ok()).toBeTruthy();
    const stopped = (await sr.json()).run as RunView;
    expect(stopped.status).toBe("stopped");
    expect(stopped.steps[1].status).toBe("canceled");
    // resume on a stopped run is a no-op
    await ctx.post(`/api/agent/runs/${run.id}/resume`);
    expect((await getRun(ctx, run.id)).status).toBe("stopped");
    await ctx.dispose();
  });

  test("editing a pending step bumps rev, records a revision, and the approved run submits the edit", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Tree Edit");
    const r = await ctx.post("/api/agent/runs", {
      data: { ask_first: true, plan: { title: "edit", steps: [
        step("s1", T2I, { prompt: "original prompt" }),
        step("s2", IMG2IMG, { prompt: "restyle", image_url: "$step:s1.outputs[0]" }, ["s1"]),
      ] } },
    });
    const run = (await r.json()).run as RunView;
    expect(run.status).toBe("awaiting_approval");

    const er = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, {
      data: { params: { prompt: "edited prompt" }, rev: 0 },
    });
    expect(er.ok(), `step edit: ${await er.text()}`).toBeTruthy();
    const d = await er.json();
    expect(d.rev).toBe(1);
    const edited = (d.run as RunView).steps[0];
    expect(edited.params.prompt).toBe("edited prompt");
    expect(edited.rev).toBe(1);

    await ctx.post(`/api/agent/runs/${run.id}/approve`);
    const view = await getRun(ctx, run.id);
    const job = (await (await ctx.get(`/api/jobs/${view.steps[0].job_id}`)).json()).job;
    expect(job.params.prompt).toBe("edited prompt");
    const done = await pollRun(ctx, run.id);
    expect(done.status).toBe("done");
    await ctx.dispose();
  });

  test("step edit refuses 409/422, cross-user and malformed reads 404, anonymous 401", async ({ baseURL }) => {
    const ctx = await signUpCtx(baseURL, "Tree EditSec");
    const other = await signUpCtx(baseURL, "Tree EditOther");
    const anon = await request.newContext({ baseURL });
    const r = await ctx.post("/api/agent/runs", {
      data: { ask_first: true, plan: { title: "sec", steps: [
        step("s1", T2I, { prompt: "a" }),
        step("s2", IMG2IMG, { prompt: "b", image_url: "$step:s1.outputs[0]" }, ["s1"]),
      ] } },
    });
    const run = (await r.json()).run as RunView;

    // cross-user: the step route is a 404, not an edit
    expect((await other.post(`/api/agent/runs/${run.id}/steps/s1`, { data: { params: { prompt: "x" }, rev: 0 } })).status()).toBe(404);
    // unknown step id → 404
    expect((await ctx.post(`/api/agent/runs/${run.id}/steps/nope`, { data: { params: {}, rev: 0 } })).status()).toBe(404);
    // malformed run id → 404
    expect((await ctx.post(`/api/agent/runs/not-a-uuid/steps/s1`, { data: { params: {} } })).status()).toBe(404);
    // missing rev → 400 (the wire contract requires it)
    expect((await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, { data: { params: { prompt: "x" } } })).status()).toBe(400);
    // invalid spec → 422 with the validator's wording
    const bad = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, { data: { params: { not_a_param: 1 }, rev: 0 } });
    expect(bad.status()).toBe(422);
    // anonymous → 401
    expect((await anon.post(`/api/agent/runs/${run.id}/steps/s1`, { data: { params: {}, rev: 0 } })).status()).toBe(401);
    expect((await anon.post(`/api/agent/runs/${run.id}/pause`)).status()).toBe(401);
    // a $step ref the step doesn't transitively depend on → 422
    expect((await ctx.post(`/api/agent/runs/${run.id}/steps/s2`, { data: { params: { image_url: "$step:nope.outputs[0]" }, rev: 0 } })).status()).toBe(422);
    // owner sees the untouched run
    expect((await getRun(ctx, run.id)).steps[0].params.prompt).toBe("a");
    await ctx.dispose(); await other.dispose(); await anon.dispose();
  });

  test("the SSE events route streams the lifecycle and closes on done", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Tree SSE");
    const r = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "sse", steps: [step("s1", T2I, { prompt: "a" })] } },
    });
    const run = (await r.json()).run as RunView;
    // the stream itself ticks the run - the GET resolves when it closes
    const res = await ctx.get(`/api/agent/runs/${run.id}/events`);
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["content-type"]).toContain("text/event-stream");
    const body = await res.text();
    const frames = body.split("\n\n").filter(Boolean);
    const kinds = frames.map((f) => f.match(/^event: (.+)$/m)?.[1]);
    expect(kinds[0]).toBe("snapshot");
    expect(kinds).toContain("run_created");
    expect(kinds).toContain("step_running");
    expect(kinds).toContain("step_done");
    expect(kinds).toContain("run_done");
    expect(kinds[kinds.length - 1]).toBe("done");
    // seq ids are present and monotonic
    const ids = frames.map((f) => Number(f.match(/^id: (\d+)$/m)?.[1])).filter((n) => n > 0);
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    const done = await getRun(ctx, run.id);
    expect(done.status).toBe("done");
    await ctx.dispose();
  });

  test("SSE ?after resumes past seqs; another user's stream 404s; anonymous 401s", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Tree SSE2");
    const other = await signUpCtx(baseURL, "Tree SSE3");
    const anon = await request.newContext({ baseURL });
    const r = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "sse2", steps: [step("s1", T2I, { prompt: "a" })] } },
    });
    const run = (await r.json()).run as RunView;
    await pollRun(ctx, run.id);

    const res = await ctx.get(`/api/agent/runs/${run.id}/events?after=1`);
    const body = await res.text();
    const ids = [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids.every((n) => n > 1)).toBe(true);

    expect((await other.get(`/api/agent/runs/${run.id}/events`)).status()).toBe(404);
    expect((await anon.get(`/api/agent/runs/${run.id}/events`)).status()).toBe(401);
    expect((await ctx.get(`/api/agent/runs/nope/events`)).status()).toBe(404);
    await ctx.dispose(); await other.dispose(); await anon.dispose();
  });

  test("assistant UI: the task tree shows status, deps and pause/resume/approve/stop controls", async ({ page }) => {
    test.setTimeout(180_000);
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await page.request.post("/api/auth/sign-up/email", {
        data: { email: `ws2tree-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "Tree UI" },
      });
      if (r.ok()) break;
      if (attempt === 3) expect(r.ok(), `sign-up: ${await r.text()}`).toBeTruthy();
      await new Promise((res) => setTimeout(res, 500));
    }
    await page.goto("/ai-assistant");
    await page.locator("textarea").fill("generate an image of a lighthouse");
    await page.getByTitle("Send").click();

    const card = page.locator("[data-testid^='run-card-']").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("awaiting approval");
    // step node + detail affordance
    await expect(card.locator("[data-testid^='step-']").first()).toBeVisible();
    await card.locator("[data-testid^='step-']").first().click();
    await expect(card.locator("[data-testid^='step-detail-']").first()).toBeVisible();
    // pending step offers edit
    await expect(card.locator("[data-testid^='step-edit-']").first()).toBeVisible();

    await page.locator("[data-testid^='run-approve-']").click();
    await expect(card).toContainText("running", { timeout: 15_000 });
    // pause while in flight → the pause control swaps to resume
    await page.locator("[data-testid^='run-pause-']").click();
    await expect(card).toContainText("paused", { timeout: 15_000 });
    await page.locator("[data-testid^='run-resume-']").click();
    await expect(card.getByText("✓").first()).toBeVisible({ timeout: 90_000 });
    await expect(card).toContainText("done");
  });

  test("planner pick: builtin bypasses the LLM; a bad pick narrates planner_error and falls back", async ({ baseURL }) => {
    test.setTimeout(90_000);
    const ctx = await signUpCtx(baseURL, "Tree Planner");

    // builtin - no LLM configured is fine; the deterministic table plans it
    const sr = await ctx.post("/api/agent/sessions", { data: { mode: "auto" } });
    const { session } = await sr.json();
    const r = await ctx.post(`/api/agent/sessions/${session.id}/messages`, {
      data: { text: "generate an image of a lighthouse", planner: "builtin", ask_first: true },
    });
    expect(r.status()).toBe(201);
    const mr = await ctx.get(`/api/agent/sessions/${session.id}/messages?after=0`);
    const md = await mr.json();
    const planMsg = (md.messages as { kind: string; content: { via?: string } }[]).find((m) => m.kind === "plan");
    expect(planMsg).toBeTruthy();
    expect(planMsg!.content.via).toBe("built-in planner");

    // a pick that can't resolve is narrated, and the turn still plans
    const r2 = await ctx.post(`/api/agent/sessions/${session.id}/messages`, {
      data: { text: "generate an image of a fox", planner: "nosuchprovider:model-x", ask_first: true },
    });
    expect(r2.status()).toBe(201);
    await new Promise((res) => setTimeout(res, 1500));
    const mr2 = await ctx.get(`/api/agent/sessions/${session.id}/messages?after=0`);
    const feed = JSON.stringify(await mr2.json());
    expect(feed).toContain("planner_error");
    await ctx.dispose();
  });

  test("editing a done run re-runs the step + transitive descendants; ancestors keep jobs, superseded specs land in revisions", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const ctx = await signUpCtx(baseURL, "Tree Rerun");
    const r = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "rerun", steps: [
        step("s1", T2I, { prompt: "root" }),
        step("s2", T2I, { prompt: "mid" }, ["s1"]),
        step("s3", T2I, { prompt: "leaf" }, ["s2"]),
      ] } },
    });
    expect(r.status()).toBe(201);
    const run = (await r.json()).run as RunView;
    const done = await pollRun(ctx, run.id);
    expect(done.status).toBe("done");
    const s1Job = done.steps[0].job_id;
    const s1Hash = done.steps[0].input_hash;
    const s2Job = done.steps[1].job_id;
    expect(s1Job && s2Job).toBeTruthy();

    // edit s2 → s2+s3 reset, s1 keeps its result, run reopens + re-runs
    const er = await ctx.post(`/api/agent/runs/${run.id}/steps/s2`, {
      data: { params: { prompt: "edited mid" }, rev: 0 },
    });
    expect(er.ok(), `edit: ${await er.text()}`).toBeTruthy();
    const after = await getRun(ctx, run.id);
    expect(after.status).toBe("running"); // reopened, no approval needed
    expect(after.steps[0].job_id).toBe(s1Job);
    expect(after.steps[0].input_hash).toBe(s1Hash);
    expect(after.steps[0].rev).toBe(0);
    // the superseded specs are auditable - done rows snapshot with outputs+job
    for (const s of after.steps.slice(1)) {
      expect(s.rev).toBe(1);
      expect(s.revisions!.length).toBe(1);
      expect(s.revisions![0].rev).toBe(0);
      expect(s.revisions![0].job_id).toBeTruthy();
      expect(s.revisions![0].outputs.length).toBeGreaterThan(0);
    }
    // the pending-delta estimate replaced the original total (s2+s3 only)
    expect(after.estimate_credits).toBeLessThan(done.estimate_credits);

    const done2 = await pollRun(ctx, run.id);
    expect(done2.status).toBe("done");
    expect(done2.steps[0].job_id).toBe(s1Job);          // ancestor untouched
    expect(done2.steps[1].job_id).not.toBe(s2Job);      // fresh job under rev 1
    expect(done2.steps[1].params.prompt).toBe("edited mid");
    await ctx.dispose();
  });

  test("a stale rev is a 409 that reports the current rev", async ({ baseURL }) => {
    const ctx = await signUpCtx(baseURL, "Tree Stale");
    const r = await ctx.post("/api/agent/runs", {
      data: { ask_first: true, plan: { title: "stale", steps: [step("s1", T2I, { prompt: "a" })] } },
    });
    const run = (await r.json()).run as RunView;
    const stale = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, {
      data: { params: { prompt: "x" }, rev: 9 },
    });
    expect(stale.status()).toBe(409);
    const body = await stale.json();
    expect(body.rev).toBe(0);
    // the right rev succeeds; a second edit with the now-stale rev 409s again
    const ok = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, {
      data: { params: { prompt: "x" }, rev: 0 },
    });
    expect(ok.ok()).toBeTruthy();
    const stale2 = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, {
      data: { params: { prompt: "y" }, rev: 0 },
    });
    expect(stale2.status()).toBe(409);
    expect((await stale2.json()).rev).toBe(1);
    await ctx.dispose();
  });

  test("the edit re-gates on the pending delta - ask_first parks at awaiting_approval", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Tree Regate");
    const r = await ctx.post("/api/agent/runs", {
      data: { ask_first: true, plan: { title: "regate", steps: [
        step("s1", T2I, { prompt: "a" }),
        step("s2", T2I, { prompt: "b" }, ["s1"]),
      ] } },
    });
    const run = (await r.json()).run as RunView;
    expect(run.status).toBe("awaiting_approval");
    // edit a pending step on the parked run - the run stays parked
    const er = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, {
      data: { params: { prompt: "edited" }, rev: 0 },
    });
    expect(er.ok()).toBeTruthy();
    const view = (await er.json()).run as RunView;
    expect(view.status).toBe("awaiting_approval");
    expect(view.steps[0].job_id).toBeNull(); // parked - the step never submitted
    expect(view.steps[1].rev).toBe(1); // the descendant reset bumped it too
    // approve → the re-run uses the edited spec end to end
    await ctx.post(`/api/agent/runs/${run.id}/approve`);
    const done = await pollRun(ctx, run.id);
    expect(done.status).toBe("done");
    expect(done.steps.every((s) => s.status === "done")).toBe(true);
    await ctx.dispose();
  });

  test("a live run refuses edits; so does a paused run's in-flight step; pause/resume illegal transitions 409", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Tree Live");
    const r = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "live", steps: [
        step("s1", T2I, { prompt: "a" }),
        step("s2", T2I, { prompt: "b" }, ["s1"]),
      ] } },
    });
    const run = (await r.json()).run as RunView;
    expect((await getRun(ctx, run.id)).status).toBe("running");
    // a running run refuses any step edit
    const live = await ctx.post(`/api/agent/runs/${run.id}/steps/s2`, {
      data: { params: { prompt: "x" }, rev: 0 },
    });
    expect(live.status()).toBe(409);
    // resume on an already-running run is an idempotent 200, not a transition
    expect((await ctx.post(`/api/agent/runs/${run.id}/resume`)).status()).toBe(200);

    // pause - s1 keeps reconciling in flight; a repeated pause stays 200
    expect((await ctx.post(`/api/agent/runs/${run.id}/pause`)).status()).toBe(200);
    expect((await ctx.post(`/api/agent/runs/${run.id}/pause`)).status()).toBe(200);
    // editing the in-flight step 409s on the step, not the run
    const inFlight = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, {
      data: { params: { prompt: "x" }, rev: 0 },
    });
    expect(inFlight.status()).toBe(409);
    // a pending descendant edits fine - but the run STAYS paused: the delta
    // gate can't auto-resume a parked run, nothing submits until resume
    const okEdit = await ctx.post(`/api/agent/runs/${run.id}/steps/s2`, {
      data: { params: { prompt: "edited while paused" }, rev: 0 },
    });
    expect(okEdit.ok(), `paused edit: ${await okEdit.text()}`).toBeTruthy();
    expect(((await okEdit.json()).run as RunView).status).toBe("paused");
    // resume → the edited spec runs; then terminal transitions still hold
    expect((await ctx.post(`/api/agent/runs/${run.id}/resume`)).status()).toBe(200);
    // terminal: stop lands; pause/resume off it are illegal transitions
    expect((await ctx.post(`/api/agent/runs/${run.id}/stop`)).status()).toBe(200);
    expect((await ctx.post(`/api/agent/runs/${run.id}/resume`)).status()).toBe(409);
    expect((await ctx.post(`/api/agent/runs/${run.id}/pause`)).status()).toBe(409);
    await ctx.dispose();
  });

  test("SSE emits one digest-gated run frame per change and a final done frame", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Tree SSEDigest");
    const r = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "digest", steps: [step("s1", T2I, { prompt: "a" })] } },
    });
    const run = (await r.json()).run as RunView;
    await pollRun(ctx, run.id); // quiet the run first - done is still streamable
    const res = await ctx.get(`/api/agent/runs/${run.id}/events`);
    expect(res.ok()).toBeTruthy();
    const body = await res.text();
    const frames = body.split("\n\n").filter(Boolean);
    const kinds = frames.map((f) => f.match(/^event: (.+)$/m)?.[1]);
    expect(kinds[0]).toBe("snapshot");
    // digest-gated: a quiet run pushes exactly one `run` frame - no per-poll
    // status spam - then `done` closes it
    expect(kinds.filter((k) => k === "run")).toHaveLength(1);
    expect(kinds[kinds.length - 1]).toBe("done");
    const runFrame = frames.find((f) => /^event: run$/m.test(f));
    const payload = JSON.parse(runFrame!.match(/^data: (.+)$/m)![1]);
    expect(payload.run.id).toBe(run.id);
    expect(payload.run.steps).toHaveLength(1);
    await ctx.dispose();
  });

  test("assistant UI: run card shows mode, planner route, step meta, attachments, outputs and earlier versions", async ({ page }) => {
    test.setTimeout(240_000);
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await page.request.post("/api/auth/sign-up/email", {
        data: { email: `ws2meta-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "Tree Meta" },
      });
      if (r.ok()) break;
      if (attempt === 3) expect(r.ok(), `sign-up: ${await r.text()}`).toBeTruthy();
      await new Promise((res) => setTimeout(res, 500));
    }
    // a session-bound run via the planner pick path - bad pick → fallback note
    const sr = await page.request.post("/api/agent/sessions", { data: { mode: "auto" } });
    const { session } = await sr.json();
    await page.request.post(`/api/agent/sessions/${session.id}/messages`, {
      data: { text: "generate an image of a lighthouse", planner: "nosuchprovider:model-x", ask_first: true },
    });
    // a second run carrying an attachment param - exercises the leaf
    await page.request.post("/api/agent/runs", {
      data: {
        session_id: session.id, ask_first: true,
        plan: { title: "with attachment", steps: [
          step("s1", IMG2IMG, { prompt: "restyle", image_url: "/files/generated/test.png" }),
        ] },
      },
    });

    await page.goto("/ai-assistant");
    await page.locator("button", { hasText: /generate an image of a lighthouse/ }).first().click();

    const cards = page.locator("[data-testid^='run-card-']");
    await expect(cards.first()).toBeVisible({ timeout: 30_000 });
    await expect(cards).toHaveCount(2, { timeout: 20_000 });

    // run-level metadata: mode chip + planner route + fallback note
    const planned = cards.filter({ hasText: /via / }).first();
    await expect(planned.locator("[data-testid^='run-mode-']")).toContainText("auto");
    await expect(planned.locator("[data-testid^='run-via-']")).toContainText("via built-in planner");
    await expect(planned.locator("[data-testid^='run-via-']")).toContainText("planner");

    // collapsed step row metadata: model label · cost · ETA
    const meta = cards.first().locator("[data-testid^='step-meta-']").first();
    await expect(meta).toBeVisible();
    await expect(meta).toContainText(/\d+\.\d+ cr/);

    // the attachment leaf on the second card
    const att = cards.nth(1).locator("[data-testid^='step-atts-']").first();
    await expect(att).toBeVisible({ timeout: 15_000 });
    await expect(att).toContainText("test.png");

    // approve + finish the planned run → output leaf + earlier versions
    const approve = planned.locator("[data-testid^='run-approve-']");
    await approve.click();
    await expect(planned.getByText("done", { exact: true })).toBeVisible({ timeout: 90_000 });
    const outs = planned.locator("[data-testid^='step-outs-']").first();
    await expect(outs).toBeVisible({ timeout: 30_000 });
    await expect(outs.locator("a[href^='/files/'], a[href^='/api/assets/']").first()).toBeVisible();

    // the param-form editor on the finished run re-runs the step
    const stepNode = planned.locator("[data-testid='step-s1']");
    await stepNode.locator("button").first().click(); // the row toggles detail
    await planned.locator("[data-testid^='step-edit-']").first().click();
    const promptField = planned.locator("[data-testid^='step-param-'][data-testid$='-prompt']").first();
    await expect(promptField).toBeVisible();
    await promptField.fill("an edited lighthouse at dusk");
    await planned.locator("[data-testid^='step-save-']").click();
    await expect(planned).toContainText("awaiting approval", { timeout: 15_000 });
    await planned.locator("[data-testid^='run-approve-']").click();
    await expect(planned.getByText("done", { exact: true })).toBeVisible({ timeout: 90_000 });

    // earlier versions - the detail stayed open through the re-run, the
    // superseded spec + its output is listed under r0
    const revs = planned.locator("[data-testid^='step-revisions-']");
    await expect(revs).toBeVisible({ timeout: 15_000 });
    await expect(revs).toContainText("r0");
  });

  test("a stopped run's edit reopens it - the canceled ancestor re-runs too", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const ctx = await signUpCtx(baseURL, "Tree Ancestor");
    const r = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "anc", steps: [
        step("s1", T2I, { prompt: "a" }),
        step("s2", T2I, { prompt: "b" }, ["s1"]),
      ] } },
    });
    const run = (await r.json()).run as RunView;

    // wait until s1 is actually in flight (or already done if the mock won
    // the race), then stop - s2 cancels either way
    let v = await getRun(ctx, run.id);
    const t0 = Date.now();
    while (!["running", "done"].includes(v.steps[0].status) && Date.now() - t0 < 60_000) {
      await new Promise((res) => setTimeout(res, 300));
      v = await getRun(ctx, run.id);
    }
    const ancBefore = v.steps[0].status;
    const sr = await ctx.post(`/api/agent/runs/${run.id}/stop`);
    expect(sr.ok()).toBeTruthy();
    const mid = await getRun(ctx, run.id);
    expect(mid.status).toBe("stopped");
    expect(mid.steps[1].status).toBe("canceled");
    const ancJob = mid.steps[0].job_id;
    // s1 was killed in flight → canceled; if its job landed first → done
    const ancAfter = mid.steps[0].status;
    expect(ancAfter === "canceled" || ancAfter === "done").toBe(true);

    // editing s2 reopens the run - a canceled ancestor resets with it
    const er = await ctx.post(`/api/agent/runs/${run.id}/steps/s2`, {
      data: { params: { prompt: "edited descendant" }, rev: 0 },
    });
    expect(er.ok(), `edit: ${await er.text()}`).toBeTruthy();
    const after = (await er.json()).run as RunView;
    expect(after.status).toBe("running");
    expect(["pending", "running"]).toContain(after.steps[1].status);
    // a killed ancestor re-queues (and may already be in flight - the edit
    // tick claims it immediately); a done one stays untouched
    if (ancAfter === "canceled") {
      expect(["pending", "running"]).toContain(after.steps[0].status);
    } else {
      expect(after.steps[0].status).toBe("done");
    }

    const done = await pollRun(ctx, run.id);
    expect(done.status).toBe("done");
    expect(done.steps.every((s) => s.status === "done")).toBe(true);
    if (ancAfter === "canceled") {
      // the ancestor got a fresh job - the run could not have finalized on a
      // producer that never re-ran
      expect(done.steps[0].job_id).not.toBe(ancJob);
    }
    expect(ancBefore).not.toBe("pending"); // sanity: it really started
    await ctx.dispose();
  });

  test("a $step-linked done descendant re-runs and re-resolves its media ref to the fresh output", async ({ baseURL }) => {
    test.setTimeout(240_000);
    const ctx = await signUpCtx(baseURL, "Tree Chain");
    const r = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "chain", steps: [
        step("s1", T2I, { prompt: "root" }),
        step("s2", IMG2IMG, { prompt: "mid", image_url: "$step:s1.outputs[0]" }, ["s1"]),
        step("s3", IMG2IMG, { prompt: "leaf", image_url: "$step:s2.outputs[0]" }, ["s2"]),
      ] } },
    });
    expect(r.status()).toBe(201);
    const run = (await r.json()).run as RunView;
    const done = await pollRun(ctx, run.id);
    expect(done.status).toBe("done");
    const s2Out = done.steps[1].outputs[0].url;
    const s3Job0 = (await (await ctx.get(`/api/jobs/${done.steps[2].job_id}`)).json()).job;
    expect(s3Job0.params.image_url).toBe(s2Out); // chained at submit time

    // edit s2 → s3 (done descendant) re-runs and its $step ref re-resolves
    const er = await ctx.post(`/api/agent/runs/${run.id}/steps/s2`, {
      data: { params: { prompt: "mid, warmer" }, rev: 0 },
    });
    expect(er.ok(), `edit: ${await er.text()}`).toBeTruthy();
    const done2 = await pollRun(ctx, run.id);
    expect(done2.status).toBe("done");
    expect(done2.steps[0].job_id).toBe(done.steps[0].job_id); // s1 untouched
    const s2Out2 = done2.steps[1].outputs[0].url;
    expect(s2Out2).not.toBe(s2Out);
    const s3Job1 = (await (await ctx.get(`/api/jobs/${done2.steps[2].job_id}`)).json()).job;
    expect(s3Job1.params.image_url).toBe(s2Out2); // the ref followed the re-run
    await ctx.dispose();
  });

  test("a re-run submits a fresh job under a rev-scoped idempotency key", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const ctx = await signUpCtx(baseURL, "Tree Idem");
    const r = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "idem", steps: [step("s1", T2I, { prompt: "a" })] } },
    });
    const run = (await r.json()).run as RunView;
    const done = await pollRun(ctx, run.id);
    const row0 = done.steps[0];
    const job0 = (await (await ctx.get(`/api/jobs/${row0.job_id}`)).json()).job;
    expect(job0.idempotencyKey).toBe(`run-step:${row0.id}:r0`);

    const er = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, {
      data: { params: { prompt: "a, again" }, rev: 0 },
    });
    expect(er.ok()).toBeTruthy();
    const done2 = await pollRun(ctx, run.id);
    const row1 = done2.steps[0];
    expect(row1.job_id).not.toBe(row0.job_id); // a fresh submission, not a replay
    const job1 = (await (await ctx.get(`/api/jobs/${row1.job_id}`)).json()).job;
    expect(job1.idempotencyKey).toBe(`run-step:${row1.id}:r1`);
    await ctx.dispose();
  });

  test("re-editing the same step stacks both earlier specs in revisions", async ({ baseURL }) => {
    test.setTimeout(240_000);
    const ctx = await signUpCtx(baseURL, "Tree Revs");
    const r = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "revs", steps: [step("s1", T2I, { prompt: "v0" })] } },
    });
    const run = (await r.json()).run as RunView;
    const d0 = await pollRun(ctx, run.id);
    const job0 = d0.steps[0].job_id;

    const e1 = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, {
      data: { params: { prompt: "v1" }, rev: 0 },
    });
    expect(e1.ok()).toBeTruthy();
    const d1 = await pollRun(ctx, run.id);
    const job1 = d1.steps[0].job_id;

    const e2 = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, {
      data: { params: { prompt: "v2" }, rev: 1 },
    });
    expect(e2.ok()).toBeTruthy();
    const view = (await e2.json()).run as RunView;
    const revs = view.steps[0].revisions!;
    expect(revs.map((x) => x.rev).sort()).toEqual([0, 1]); // both superseded specs
    expect(revs.find((x) => x.rev === 0)?.job_id).toBe(job0);
    expect(revs.find((x) => x.rev === 1)?.job_id).toBe(job1);

    const d2 = await pollRun(ctx, run.id);
    expect(d2.status).toBe("done");
    expect(d2.steps[0].job_id).not.toBe(job1);
    expect(d2.steps[0].job_id).not.toBe(job0);
    await ctx.dispose();
  });

  test("assistant UI: an errored EventSource falls back to the session poll", async ({ page }) => {
    test.setTimeout(180_000);
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await page.request.post("/api/auth/sign-up/email", {
        data: { email: `ws2sse-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "Tree SSEFB" },
      });
      if (r.ok()) break;
      if (attempt === 3) expect(r.ok(), `sign-up: ${await r.text()}`).toBeTruthy();
      await new Promise((res) => setTimeout(res, 500));
    }
    await page.route("**/api/agent/runs/*/events", (route) => route.abort());
    const sr = await page.request.post("/api/agent/sessions", { data: { mode: "auto" } });
    const { session } = await sr.json();
    await page.request.post(`/api/agent/sessions/${session.id}/messages`, {
      data: { text: "generate an image of a lighthouse", planner: "builtin", ask_first: true },
    });
    await page.goto("/ai-assistant");
    await page.locator("button", { hasText: /generate an image of a lighthouse/ }).first().click();
    const card = page.locator("[data-testid^='run-card-']").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    // no live stream - the 1.6 s session poll still drives the tree
    await card.locator("[data-testid^='run-approve-']").click();
    await expect(card).toContainText("running", { timeout: 20_000 });
    await expect(card.getByText("✓").first()).toBeVisible({ timeout: 90_000 });
    await expect(card.getByText("done", { exact: true })).toBeVisible();
  });

  test("editing the middle of a chain re-runs exactly the step + descendant and charges their cost", async ({ baseURL }) => {
    test.setTimeout(240_000);
    const ctx = await signUpCtx(baseURL, "Tree Delta");
    const jobs = async () => (((await (await ctx.get("/api/jobs")).json()).jobs) as unknown[]).length;
    type Ledger = { delta: string; kind: string; refId: string | null };
    const ledger = async () =>
      (((await (await ctx.get("/api/me/ledger")).json()).entries) as Ledger[]);

    const r = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "delta", steps: [
        step("s1", T2I, { prompt: "root" }),
        step("s2", T2I, { prompt: "mid" }, ["s1"]),
        step("s3", T2I, { prompt: "leaf" }, ["s2"]),
      ] } },
    });
    const run = (await r.json()).run as RunView;
    const done = await pollRun(ctx, run.id);
    expect(done.status).toBe("done");
    const jobs0 = await jobs();

    const er = await ctx.post(`/api/agent/runs/${run.id}/steps/s2`, {
      data: { params: { prompt: "mid edited" }, rev: 0 },
    });
    expect(er.ok(), `edit: ${await er.text()}`).toBeTruthy();
    const done2 = await pollRun(ctx, run.id);
    expect(done2.status).toBe("done");

    // exactly two fresh jobs - s2 + its descendant; s1 kept its job
    expect(await jobs()).toBe(jobs0 + 2);
    expect(done2.steps[0].job_id).toBe(done.steps[0].job_id);
    // and the spend for exactly those two jobs equals their summed cost
    const ids = [done2.steps[1].job_id, done2.steps[2].job_id];
    const spend = (await ledger()).filter((e) => e.kind === "spend" && ids.includes(e.refId ?? ""));
    expect(spend).toHaveLength(2);
    const charged = spend.reduce((a, e) => a + Math.abs(Number(e.delta)), 0);
    expect(charged).toBeCloseTo((done2.steps[1].cost ?? 0) + (done2.steps[2].cost ?? 0), 5);

    // a step that completes in flight while the run is paused is charged -
    // its spend entry stands with no refund beside it; the paused pending
    // step never even submitted
    const r2 = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "paused-charge", steps: [
        step("s1", T2I, { prompt: "one" }),
        step("s2", T2I, { prompt: "two" }, ["s1"]),
      ] } },
    });
    const run2 = (await r2.json()).run as RunView;
    // let s1 actually go in flight (or land), then pause
    let v = await getRun(ctx, run2.id);
    const t0 = Date.now();
    while (!["running", "done"].includes(v.steps[0].status) && Date.now() - t0 < 60_000) {
      await new Promise((res) => setTimeout(res, 300));
      v = await getRun(ctx, run2.id);
    }
    await ctx.post(`/api/agent/runs/${run2.id}/pause`);
    v = await getRun(ctx, run2.id); // v was last read before the pause landed
    // wait for the in-flight job to reconcile under the pause
    const t1 = Date.now();
    while (v.steps[0].status !== "done" && v.status === "paused" && Date.now() - t1 < 60_000) {
      await new Promise((res) => setTimeout(res, 800));
      v = await getRun(ctx, run2.id);
    }
    expect(v.steps[0].status).toBe("done");
    const entries = (await ledger()).filter((e) => e.refId === v.steps[0].job_id);
    expect(entries.some((e) => e.kind === "spend")).toBe(true);
    expect(entries.some((e) => e.kind === "refund")).toBe(false);
    expect(v.steps[1].job_id).toBeNull(); // paused - never submitted, never charged
    await ctx.post(`/api/agent/runs/${run2.id}/resume`);
    expect((await pollRun(ctx, run2.id)).status).toBe("done");
    await ctx.dispose();
  });

  test("+N more expanders - the run strip mid-run and a step's own outputs", async ({ page }) => {
    test.setTimeout(300_000);
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await page.request.post("/api/auth/sign-up/email", {
        data: { email: `ws2outs-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "Tree Outs" },
      });
      if (r.ok()) break;
      if (attempt === 3) expect(r.ok(), `sign-up: ${await r.text()}`).toBeTruthy();
      await new Promise((res) => setTimeout(res, 500));
    }
    const sr = await page.request.post("/api/agent/sessions", { data: { mode: "auto" } });
    const { session } = await sr.json();
    await page.request.post(`/api/agent/sessions/${session.id}/messages`, {
      data: { text: "outputs expander check", record_only: true },
    });
    // five steps - while the last runs, four outputs overflow the strip
    const rr = await page.request.post("/api/agent/runs", {
      data: { session_id: session.id, mode: "auto",
        plan: { title: "strip", steps: [
          step("s1", T2I, { prompt: "a" }),
          step("s2", T2I, { prompt: "b" }, ["s1"]),
          step("s3", T2I, { prompt: "c" }, ["s2"]),
          step("s4", T2I, { prompt: "d" }, ["s3"]),
          step("s5", T2I, { prompt: "e" }, ["s4"]),
        ] } },
    });
    const run = (await rr.json()).run as RunView;
    await page.goto("/ai-assistant");
    await page.locator("button", { hasText: "outputs expander check" }).first().click();
    const card = page.locator(`[data-testid='run-card-${run.id}']`);
    await expect(card).toBeVisible({ timeout: 30_000 });

    // mid-run: 4 done steps → the strip caps at 3 with "+1 more" → expands
    const more = card.locator("[data-testid^='run-strip-more-']");
    await expect(more).toHaveText("+1 more", { timeout: 120_000 });
    await more.click();
    await expect(card.locator("[data-testid^='run-strip-'] a")).toHaveCount(4);

    // a step's own overflow - the mock emits one item per job, so the poll is
    // patched to hand the card a 4-output step (read-side only)
    await page.route("**/api/agent/sessions/*/messages**", async (route) => {
      const res = await route.fetch();
      const j = await res.json() as { runs?: { steps?: { step_id?: string; outputs?: unknown }[] }[] };
      for (const rv of j.runs ?? []) {
        const s = (rv.steps ?? []).find((x) => x.step_id === "s1");
        if (s) s.outputs = [1, 2, 3, 4].map((n) => ({ url: `/files/mock-out-${n}.png`, type: "image" }));
      }
      await route.fulfill({ response: res, json: j });
    });
    const outs = card.locator("[data-testid='step-outs-s1']");
    const stepMore = outs.locator("button", { hasText: "more" });
    await expect(stepMore).toHaveText("+1 more", { timeout: 30_000 });
    await stepMore.click();
    await expect(outs.locator("a")).toHaveCount(4);
  });

  test("'Run without asking' starts with no Approve; 'Confirm before running' parks the next brief", async ({ page }) => {
    test.setTimeout(240_000);
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await page.request.post("/api/auth/sign-up/email", {
        data: { email: `ws2gate-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "Tree Gate" },
      });
      if (r.ok()) break;
      if (attempt === 3) expect(r.ok(), `sign-up: ${await r.text()}`).toBeTruthy();
      await new Promise((res) => setTimeout(res, 500));
    }
    await page.goto("/ai-assistant");
    // default is Confirm - switch to auto-run and the plan starts on its own
    await page.getByTitle("Autonomy").click();
    await page.getByText("Run without asking").click();
    await page.locator("textarea").fill("generate an image of a lighthouse");
    await page.getByTitle("Send").click();
    const card = page.locator("[data-testid^='run-card-']").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator("[data-testid^='run-approve-']")).toHaveCount(0);
    await expect(card).toContainText(/running|done/, { timeout: 15_000 });

    // toggle back - the next brief parks at awaiting_approval again
    // (cards render oldest → newest - the fresh run is the last one)
    await page.getByTitle("Autonomy").click();
    await page.getByText("Confirm before running").click();
    await page.locator("textarea").fill("generate an image of a fox");
    await page.getByTitle("Send").click();
    const card2 = page.locator("[data-testid^='run-card-']").last();
    await expect(card2.locator("[data-testid^='run-approve-']")).toBeVisible({ timeout: 20_000 });
    await expect(card2).toContainText("awaiting approval");
  });

  test("a pending-step edit on a paused run stays paused; resume finishes it with outputs", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const ctx = await signUpCtx(baseURL, "Tree PausedEdit");
    const r = await ctx.post("/api/agent/runs", {
      data: { plan: { title: "pe", steps: [
        step("s1", T2I, { prompt: "a" }),
        step("s2", T2I, { prompt: "b" }, ["s1"]),
      ] } },
    });
    const run = (await r.json()).run as RunView;
    expect((await ctx.post(`/api/agent/runs/${run.id}/pause`)).ok()).toBeTruthy();
    const er = await ctx.post(`/api/agent/runs/${run.id}/steps/s2`, {
      data: { params: { prompt: "edited while paused" }, rev: 0 },
    });
    expect(er.ok(), `edit: ${await er.text()}`).toBeTruthy();
    expect(((await er.json()).run as RunView).status).toBe("paused");
    // nothing submits while paused - s2 never got a job yet
    expect((await getRun(ctx, run.id)).steps[1].job_id).toBeNull();
    expect((await ctx.post(`/api/agent/runs/${run.id}/resume`)).ok()).toBeTruthy();
    const done = await pollRun(ctx, run.id);
    expect(done.status).toBe("done");
    expect(done.steps[1].params.prompt).toBe("edited while paused");
    expect(done.steps.every((s) => s.status === "done" && s.outputs.length > 0)).toBe(true);
    await ctx.dispose();
  });

  test("'now animate it' plans image-to-video off the session's last output", async ({ baseURL }) => {
    test.setTimeout(240_000);
    const ctx = await signUpCtx(baseURL, "Tree Animate");
    const sr = await ctx.post("/api/agent/sessions", { data: { mode: "auto" } });
    const { session } = await sr.json();
    const mr = await ctx.post(`/api/agent/sessions/${session.id}/messages`, {
      data: { text: "generate an image of a lighthouse", planner: "builtin", ask_first: true },
    });
    expect(mr.status()).toBe(201);
    const sessionRuns = async () => {
      const list = (((await (await ctx.get("/api/agent/runs")).json()).runs) as { id: string; session_id: string | null }[])
        .filter((x) => x.session_id === session.id);
      return list;
    };
    const first = (await sessionRuns()).map((x) => x.id);
    expect(first).toHaveLength(1);
    expect((await ctx.post(`/api/agent/runs/${first[0]}/approve`)).ok()).toBeTruthy();
    const done = await pollRun(ctx, first[0]);
    expect(done.status).toBe("done");
    const imgUrl = done.steps[0].outputs[0].url;

    // the follow-up brief plans i2v off the output the first run left behind
    const mr2 = await ctx.post(`/api/agent/sessions/${session.id}/messages`, {
      data: { text: "now animate it", planner: "builtin", ask_first: true },
    });
    expect(mr2.status()).toBe(201);
    const rs = await sessionRuns();
    expect(rs).toHaveLength(2);
    const second = await getRun(ctx, rs.find((x) => x.id !== first[0])!.id);
    expect(second.steps[0].endpoint_id).toBe(I2V);
    expect(second.steps[0].params.image_url).toBe(imgUrl);
    await ctx.dispose();
  });
});
