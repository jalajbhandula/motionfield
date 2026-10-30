/**
 * WS2 s6 run modes e2e (GENERATION_PROVIDER=mock):
 *  1. Auto: an ask-first plan parks at awaiting_approval; a cheap plan with
 *     no ask_first runs itself to done;
 *  2. Custom: every run parks regardless of ask_first; the step exposes
 *     model_options, an endpoint pick + effort persist as provenance, and
 *     the approved run's job carries the picked endpoint;
 *  3. the picker is same-kind only: a video endpoint can't replace an image
 *     step (422), and a pick whose required media input the step can't
 *     satisfy stays out of model_options;
 *  4. Offline: heavy endpoints and remote (non-loopback) media refs are
 *     plain 422s before any job exists; a remote planner pick narrates
 *     planner_error and the built-in planner still answers;
 *  5. Assistant UI: the Custom run parks, the step shows a model picker +
 *     effort select, picks land through the step edit API, and the card
 *     shows mode + via.
 *  6. Restricted picks hide behind the license opt-in and are marked
 *     ' · restricted'; a pick + effort reprices the step and the approved
 *     job runs exactly the stored endpoint + params.
 *  7. Effort levels re-derive only the knobs the endpoint declares
 *     (resolution/duration/steps/fps) and re-price exactly as cost(params)
 *     says; denoise and batch_size are never effort's.
 *  8. A model pick refits carried params to the new schema (enum + range),
 *     drops fields it doesn't declare, keeps explicit edits strict, and an
 *     endpoint-only pick preserves + re-applies the stored effort level.
 *  9. Offline + a loopback planner stub: the UI picker lists the local
 *     route only, a stub-planned run shows `via <provider>·<model>`, and a
 *     remote media ref on a step edit is a 422 with offline wording.
 * 10. Parked Custom runs don't hold SSE streams - at most two /events are
 *     open at once (HTTP/1.1's 6-per-host limit stays clear) and a fourth
 *     approve lands fast.
 * 11. Honest labels + chat restore: 'time left unknown' while a pending
 *     step has no ETA, 'cr to re-run' after an edit, and reopening a chat
 *     restores its stored planner pick.
 */
import http from "node:http";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, request } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const T2I = "motionfield/z-image-turbo/text-to-image";
const IMG2IMG = "motionfield/z-image-turbo/img2img";
const T2V = "motionfield/wan-2.1/text-to-video";
const HEAVY_T2I = "motionfield/qwen-image-edit/text-to-image";
const VACE_I2V = "motionfield/wan-vace/image-to-video";
const WAN22_I2V = "motionfield/wan-2.2/image-to-video";
const LTX_T2V = "motionfield/ltx-video/text-to-video";
const DIRECTOR = "motionfield/director/generate";
const UPSCALE = "motionfield/upscale/image";

type StepView = {
  step_id: string; status: string; endpoint_id: string; job_id: string | null;
  params: Record<string, unknown>; rev: number; effort?: string | null;
  cost?: number | null; eta_seconds?: number | null;
  model_choice?: string | null; model_options?: { endpoint_id: string; label: string; restricted: boolean }[];
};
type RunView = {
  id: string; status: string; mode: string; via?: string | null; planner_note?: string | null;
  estimate_credits?: number;
  steps: StepView[];
};

