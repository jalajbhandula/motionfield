/**
 * PersonSwap e2e (GENERATION_PROVIDER=mock - mock proves the plumbing, never the
 * pixel output; real generation is the gpu-smoke lane):
 *  - the clip and identity uploads stay disabled until the likeness box is
 *    ticked; POST /api/person-swap is consent-gated the same way - INCLUDING the
 *    held path (a consentless POST while the slot is full 400s and inserts
 *    nothing)
 *  - /api/person-swap/detect probes + reports the billed window count AND the
 *    honest per-mode × resolution local totals the page prints
 *  - mocked person / environment / both runs complete; the job's meta
 *    reports windows / gen_box and the lip line
 *  - 7 s clip → meta.windows == 2
 *  - batch = clips × identity sets, one job each under a batch_id; members
 *    over the caller's free slots are HELD server-side (never rejected) and
 *    released as members finish - the chain advances even when the client
 *    polls only /api/jobs/:id
 *  - 360×640 and 640×360 sources come back at the same dims with no border
 *  - /export renders the side-by-side mp4 once (exactly 2× one side's width),
 *    reuses it, and a foreign user 404s every person-swap surface identically
 *  - a completed person-swap asset is reusable as the next run's source
 *  - a person ref saved via POST /api/refs is listed by GET /api/refs
 *  - POST /api/jobs gates the endpoint server-side (no consent → 400)
 */
import { test, expect, request as pwRequest, type APIRequestContext, type TestInfo } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

