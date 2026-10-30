/**
 * Re-shoot e2e (GENERATION_PROVIDER=mock via playwright.config):
 *  - upload → /api/reshoot/probe returns owned-media probe numbers - packet
 *    frames, not duration×fps (48, not the 50 a 0.1 s longer audio would
 *    read), and the render size it will actually run at
 *  - /api/reshoot/submit creates the job with SERVER-probed timing params -
 *    fitted dims, frames, fps/duration; strength, distance and the typed
 *    move stack reach job.params
 *  - guards: external url → 400, unowned /files/ → 404, traversal → 404,
 *    stills-only move → 400, >3-move stack → 400, bad backend → 400,
 *    >60 fps → 400 and over-cap → 400 - none of them touch the balance
 *  - /new-camera-move page: probe card shows "renders at", stills-only picker rows
 *    are hidden (not disabled), the cloud engine option admits it's untested
 */
import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const tmp = mkdtempSync(join(tmpdir(), "of-ws3-reshoot-"));

/** A CFR clip; `audio` is the sine's duration in seconds (0 = silent) - a
 *  longer audio than `secs` is exactly the case that lies under
 *  duration×fps counting. */
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

/** Each user needs its own context - the shared `request` fixture keeps the
 *  first session cookie and better-auth 403s a sign-up while authenticated. */