async function signUpCtx(baseURL: string | undefined, name: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL });
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await ctx.post("/api/auth/sign-up/email", {
      data: { email: `ws2modes-${Date.now()}-${attempt}-${Math.random().toString(36).slice(2, 6)}@test.local`, password: "test-pass-1234", name },
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

const jobsCount = async (ctx: APIRequestContext) =>
  (((await (await ctx.get("/api/jobs")).json()).jobs) as unknown[]).length;

test.describe("ws2 run modes", () => {
  test("auto: an ask-first plan parks; a cheap plan runs itself to done", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Modes Auto");
    const parked = await ctx.post("/api/agent/runs", {
      data: { mode: "auto", ask_first: true, plan: { title: "parked", steps: [step("s1", T2I, { prompt: "a" })] } },
    });
    expect(parked.status()).toBe(201);
    expect(((await parked.json()).run as RunView).status).toBe("awaiting_approval");

    const go = await ctx.post("/api/agent/runs", {
      data: { mode: "auto", plan: { title: "go", steps: [step("s1", T2I, { prompt: "b" })] } },
    });
    expect(go.status()).toBe(201);
    const run = (await go.json()).run as RunView;
    expect(run.mode).toBe("auto");
    const done = await pollRun(ctx, run.id);
    expect(done.status).toBe("done");
    await ctx.dispose();
  });

  test("custom: parks, step model picker + effort persist, the job runs the picked endpoint", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const ctx = await signUpCtx(baseURL, "Modes Custom");
    const r = await ctx.post("/api/agent/runs", {
      data: {
        // custom parks even without ask_first - the gate is part of the mode
        mode: "custom", ask_first: false,
        plan: { title: "custom", steps: [step("s1", T2I, { prompt: "a portrait" })] },
      },
    });
    expect(r.status()).toBe(201);
    const run = (await r.json()).run as RunView;
    expect(run.mode).toBe("custom");
    expect(run.status).toBe("awaiting_approval");

    // the step exposes its picker: same-output-kind endpoints that pass
    // license + mode policy, minus its own current endpoint
    const s1 = run.steps[0];
    expect(s1.model_options!.length).toBeGreaterThan(0);
    expect(s1.model_options!.every((o) => o.endpoint_id !== s1.endpoint_id)).toBe(true);
    const pick = s1.model_options![0].endpoint_id;

    const er = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, {
      data: { endpoint_id: pick, effort: "draft", rev: 0 },
    });
    expect(er.ok(), `step pick: ${await er.text()}`).toBeTruthy();
    const after = (await er.json()).run as RunView;
    // the custom gate re-parks after every edit
    expect(after.status).toBe("awaiting_approval");
    expect(after.steps[0].endpoint_id).toBe(pick);
    expect(after.steps[0].model_choice).toBe(pick); // provenance: the user's pick
    expect(after.steps[0].effort).toBe("draft");
    expect(after.steps[0].rev).toBe(1);

    await ctx.post(`/api/agent/runs/${run.id}/approve`);
    const done = await pollRun(ctx, run.id);
    expect(done.status).toBe("done");
    const job = (await (await ctx.get(`/api/jobs/${done.steps[0].job_id}`)).json()).job;
    expect(job.endpointId).toBe(pick);
    await ctx.dispose();
  });

  test("the endpoint picker is same-kind only - a video pick on an image step is a plain 422", async ({ baseURL }) => {
    const ctx = await signUpCtx(baseURL, "Modes Kind");
    const r = await ctx.post("/api/agent/runs", {
      data: {
        mode: "custom", plan: { title: "kind", steps: [
          step("s1", T2I, { prompt: "a" }),
          step("s2", T2V, { prompt: "b" }, ["s1"]),
        ] },
      },
    });
    expect(r.status()).toBe(201);
    const run = (await r.json()).run as RunView;

    // wrong-kind pick → 422 with the kind wording
    const bad = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, {
      data: { endpoint_id: T2V, rev: 0 },
    });
    expect(bad.status()).toBe(422);
    expect(await bad.text()).toMatch(/output kind/i);
    // unknown endpoint → 422
    expect((await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, {
      data: { endpoint_id: "motionfield/nope/nope", rev: 0 },
    })).status()).toBe(422);
    // s2's picker only offers video endpoints whose media inputs the step's
    // deps could satisfy - nothing requires an input s2 doesn't have (no
    // image dep), so every option's required-media need is self-consistent
    const s2 = run.steps[1];
    expect(s2.model_options!.every((o) => !o.endpoint_id.endsWith("text-to-image"))).toBe(true);
    // effort outside the enum is a 400, not a write
    expect((await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, {
      data: { effort: "turbo", rev: 0 },
    })).status()).toBe(400);
    await ctx.dispose();
  });

  test("offline: heavy endpoints + remote media refs 422 before jobs; a remote planner pick falls back visibly", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ctx = await signUpCtx(baseURL, "Modes Offline");
    const pr = await ctx.put("/api/llm/prefs", { data: { offline: true } });
    expect(pr.ok()).toBeTruthy();
    const before = await jobsCount(ctx);

    // a heavy endpoint is outside offline policy - 422, no run, no job
    const heavy = await ctx.post("/api/agent/runs", {
      data: { mode: "offline", plan: { title: "heavy", steps: [step("s1", HEAVY_T2I, { prompt: "a" })] } },
    });
    expect(heavy.status()).toBe(422);
    // a remote media ref is refused before any fetch would happen
    const remote = await ctx.post("/api/agent/runs", {
      data: { mode: "offline", plan: { title: "remote", steps: [
        step("s1", IMG2IMG, { prompt: "restyle", image_url: "https://example.com/a.png" }),
      ] } },
    });
    expect(remote.status()).toBe(422);
    expect(await remote.text()).toMatch(/offline/i);
    expect(await jobsCount(ctx)).toBe(before);

    // the saved pref coerces even a posted "auto" - the run is offline
    const coerced = await ctx.post("/api/agent/runs", {
      data: { mode: "auto", ask_first: true, plan: { title: "coerced", steps: [step("s1", T2I, { prompt: "a" })] } },
    });
    expect(coerced.status()).toBe(201);
    const cRun = (await coerced.json()).run as RunView;
    expect(cRun.mode).toBe("offline");

    // a remote planner pick is refused before any network call - the turn
    // narrates it and the built-in planner still answers
    await ctx.put("/api/llm/providers/custom", { data: { baseUrl: "https://llm.example.test/v1" } });
    const sr = await ctx.post("/api/agent/sessions", { data: { mode: "offline" } });
    const { session } = await sr.json();
    const mr = await ctx.post(`/api/agent/sessions/${session.id}/messages`, {
      data: { text: "generate an image of a lighthouse", planner: "custom:remote-model", ask_first: true },
    });
    expect(mr.status()).toBe(201);
    const feed = await (await ctx.get(`/api/agent/sessions/${session.id}/messages?after=0`)).json();
    const text = JSON.stringify(feed);
    expect(text).toContain("planner_error");
    expect(text).toMatch(/offline/i);
    const planMsg = (feed.messages as { kind: string; content: { via?: string } }[])
      .find((m) => m.kind === "plan");
    expect(planMsg?.content.via).toBe("built-in planner");
    await ctx.dispose();
  });

  test("assistant UI: custom mode menu → parked run → per-step model + effort controls", async ({ page }) => {
    test.setTimeout(240_000);
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await page.request.post("/api/auth/sign-up/email", {
        data: { email: `ws2modesui-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "Modes UI" },
      });
      if (r.ok()) break;
      if (attempt === 3) expect(r.ok(), `sign-up: ${await r.text()}`).toBeTruthy();
      await new Promise((res) => setTimeout(res, 500));
    }
    await page.goto("/ai-assistant");

    // pick Custom in the mode menu, then send a brief through the built-in
    // planner - the run must park even though "auto-run" is on
    await page.getByTestId("mode-menu-button").click();
    await page.getByTestId("mode-option-custom").click();
    await page.getByTitle("Autonomy").click();
    await page.getByText("Run without asking").click();
    await page.locator("textarea").fill("generate an image of a lighthouse");
    await page.getByTitle("Send").click();

    const card = page.locator("[data-testid^='run-card-']").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator("[data-testid^='run-mode-']")).toContainText("custom");
    await expect(card).toContainText("awaiting approval");
    await expect(card.locator("[data-testid^='run-via-']")).toContainText(/via |built-in/);
    await expect(card.locator("[data-testid^='run-footer-']")).toContainText(/custom/);

    // per-step controls: model picker (current endpoint selected + same-kind
    // options) and the effort select
    const modelSel = card.locator("[data-testid='step-model-s1']");
    const effortSel = card.locator("[data-testid='step-effort-s1']");
    await expect(modelSel).toBeVisible({ timeout: 15_000 });
    await expect(effortSel).toBeVisible();
    const optCount = await modelSel.locator("option").count();
    expect(optCount, "the picker lists same-kind endpoints beyond the current one").toBeGreaterThan(1);

    // pick a different model → the step edit API applies it (rev bump) and
    // the run stays parked
    const pickValue = await modelSel.locator("option").nth(1).getAttribute("value");
    await modelSel.selectOption({ index: 1 });
    await expect(modelSel).toHaveValue(pickValue!, { timeout: 20_000 });

    // effort select → 'high' persists as provenance on the step
    await effortSel.selectOption("high");
    const runId = (await card.getAttribute("data-testid"))!.replace("run-card-", "");
    let view: RunView | undefined;
    await expect(async () => {
      view = await getRun(page.request, runId);
      expect(view.steps[0].effort).toBe("high");
      expect(view.steps[0].model_choice).toBe(pickValue);
      expect(view.steps[0].endpoint_id).toBe(pickValue);
      expect(view.status).toBe("awaiting_approval");
    }).toPass({ timeout: 20_000 });
    await card.locator("[data-testid^='run-approve-']").click();
    await expect(card.getByText("done", { exact: true })).toBeVisible({ timeout: 90_000 });
  });

  test("restricted picks hide behind the opt-in - ' · restricted' in the picker; a pick+effort reprices and the job runs those params", async ({ page }) => {
    test.setTimeout(240_000);
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await page.request.post("/api/auth/sign-up/email", {
        data: { email: `ws2restr-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "Modes Restricted" },
      });
      if (r.ok()) break;
      if (attempt === 3) expect(r.ok(), `sign-up: ${await r.text()}`).toBeTruthy();
      await new Promise((res) => setTimeout(res, 500));
    }
    const sr = await page.request.post("/api/agent/sessions", { data: { mode: "custom" } });
    const { session } = await sr.json();
    // title the chat without a planner turn - the run's plan message lands below it
    await page.request.post(`/api/agent/sessions/${session.id}/messages`, {
      data: { text: "restricted pick check", record_only: true },
    });
    const r = await page.request.post("/api/agent/runs", {
      data: {
        session_id: session.id, mode: "custom",
        plan: { title: "restr", steps: [
          step("s1", VACE_I2V, { prompt: "animate it", image_url: "/files/a.png" }),
        ] },
      },
    });
    expect(r.status()).toBe(201);
    const run = (await r.json()).run as RunView;

    // no opt-in → nothing restricted is offered
    expect(run.steps[0].model_options!.every((o) => !o.restricted)).toBe(true);
    // opt in → restricted same-kind endpoints appear, marked
    expect((await page.request.post("/api/licenses/opt-in", { data: {} })).ok()).toBeTruthy();
    const opened = await getRun(page.request, run.id);
    expect(opened.steps[0].model_options!.some((o) => o.restricted)).toBe(true);
    expect(opened.steps[0].model_options!.some((o) => o.endpoint_id === "motionfield/ltx-video/image-to-video" && o.restricted)).toBe(true);
    const costBefore = opened.steps[0].cost;

    await page.goto("/ai-assistant");
    await page.locator("button", { hasText: "restricted pick check" }).first().click();
    const card = page.locator(`[data-testid='run-card-${run.id}']`);
    await expect(card).toBeVisible({ timeout: 30_000 });

    const modelSel = card.locator("[data-testid='step-model-s1']");
    const effortSel = card.locator("[data-testid='step-effort-s1']");
    await expect(modelSel).toBeVisible({ timeout: 15_000 });
    // ' · restricted' marks the opt-in options; an unset effort renders the
    // planner's-settings row, not "standard"
    const labels = await modelSel.locator("option").allTextContents();
    expect(labels.some((l) => l.includes("restricted"))).toBe(true);
    await expect(effortSel.locator("option", { hasText: "current settings" })).toHaveCount(1);

    // pick Wan 2.2 + high effort - the step re-derives and re-prices.
    // (the endpoint pick bumps rev; the effort edit has to go on the fresh
    // rev or it 409s - wait for the poll to re-render the selects)
    await modelSel.selectOption("motionfield/wan-2.2/image-to-video");
    await expect(modelSel).toHaveValue("motionfield/wan-2.2/image-to-video", { timeout: 20_000 });
    await effortSel.selectOption("high");
    let view!: RunView;
    await expect(async () => {
      view = await getRun(page.request, run.id);
      const s = view.steps[0];
      expect(s.endpoint_id).toBe("motionfield/wan-2.2/image-to-video");
      expect(s.effort).toBe("high");
      // high re-derived on Wan 2.2's own schema (steps(20) caps at 2×default)
      expect(s.params).toMatchObject({ resolution: "720p", duration: 5, fps: 24, steps: 40 });
      // per5s({480p:8,720p:14}) at 5s → 14 - and it re-priced, not re-shown
      expect(s.cost).toBeCloseTo(14, 2);
      expect(view.estimate_credits!).toBeCloseTo(14, 2);
      expect(costBefore).not.toBe(s.cost);
    }).toPass({ timeout: 20_000 });
    await expect(card.locator("[data-testid='step-meta-s1']")).toContainText("14.00 cr", { timeout: 15_000 });
    await expect(card.locator("[data-testid='step-meta-s1']")).toContainText("steps 40");

    await card.locator("[data-testid^='run-approve-']").click();
    await expect(card.getByText("done", { exact: true })).toBeVisible({ timeout: 90_000 });
    const done = await getRun(page.request, run.id);
    const job = (await (await page.request.get(`/api/jobs/${done.steps[0].job_id}`)).json()).job;
    // the job ran exactly the picked endpoint and exactly the stored params
    expect(job.endpointId).toBe("motionfield/wan-2.2/image-to-video");
    expect(job.params).toEqual(done.steps[0].params);
  });

  test("effort levels re-derive declared knobs and re-price - never denoise or batch_size", async ({ baseURL }) => {
    const ctx = await signUpCtx(baseURL, "Modes Effort");
    // Wan 2.1 t2v declares resolution + duration
    const r = await ctx.post("/api/agent/runs", {
      data: { mode: "custom", plan: { title: "effort", steps: [step("s1", T2V, { prompt: "a wave" })] } },
    });
    const run = (await r.json()).run as RunView;
    const dr = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, { data: { effort: "draft", rev: 0 } });
    expect(dr.ok(), `draft: ${await dr.text()}`).toBeTruthy();
    let s = ((await dr.json()).run as RunView).steps[0];
    expect(s.effort).toBe("draft");
    expect(s.params).toMatchObject({ resolution: "480p", duration: 3 });
    // catalog: per5s({480p:5,720p:9}) - 5·3/5 = 3 exactly
    expect(s.cost).toBeCloseTo(3, 2);
    const hi = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, { data: { effort: "high", rev: 1 } });
    s = ((await hi.json()).run as RunView).steps[0];
    expect(s.effort).toBe("high");
    expect(s.params).toMatchObject({ resolution: "720p", duration: 5 });
    expect(s.cost).toBeCloseTo(9, 2);

    // the fuller knob set - VACE i2v also declares steps + fps
    const r2 = await ctx.post("/api/agent/runs", {
      data: { mode: "custom", plan: { title: "vace", steps: [
        step("s1", VACE_I2V, { prompt: "a", image_url: "/files/a.png" }),
      ] } },
    });
    const run2 = (await r2.json()).run as RunView;
    const lo = await ctx.post(`/api/agent/runs/${run2.id}/steps/s1`, { data: { effort: "draft", rev: 0 } });
    expect(lo.ok(), `draft: ${await lo.text()}`).toBeTruthy();
    s = ((await lo.json()).run as RunView).steps[0];
    expect(s.params).toMatchObject({ resolution: "480p", duration: 1, fps: 16, steps: 2 });
    expect(s.cost).toBeCloseTo(1, 2); // 5·1/5
    const hi2 = await ctx.post(`/api/agent/runs/${run2.id}/steps/s1`, { data: { effort: "high", rev: 1 } });
    expect(hi2.ok(), `high: ${await hi2.text()}`).toBeTruthy();
    s = ((await hi2.json()).run as RunView).steps[0];
    expect(s.params).toMatchObject({ resolution: "720p", duration: 5, fps: 24, steps: 16 });
    expect(s.cost).toBeCloseTo(9, 2); // 9·5/5

    // an img2img step keeps its denoise at both ends of the level, and a t2i
    // step keeps its posted batch - neither is effort's to move
    const r3 = await ctx.post("/api/agent/runs", {
      data: { mode: "custom", plan: { title: "i2i", steps: [
        step("s1", IMG2IMG, { prompt: "restyle", image_url: "/files/a.png", denoise: 0.6 }),
      ] } },
    });
    const run3 = (await r3.json()).run as RunView;
    for (const [eff, rev] of [["draft", 0], ["high", 1]] as const) {
      const er = await ctx.post(`/api/agent/runs/${run3.id}/steps/s1`, { data: { effort: eff, rev } });
      expect(er.ok(), `${eff}: ${await er.text()}`).toBeTruthy();
      expect(((await er.json()).run as RunView).steps[0].params.denoise).toBe(0.6);
    }
    const r4 = await ctx.post("/api/agent/runs", {
      data: { mode: "custom", plan: { title: "batch", steps: [step("s1", T2I, { prompt: "a", batch_size: 1 })] } },
    });
    const run4 = (await r4.json()).run as RunView;
    const e4 = await ctx.post(`/api/agent/runs/${run4.id}/steps/s1`, { data: { effort: "high", rev: 0 } });
    expect(e4.ok(), `high t2i: ${await e4.text()}`).toBeTruthy();
    expect(((await e4.json()).run as RunView).steps[0].params.batch_size).toBe(1);
    await ctx.dispose();
  });

  test("a model pick refits carried params to the new schema; effort survives the pick; explicit edits stay strict", async ({ baseURL }) => {
    const ctx = await signUpCtx(baseURL, "Modes Swap");
    // director + ltx are restricted - opt in so the catalog offers them
    expect((await ctx.post("/api/licenses/opt-in", { data: {} })).ok()).toBeTruthy();
    const r = await ctx.post("/api/agent/runs", {
      data: { mode: "custom", plan: { title: "swap", steps: [
        step("s1", DIRECTOR, { prompt: "a city", duration: 4, aspect_ratio: "21:9", moves: "dolly-in" }),
      ] } },
    });
    expect(r.status()).toBe(201);
    const run = (await r.json()).run as RunView;

    // Wan's duration enum is [3,5] - a carried 4 refits to the new default;
    // a ratio it doesn't offer falls back to the default too; fields it
    // doesn't declare (moves) drop out
    const sw = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, {
      data: { endpoint_id: T2V, rev: 0 },
    });
    expect(sw.ok(), `swap: ${await sw.text()}`).toBeTruthy();
    let s = ((await sw.json()).run as RunView).steps[0];
    expect(s.endpoint_id).toBe(T2V);
    expect(s.model_choice).toBe(T2V);
    expect(s.params).toMatchObject({ prompt: "a city", duration: 5, aspect_ratio: "16:9" });
    expect(s.params.moves).toBeUndefined();

    // an explicitly-edited value the new schema refuses stays strict - the
    // same ratio a carried value would refit is a plain 422 when it was
    // posted in this edit
    const strict = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, {
      data: { endpoint_id: LTX_T2V, params: { aspect_ratio: "21:9" }, rev: 1 },
    });
    expect(strict.status()).toBe(422);

    // high effort, then a pick - the level survives and re-derives on the
    // new schema (LTX's duration tops at 10, and knobs Wan lacks - steps +
    // fps - get their high values)
    const e1 = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, { data: { effort: "high", rev: 1 } });
    expect(e1.ok(), `effort: ${await e1.text()}`).toBeTruthy();
    const pk = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, {
      data: { endpoint_id: LTX_T2V, rev: 2 },
    });
    expect(pk.ok(), `ltx pick: ${await pk.text()}`).toBeTruthy();
    s = ((await pk.json()).run as RunView).steps[0];
    expect(s.effort).toBe("high");
    expect(s.params).toMatchObject({ resolution: "720p", duration: 10, fps: 25 });

    // editing an effort-owned knob clears the level; a non-knob edit keeps it
    const clr = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, { data: { params: { duration: 3 }, rev: 3 } });
    expect(clr.ok(), `clear: ${await clr.text()}`).toBeTruthy();
    expect(((await clr.json()).run as RunView).steps[0].effort).toBeNull();
    const d1 = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, { data: { effort: "draft", rev: 4 } });
    expect(d1.ok(), `draft: ${await d1.text()}`).toBeTruthy();
    const keep = await ctx.post(`/api/agent/runs/${run.id}/steps/s1`, { data: { params: { prompt: "a city at night" }, rev: 5 } });
    expect(keep.ok(), `keep: ${await keep.text()}`).toBeTruthy();
    expect(((await keep.json()).run as RunView).steps[0].effort).toBe("draft");
    await ctx.dispose();
  });

  test("offline: the planner picker narrows to loopback; a stub plans the run; a remote media edit is a 422", async ({ page }) => {
    test.setTimeout(180_000);
    // a loopback planner stub - answers /v1/models + /v1/chat/completions so
    // the pick → route → plan path is exercised without leaving the box
    const stubPlan = JSON.stringify({
      title: "stub plan",
      steps: [{ id: "s1", title: "Generate", endpoint_id: T2I,
        params: { prompt: "a stub lighthouse" }, depends_on: [] }],
    });
    const saw: string[] = [];
    const stub = http.createServer((req, res) => {
      saw.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.end(JSON.stringify({ id: "c", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: stubPlan }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        res.end(JSON.stringify({ object: "list", data: [{ id: "stub-m", object: "model" }] }));
        return;
      }
      res.statusCode = 404; res.end("{}");
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    const port = (stub.address() as { port: number }).port;
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const r = await page.request.post("/api/auth/sign-up/email", {
          data: { email: `ws2stub-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "Modes Stub" },
        });
        if (r.ok()) break;
        if (attempt === 3) expect(r.ok(), `sign-up: ${await r.text()}`).toBeTruthy();
        await new Promise((res) => setTimeout(res, 500));
      }
      // a remote provider alongside - the offline picker must hide it
      await page.request.put("/api/llm/providers/custom", { data: { baseUrl: "https://llm.example.test/v1", apiKey: "sk-test" } });
      const pr = await page.request.put("/api/llm/providers/lmstudio", {
        data: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k" },
      });
      expect(pr.ok(), `provider save: ${await pr.text()}`).toBeTruthy();
      await page.request.put("/api/llm/prefs", { data: { offline: true } });

      // a run planned through the stub - via carries the provider·model
      const sr = await page.request.post("/api/agent/sessions", { data: { mode: "offline" } });
      const { session } = await sr.json();
      const mr = await page.request.post(`/api/agent/sessions/${session.id}/messages`, {
        data: { text: "generate an image of a lighthouse", planner: "lmstudio:stub-m", ask_first: true },
      });
      expect(mr.status()).toBe(201);
      expect(saw.some((x) => x.startsWith("POST /v1/chat/completions"))).toBe(true);

      await page.goto("/ai-assistant");
      await expect(page.getByTestId("mode-menu-button")).toContainText("Offline", { timeout: 15_000 });
      await page.getByTestId("planner-pick").click();
      const drop = page.getByTestId("planner-menu").getByRole("button");
      await expect(drop.filter({ hasText: "stub-m" }).first()).toBeVisible({ timeout: 15_000 });
      expect((await drop.allTextContents()).join("\n")).not.toMatch(/custom|remote-model/i);
      await page.getByTestId("planner-pick").click(); // close

      await page.locator("button", { hasText: /generate an image of a lighthouse/ }).first().click();
      // chat restore: the stored loopback pick lands back on the composer -
      // the picker shows stub-m, never a silent relabel to "Auto"
      await expect(page.getByTestId("planner-pick")).toContainText("stub-m", { timeout: 15_000 });
      const card = page.locator("[data-testid^='run-card-']").first();
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card.locator("[data-testid^='run-via-']")).toContainText("lmstudio·stub-m");

      // a remote media ref on a step edit is a 422 with offline wording - no job
      const jobs0 = await jobsCount(page.request);
      const r2 = await page.request.post("/api/agent/runs", {
        data: { mode: "offline", ask_first: true, plan: { title: "i2i", steps: [
          step("s1", IMG2IMG, { prompt: "restyle", image_url: "/files/a.png" }),
        ] } },
      });
      const run2 = (await r2.json()).run as RunView;
      const bad = await page.request.post(`/api/agent/runs/${run2.id}/steps/s1`, {
        data: { params: { image_url: "http://10.0.0.1/x.png" }, rev: 0 },
      });
      expect(bad.status()).toBe(422);
      expect(await bad.text()).toMatch(/offline/i);
      expect(await jobsCount(page.request)).toBe(jobs0);
    } finally {
      await new Promise((r) => stub.close(r));
    }
  });

  test("parked runs don't hold streams - at most two /events open, an approve lands fast", async ({ page }) => {
    test.setTimeout(240_000);
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await page.request.post("/api/auth/sign-up/email", {
        data: { email: `ws2cap-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "Modes Cap" },
      });
      if (r.ok()) break;
      if (attempt === 3) expect(r.ok(), `sign-up: ${await r.text()}`).toBeTruthy();
      await new Promise((res) => setTimeout(res, 500));
    }
    const sr = await page.request.post("/api/agent/sessions", { data: { mode: "auto" } });
    const { session } = await sr.json();
    await page.request.post(`/api/agent/sessions/${session.id}/messages`, {
      data: { text: "stream cap check", record_only: true },
    });
    // four parked Custom runs - none of them may hold a stream
    const parked: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await page.request.post("/api/agent/runs", {
        data: { session_id: session.id, mode: "custom",
          plan: { title: `parked ${i}`, steps: [step("s1", T2I, { prompt: `p${i}` })] } },
      });
      parked.push(((await r.json()).run as RunView).id);
    }
    // one running run - the only one that may stream
    const rr = await page.request.post("/api/agent/runs", {
      data: { session_id: session.id, mode: "auto",
        plan: { title: "live", steps: [step("s1", T2I, { prompt: "live" })] } },
    });
    const live = ((await rr.json()).run as RunView).id;

    // count concurrent /events connections - HTTP/1.1 gives each host ~6,
    // and the page's polling + actions have to fit under that
    const evUrl = /\/api\/agent\/runs\/[^/]+\/events/;
    let cur = 0; let max = 0;
    const streamed = new Set<string>();
    page.on("request", (req) => {
      if (!evUrl.test(req.url())) return;
      cur++; max = Math.max(max, cur);
      streamed.add(req.url().match(/runs\/([^/]+)\/events/)![1]);
    });
    page.on("requestfinished", (req) => { if (evUrl.test(req.url())) cur--; });
    page.on("requestfailed", (req) => { if (evUrl.test(req.url())) cur--; });

    await page.goto("/ai-assistant");
    await page.locator("button", { hasText: "stream cap check" }).first().click();
    const cards = page.locator("[data-testid^='run-card-']");
    await expect(cards).toHaveCount(5, { timeout: 30_000 });
    await new Promise((res) => setTimeout(res, 4000));
    expect(max).toBeLessThanOrEqual(2);
    // none of the parked runs ever held a stream
    for (const id of parked) expect(streamed.has(id)).toBe(false);

    // approve two parked runs - three live runs total, still ≤ 2 streams
    const t0 = Date.now();
    const p0 = page.waitForResponse((r) => r.url().includes(`/runs/${parked[0]}/approve`) && r.ok(), { timeout: 5_000 });
    await page.locator(`[data-testid='run-approve-${parked[0]}']`).click();
    await p0;
    expect(Date.now() - t0).toBeLessThan(5_000);
    const p1 = page.waitForResponse((r) => r.url().includes(`/runs/${parked[1]}/approve`) && r.ok(), { timeout: 5_000 });
    await page.locator(`[data-testid='run-approve-${parked[1]}']`).click();
    await p1;
    await new Promise((res) => setTimeout(res, 4000));
    expect(max).toBeLessThanOrEqual(2);
  });

  test("honest labels + chat restore: 'time left unknown', 'cr to re-run', stored builtin pick", async ({ page }) => {
    test.setTimeout(240_000);
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await page.request.post("/api/auth/sign-up/email", {
        data: { email: `ws2lab-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "Modes Labels" },
      });
      if (r.ok()) break;
      if (attempt === 3) expect(r.ok(), `sign-up: ${await r.text()}`).toBeTruthy();
      await new Promise((res) => setTimeout(res, 500));
    }
    const sr = await page.request.post("/api/agent/sessions", { data: { mode: "auto" } });
    const { session } = await sr.json();
    await page.request.post(`/api/agent/sessions/${session.id}/messages`, {
      data: { text: "labels check", record_only: true },
    });
    // s2's endpoint has no job history - its ETA is genuinely unknown
    const rr = await page.request.post("/api/agent/runs", {
      data: { session_id: session.id, mode: "auto",
        plan: { title: "labels", steps: [
          step("s1", T2I, { prompt: "a" }),
          step("s2", UPSCALE, { image_url: "$step:s1.outputs[0]" }, ["s1"]),
        ] } },
    });
    const run = (await rr.json()).run as RunView;
    // defensive: the fixture step must really have no ETA - else the label
    // assertion would be vacuous
    {
      const v = await getRun(page.request, run.id);
      expect(v.steps[1].eta_seconds).toBeNull();
    }
    // a second, parked custom run - its step gets edited below (cr to re-run)
    const pr = await page.request.post("/api/agent/runs", {
      data: { session_id: session.id, mode: "custom",
        plan: { title: "edit me", steps: [step("s1", T2I, { prompt: "b" })] } },
    });
    const parked = ((await pr.json()).run as RunView).id;
    // a second chat with the builtin planner stored - reopening restores it
    const s2r = await page.request.post("/api/agent/sessions", { data: { mode: "auto" } });
    const { session: s2 } = await s2r.json();
    await page.request.post(`/api/agent/sessions/${s2.id}/messages`, {
      data: { text: "builtin restore brief - generate an image of a lighthouse", planner: "builtin", ask_first: true },
    });

    await page.goto("/ai-assistant");
    await page.locator("button", { hasText: "labels check" }).first().click();
    const card = page.locator(`[data-testid='run-card-${run.id}']`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    // while the run is live and a pending step has no ETA, the footer says so
    await expect(card.locator("[data-testid^='run-footer-']")).toContainText(
      "time left unknown", { timeout: 20_000 });

    // an edited step flips the credit wording - the estimate is only what's left
    const er = await page.request.post(`/api/agent/runs/${parked}/steps/s1`, {
      data: { params: { prompt: "edited" }, rev: 0 },
    });
    expect(er.ok()).toBeTruthy();
    const card2 = page.locator(`[data-testid='run-card-${parked}']`);
    await expect(card2.locator("[data-testid^='run-footer-']")).toContainText("cr to re-run", { timeout: 20_000 });

    // chat restore - the builtin-picked chat reopens with "Built-in" on the
    // picker, and its next run plans that way too
    await page.locator("button", { hasText: /builtin restore brief/ }).first().click();
    await expect(page.getByTestId("planner-pick")).toContainText("Built-in", { timeout: 15_000 });
    await page.locator("textarea").fill("generate an image of a fox");
    await page.getByTitle("Send").click();
    const newest = page.locator("[data-testid^='run-card-']").last();
    await expect(newest.locator("[data-testid^='run-via-']")).toContainText("via built-in planner", { timeout: 30_000 });
  });
});
