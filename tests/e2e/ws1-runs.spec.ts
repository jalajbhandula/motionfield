import { expect, request, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILLS } from "../../src/lib/catalog/skills";

/**
 * WS1 s8 durable runs over v1 (OF-0757 / OF-0759 / OF-0764 / OF-0767) -
 * signup → key → literal plan → ask_first gate → approve → poll to done →
 * control verbs → step edits + stale rev → idempotent replay/mismatch →
 * text/builtin planner + fallback note → owner scoping → auth/malformed/413.
 * Second test: same-key concurrency, a chained two-step run through the
 * output contract, a done-run edit that re-runs downstream, and a held
 * pause window. Third: catalog skills through create + inputs.
 * The mock provider completes each step inside the poll budget.
 */

const EP = "motionfield/z-image-turbo/text-to-image";
const EDIT_EP = "motionfield/qwen-image-edit/edit";

const plan = (prompt: string) => ({
  title: "e2e one step",
  steps: [{ id: "s1", title: "frame", endpoint_id: EP, params: { prompt }, depends_on: [] }],
});

const chain = (p1: string, p2: string) => ({
  title: "e2e two-step chain",
  steps: [
    { id: "s1", title: "frame", endpoint_id: EP, params: { prompt: p1 }, depends_on: [] },
    { id: "s2", title: "edit", endpoint_id: EDIT_EP,
      params: { prompt: p2, image_url: "$step:s1.outputs[0]" }, depends_on: ["s1"] },
  ],
});

interface RunView {
  id: string;
  status: string;
  title: string | null;
  mode: string;
  ask_first: boolean;
  project_id: string | null;
  estimate: { credits: number; eta_seconds: number | null };
  planner: { via: string | null; fallback_reason: string | null };
  steps: {
    id: string; title: string; endpoint: string; status: string; rev: number;
    job_id: string | null;
    outputs: { url: string; type: string; bytes: number | null }[];
    error: string | null; depends_on: string[];
  }[];
  created_at: string;
  updated_at: string;
  links: { self: string; approve: string; control: string };
}