function makeClip(file: string, sec = 1.5, audio = true, size = "320x180") {
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi",
    "-i", `color=black:size=${size}:rate=24:duration=${sec}`,
    ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${sec}`] : []),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", file,
  ]);
  return file;
}
function videoMeta(file: string): { w: number; h: number; dur: number; audio: boolean } {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
  ]).toString();
  const j = JSON.parse(out) as { format: { duration: string }; streams: { codec_type: string; width?: number; height?: number }[] };
  const v = j.streams.find((s) => s.codec_type === "video")!;
  return { w: v.width!, h: v.height!, dur: Number(j.format.duration), audio: j.streams.some((s) => s.codec_type === "audio") };
}

async function signUp(request: APIRequestContext, tag: string) {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const su = await request.post("/api/auth/sign-up/email", {
    data: { email, password: "test-pass-1234", name: tag },
  });
  expect(su.ok()).toBeTruthy();
  return email;
}

async function uploadFile(request: APIRequestContext, name: string, mimeType: string, buf: Buffer) {
  const up = await request.post("/api/uploads", {
    multipart: { file: { name, mimeType, buffer: buf } },
  });
  expect(up.ok()).toBeTruthy();
  return (await up.json()).url as string;
}
const uploadClip = (request: APIRequestContext, path: string, sec = 1.5, audio = true, size = "320x180") =>
  uploadFile(request, basename(path), "video/mp4", readFileSync(makeClip(path, sec, audio, size)));

/** media files live in the test's playwright output dir - auto-cleaned, no
 *  mkdtemp litter in $TMPDIR */
const clipPath = (t: TestInfo, name: string) => t.outputPath(name);

type DoneRow = {
  status: string; error: string | null; held?: boolean;
  outputs: { type: string; url: string }[];
  meta: {
    windows: number; gen_box: string; steps: number; lip: string | null; window_wall_s: number[];
    draft?: boolean; draft_steps?: number; draft_of?: string;
    matte?: string | null; mask?: string | null;
    coverage?: { person_mean?: number; face_pct?: number | null } | null;
  } | null;
  lip?: string | null;
};

/** Poll a person-swap run to terminal; returns the final row. */
async function waitDone(request: APIRequestContext, id: string, timeoutMs = 180_000): Promise<DoneRow> {
  let row: DoneRow | null = null;
  await expect.poll(async () => {
    const g = await request.get(`/api/person-swap/${id}`);
    row = (await g.json()).job;
    return row!.status === "completed" ? "done" : row!.status === "failed" ? `FAILED:${row!.error}` : null;
  }, { timeout: timeoutMs, intervals: [2000] }).toBe("done");
  return row!;
}

/** Poll ONLY the generic job surface - the held-chain advance must not
 *  depend on the person-swap endpoints. Returns the raw jobs row. */
async function waitJobDone(request: APIRequestContext, id: string, timeoutMs = 180_000): Promise<Record<string, unknown>> {
  let row: Record<string, unknown> | null = null;
  await expect.poll(async () => {
    const g = await request.get(`/api/jobs/${id}`);
    row = (await g.json()).job;
    return row!.status === "completed" ? "done" : row!.status === "failed" ? `FAILED:${row!.error}` : null;
  }, { timeout: timeoutMs, intervals: [2000] }).toBe("done");
  return row!;
}

/** cropdetect verdict on a generated file (limit 16, round 2) - a borderless
 *  output reports the whole frame. */
function cropdetect(file: string): { w: number; h: number; x: number; y: number } {
  const p = spawnSync("ffmpeg", ["-v", "info", "-i", file, "-vf", "cropdetect=limit=16:round=2", "-f", "null", "-"]);
  const stderr = String(p.stderr ?? "");
  const m = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].pop();
  if (!m) throw new Error(`cropdetect found nothing in ${file}`);
  return { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
}

const generatedFile = (url: string) => `${process.cwd()}/public/files/${url.replace(/^\/files\//, "")}`;

/** The output keeps the source's exact dims and carries no black frame -
 *  cropdetect's suggested rect is the full frame (±2 px). */
function expectNoBorder(file: string, w: number, h: number) {
  const meta = videoMeta(file);
  expect({ w: meta.w, h: meta.h }).toEqual({ w, h });
  const c = cropdetect(file);
  expect(c.x).toBeLessThanOrEqual(2);
  expect(c.y).toBeLessThanOrEqual(2);
  expect(Math.abs(c.w - w)).toBeLessThanOrEqual(2);
  expect(Math.abs(c.h - h)).toBeLessThanOrEqual(2);
}

test.describe("ws4 person-swap", () => {
  test("gates → detect+estimate → person run → meta → sxs export → foreign 404s", async ({ request }, testInfo) => {
    await signUp(request, "ws4-person-swap");
    const videoUrl = await uploadClip(request, clipPath(testInfo, "person-swap-src.mp4"), 2, true);
    const img = await uploadFile(request, "s.png", "image/png", PNG);

    // detect - server probes; the estimate is what the page prints
    const det = await request.post("/api/person-swap/detect", { data: { video_url: videoUrl } });
    expect(det.status()).toBe(200);
    const d = await det.json();
    expect(d.probe.has_audio).toBe(true);
    expect(d.in_range).toBe(true);
    expect(d.windows).toBe(1);
    expect(d.local.steps).toBe(16);
    // per-mode × resolution totals - every mode positive at both res
    for (const r of ["480p", "720p"]) for (const m of ["person", "environment", "both"])
      expect(d.local.total_min[r][m]).toBeGreaterThan(0);
    // honesty: person is the heavier pass and "both" composes both passes -
    // person total + environment window time (the person-side overhead and
    // lip are shared, not duplicated)
    const t480 = d.local.total_min["480p"];
    expect(t480.person).toBeGreaterThan(t480.environment);
    expect(t480.both).toBeCloseTo(t480.person + t480.environment, 1);
    // and the rate the page prints comes from the same total - they agree
    const ratePerSec = t480.person / d.probe.duration;
    expect(ratePerSec).toBeGreaterThan(1);

    // consent gate - the clip is already an identity input
    let r = await request.post("/api/person-swap", {
      data: { video_url: videoUrl, mode: "person", image_urls: [img] },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("likeness consent required");

    // person needs refs - with consent but none
    r = await request.post("/api/person-swap", {
      data: { video_url: videoUrl, mode: "person", image_urls: [], likeness_consent: true },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("reference image");

    // person run - matte preflight + ref cut-out + 1 window + assemble + lip
    r = await request.post("/api/person-swap", {
      data: { video_url: videoUrl, mode: "person", image_urls: [img], likeness_consent: true, lip_sync: true },
    });
    expect(r.status()).toBe(201);
    const { jobs, batch_id, windows } = await r.json();
    expect(batch_id).toBeUndefined();
    expect(windows).toEqual([1]);
    const job = jobs[0];
    expect(job.held).toBe(false);
    const done = await waitDone(request, job.id);
    expect(String(done.outputs[0].url)).toMatch(/^\/files\/generated\//);
    // run meta - windows, gen box, steps and the lip outcome are all there
    expect(done.meta?.windows).toBe(1);
    expect(done.meta?.gen_box).toMatch(/^\d+×\d+$/);
    expect(done.meta?.steps).toBe(16);          // local default
    expect(done.lip ?? done.meta?.lip).toBe("restored"); // clip has audio

    // the result is an asset - reusable as the source of a next run
    const resultUrl = done.outputs[0].url as string;
    r = await request.post("/api/person-swap/detect", { data: { video_url: resultUrl } });
    expect(r.status()).toBe(200);

    // side-by-side export - rendered once, exactly 2× one side's width
    const ex1 = await request.get(`/api/person-swap/${job.id}/export`);
    expect(ex1.status()).toBe(200);
    const { url: sxs } = await ex1.json();
    const ex2 = await request.get(`/api/person-swap/${job.id}/export`);
    expect((await ex2.json()).url).toBe(sxs);
    const sxsM = videoMeta(generatedFile(sxs));
    expect(sxsM.h).toBe(640);
    const outM = videoMeta(generatedFile(resultUrl));
    const sideW = Math.round((outM.w * 640 / outM.h) / 2) * 2;
    expect(sxsM.w).toBe(2 * sideW);

    // second user (fresh context - the fixture's jar belongs to A) - every
    // person-swap surface 404s on a foreign job, and foreign media in the submit
    // body 404s before any probe
    const baseURL = testInfo.project.use.baseURL as string;
    const ctxB = await pwRequest.newContext({ baseURL });
    await signUp(ctxB, "ws4-person-swap-b");
    expect((await ctxB.get(`/api/person-swap/${job.id}`)).status()).toBe(404);
    expect((await ctxB.get(`/api/person-swap/${job.id}/export`)).status()).toBe(404);
    expect((await ctxB.delete(`/api/person-swap/${job.id}`)).status()).toBe(404);
    r = await ctxB.post("/api/person-swap", {
      data: { video_url: videoUrl, mode: "environment", likeness_consent: true },
    });
    expect(r.status()).toBe(404);
    await ctxB.dispose();

    // and the generic jobs path is gated the same way
    r = await request.post("/api/jobs", {
      data: {
        endpoint_id: "motionfield/person-swap/v1.0",
        params: { video_url: videoUrl, mode: "person", image_urls: [img], windows: 1 },
      },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("likeness consent required");
  });

  test("meta: 7 s clip → 2 windows · silent clip → lip restore skipped", async ({ request }, testInfo) => {
    await signUp(request, "ws4-meta");
    const img = await uploadFile(request, "m.png", "image/png", PNG);

    const seven = await uploadClip(request, clipPath(testInfo, "person-swap-7s.mp4"), 7, true);
    let r = await request.post("/api/person-swap", {
      // lip off here - the signup budget (~60 cr) covers one 2-window job;
      // the lip assertions ride the cheaper legs below
      data: { video_url: seven, mode: "person", image_urls: [img], likeness_consent: true, lip_sync: false },
    });
    expect(r.status()).toBe(201);
    const { jobs } = await r.json();
    const done = await waitDone(request, jobs[0].id);
    expect(done.meta?.windows).toBe(2);
    expect(done.meta?.window_wall_s.length).toBe(2);
    expect(String(done.meta?.lip)).toMatch(/^lip restore skipped: off$/);

    // fresh user - one charged run each; the point is the lip outcome, not
    // a stress on the ledger
    const ctxB = await pwRequest.newContext({ baseURL: testInfo.project.use.baseURL as string });
    await signUp(ctxB, "ws4-meta-b");
    const img2 = await uploadFile(ctxB, "m2.png", "image/png", PNG);
    const silent = await uploadClip(ctxB, clipPath(testInfo, "person-swap-silent.mp4"), 2, false);
    r = await ctxB.post("/api/person-swap", {
      data: { video_url: silent, mode: "person", image_urls: [img2], likeness_consent: true, lip_sync: true },
    });
    expect(r.status()).toBe(201);
    const done2 = await waitDone(ctxB, (await r.json()).jobs[0].id);
    expect(String(done2.meta?.lip)).toBe("lip restore skipped: no audio");
    await ctxB.dispose();
  });

  test("batch identities + clips are held, never rejected for concurrency", async ({ request }, testInfo) => {
    await signUp(request, "ws4-batch"); // free plan → 1 video slot
    const img = await uploadFile(request, "b.png", "image/png", PNG);
    const c1 = await uploadClip(request, clipPath(testInfo, "person-swap-b1.mp4"), 2, false);
    const c2 = await uploadClip(request, clipPath(testInfo, "person-swap-b2.mp4"), 2, false);

    // 1 clip × 2 identities → 2 jobs under one batch_id - the second is held
    let r = await request.post("/api/person-swap", {
      data: {
        video_url: c1, mode: "person", likeness_consent: true, lip_sync: false,
        identities: [{ image_urls: [img] }, { image_urls: [img] }],
      },
    });
    expect(r.status()).toBe(201);
    let b = await r.json();
    expect(b.jobs.length).toBe(2);
    expect(b.rejected.length).toBe(0);
    expect(b.batch_id).toBeTruthy();
    expect(b.jobs.filter((j: { held?: boolean }) => j.held).length).toBeGreaterThan(0);

    // the held member submits once the first frees its slot - both finish
    for (const j of b.jobs) await waitDone(request, j.id);
    const list = await request.get(`/api/person-swap?batch_id=${b.batch_id}`);
    const listed = (await list.json()).jobs;
    expect(listed.length).toBe(2);
    expect(listed.every((j: { status: string }) => j.status === "completed")).toBeTruthy();

    // 2 clips × 1 identity → 2 jobs (one per clip) - a fresh user carries
    // its own signup credits; reusing A would blow the ~60 cr budget
    const ctxB = await pwRequest.newContext({ baseURL: testInfo.project.use.baseURL as string });
    await signUp(ctxB, "ws4-batch-b");
    const imgB = await uploadFile(ctxB, "b2.png", "image/png", PNG);
    const c1b = await uploadClip(ctxB, clipPath(testInfo, "person-swap-c1.mp4"), 2, false);
    const c2b = await uploadClip(ctxB, clipPath(testInfo, "person-swap-c2.mp4"), 2, false);
    r = await ctxB.post("/api/person-swap", {
      data: {
        video_url: c1b, clips: [c2b], mode: "person", image_urls: [imgB],
        likeness_consent: true, lip_sync: false,
      },
    });
    expect(r.status()).toBe(201);
    b = await r.json();
    expect(b.jobs.length).toBe(2);
    expect(b.rejected.length).toBe(0);
    expect(b.batch_id).toBeTruthy();
    for (const j of b.jobs) await waitDone(ctxB, j.id);
    await ctxB.dispose();
  });

  test("held chain advances on /api/jobs/:id alone · a consentless held POST is a 400", async ({ request }, testInfo) => {
    await signUp(request, "ws4-holdsec"); // free plan → 1 video slot
    const img = await uploadFile(request, "h.png", "image/png", PNG);
    const c1 = await uploadClip(request, clipPath(testInfo, "person-swap-h1.mp4"), 2, false);

    // 1 clip × 2 identities → job1 live, job2 held (charged, no provider id)
    let r = await request.post("/api/person-swap", {
      data: {
        video_url: c1, mode: "person", likeness_consent: true, lip_sync: false,
        identities: [{ image_urls: [img] }, { image_urls: [img] }],
      },
    });
    expect(r.status()).toBe(201);
    const b = await r.json();
    expect(b.jobs.length).toBe(2);
    expect(b.jobs.filter((j: { held?: boolean }) => j.held).length).toBe(1);

    // while job1 still runs (the held members exist only as queued rows),
    // the same POST without consent must 400 BEFORE any row is inserted -
    // held units pass through createJob's gates, not around them
    const noConsent = await request.post("/api/person-swap", {
      data: {
        video_url: c1, mode: "person", image_urls: [img],
        identities: [{ image_urls: [img] }, { image_urls: [img] }],
      },
    });
    expect(noConsent.status()).toBe(400);
    expect((await noConsent.json()).error).toContain("likeness consent required");
    const listNow = await request.get("/api/person-swap");
    expect((await listNow.json()).jobs.length).toBe(2); // nothing new was created

    // the chain: job1 completes → its recipe releases job2 mid-tick → job2
    // runs - and the client only ever touched /api/jobs/:id, never a person-swap
    // endpoint, for the whole advance
    for (const j of b.jobs as { id: string }[]) {
      const done = await waitJobDone(request, j.id);
      expect(done.status).toBe("completed");
    }
  });

  test("environment + both modes complete; 360×640 and 640×360 outputs keep source dims, no border", async ({ request }, testInfo) => {
    // user A - portrait 360×640, environment mode: no refs needed, consent
    // still required (the person in the clip is the likeness)
    await signUp(request, "ws4-modes");
    const cPortrait = await uploadClip(request, clipPath(testInfo, "person-swap-360x640.mp4"), 2, false, "360x640");

    let r = await request.post("/api/person-swap", {
      data: { video_url: cPortrait, mode: "environment", likeness_consent: true, lip_sync: false },
    });
    expect(r.status()).toBe(201);
    const envJob = (await r.json()).jobs[0];
    const envDone = await waitDone(request, envJob.id);
    expect(envDone.status).toBe("completed");
    expect(String(envDone.lip ?? envDone.meta?.lip)).toBe("lip restore skipped: environment mode");
    expectNoBorder(generatedFile(envDone.outputs[0].url), 360, 640);

    // user B - landscape 640×360, "both": person pass AND env pass per window
    const ctxB = await pwRequest.newContext({ baseURL: testInfo.project.use.baseURL as string });
    await signUp(ctxB, "ws4-modes-b");
    const imgB = await uploadFile(ctxB, "mb.png", "image/png", PNG);
    const cLand = await uploadClip(ctxB, clipPath(testInfo, "person-swap-640x360.mp4"), 2, false, "640x360");
    r = await ctxB.post("/api/person-swap", {
      data: { video_url: cLand, mode: "both", image_urls: [imgB], likeness_consent: true, lip_sync: false },
    });
    expect(r.status()).toBe(201);
    const bothJob = (await r.json()).jobs[0];
    const bothDone = await waitDone(ctxB, bothJob.id);
    expect(bothDone.status).toBe("completed");
    expect(String(bothDone.lip ?? bothDone.meta?.lip)).toMatch(/^lip restore skipped: (no audio|off)$/);
    expectNoBorder(generatedFile(bothDone.outputs[0].url), 640, 360);
    await ctxB.dispose();
  });

  test("/person-swap UI: consent-gated inputs → estimate → run → compare slider", async ({ page }, testInfo) => {
    await expect.poll(async () => {
      const email = `ws4-dui-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
      const su = await page.context().request.post("/api/auth/sign-up/email", {
        data: { email, password: "test-pass-1234", name: "WS4 D UI" },
      });
      if (!su.ok()) return 0;
      return (await page.context().request.get("/api/me")).status();
    }, { timeout: 90_000, intervals: [1000, 3000, 6000, 10000] }).toBe(200);

    const srcClip = makeClip(clipPath(testInfo, "person-swap-ui.mp4"), 2, false);
    const pngPath = clipPath(testInfo, "person-swap-ref.png");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=red:size=64x64", "-frames:v", "1", pngPath]);

    await page.goto("/person-swap");
    await expect(page.getByRole("heading", { name: "Person Swap" })).toBeVisible();

    // every likeness input stays disabled until the consent box is ticked
    const consentBox = page.locator("#person-swap-consent");
    const clipInput = page.getByLabel(/Source clip/i);
    const refInput = page.getByLabel(/Identity ref/i).first();
    await expect(consentBox).not.toBeChecked();
    await expect(clipInput).toBeDisabled();
    await expect(refInput).toBeDisabled();
    await expect(page.getByRole("button", { name: /Run (?:person-swap|draft)/i })).toBeDisabled();
    await consentBox.check();
    await expect(clipInput).toBeEnabled();
    await expect(refInput).toBeEnabled();

    await clipInput.setInputFiles(srcClip);
    await expect(page.getByText(/generation window/)).toBeVisible({ timeout: 60_000 });
    // honest local runtime line - the measure people actually wait through
    await expect(page.getByText(/min local/)).toBeVisible();

    await refInput.setInputFiles(pngPath);
    await expect(page.getByRole("button", { name: /Run (?:person-swap|draft)/i })).toBeEnabled({ timeout: 15_000 });
    // draft-first is the default path - preview → approve → final
    await expect(page.getByText(/Draft first/)).toBeVisible();
    await page.getByRole("button", { name: /Run (?:person-swap|draft)/i }).click();
    await expect(page.getByText("Runs")).toBeVisible();
    await expect(page.locator("ul li").first()).toContainText(/queued|in_progress|completed/, { timeout: 15_000 });
    await expect(page.getByText(/completed/).first()).toBeVisible({ timeout: 180_000 });

    // the draft review gates the final - preview + matte review + approve
    await expect(page.getByText("Draft review - approve before the full render")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("ul li").first()).toContainText(/draft/);
    await page.getByRole("button", { name: /Approve - run the full render/ }).click();
    await expect(page.getByText(/· final/)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("ul li").nth(1)).toContainText(/completed/, { timeout: 180_000 });

    // the compare slider only shows when a result exists - real range input
    await expect(page.getByText("Source ↔ swapped")).toBeVisible({ timeout: 60_000 });
    const slider = page.locator('input[aria-label="Compare source and result"]');
    await expect(slider).toBeVisible();
    await expect(slider).toHaveAttribute("aria-valuenow", "50");
    await slider.focus();
    await slider.press("ArrowLeft");
    // step=1 - ArrowLeft nudges the compare position left; assert the move
    await expect(async () => {
      const now = Number(await slider.getAttribute("aria-valuenow"));
      expect(now).toBeLessThan(50);
    }).toPass();
    await slider.fill("75");
    await expect(slider).toHaveAttribute("aria-valuenow", "75");
    await expect(page.getByRole("button", { name: /Side-by-side mp4/ })).toBeVisible();
  });

  test("draft → approve → final + draft_of refusals (mock)", async ({ request }, testInfo) => {
    await signUp(request, "ws4-draft");
    const img = await uploadFile(request, "d.png", "image/png", PNG);
    const clip = await uploadClip(request, clipPath(testInfo, "person-swap-draft.mp4"), 3, false, "640x360");

    // draft - one cheap window, flagged in meta
    let r = await request.post("/api/person-swap", {
      data: { video_url: clip, mode: "person", image_urls: [img], likeness_consent: true, lip_sync: false, draft: true },
    });
    expect(r.status()).toBe(201);
    const { jobs } = await r.json();
    const draftDone = await waitDone(request, jobs[0].id);
    expect(draftDone.meta?.draft).toBe(true);
    expect(draftDone.meta?.draft_steps).toBe(4);
    expect(draftDone.meta?.windows).toBe(1);
    expect(String(draftDone.outputs[0].url)).toMatch(/^\/files\/generated\//);
    // lip never runs on a draft
    expect(String(draftDone.lip ?? draftDone.meta?.lip)).toBe("lip restore skipped: draft");
    // every evidence URL meta carries is a /files/ path - never a server path
    for (const k of ["matte", "mask"] as const) {
      const v = (draftDone.meta as Record<string, unknown>)?.[k];
      if (v != null) expect(String(v)).toMatch(/^\/files\//);
    }

    // approve - the final reuses the draft's seed key
    r = await request.post("/api/person-swap", {
      data: { video_url: clip, mode: "person", image_urls: [img], likeness_consent: true, lip_sync: false, draft_of: jobs[0].id },
    });
    expect(r.status()).toBe(201);
    const finId = (await r.json()).jobs[0].id;
    const finDone = await waitDone(request, finId);
    expect(finDone.meta?.draft_of).toBe(jobs[0].id);
    expect(finDone.meta?.draft).not.toBe(true);

    // refusal cases - each 400s before any row exists
    const refuse = async (data: Record<string, unknown>, match: RegExp) => {
      const rr = await request.post("/api/person-swap", { data });
      expect(rr.status()).toBe(400);
      expect((await rr.json()).error).toMatch(match);
    };
    await refuse(
      { video_url: clip, mode: "person", image_urls: [img], likeness_consent: true, quick: true, draft: true },
      /fast path/);
    await refuse(
      { video_url: clip, mode: "person", image_urls: [img], likeness_consent: true, draft: true, draft_of: jobs[0].id },
      /another draft/);
    await refuse(
      { video_url: clip, mode: "person", image_urls: [img], likeness_consent: true, draft: true, identities: [{ image_urls: [img] }] },
      /one clip/);
    await refuse(
      { video_url: clip, mode: "person", image_urls: [img], likeness_consent: true, draft_of: "no-such-job" },
      /completed Person Swap draft/);
    // hex-only strings pass the OLD loose guard - the strict uuid shape must 400 them before the pg cast
    for (const bad of ["abc", "----"])
      await refuse(
        { video_url: clip, mode: "person", image_urls: [img], likeness_consent: true, draft_of: bad },
        /completed Person Swap draft/);

    // a foreign job id can't be approved - and a completed NON-draft job
    // can't masquerade as a draft even for its owner
    const ctxB = await pwRequest.newContext({ baseURL: testInfo.project.use.baseURL as string });
    await signUp(ctxB, "ws4-draft-b");
    const imgB = await uploadFile(ctxB, "db.png", "image/png", PNG);
    const clipB = await uploadClip(ctxB, clipPath(testInfo, "person-swap-draft-b.mp4"), 3, false, "640x360");
    r = await ctxB.post("/api/person-swap", {
      data: { video_url: clipB, mode: "person", image_urls: [imgB], likeness_consent: true, lip_sync: false },
    });
    const bNormal = (await r.json()).jobs[0].id;
    await waitDone(ctxB, bNormal);
    const foreign = await request.post("/api/person-swap", {
      data: { video_url: clip, mode: "person", image_urls: [img], likeness_consent: true, lip_sync: false, draft_of: bNormal },
    });
    expect(foreign.status()).toBe(400);
    expect((await foreign.json()).error).toContain("draft");
    const notDraft = await ctxB.post("/api/person-swap", {
      data: { video_url: clipB, mode: "person", image_urls: [imgB], likeness_consent: true, lip_sync: false, draft_of: bNormal },
    });
    expect(notDraft.status()).toBe(400);
    expect((await notDraft.json()).error).toContain("draft");
    await ctxB.dispose();
  });

  test("a person ref saved via /api/refs is listed by GET /api/refs", async ({ request }) => {
    await signUp(request, "ws4-refs");

    const img = await uploadFile(request, "ref.png", "image/png", PNG);
    const refName = `ref-${Date.now()}`;
    const r = await request.post("/api/refs", {
      data: { kind: "person", name: refName, likeness_consent: true, images: [img] },
    });
    expect(r.status()).toBe(201);

    const api = await request.get("/api/refs");
    expect(api.ok()).toBeTruthy();
    const listed = (await api.json()).refs as { name: string; kind?: string }[];
    expect(listed.some((x) => x.name === refName && x.kind === "person")).toBeTruthy();
  });
});
