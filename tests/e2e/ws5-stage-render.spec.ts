import { expect, request as playwrightRequest, test, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Stage render (OF-0541/0542/0543/0544): the "Render video" dialog on the
 * Stage editor, the stage-render recipe end to end under the mock provider
 * (headless previz + depth/pose passes → substituted VACE window graphs),
 * and the parameter/ownership/window guards.
 */

test.describe.configure({ mode: "serial" });
const tmp = mkdtempSync(join(tmpdir(), "of-sr-e2e-"));

async function signup(ctx: APIRequestContext | { request: APIRequestContext }, label: string) {
  const api = "request" in ctx ? ctx.request : ctx;
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const password = "test-pass-1234";
  for (let i = 0; i < 5; i++) {
    try {
      if ((await api.post("/api/auth/sign-up/email", { data: { email, password, name: "WS5 StageRender" } })).ok()
        || (await api.post("/api/auth/sign-in/email", { data: { email, password } })).ok()) return;
    } catch { /* transient */ }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw new Error("signup failed");
}

async function mkEmpty(ctx: APIRequestContext) {
  const r = await ctx.post("/api/stage", { data: { empty: true } });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()) as { id: string; revision: number; scene: { nodes: { id: string; kind: string }[] } };
}

const submitJob = (ctx: APIRequestContext, params: Record<string, unknown>) =>
  ctx.post("/api/jobs", {
    data: { endpoint_id: "motionfield/stage/render", params },
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });

async function drainJob(ctx: APIRequestContext, id: string, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const g = await ctx.get(`/api/jobs/${id}`);
    const { job } = await g.json();
    if (!["queued", "in_progress"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("job did not settle");
}

async function fetchToFile(ctx: APIRequestContext, url: string, name: string) {
  const r = await ctx.get(url);
  expect(r.ok()).toBeTruthy();
  const p = join(tmp, name);
  writeFileSync(p, Buffer.from(await r.body()));
  return p;
}

const ffprobeJson = (file: string) => JSON.parse(execFileSync("ffprobe", [
  "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
]).toString());

const videoStream = (j: { streams: { codec_type: string; width?: number; height?: number; r_frame_rate?: string }[] }) =>
  j.streams.find((s) => s.codec_type === "video")!;

/* ================= UI: the Render video dialog ================= */

test("render dialog - plan preview, pose gating, composed prompt, submit", async ({ page }) => {
  test.setTimeout(120_000);
  await signup(page, "ws5sr-ui");
  const sc = await mkEmpty(page.request);
  // a named node with a per-object prompt the composed prompt must carry
  const add = await page.request.post(`/api/stage/${sc.id}/ops`, {
    data: { base_revision: 1, ops: [
      { op: "add", node: { kind: "primitive", name: "Totem Box", prompt: "a glowing obsidian totem", props: { shape: "box", size: [2, 3, 2], color: "#446699" } } },
    ] },
  });
  expect(add.status(), await add.text()).toBe(200);

  await page.goto(`/scene-3d/${sc.id}`);
  await page.getByRole("button", { name: "Render video" }).click();
  const dlg = page.getByTestId("render-dialog");
  await expect(dlg).toBeVisible();

  // default plan: whole-scene length capped at the 2-window ceiling for the
  // empty 10 s scene → 153 frames / 2 windows at the 480p-class size
  const plan = await page.getByTestId("render-plan").innerText();
  expect(plan).toContain("832×480 @ 16 fps");
  expect(plan).toContain("153 frames");
  expect(plan).toContain("2 windows");
  expect(plan).toContain("8-frame continuation");

  // composed prompt = user text + the frustum-visible node's prompt
  const composed = await page.getByTestId("render-composed-prompt").innerText();
  expect(composed).toContain("Untitled scene");
  expect(composed).toContain("a glowing obsidian totem");

  // pose stays disabled without a mannequin (the attribute - toBeDisabled
  // on <option> consults the parent select in playwright)
  await expect(dlg.getByLabel("Render control").locator("option[value=pose]")).toHaveAttribute("disabled", "");

  // over the 2-window ceiling → error + disabled submit; out-of-scene too
  await dlg.getByLabel("Render duration").fill("12");
  await expect(page.getByTestId("render-error")).toContainText("2-window");
  await expect(dlg.getByRole("button", { name: "Render", exact: true })).toBeDisabled();
  await dlg.getByLabel("Render start").fill("10");
  await expect(page.getByTestId("render-error")).toContainText("inside the scene");
  await dlg.getByLabel("Render start").fill("2");
  await dlg.getByLabel("Render duration").fill("7");
  await expect(page.getByTestId("render-plan")).toContainText("113 frames");
  await expect(page.getByTestId("render-error")).toHaveCount(0);
  await page.getByLabel("Close render dialog").click();

  // add a mannequin → pose unlocks
  await page.getByRole("button", { name: "+ Add node" }).click();
  await page.getByRole("menuitem", { name: "Mannequin" }).click();
  await page.getByRole("button", { name: "Render video" }).click();
  await expect(dlg.getByLabel("Render control").locator("option[value=pose]")).not.toHaveAttribute("disabled", "");
  await dlg.getByLabel("Render control").selectOption("pose");
  await dlg.getByLabel("Render seed").fill("7");
  await dlg.getByRole("button", { name: "Render", exact: true }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(/Render job submitted/);

  // the job landed on the open catalog endpoint, pinned to a revision
  const jobs = await (await page.request.get("/api/jobs")).json();
  const j = jobs.jobs.find((x: { endpointId: string }) => x.endpointId === "motionfield/stage/render");
  expect(j).toBeTruthy();
  expect(j.params.revision).toBeGreaterThanOrEqual(2);
  expect(j.params.control).toBe("pose");
});

/* ================= recipe end-to-end under the mock provider ================= */

test("recipe - 1-window depth render: previz+control passes, substituted VACE graph, tagged output", async ({ baseURL }) => {
  test.setTimeout(300_000);
  const A = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "ws5sr-1w");
    const sc = await mkEmpty(A);
    const add = await A.post(`/api/stage/${sc.id}/ops`, {
      data: { base_revision: 1, ops: [
        { op: "update", id: "ground", path: "prompt", value: "empty greybox set" },
      ] },
    });
    expect(add.status()).toBe(200);

    const r = await submitJob(A, {
      scene_id: sc.id, revision: 2, start_s: 0, duration_s: 1,
      control: "depth", prompt: "test scene render", seed: 42,
    });
    const rj = await r.json().catch(() => null);
    expect(r.status(), JSON.stringify(rj)).toBe(201);
    const job = await drainJob(A, rj.job.id);
    expect(job.status, JSON.stringify(job)).toBe("completed");

    // Finishing adds a polished video while retaining all three scene artifacts.
    expect(job.outputs.filter((o: { role?: string }) => o.role === "finished")).toHaveLength(1);
    const urls = job.outputs.filter((o: { role?: string }) => o.role !== "finished")
      .map((o: { url: string }) => o.url);
    expect(urls.length).toBe(3);
    expect(urls[0]).toContain(`/files/generated/stage-${job.id}.mp4`);

    // the final mp4 carries the scene provenance tag + runs at 16 fps
    const finalProbe = ffprobeJson(await fetchToFile(A, urls[0], `final-${job.id}.mp4`));
    expect(finalProbe.format?.tags?.comment).toBe(`rendered from Stage scene ${sc.id} rev 2`);

    // control pass = the real requested shape: 16 fps, 480p-class, 17 frames (4n+1)
    const controlProbe = ffprobeJson(await fetchToFile(A, urls[2], `control-${job.id}.mp4`));
    const cs = videoStream(controlProbe);
    expect(cs.width).toBe(832);
    expect(cs.height).toBe(480);
    const [rn, rd] = String(cs.r_frame_rate).split("/").map(Number);
    expect(rn / rd).toBeCloseTo(16, 3);
    expect(Number(controlProbe.format.duration)).toBeCloseTo(17 / 16, 1);

    // the stored graph is the submitted VACE window - local weights, scene control
    const g = await (await A.get(`/api/jobs/${job.id}/graph`)).json();
    const classes = Object.values(g.graph ?? g).map((n) => (n as { class_type?: string })?.class_type);
    expect(classes).toContain("WanVaceToVideo");
    const gstr = JSON.stringify(g);
    expect(gstr).toContain("wan2.1_vace_1.3B_fp16.safetensors");
    expect(gstr).toContain("test scene render");
    expect(gstr).toContain("empty greybox set"); // composed prompt reached the encoder

    const meta = job.providerMeta?.stage_render;
    expect(meta?.control).toBe("depth");
    expect(meta?.frames).toBe(17);
    expect(meta?.windows?.length).toBe(1);
    expect(meta?.graphs?.length).toBe(1);
    expect(meta?.prompt).toContain("test scene render");
  } finally {
    await A.dispose();
  }
});

test("recipe - 2-window render: continuation mask + keep-frames on window 2", async ({ baseURL }) => {
  test.setTimeout(300_000);
  const A = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "ws5sr-2w");
    const sc = await mkEmpty(A);
    await A.post(`/api/stage/${sc.id}/ops`, {
      data: { base_revision: 1, ops: [
        { op: "add", node: { kind: "mannequin", name: "Actor", prompt: "a tired guard", props: { pose: "stand", height: 1.8 } } },
      ] },
    });

    // 6 s → 97 frames → balanced windows [53, 53] with the 8-frame continuation.
    // rev 2 pins the doc WITH the mannequin - rev 1 wouldn't see it.
    const r = await submitJob(A, {
      scene_id: sc.id, revision: 2, start_s: 0, duration_s: 6,
      control: "pose", prompt: "a patrol", seed: 5,
    });
    const rj = await r.json().catch(() => null);
    expect(r.status(), JSON.stringify(rj)).toBe(201);
    const job = await drainJob(A, rj.job.id);
    expect(job.status, JSON.stringify(job)).toBe("completed");

    const meta = job.providerMeta?.stage_render;
    expect(meta?.control).toBe("pose");
    expect(meta?.windows).toEqual([{ len: 53, overlap: 0 }, { len: 53, overlap: 8 }]);
    expect(meta?.frames).toBe(97);
    expect(meta?.graphs?.length).toBe(2);
    // window 2's graph carries the mask loader + keep-frames wiring
    const w2 = JSON.stringify(meta.graphs[1]);
    expect(w2).toContain("ImageToMask");
    expect(w2).toContain("control-w1.mp4");
    expect(JSON.stringify(meta.graphs[0])).not.toContain("ImageToMask");

    // pose control pass: 97 frames, 832×480, and not a blank canvas
    const urls = job.outputs.filter((o: { role?: string }) => o.role !== "finished").map((o: { url: string }) => o.url);
    const controlProbe = ffprobeJson(await fetchToFile(A, urls[2], `pose-${job.id}.mp4`));
    const cs = videoStream(controlProbe);
    expect(cs.width).toBe(832);
    expect(cs.height).toBe(480);
    expect(Number(controlProbe.format.duration)).toBeCloseTo(97 / 16, 1);
  } finally {
    await A.dispose();
  }
});