test("[#122] v1 runs flow", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const email = `ws1runs-${Date.now()}@e2e.test`;

  // UI sign-up - the key comes out of the real /settings/keys panel, the
  // same path ws1-sdk/ws1-cli drive (a POST /api/keys shortcut would prove
  // nothing about the surface a user actually has)
  await page.goto("/signup");
  await page.getByPlaceholder("Display name").fill("WS1 Runs E2E");
  await page.getByPlaceholder("you@email.com").fill(email);
  await page.getByPlaceholder(/Password/).fill("e2e-password-123");
  await page.getByRole("button", { name: /Get 50 credits/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: 30_000 });
  const up = await page.request.post("/api/billing", { data: { action: "subscribe", plan_id: "pro" } });
  expect(up.ok()).toBeTruthy();

  await page.goto("/settings/keys");
  await page.getByTestId("key-label").fill("runs-e2e");
  await page.getByTestId("create-key").click();
  const keyEl = page.getByTestId("key-value");
  await expect(keyEl).toBeVisible({ timeout: 15_000 });
  const key = (await keyEl.textContent())!.trim();
  expect(key).toMatch(/^of_/);

  const ctx = await request.newContext({ baseURL });
  const auth = { Authorization: `Bearer ${key}` };

  /* ---- auth + malformed input ---- */

  expect((await ctx.get("/api/v1/runs/" + crypto.randomUUID())).status()).toBe(401);
  expect((await ctx.post("/api/v1/runs", { data: { plan: plan("x") } })).status()).toBe(401);

  const notJson = await ctx.post("/api/v1/runs", {
    headers: { ...auth, "content-type": "application/json" },
    data: "this is not json{",
  });
  expect(notJson.status()).toBe(400);
  expect((await notJson.json()).error.code).toBe("bad_request");

  const twoForms = await ctx.post("/api/v1/runs", {
    data: { plan: plan("x"), text: "also text" }, headers: auth,
  });
  expect(twoForms.status()).toBe(400);
  expect((await twoForms.json()).error.code).toBe("bad_request");

  const noForms = await ctx.post("/api/v1/runs", { data: { mode: "auto" }, headers: auth });
  expect(noForms.status()).toBe(400);

  // inputs only apply to text and skill runs - a literal plan can't take them
  const planInputs = await ctx.post("/api/v1/runs", {
    data: { plan: plan("x"), inputs: [{ url: "/files/uploads/x.png", mime: "image/png" }] },
    headers: auth,
  });
  expect(planInputs.status()).toBe(400);
  expect((await planInputs.json()).error.code).toBe("bad_request");

  const unknownSkill = await ctx.post("/api/v1/runs", {
    data: { skill: "no-such-skill", brief: "x" }, headers: auth,
  });
  expect(unknownSkill.status()).toBe(404);
  expect((await unknownSkill.json()).error.code).toBe("not_found");

  // over the 1MB body cap - a plan padded past the limit
  const huge = await ctx.post("/api/v1/runs", {
    data: { text: `x${"y".repeat(1100 * 1024)}` }, headers: auth,
  });
  expect(huge.status()).toBe(413);
  expect((await huge.json()).error.code).toBe("payload_too_large");

  /* ---- literal plan + ask_first gate ---- */

  const idem = `runs-e2e-${Date.now()}`;
  const mk = await ctx.post("/api/v1/runs", {
    data: { plan: plan("a lighthouse at dawn"), ask_first: true },
    headers: { ...auth, "Idempotency-Key": idem },
  });
  expect(mk.status(), `create: ${await mk.text()}`).toBe(201);
  const run = (await mk.json()) as RunView;
  expect(run.status).toBe("awaiting_approval");
  expect(run.ask_first).toBe(true);
  expect(run.steps.length).toBe(1);
  expect(run.steps[0].id).toBe("s1");
  expect(run.steps[0].status).toBe("pending");
  expect(run.steps[0].endpoint).toBe(EP);
  expect(run.steps[0].job_id).toBeNull();
  // the projection never leaks internals
  expect("params" in run.steps[0]).toBe(false);
  expect("session_id" in run).toBe(false);
  expect("user_id" in run).toBe(false);
  expect(run.links.self).toBe(`/api/v1/runs/${run.id}`);
  expect(run.links.approve).toBe(`/api/v1/runs/${run.id}/approve`);
  expect(run.links.control).toBe(`/api/v1/runs/${run.id}/control`);

  /* ---- idempotency ---- */

  const replay = await ctx.post("/api/v1/runs", {
    data: { plan: plan("a lighthouse at dawn"), ask_first: true },
    headers: { ...auth, "Idempotency-Key": idem },
  });
  expect(replay.status()).toBe(200);
  expect(((await replay.json()) as RunView).id).toBe(run.id);

  const mismatch = await ctx.post("/api/v1/runs", {
    data: { plan: plan("a different plan"), ask_first: true },
    headers: { ...auth, "Idempotency-Key": idem },
  });
  expect(mismatch.status()).toBe(422);
  expect((await mismatch.json()).error.code).toBe("idempotency_mismatch");

  /* ---- step edit while parked + optimistic concurrency ---- */

  const stepRev = run.steps[0].rev;
  const stale = await ctx.patch(`/api/v1/runs/${run.id}/steps/s1`, {
    data: { rev: stepRev + 9, params: { prompt: "stale" } }, headers: auth,
  });
  expect(stale.status()).toBe(409);
  const staleBody = await stale.json();
  expect(staleBody.error.code).toBe("stale_revision");
  expect(staleBody.error.head_rev).toBe(stepRev);

  const edit = await ctx.patch(`/api/v1/runs/${run.id}/steps/s1`, {
    data: { rev: stepRev, title: "the one true frame", params: { prompt: "a lighthouse at dusk" } },
    headers: auth,
  });
  expect(edit.status(), `edit: ${await edit.text()}`).toBe(200);
  const afterEdit = (await edit.json()) as RunView;
  expect(afterEdit.steps[0].title).toBe("the one true frame");
  expect(afterEdit.steps[0].rev).toBeGreaterThan(stepRev);

  const stale2 = await ctx.patch(`/api/v1/runs/${run.id}/steps/s1`, {
    data: { rev: stepRev, title: "stale again" }, headers: auth,
  });
  expect(stale2.status()).toBe(409);
  expect(((await stale2.json()).error as { code: string; head_rev: number }).code).toBe("stale_revision");

  const noStep = await ctx.patch(`/api/v1/runs/${run.id}/steps/nope`, {
    data: { rev: 0, title: "x" }, headers: auth,
  });
  expect(noStep.status()).toBe(404);

  /* ---- approve → run to done ---- */

  const approved = await ctx.post(`/api/v1/runs/${run.id}/approve`, { headers: auth });
  expect(approved.status()).toBe(200);
  expect(((await approved.json()) as RunView).status).toBe("running");

  // a parked run mints nothing - the job row appears after approve + ticks
  let view = {} as RunView;
  await expect.poll(async () => {
    view = (await (await ctx.get(`/api/v1/runs/${run.id}`, { headers: auth })).json()) as RunView;
    return view.status;
  }, { timeout: 120_000, intervals: [1000, 2000, 3000] }).toBe("done");
  expect(view.steps[0].status).toBe("done");
  expect(view.steps[0].job_id).toMatch(/^[0-9a-f-]{36}$/);
  expect((view.steps[0].outputs as { url?: string }[]).length).toBeGreaterThan(0);

  /* ---- control verbs ---- */

  const mk2 = await ctx.post("/api/v1/runs", {
    data: { plan: plan("a second lighthouse"), ask_first: true }, headers: auth,
  });
  const run2 = ((await mk2.json()) as RunView).id;
  await ctx.post(`/api/v1/runs/${run2}/approve`, { headers: auth });

  const pause = await ctx.post(`/api/v1/runs/${run2}/control`, {
    data: { action: "pause" }, headers: auth,
  });
  expect(pause.status()).toBe(200);
  expect(((await pause.json()) as RunView).status).toBe("paused");

  const resume = await ctx.post(`/api/v1/runs/${run2}/control`, {
    data: { action: "resume" }, headers: auth,
  });
  expect(resume.status()).toBe(200);
  expect(((await resume.json()) as RunView).status).toBe("running");

  const stop = await ctx.post(`/api/v1/runs/${run2}/control`, {
    data: { action: "stop" }, headers: auth,
  });
  expect(stop.status()).toBe(200);
  expect(((await stop.json()) as RunView).status).toBe("stopped");

  // terminal idempotency + a forbidden transition
  const stopAgain = await ctx.post(`/api/v1/runs/${run2}/control`, {
    data: { action: "stop" }, headers: auth,
  });
  expect(stopAgain.status()).toBe(200);
  const pauseStopped = await ctx.post(`/api/v1/runs/${run2}/control`, {
    data: { action: "pause" }, headers: auth,
  });
  expect(pauseStopped.status()).toBe(409);
  expect(((await pauseStopped.json()).error as { code: string }).code).toBe("conflict");

  const badAction = await ctx.post(`/api/v1/runs/${run2}/control`, {
    data: { action: "explode" }, headers: auth,
  });
  expect(badAction.status()).toBe(400);

  /* ---- text brief through the builtin planner; a dead pick falls back visibly ---- */

  const textRun = await ctx.post("/api/v1/runs", {
    data: { text: "make a 5-second clip of rain on a window", planner: "builtin" },
    headers: auth,
  });
  expect(textRun.status(), `text: ${await textRun.text()}`).toBe(201);
  const tv = (await textRun.json()) as RunView;
  expect(tv.planner.via).toBe("built-in planner");
  expect(tv.steps.length).toBeGreaterThan(0);

  const deadPick = await ctx.post("/api/v1/runs", {
    data: { text: "make a 5-second clip of rain on a window", planner: "not-a-provider:not-a-model" },
    headers: auth,
  });
  expect(deadPick.status(), `deadPick: ${await deadPick.text()}`).toBe(201);
  const dv = (await deadPick.json()) as RunView;
  // the failed pick is visible, never silent - fallback_reason tells the story
  expect(dv.planner.via).toBe("built-in planner");
  expect(dv.planner.fallback_reason).toContain("not-a-provider:not-a-model");

  /* ---- owner scoping: a second user's key sees 404s ---- */

  // a fresh context - ctx carries user A's session cookie, so signing up on
  // it would be rejected
  const ctx2 = await request.newContext({ baseURL });
  for (let attempt = 0; attempt < 4; attempt++) {
    const su2 = await ctx2.post("/api/auth/sign-up/email", {
      data: { email: `ws1runs-b-${Date.now()}-${attempt}@e2e.test`, password: "e2e-password-123", name: "WS1 Runs B" },
    });
    if (su2.ok()) break;
    if (attempt === 3) expect(su2.ok(), `signup-b: ${await su2.text()}`).toBeTruthy();
    await new Promise((r) => setTimeout(r, 500));
  }
  const k2 = await ctx2.post("/api/keys", { data: { label: "runs-e2e-b" } });
  const key2 = ((await k2.json()) as { key: string }).key;
  const auth2 = { Authorization: `Bearer ${key2}` };

  expect((await ctx.get(`/api/v1/runs/${run.id}`, { headers: auth2 })).status()).toBe(404);
  expect((await ctx.post(`/api/v1/runs/${run.id}/approve`, { headers: auth2 })).status()).toBe(404);
  expect((await ctx.post(`/api/v1/runs/${run.id}/control`, {
    data: { action: "stop" }, headers: auth2 })).status()).toBe(404);
  expect((await ctx.patch(`/api/v1/runs/${run.id}/steps/s1`, {
    data: { rev: 0, title: "x" }, headers: auth2 })).status()).toBe(404);
  await ctx2.dispose();
  expect((await ctx.get(`/api/v1/runs/${crypto.randomUUID()}`, { headers: auth })).status()).toBe(404);
  // a non-uuid id is a clean 404, not a 500
  expect((await ctx.get("/api/v1/runs/not-a-uuid", { headers: auth })).status()).toBe(404);

  await ctx.dispose();
});