async function signUp(tag: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({
    baseURL: `http://localhost:${process.env.PORT || "3100"}`,
  });
  const email = `ws3rs-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const su = await ctx.post("/api/auth/sign-up/email", {
    data: { email, password: "test-pass-1234", name: "WS3 ReShoot" },
  });
  expect(su.ok(), `signup: ${su.status()}`).toBeTruthy();
  return ctx;
}

async function balance(api: APIRequestContext): Promise<number> {
  const me = await api.get("/api/me");
  return Number((await me.json()).profile.credits);
}

/** Playwright can't fill() a range input - drive it like a user does:
 *  set the value through the native setter so React's controlled input
 *  sees a real input event. */
async function setRange(loc: import("@playwright/test").Locator, value: string) {
  await loc.evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

test.describe("ws3 reshoot", () => {
  test("[OF-0xx1] probe + submit: ownership first, probed timing on the job, guards never charge", async () => {
    const api = await signUp("api");
    // 2 s of video @24fps, audio runs 0.1 s past it - the container reads
    // 2.1 s, but the video stream carries exactly 48 packets
    const clip = makeClip(join(tmp, "clip.mp4"), 2, 2.1);
    const up = await api.post("/api/uploads", {
      multipart: { file: { name: "clip.mp4", mimeType: "video/mp4", buffer: clip } },
    });
    expect(up.ok()).toBeTruthy();
    const { url: videoUrl } = await up.json();
    expect(videoUrl).toMatch(/^\/files\//);

    // probe - the owned-media numbers the page quotes
    let r = await api.post("/api/reshoot/probe", { data: { video_url: videoUrl } });
    expect(r.ok()).toBeTruthy();
    const probe = (await r.json()).probe;
    expect(Math.abs(probe.fps - 24)).toBeLessThan(0.01);
    expect(probe.frames).toBe(48);           // packet count - not round(2.1*24)=50
    expect(probe.render_width).toBe(320);    // fitted dims the run actually uses
    expect(probe.render_height).toBe(176);
    expect(probe.has_audio).toBe(true);
    expect(probe.capped_at).toBe(probe.frames);

    // submit - the job's timing params are the probe's, not the client's
    r = await api.post("/api/reshoot/submit", {
      data: {
        video_url: videoUrl, moves: "dolly-in", strength: 1.4, distance: 6,
        // bogus client-supplied timing - the route must overwrite them
        frames: 7, fps: 3, duration: 9, width: 64, height: 64,
      },
    });
    expect(r.status()).toBe(201);
    const { job } = await r.json();
    const jr = await api.get(`/api/jobs/${job.id}`);
    const { job: full } = await jr.json();
    expect(full.params.frames).toBe(48);     // server-probed, not the client's 7
    expect(Math.abs(full.params.fps - 24)).toBeLessThan(0.01);
    expect(full.params.duration).toBeCloseTo(2.0, 3); // stream truth: 48/24, not the 2.1 s container
    expect(full.params.moves).toBe("dolly-in");
    expect(full.params.strength).toBe(1.4);  // page controls reach params
    expect(full.params.distance).toBe(6);
    expect(full.params.width).toBe(320);
    expect(full.params.height).toBe(176);    // aspect kept, floored to 16

    // mock provider completes; the output asset lands under generated/
    const deadline = Date.now() + 60_000;
    let status = job.status, last = full;
    while (Date.now() < deadline && ["queued", "in_progress"].includes(status)) {
      await new Promise((r2) => setTimeout(r2, 1200));
      const g = await api.get(`/api/jobs/${job.id}`);
      last = (await g.json()).job; status = last.status;
    }
    expect(status).toBe("completed");
    expect(last.outputs?.[0]?.url).toMatch(/^\/files\/generated\//);

    // a 1080p clip renders at the fitted Wan box (832×464), not source dims
    const hd = makeClip(join(tmp, "hd.mp4"), 2, 0, 24, "1920x1080");
    const upHd = await api.post("/api/uploads", {
      multipart: { file: { name: "hd.mp4", mimeType: "video/mp4", buffer: hd } },
    });
    const { url: hdUrl } = await upHd.json();
    r = await api.post("/api/reshoot/probe", { data: { video_url: hdUrl } });
    expect(r.ok()).toBeTruthy();
    const hdProbe = (await r.json()).probe;
    expect(hdProbe.width).toBe(1920);
    expect(hdProbe.render_width).toBe(832);
    expect(hdProbe.render_height).toBe(464);
    r = await api.post("/api/reshoot/submit", { data: { video_url: hdUrl, moves: "locked-off" } });
    expect(r.status()).toBe(201);
    const hdJob = (await r.json()).job;
    const hdFull = (await (await api.get(`/api/jobs/${hdJob.id}`)).json()).job;
    expect(hdFull.params.width).toBe(832);
    expect(hdFull.params.height).toBe(464);
    expect(hdFull.params.frames).toBe(48);
    // settle it - a live hd job would eat the free plan's one video slot
    const hdDeadline = Date.now() + 60_000;
    let hdStatus = hdJob.status;
    while (Date.now() < hdDeadline && ["queued", "in_progress"].includes(hdStatus)) {
      await new Promise((r2) => setTimeout(r2, 1200));
      hdStatus = (await (await api.get(`/api/jobs/${hdJob.id}`)).json()).job.status;
    }
    expect(hdStatus).toBe("completed");

    // a still image is bad input, not a server error - 400, no charge
    const png = join(tmp, "still.png");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:duration=0.1", "-frames:v", "1", png]);
    const upPng = await api.post("/api/uploads", {
      multipart: { file: { name: "still.png", mimeType: "image/png", buffer: readFileSync(png) } },
    });
    const { url: pngUrl } = await upPng.json();
    r = await api.post("/api/reshoot/probe", { data: { video_url: pngUrl } });
    expect(r.status()).toBe(400);
    r = await api.post("/api/reshoot/submit", { data: { video_url: pngUrl, moves: "locked-off" } });
    expect(r.status()).toBe(400);

    // over-cap: an 11 s clip (265 frames) is past the 81-frame local budget
    // → a plain 400 before any charge; the SAME clip on cloud (≤481) is in
    // - and the cloud job DOES charge, so it lands before the window
    const big = makeClip(join(tmp, "big.mp4"), 11);
    const upBig = await api.post("/api/uploads", {
      multipart: { file: { name: "big.mp4", mimeType: "video/mp4", buffer: big } },
    });
    const { url: bigUrl } = await upBig.json();
    const bigProbe = await api.post("/api/reshoot/probe", { data: { video_url: bigUrl } });
    expect((await bigProbe.json()).probe.frames).toBeGreaterThan(81);
    let oc = await api.post("/api/reshoot/submit", {
      data: { video_url: bigUrl, moves: "dolly-in", backend: "local" },
    });
    expect(oc.status()).toBe(400);
    expect((await oc.json()).error).toMatch(/local budget/);
    oc = await api.post("/api/reshoot/submit", {
      data: { video_url: bigUrl, moves: "dolly-in", backend: "cloud" },
    });
    expect(oc.status()).toBe(201);

    // settle the daily-grant so the balance check measures only job charges -
    // everything below this line is a refusal and must leave it untouched
    const before = await balance(api);

    // guards - ownership and shape before any charge
    for (const [data, code] of [
      [{ video_url: "https://example.com/v.mp4" }, 400],
      [{ video_url: "/files/uploads/does-not-exist.mp4" }, 404],
      [{ video_url: "/files/../escape.mp4" }, 404],
      [{ video_url: videoUrl, moves: "frozen-moment-arc" }, 400], // stills-only
      [{ video_url: videoUrl, moves: "pan-left+tilt-up+crane-up+dolly-in" }, 400],
      [{ video_url: videoUrl, moves: "not-a-move" }, 400],
      [{ video_url: videoUrl, backend: "ltx" }, 400],
    ] as const) {
      const g = await api.post("/api/reshoot/submit", { data });
      expect(g.status(), JSON.stringify(data)).toBe(code);
    }

    // a 120 fps clip - VHS force_rate tops out at 60; a plain 400, no charge
    const fast = makeClip(join(tmp, "fast.mp4"), 1, 0, 120);
    const upFast = await api.post("/api/uploads", {
      multipart: { file: { name: "fast.mp4", mimeType: "video/mp4", buffer: fast } },
    });
    const fastUrl = (await upFast.json()).url;
    const fr = await api.post("/api/reshoot/submit", { data: { video_url: fastUrl, moves: "dolly-in" } });
    expect(fr.status()).toBe(400);
    expect((await fr.json()).error).toMatch(/60 fps/);

    // the generic jobs route is also gated - probe fields are required there
    const dj = await api.post("/api/jobs", {
      data: { endpoint_id: "motionfield/reshoot/video", params: { video_url: videoUrl, moves: "pan-left" } },
    });
    expect(dj.status()).toBe(400);
    expect((await dj.json()).error).toMatch(/frames/);

    // the local-budget refusal rides again inside the window
    oc = await api.post("/api/reshoot/submit", {
      data: { video_url: bigUrl, moves: "dolly-in", backend: "local" },
    });
    expect(oc.status()).toBe(400);

    // another user's clip → ownership refuses it before any charge
    const api2 = await signUp("api2");
    oc = await api2.post("/api/reshoot/submit", {
      data: { video_url: videoUrl, moves: "dolly-in" },
    });
    expect(oc.status()).toBe(404);

    // none of the refusals touched the balance
    expect(await balance(api), "rejections must not charge").toBe(before);
    await api.dispose();
    await api2.dispose();
  });

  test("[OF-0xx2] /new-camera-move page - probe card, hidden stills rows, controls reach the job", async ({ page }) => {
    let attempt = 0;
    await expect.poll(async () => {
      const email = `ws3rs-ui-${Date.now()}-${attempt++}-${Math.random().toString(36).slice(2, 6)}@test.local`;
      const su = await page.context().request.post("/api/auth/sign-up/email", {
        data: { email, password: "test-pass-1234", name: "WS3 RS UI" },
      });
      if (!su.ok()) return 0;
      return (await page.context().request.get("/api/me")).status();
    }, { timeout: 90_000, intervals: [1000, 3000, 6000, 10000] }).toBe(200);

    const clipPath = join(tmp, "ui-clip.mp4");
    makeClip(clipPath, 2, 2.1);

    await page.goto("/new-camera-move");
    await expect(page.getByRole("heading", { name: "New Camera Move" })).toBeVisible();
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(clipPath);
    const card = page.getByTestId("probe-card");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("48 frames · 24.00 fps");
    await expect(card).toContainText("renders at 320×176");
    await expect(card).toContainText("keeps the source audio");

    // the picker: a pose-path move is offered; the stills-only orbit row is
    // not merely disabled - it's not listed at all
    await page.getByRole("button", { name: /New path/ }).click();
    // the picker row shares its title with the standalone move-chips buttons -
    // scope to the open popover
    const pop = page.getByTestId("traj-picker-pop");
    const dolly = pop.getByRole("button", { name: "Dolly In", exact: true });
    const frozen = pop.getByRole("button", { name: "Frozen Orbit" });
    await expect(dolly).toBeEnabled();
    await expect(frozen).toHaveCount(0);
    await dolly.click();

    // strength, distance and a two-move chip stack all reach the submit -
    // and the job params carry them
    await setRange(page.getByLabel("Move strength"), "1.5");
    await page.getByLabel("Subject distance").fill("6.5");
    const chips = page.getByTestId("move-chips");
    await chips.getByRole("button", { name: "Dolly In", exact: true }).click();
    await chips.getByRole("button", { name: "Pan Left", exact: true }).click();

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/reshoot/submit") && r.request().method() === "POST"),
      page.getByRole("button", { name: "Apply new camera move", exact: true }).click(),
    ]);
    expect(resp.status()).toBe(201);
    const body = resp.request().postDataJSON();
    expect(body.moves).toBe("dolly-in+pan-left");
    expect(body.strength).toBe(1.5);
    expect(body.distance).toBe(6.5);
    expect(body.backend).toBe("local");
    const { job } = await resp.json();
    const full = (await (await page.context().request.get(`/api/jobs/${job.id}`)).json()).job;
    expect(full.params.moves).toBe("dolly-in+pan-left");
    expect(full.params.strength).toBe(1.5);
    expect(full.params.distance).toBe(6.5);

    // the cloud option shows its honest label in the engine select
    const engine = page.locator("select");
    await expect(engine.locator("option", { hasText: "untested" })).toHaveCount(1);

    // an over-local-cap clip: the card says "cloud recommended", and only
    // the hard cap disables the button entirely
    const bigPath = join(tmp, "big-ui.mp4");
    makeClip(bigPath, 11);
    await page.getByRole("button", { name: "✕" }).click(); // drop the first clip - the input remounts
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(bigPath);
    await expect(card).toContainText("cloud recommended", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Apply new camera move", exact: true })).toBeEnabled();
  });
});
