/**
 * VFX Lab e2e (GENERATION_PROVIDER=mock via playwright.config):
 *  - /api/vfx-lab/probe: packet frames (48, not the 50 a longer audio would
 *    read), fitted render dims, 8n+1 frame count, token budget, per-engine
 *    estimates, ltx098 hidden (no checkpoint on this Mac)
 *  - /api/vfx-lab/submit: ownership → probe-stamped params (frames/fps/
 *    duration/dims + lock-derived denoise & sigmas); license opt-in gates
 *    the restricted LTX endpoints; the Wan alt is open (no opt-in)
 *  - guards: external/unowned/traversal plates → 400/404; stills in the
 *    video slot and clips in the image slot → 400; unverified preset → 400;
 *    engine+structure together → 400; >10 s plate → 400; none charge
 *  - /api/vfx-lab/target: no instruction → 400; with one → a real klein-edit job
 *  - /visual-effects page: probe card, the 20-card preset grid (pending state before
 *    verified records), ltx098 absent from the engine select, Wan alt toggle,
 *    a UI submit lands the job and side-by-side renders
 */
import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VFX_PRESETS, vfxPresetHash } from "../../src/lib/catalog/presets/vfx-lab";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const tmp = mkdtempSync(join(tmpdir(), "of-ws3-vfxlab-"));

/** The e2e verify fixture - the dev server reads VFX_VERIFY_FILE (playwright
 *  config) lazily per request, so the spec controls what the page sees:
 *  absent → the API test asserts the honest empty grid; the UI test then
 *  seeds real mechanism hashes as verified and exercises the preset path. */
const E2E_VERIFY = resolve(process.cwd(), "tests", "fixtures", "vfx-verify-e2e.json");
rmSync(E2E_VERIFY, { force: true });
function seedVerify() {
  writeFileSync(E2E_VERIFY, JSON.stringify({
    version: 1,
    records: Object.fromEntries(VFX_PRESETS.map((p) => [p.id, {
      mechanism_hash: vfxPresetHash(p),
      status: "verified", date: "e2e", note: "e2e-fabricated",
      // s11 - the gate wants the measurement the stamp claims
      effect_diff: { mean: 80, min: 60, frames: [0], per_frame: [80] },
    }])),
  }, null, 2));
}

function makeClip(file: string, secs = 2, audio = 0, rate = 24, size = "320x180") {
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate}:duration=${secs}`,
    ...(audio > 0 ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${audio}`] : ["-an"]),
    "-map", "0:v", ...(audio > 0 ? ["-map", "1:a", "-c:a", "aac"] : []),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
  ]);
  return readFileSync(file);
}
function makeStill(file: string, size = "640x360") {
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi",
    "-i", `testsrc2=size=${size}:duration=0.1`, "-frames:v", "1", file]);
  return readFileSync(file);
}