test("[#122] v1 runs - same-key race mints one run; chained run → done; rerun edit; pause window", async ({ baseURL }) => {
  test.setTimeout(300_000);
  const ctx = await request.newContext({ baseURL });
  const email = `ws1runs2-${Date.now()}@e2e.test`;

  const su = await ctx.post("/api/auth/sign-up/email", {
    data: { email, password: "e2e-password-123", name: "WS1 Runs E2E 2" },
  });
  expect(su.ok(), `signup failed: ${await su.text()}`).toBeTruthy();
  const up = await ctx.post("/api/billing", { data: { action: "subscribe", plan_id: "pro" } });
  expect(up.ok()).toBeTruthy();
  const k = await ctx.post("/api/keys", { data: { label: "runs-e2e-2" } });
  const key = ((await k.json()) as { key: string }).key;
  const auth = { Authorization: `Bearer ${key}` };

  /* ---- concurrent same-key creates mint exactly one run ---- */

  const countRuns = async () =>
    (((await (await ctx.get("/api/agent/runs")).json()) as { runs: { id: string }[] }).runs).length;
  const before = await countRuns();
  const idem = `runs-race-${Date.now()}`;
  const body = { plan: plan("a race to the lighthouse"), ask_first: true };
  const res = await Promise.all(Array.from({ length: 3 }, () =>
    ctx.post("/api/v1/runs", { data: body, headers: { ...auth, "Idempotency-Key": idem } })));
  // each request either wins (201), replays the winner (200) or found the
  // reservation still in flight (409 - a later retry replays)
  for (const s of res.map((r) => r.status())) expect([200, 201, 409]).toContain(s);
  const okIds = new Set<string>();
  for (const r of res) if (r.status() !== 409) okIds.add(((await r.json()) as RunView).id);
  expect(okIds.size).toBe(1);
  const runId = [...okIds][0];
  // a same-key retry after the fact replays the winner
  const replay = await ctx.post("/api/v1/runs", {
    data: body, headers: { ...auth, "Idempotency-Key": idem },
  });
  expect(replay.status()).toBe(200);
  expect(((await replay.json()) as RunView).id).toBe(runId);
  // exactly one new agent_runs row - no double mint under the race
  expect(await countRuns()).toBe(before + 1);

  /* ---- chained two-step run: outputs carry {url,type,bytes} ---- */

  const mk = await ctx.post("/api/v1/runs", {
    data: { plan: chain("a lighthouse at dawn", "make it dusk"), ask_first: true },
    headers: auth,
  });
  expect(mk.status(), `chain create: ${await mk.text()}`).toBe(201);
  const chained = (await mk.json()) as RunView;
  expect(chained.status).toBe("awaiting_approval");
  expect(chained.steps.map((s) => s.depends_on)).toEqual([[], ["s1"]]);

  await ctx.post(`/api/v1/runs/${chained.id}/approve`, { headers: auth });
  let view = {} as RunView;
  await expect.poll(async () => {
    view = (await (await ctx.get(`/api/v1/runs/${chained.id}`, { headers: auth })).json()) as RunView;
    return view.status;
  }, { timeout: 180_000, intervals: [1000, 2000, 3000] }).toBe("done");

  const jobIds: Record<string, string> = {};
  for (const s of view.steps) {
    expect(s.status).toBe("done");
    expect(s.job_id).toMatch(/^[0-9a-f-]{36}$/);
    jobIds[s.id] = s.job_id!;
    expect(s.outputs.length).toBeGreaterThan(0);
    for (const o of s.outputs) {
      expect(o.url).toMatch(/^\/files\//);
      expect(o.type).toMatch(/^image\//);
      expect(o.bytes, `${s.id} output bytes`).toBeGreaterThan(0);
    }
  }
  // the minted job serves real bytes - the same artifact the step recorded
  const res1 = await ctx.get(`/api/v1/jobs/${jobIds.s1}/result`, { headers: auth });
  expect(res1.status()).toBe(200);
  expect((await res1.body()).byteLength).toBeGreaterThan(0);

  /* ---- a done-run edit re-submits the step AND its downstream dep ---- */

  const rev = view.steps[0].rev;
  const edit = await ctx.patch(`/api/v1/runs/${chained.id}/steps/s1`, {
    data: { rev, params: { prompt: "a lighthouse at golden hour" } }, headers: auth,
  });
  expect(edit.status(), `rerun edit: ${await edit.text()}`).toBe(200);
  const edited = (await edit.json()) as RunView;
  // ask_first re-gates the reopened delta - approve releases it again
  expect(edited.status).toBe("awaiting_approval");
  expect(edited.steps[0].rev).toBeGreaterThan(rev);
  expect(edited.steps[0].status).toBe("pending");
  expect(edited.steps[1].status).toBe("pending");

  await ctx.post(`/api/v1/runs/${chained.id}/approve`, { headers: auth });
  let view2 = {} as RunView;
  await expect.poll(async () => {
    view2 = (await (await ctx.get(`/api/v1/runs/${chained.id}`, { headers: auth })).json()) as RunView;
    return view2.status;
  }, { timeout: 180_000, intervals: [1000, 2000, 3000] }).toBe("done");
  expect(view2.steps[0].job_id).not.toBe(jobIds.s1); // new job, not a replay
  expect(view2.steps[1].job_id).not.toBe(jobIds.s2); // downstream re-ran too
  expect(view2.steps.every((s) => s.status === "done")).toBe(true);
  for (const s of view2.steps) for (const o of s.outputs) {
    expect(o.type).toMatch(/^image\//);
    expect(o.bytes).toBeGreaterThan(0);
  }
  // the rerun submitted the EDITED spec - the new job's stored params carry
  // the replacement prompt verbatim
  const job1 = await ctx.get(`/api/v1/jobs/${view2.steps[0].job_id}`, { headers: auth });
  expect(job1.status()).toBe(200);
  expect(((await job1.json()) as { params: { prompt?: string } }).params?.prompt)
    .toBe("a lighthouse at golden hour");

  /* ---- pause holds downstream work for a real window; resume releases ---- */

  const mk3 = await ctx.post("/api/v1/runs", {
    data: { plan: chain("pause me", "then finish"), ask_first: true }, headers: auth,
  });
  const run3 = ((await mk3.json()) as RunView).id;
  await ctx.post(`/api/v1/runs/${run3}/approve`, { headers: auth });
  const pause = await ctx.post(`/api/v1/runs/${run3}/control`, {
    data: { action: "pause" }, headers: auth,
  });
  expect(pause.status()).toBe(200);

  // a paused run still reconciles its in-flight step - s1 may finish, but
  // s2 must stay pending for the whole held window
  const holdUntil = Date.now() + 11_000;
  let sawS1Done = false;
  while (Date.now() < holdUntil) {
    const v = (await (await ctx.get(`/api/v1/runs/${run3}`, { headers: auth })).json()) as RunView;
    expect(v.status).toBe("paused");
    expect(v.steps[1].status).toBe("pending");
    expect(v.steps[1].job_id).toBeNull();
    if (v.steps[0].status === "done") sawS1Done = true;
    await new Promise((r) => setTimeout(r, 1200));
  }
  expect(sawS1Done, "the in-flight step should have reconciled to done while paused").toBe(true);

  const resume = await ctx.post(`/api/v1/runs/${run3}/control`, {
    data: { action: "resume" }, headers: auth,
  });
  expect(resume.status()).toBe(200);
  await expect.poll(async () => {
    const v = (await (await ctx.get(`/api/v1/runs/${run3}`, { headers: auth })).json()) as RunView;
    return v.status;
  }, { timeout: 120_000, intervals: [1000, 2000, 3000] }).toBe("done");

  /* ---- a fourth run stops mid-flight ---- */

  const mk4 = await ctx.post("/api/v1/runs", {
    data: { plan: chain("stop me", "never mind"), ask_first: true }, headers: auth,
  });
  const run4 = ((await mk4.json()) as RunView).id;
  await ctx.post(`/api/v1/runs/${run4}/approve`, { headers: auth });
  const stop = await ctx.post(`/api/v1/runs/${run4}/control`, {
    data: { action: "stop" }, headers: auth,
  });
  expect(stop.status()).toBe(200);
  expect(((await stop.json()) as RunView).status).toBe("stopped");
  const stoppedView = (await (await ctx.get(`/api/v1/runs/${run4}`, { headers: auth })).json()) as RunView;
  expect(stoppedView.status).toBe("stopped");
  // the executor lands a never-submitted pending step as canceled - not just
  // "not done": the run mustn't leave a dangling pending row behind
  expect(stoppedView.steps[1].status).toBe("canceled");

  await ctx.dispose();
});

test("[#122][OF-0757][OF-0759] v1 runs - catalog skills take brief/answers/inputs and produce the skill's own steps", async ({ baseURL }) => {
  test.setTimeout(300_000);
  const ctx = await request.newContext({ baseURL });
  const email = `ws1skills-${Date.now()}@e2e.test`;

  const su = await ctx.post("/api/auth/sign-up/email", {
    data: { email, password: "e2e-password-123", name: "WS1 Skills E2E" },
  });
  expect(su.ok(), `signup failed: ${await su.text()}`).toBeTruthy();
  const up = await ctx.post("/api/billing", { data: { action: "subscribe", plan_id: "pro" } });
  expect(up.ok()).toBeTruthy();
  const k = await ctx.post("/api/keys", { data: { label: "skills-e2e" } });
  const key = ((await k.json()) as { key: string }).key;
  const auth = { Authorization: `Bearer ${key}` };

  // real fixtures: a real mp4 (ffmpeg, the same lavfi the other specs use) +
  // a real PNG upload - the media params the skill steps leave unset
  const tmp = mkdtempSync(join(tmpdir(), "of-skill-e2e-"));
  const clip = join(tmp, "clip.mp4");
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=320x180:d=2:r=24",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
  ]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const upVideo = await ctx.post("/api/v1/uploads", {
    headers: auth,
    multipart: { file: { name: "clip.mp4", mimeType: "video/mp4", buffer: readFileSync(clip) } },
  });
  expect(upVideo.status(), `video upload: ${await upVideo.text()}`).toBe(201);
  const videoUrl = ((await upVideo.json()) as { url: string }).url;
  expect(videoUrl).toMatch(/^\/files\/uploads\//);
  const upImage = await ctx.post("/api/v1/uploads", {
    headers: auth,
    multipart: { file: { name: "in.png", mimeType: "image/png", buffer: png } },
  });
  expect(upImage.status(), `image upload: ${await upImage.text()}`).toBe(201);
  const imageUrl = ((await upImage.json()) as { url: string }).url;

  /** assert the created run's steps are the skill's own pipeline - titles and
   *  endpoints exactly as `skill.steps(brief, answers)` lays them out */
  const expectSkillSteps = (
    run: RunView, slug: string, brief: string, answers?: Record<string, string>,
  ) => {
    const skill = SKILLS.find((s) => s.id === slug);
    expect(skill, `catalog has ${slug}`).toBeTruthy();
    const want = skill!.steps(brief, answers ?? {});
    expect(run.steps.map((s) => s.title)).toEqual(want.map((s) => s.label));
    expect(run.steps.map((s) => s.endpoint)).toEqual(want.map((s) => s.endpoint));
    expect(run.planner.via).toBe(`skill·${slug}`);
  };

  /* narrated-explainer - a brief + intake answers, no media needed */
  const ne = await ctx.post("/api/v1/runs", {
    data: {
      skill: "narrated-explainer", brief: "how rain forms",
      answers: { scenes: "3", voice: "Bright female (af_sky)", style: "Whiteboard", aspect: "16:9" },
      ask_first: true,
    },
    headers: auth,
  });
  expect(ne.status(), `narrated-explainer: ${await ne.text()}`).toBe(201);
  const neRun = (await ne.json()) as RunView;
  expectSkillSteps(neRun, "narrated-explainer", "how rain forms",
    { scenes: "3", voice: "Bright female (af_sky)", style: "Whiteboard", aspect: "16:9" });
  // answers reach params - the agent view carries them verbatim
  const neFull = (await (await ctx.get(`/api/agent/runs/${neRun.id}`)).json()) as {
    run: { steps: { params: Record<string, unknown> }[] };
  };
  expect(neFull.run.steps[0].params.voice).toBe("af_sky");
  expect(neFull.run.steps[0].params.aspect_ratio).toBe("16:9");

  /* plate-cleanup - an instruction + an uploaded image fill image_url */
  const pc = await ctx.post("/api/v1/runs", {
    data: {
      skill: "plate-cleanup", brief: "the festival photo",
      answers: { remove: "the trash can" },
      inputs: [{ url: imageUrl, mime: "image/png" }],
      ask_first: true,
    },
    headers: auth,
  });
  expect(pc.status(), `plate-cleanup: ${await pc.text()}`).toBe(201);
  const pcRun = (await pc.json()) as RunView;
  expectSkillSteps(pcRun, "plate-cleanup", "the festival photo", { remove: "the trash can" });
  const pcFull = (await (await ctx.get(`/api/agent/runs/${pcRun.id}`)).json()) as {
    run: { steps: { params: Record<string, unknown> }[] };
  };
  expect(pcFull.run.steps[0].params.image_url).toBe(imageUrl);
  expect(String(pcFull.run.steps[0].params.prompt)).toContain("the trash can");

  /* video-reframe - an uploaded video fills video_url */
  const vr = await ctx.post("/api/v1/runs", {
    data: {
      skill: "video-reframe", brief: "the launch clip",
      answers: { ratio: "9:16" },
      inputs: [{ url: videoUrl, mime: "video/mp4" }],
      ask_first: true,
    },
    headers: auth,
  });
  expect(vr.status(), `video-reframe: ${await vr.text()}`).toBe(201);
  const vrRun = (await vr.json()) as RunView;
  expectSkillSteps(vrRun, "video-reframe", "the launch clip", { ratio: "9:16" });
  const vrFull = (await (await ctx.get(`/api/agent/runs/${vrRun.id}`)).json()) as {
    run: { steps: { params: Record<string, unknown> }[] };
  };
  expect(vrFull.run.steps[0].params.video_url).toBe(videoUrl);
  expect(vrFull.run.steps[0].params.aspect_ratio).toBe("9:16");

  /* image-upscaler - second input-consuming skill; the url is used once */
  const iu = await ctx.post("/api/v1/runs", {
    data: {
      skill: "image-upscaler", brief: "a soft product shot",
      answers: { scale: "2×" },
      inputs: [{ url: imageUrl, mime: "image/png" }],
      ask_first: true,
    },
    headers: auth,
  });
  expect(iu.status(), `image-upscaler: ${await iu.text()}`).toBe(201);
  const iuRun = (await iu.json()) as RunView;
  expectSkillSteps(iuRun, "image-upscaler", "a soft product shot", { scale: "2×" });
  const iuFull = (await (await ctx.get(`/api/agent/runs/${iuRun.id}`)).json()) as {
    run: { steps: { params: Record<string, unknown> }[] };
  };
  expect(iuFull.run.steps[0].params.image_url).toBe(imageUrl);
  expect(iuFull.run.steps[0].params.scale).toBe(2);

  /* [OF-0759] short-maker - the t2i → i2v chain runs end to end: approve,
   * poll to done, both steps carry real output bytes */
  const sm = await ctx.post("/api/v1/runs", {
    data: {
      skill: "short-maker", brief: "a lighthouse on a cliff",
      answers: { platform: "Reels" }, ask_first: true,
    },
    headers: auth,
  });
  expect(sm.status(), `short-maker: ${await sm.text()}`).toBe(201);
  const smRun = (await sm.json()) as RunView;
  expectSkillSteps(smRun, "short-maker", "a lighthouse on a cliff", { platform: "Reels" });
  // s2's frame is the $step ref the skill left unset - wired to s1's output
  const smFull = (await (await ctx.get(`/api/agent/runs/${smRun.id}`)).json()) as {
    run: { steps: { params: Record<string, unknown> }[] };
  };
  expect(smFull.run.steps[1].params.image_url).toBe("$step:s1.outputs[0]");

  await ctx.post(`/api/v1/runs/${smRun.id}/approve`, { headers: auth });
  let smView = {} as RunView;
  await expect.poll(async () => {
    smView = (await (await ctx.get(`/api/v1/runs/${smRun.id}`, { headers: auth })).json()) as RunView;
    return smView.status;
  }, { timeout: 180_000, intervals: [1000, 2000, 3000] }).toBe("done");
  for (const s of smView.steps) {
    expect(s.status).toBe("done");
    expect(s.outputs.length).toBeGreaterThan(0);
    for (const o of s.outputs) expect(o.bytes).toBeGreaterThan(0);
  }

  /* [OF-0757] ugc-ad - product + creator uploads ride `inputs` into step 1's
   * media params (agent view, where params are visible) */
  const upProduct = await ctx.post("/api/v1/uploads", {
    headers: auth,
    multipart: { file: { name: "product.png", mimeType: "image/png", buffer: png } },
  });
  expect(upProduct.status(), `product upload: ${await upProduct.text()}`).toBe(201);
  const productUrl = ((await upProduct.json()) as { url: string }).url;
  const upCreator = await ctx.post("/api/v1/uploads", {
    headers: auth,
    multipart: { file: { name: "creator.png", mimeType: "image/png", buffer: png } },
  });
  expect(upCreator.status(), `creator upload: ${await upCreator.text()}`).toBe(201);
  const creatorUrl = ((await upCreator.json()) as { url: string }).url;

  const ua = await ctx.post("/api/v1/runs", {
    data: {
      skill: "ugc-ad", brief: "an insulated water bottle",
      answers: { hook: "Unboxing" },
      inputs: [{ url: productUrl, mime: "image/png" }, { url: creatorUrl, mime: "image/png" }],
      ask_first: true,
    },
    headers: auth,
  });
  expect(ua.status(), `ugc-ad: ${await ua.text()}`).toBe(201);
  const uaRun = (await ua.json()) as RunView;
  expectSkillSteps(uaRun, "ugc-ad", "an insulated water bottle", { hook: "Unboxing" });
  const uaFull = (await (await ctx.get(`/api/agent/runs/${uaRun.id}`)).json()) as {
    run: { steps: { params: Record<string, unknown> }[] };
  };
  // the product upload fills step 1's product slot, the creator photo the
  // scene slot (each input used once, in order), and step 2's frame chains
  // off step 1's hero shot - the same fill order the app applies
  expect(uaFull.run.steps[0].params.product_image_url).toBe(productUrl);
  expect(uaFull.run.steps[0].params.image_url).toBe(creatorUrl);
  expect(uaFull.run.steps[1].params.image_url).toBe("$step:s1.outputs[0]");

  /* @ref names in a v1 text brief resolve against the caller's own refs
   * (the s11 carry-in): @hero's stored /files/ image lands in the step's
   * media param, and an unknown name is a plain 422, never a guess */
  const refRes = await ctx.post("/api/refs", {
    data: { name: "hero", category: "character", kind: "person",
      likeness_consent: true, images: [imageUrl] },
  });
  expect(refRes.status(), `ref create: ${await refRes.text()}`).toBe(201);
  const refRun = await ctx.post("/api/v1/runs", {
    data: { text: "a clip of @hero", planner: "builtin", ask_first: true },
    headers: auth,
  });
  expect(refRun.status(), `@ref run: ${await refRun.text()}`).toBe(201);
  const refRunId = ((await refRun.json()) as RunView).id;
  const refFull = (await (await ctx.get(`/api/agent/runs/${refRunId}`)).json()) as {
    run: { steps: { params: Record<string, unknown> }[] };
  };
  expect(refFull.run.steps[0].params.image_url).toBe(imageUrl);

  const missing = await ctx.post("/api/v1/runs", {
    data: { text: "a clip of @ghost", planner: "builtin" }, headers: auth,
  });
  expect(missing.status()).toBe(422);
  const missingErr = (await missing.json()) as { error: { code: string; message: string } };
  expect(missingErr.error.code).toBe("unprocessable_entity");
  expect(missingErr.error.message).toContain("@ghost");

  // the skills API lists every slug these runs used
  const listed = await ctx.get("/api/v1/skills", { headers: auth });
  const slugs = ((await listed.json()) as { skills: { slug: string }[] }).skills.map((s) => s.slug);
  for (const slug of ["narrated-explainer", "plate-cleanup", "video-reframe", "image-upscaler",
    "short-maker", "ugc-ad"])
    expect(slugs).toContain(slug);

  await ctx.dispose();
});