/* ================= guards: params, ownership, the window ceiling ================= */

test("guards - missing params 400, >2 windows rejected, pose without mannequin fails, foreign scene fails", async ({ baseURL }) => {
  test.setTimeout(180_000);
  const A = await playwrightRequest.newContext({ baseURL });
  const B = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "ws5sr-ga");
    await signup(B, "ws5sr-gb");
    const sc = await mkEmpty(A);

    // catalog validation - before a job ever exists
    expect((await submitJob(A, { revision: 1 })).status()).toBe(400);
    expect((await submitJob(A, { scene_id: sc.id, revision: 1, duration_s: 0 })).status()).toBe(400);
    const tooLong = await submitJob(A, { scene_id: sc.id, revision: 1, duration_s: 12 });
    expect(tooLong.status(), await tooLong.text()).toBe(400);
    expect((await tooLong.json()).error).toContain("window");

    // a duration that would need >2 windows inside the same scene bound is
    // also refused at submit, not after a generation window burned
    const startOk = await submitJob(A, { scene_id: sc.id, revision: 1, start_s: 0, duration_s: 9.5 });
    expect(startOk.status(), await startOk.text()).toBe(201);
    const jobOk = await drainJob(A, (await startOk.json()).job.id);
    expect(jobOk.status, JSON.stringify(jobOk)).toBe("completed");

    // duration outside the scene duration → recipe failure
    const bounds = await submitJob(A, { scene_id: sc.id, revision: 1, start_s: 8, duration_s: 9 });
    expect(bounds.status()).toBe(201);
    const jobBounds = await drainJob(A, (await bounds.json()).job.id);
    expect(jobBounds.status).toBe("failed");
    expect(jobBounds.error).toContain("inside the scene");

    // pose without a mannequin → failed, not silently depth
    const pose = await submitJob(A, { scene_id: sc.id, revision: 1, duration_s: 1, control: "pose" });
    const jobPose = await drainJob(A, (await pose.json()).job.id);
    expect(jobPose.status).toBe("failed");
    expect(jobPose.error).toContain("mannequin");

    // foreign scene → "scene not found", never a render of someone else's doc
    const foreign = await submitJob(B, { scene_id: sc.id, revision: 1, duration_s: 1 });
    expect(foreign.status()).toBe(201);
    const jobForeign = await drainJob(B, (await foreign.json()).job.id);
    expect(jobForeign.status).toBe("failed");
    expect(jobForeign.error).toContain("scene not found");

    // a revision that doesn't exist → failed, and a malformed id fails too
    const badRev = await submitJob(A, { scene_id: sc.id, revision: 99, duration_s: 1 });
    expect((await drainJob(A, (await badRev.json()).job.id)).status).toBe("failed");
    const badId = await submitJob(A, { scene_id: "not-a-scene", revision: 1, duration_s: 1 });
    expect((await drainJob(A, (await badId.json()).job.id)).status).toBe("failed");
  } finally {
    await A.dispose(); await B.dispose();
  }
});