async function signUp(tag: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: `http://localhost:${process.env.PORT || "3100"}` });
  const su = await ctx.post("/api/auth/sign-up/email", {
    data: { email: `ws3vfx-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
      password: "test-pass-1234", name: "WS3 VFX" },
  });
  expect(su.ok(), `signup: ${su.status()}`).toBeTruthy();
  return ctx;
}
/** the restricted-license opt-in - what /settings/licenses writes */
async function optIn(api: APIRequestContext) {
  const r = await api.post("/api/licenses/opt-in", { data: { confirm: true } });
  expect(r.ok()).toBeTruthy();
}
async function balance(api: APIRequestContext): Promise<number> {
  return Number((await (await api.get("/api/me")).json()).profile.credits);
}
async function upload(api: APIRequestContext, name: string, mime: string, buf: Buffer) {
  const up = await api.post("/api/uploads", { multipart: { file: { name, mimeType: mime, buffer: buf } } });
  expect(up.ok()).toBeTruthy();
  return (await up.json()).url as string;
}
async function jobRow(api: APIRequestContext, id: string) {
  return (await (await api.get(`/api/jobs/${id}`)).json()).job;
}

test.describe("ws3 vfx-lab", () => {
  test("[OF-0xx3] api - probe truth, server-stamped params, license gate, guards never charge", async () => {
    const api = await signUp("api");
    // 2 s video @24fps + audio 0.1 s longer - the stream carries exactly 48 packets
    const videoUrl = await upload(api, "plate.mp4", "video/mp4", makeClip(join(tmp, "plate.mp4"), 2, 2.1));
    const imgUrl = await upload(api, "plate.png", "image/png", makeStill(join(tmp, "plate.png")));

    // ---- probe (video) ----
    let r = await api.post("/api/vfx-lab/probe", { data: { video_url: videoUrl } });
    expect(r.ok()).toBeTruthy();
    const probe = (await r.json()).probe;
    expect(probe.kind).toBe("video");
    expect(probe.frames).toBe(48);                 // stream packets - not round(2.1*24)=50
    expect(probe.duration).toBeCloseTo(2.0, 3);    // stream truth
    expect(probe.render_frames).toBe(41);          // largest 8n+1 ≤ 48 @24 fps
    expect(probe.render_width % 32).toBe(0);
    expect(probe.render_height % 32).toBe(0);
    expect(probe.render_tokens).toBeLessThanOrEqual(probe.token_cap);
    expect(probe.estimates.ltx095).toBeGreaterThan(0);
    expect(probe.ltx098).toBe(false);              // distilled ckpt absent on this Mac
    expect(probe.presets).toHaveLength(0);         // no verified records yet - nothing on offer

    // ---- probe (image) ----
    r = await api.post("/api/vfx-lab/probe", { data: { image_url: imgUrl } });
    expect(r.ok()).toBeTruthy();
    const imgProbe = (await r.json()).probe;
    expect(imgProbe.kind).toBe("image");
    expect(imgProbe.render_frames).toBe(65);       // 3 s @24 → 8n+1

    // ---- target maker ----
    r = await api.post("/api/vfx-lab/target", { data: { image_url: imgUrl } });
    expect(r.status()).toBe(400);                  // no instruction
    r = await api.post("/api/vfx-lab/target", { data: { image_url: imgUrl, instruction: "coat everything in ice" } });
    expect(r.status()).toBe(201);
    const tgt = (await r.json()).job;
    expect((await jobRow(api, tgt.id)).endpointId).toBe("motionfield/flux2-klein/edit");
    // the free plan's single live-job slot: drain the target job before the
    // video submit or it 429s on concurrency (the gate counts every kind)
    for (let i = 0; i < 60; i++) {
      const s = (await jobRow(api, tgt.id)).status;
      if (["completed", "failed", "canceled"].includes(s)) break;
      await new Promise((w) => setTimeout(w, 1000));
    }

    // ---- the license gate before any charge (restricted LTX) ----
    r = await api.post("/api/vfx-lab/submit", { data: { video_url: videoUrl } });
    expect(r.status()).toBe(403);
    expect((await r.json()).error.code).toBe("restricted_license");
    await optIn(api);

    // ---- submit a plate run - params are server truth ----
    r = await api.post("/api/vfx-lab/submit", {
      data: {
        video_url: videoUrl, plate_lock: "light", hold: 0, prompt: "a thin frost",
        // client-supplied timing - the route must overwrite every field
        frames: 7, fps: 3, duration: 9, width: 64, height: 64,
      },
    });
    expect(r.status()).toBe(400); // strictObject - the extras never reach params
    r = await api.post("/api/vfx-lab/submit", {
      data: { video_url: videoUrl, plate_lock: "light", hold: 0, prompt: "a thin frost" },
    });
    expect(r.status()).toBe(201);
    const { job } = await r.json();
    const full = await jobRow(api, job.id);
    expect(full.params.frames).toBe(41);
    expect(full.params.fps).toBe(24);
    expect(Number(full.params.duration)).toBeCloseTo(2.0, 3);
    expect(full.params.width).toBe(320);           // 320×180 fits under the 480p box - no upscale
    expect(full.params.height).toBe(160);
    expect(full.params.denoise).toBeCloseTo(0.4);  // light lock
    expect(full.params.hold).toBe(0);
    expect(full.params.plate_lock).toBe("light");
    // let the mock job settle so the free video slot frees for the next user
    let st = job.status;
    for (let i = 0; i < 60 && ["queued", "in_progress"].includes(st); i++) {
      await new Promise((s) => setTimeout(s, 1000));
      st = (await jobRow(api, job.id)).status;
    }
    expect(st).toBe("completed");

    // ---- a still → the image endpoint ----
    const api2 = await signUp("img");
    const img2 = await upload(api2, "s.png", "image/png", makeStill(join(tmp, "s.png")));
    await optIn(api2);
    r = await api2.post("/api/vfx-lab/submit", { data: { image_url: img2, prompt: "slow ash", duration: 2 } });
    expect(r.status()).toBe(201);
    const ij = (await r.json()).job;
    const ijf = await jobRow(api2, ij.id);
    expect(ijf.endpointId).toBe("motionfield/ltx-video/vfx-lab-image");
    expect(ijf.params.frames).toBe(41);            // 2 s @24 → 8n+1
    expect(ijf.params.fps).toBe(24);
    st = ij.status;
    for (let i = 0; i < 60 && ["queued", "in_progress"].includes(st); i++) {
      await new Promise((s) => setTimeout(s, 1000));
      st = (await jobRow(api2, ij.id)).status;
    }
    expect(st).toBe("completed");

    // ---- the Wan alt - open license, no opt-in needed ----
    const api3 = await signUp("alt");
    const altClip = await upload(api3, "a.mp4", "video/mp4", makeClip(join(tmp, "a.mp4"), 2));
    r = await api3.post("/api/vfx-lab/submit", { data: { video_url: altClip, structure: "depth", alt_length: "preview" } });
    expect(r.status()).toBe(201);
    const aj = (await r.json()).job;
    const ajf = await jobRow(api3, aj.id);
    expect(ajf.endpointId).toBe("motionfield/wan-vace/vfx-lab-alt");
    expect(ajf.params.fps).toBe(16);
    expect((ajf.params.frames - 1) % 4).toBe(0);
    expect(ajf.params.frames).toBeLessThanOrEqual(33);
    st = aj.status;
    for (let i = 0; i < 60 && ["queued", "in_progress"].includes(st); i++) {
      await new Promise((s) => setTimeout(s, 1000));
      st = (await jobRow(api3, aj.id)).status;
    }
    expect(st).toBe("completed");

    // ---- guards - never touch the balance ----
    const api4 = await signUp("guard");
    const gClip = await upload(api4, "g.mp4", "video/mp4", makeClip(join(tmp, "g.mp4"), 2));
    const gPng = await upload(api4, "g.png", "image/png", makeStill(join(tmp, "g.png")));
    await optIn(api4);
    const before = await balance(api4);
    for (const [data, code] of [
      [{ video_url: "https://example.com/v.mp4" }, 400],
      [{ video_url: "/files/uploads/nope.mp4" }, 404],
      [{ video_url: "/files/../escape.mp4" }, 404],
      [{ video_url: gClip, image_url: gPng }, 400],          // two plates
      [{ video_url: gClip, engine: "ltx098" }, 400],         // checkpoint absent
      [{ video_url: gClip, vfx_preset: "vfx-frostbite" }, 400], // unverified
      [{ video_url: gClip, plate_lock: "max" }, 400],        // not a lock
      [{ video_url: gClip, hold: 5 }, 400],                  // not a hold pick
      [{ video_url: gClip, engine: "ltx095", structure: "depth" }, 400], // exclusive
      [{ video_url: gPng }, 400],                            // still in the video slot
      [{ video_url: gClip, structure: "image" }, 400],       // image structure needs a still
      [{ image_url: gPng, structure: "depth" }, 400],        // depth needs a clip
      [{ image_url: gClip }, 400],                           // clip in the image slot
    ] as const) {
      const g = await api4.post("/api/vfx-lab/submit", { data });
      expect(g.status(), JSON.stringify(data)).toBe(code);
    }
    // probe rejects non-video too - a still is bad input, not a 500
    const gp = await api4.post("/api/vfx-lab/probe", { data: { video_url: gPng } });
    expect(gp.status()).toBe(400);
    // >10 s plate → over the budget before charge
    const big = await upload(api4, "big.mp4", "video/mp4", makeClip(join(tmp, "big.mp4"), 11));
    const bb = await api4.post("/api/vfx-lab/submit", { data: { video_url: big } });
    expect(bb.status()).toBe(400);
    expect((await bb.json()).error).toMatch(/10 s/);
    // the generic jobs route hits the same endpoint gate - probe fields required
    const dj = await api4.post("/api/jobs", {
      data: { endpoint_id: "motionfield/ltx-video/vfx-lab-plate", params: { video_url: gClip, prompt: "x" } },
    });
    expect(dj.status()).toBe(400);
    expect((await dj.json()).error).toMatch(/frames/);
    // ownership - another user's plate is a 404, not a leak
    const api5 = await signUp("thief");
    const th = await api5.post("/api/vfx-lab/submit", { data: { video_url: gClip } });
    expect(th.status()).toBe(404);
    expect(await balance(api4), "rejections must not charge").toBe(before);
    await api.dispose(); await api2.dispose(); await api3.dispose(); await api4.dispose(); await api5.dispose();
  });

  test("[OF-0xx4] /visual-effects page - probe card, preset grid, engine select, UI submit", async ({ page }) => {
    let attempt = 0;
    await expect.poll(async () => {
      const email = `ws3vfx-ui-${Date.now()}-${attempt++}-${Math.random().toString(36).slice(2, 6)}@test.local`;
      const su = await page.context().request.post("/api/auth/sign-up/email", {
        data: { email, password: "test-pass-1234", name: "WS3 VFX UI" },
      });
      if (!su.ok()) return 0;
      return (await page.context().request.get("/api/me")).status();
    }, { timeout: 90_000, intervals: [1000, 3000, 6000, 10000] }).toBe(200);
    await page.context().request.post("/api/licenses/opt-in", { data: { confirm: true } });

    const clipPath = join(tmp, "ui-plate.mp4");
    makeClip(clipPath, 2, 2.1);

    // seed the e2e fixture - real hashes, fabricated status - so the page
    // exercises the verified path (records only ever come from real runs)
    seedVerify();

    await page.goto("/visual-effects");
    await expect(page.getByRole("heading", { name: "Visual Effects" })).toBeVisible();

    // the preset grid renders all 20 cards - verified chips under the seed
    const grid = page.getByTestId("vfx-preset-grid");
    await expect(grid.locator("button")).toHaveCount(20);
    await expect(grid.locator("text=verified").first()).toBeVisible();
    // engine select hides ltx098 - the checkpoint isn't on this Mac
    const engine = page.getByLabel("engine");
    await expect(engine.locator("option", { hasText: "0.9.8" })).toHaveCount(0);
    await expect(engine.locator("option", { hasText: "0.9.5" })).toHaveCount(1);

    // upload → the probe card
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(clipPath);
    const card = page.getByTestId("vfx-probe-card");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("48 frames");
    await expect(card).toContainText("2.00 s");
    await expect(card).toContainText("41 frames @ 24");
    await expect(card).toContainText("latent tokens");
    await expect(card).toContainText("ltx098 hidden");

    // the estimate line, and the Wan alt toggle swaps the controls honestly
    await expect(page.getByTestId("vfx-est")).toContainText(/~\d+ min · LTX 0\.9\.5/);
    await page.getByTestId("vfx-alt-toggle").check();
    await expect(page.getByLabel("structure")).toBeVisible();
    await expect(page.getByTestId("vfx-est")).toContainText(/Wan VACE/);
    await page.getByTestId("vfx-alt-toggle").uncheck();

    // a verified preset applies its defaults and submits through the merge
    await grid.getByRole("button", { name: /Frostbite/ }).click();
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/vfx-lab/submit") && r.request().method() === "POST"),
      page.getByTestId("vfx-run").click(),
    ]);
    expect(resp.status()).toBe(201);
    const body = resp.request().postDataJSON();
    expect(body.vfx_preset).toBe("vfx-frostbite");
    expect(body.engine).toBe("ltx095");
    expect(body.plate_lock).toBe("strong");      // the preset's lock, applied
    const { job } = await resp.json();
    const full = await jobRow(page.context().request, job.id);
    expect(full.params.frames).toBe(41);
    expect(full.params.fps).toBe(24);
    expect(String(full.params.prompt)).toContain("frost"); // preset text leads the merge
    expect(full.params.vfx_preset).toBe("vfx-frostbite");
    expect(full.params.denoise).toBeCloseTo(0.8); // strong lock
    await expect(page.getByTestId("vfx-job")).toBeVisible();
    await expect(page.getByTestId("vfx-side-by-side")).toBeVisible();
  });
});
