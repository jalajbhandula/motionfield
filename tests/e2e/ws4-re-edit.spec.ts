/**
 * ReCut v2 e2e (GENERATION_PROVIDER=mock):
 *  - POST /api/re-edit/detect splits the uploaded clip server-side
 *  - POST /api/re-edit runs the WHOLE edit in ONE job (no per-shot children)
 *  - the assembled result keeps the source's frame rate/size/audio
 *  - POST /api/re-edit/[id]/shots/[i] regenerates one shot - one more job
 *  - a 31 s reference → 400
 *  - an external video_url → 400, a /files url you don't own → 404
 */
import { test, expect } from "@playwright/test";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESTYLE_PRESET_IDS } from "../../src/lib/catalog/video/swap";
import { EFFECT_PRESETS } from "../../src/lib/catalog/presets/effects";
import { specById, specVisible } from "../../src/lib/catalog/presets/schema";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const tmp = mkdtempSync(join(tmpdir(), "of-ws4-e2e-"));

function makeClip(file: string, secs: { color: string; dur: number }[], audio = true) {
  const inputs = secs.flatMap((s) => [
    "-f", "lavfi", "-i", `color=${s.color}:size=320x180:rate=24:duration=${s.dur}`,
  ]);
  const total = secs.reduce((a, s) => a + s.dur, 0);
  execFileSync("ffmpeg", [
    "-y", "-v", "error", ...inputs,
    ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${total}`] : []),
    "-filter_complex",
    secs.map((_, i) => `[${i}:v]`).join("") + `concat=n=${secs.length}:v=1:a=0[v]`,
    "-map", "[v]", ...(audio ? ["-map", `${secs.length}:a`, "-c:a", "aac"] : ["-an"]),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
  ]);
  return readFileSync(file);
}

const ffprobeJson = (file: string) => JSON.parse(execFileSync("ffprobe", [
  "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
]).toString());

test.describe("ws4 re-edit", () => {
  test("detect → one-job rebuild → per-shot regen; ownership + duration guards", async ({ request }) => {
    const email = `ws4-re-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const su = await request.post("/api/auth/sign-up/email", {
      data: { email, password: "test-pass-1234", name: "WS4 ReCut" },
    });
    expect(su.ok()).toBeTruthy();

    // luma-contrasting shots - ffmpeg's scene detector is luma-based
    const clip = makeClip(join(tmp, "two-shot.mp4"), [
      { color: "black", dur: 1.0 }, { color: "white", dur: 1.2 },
    ]);
    const up = await request.post("/api/uploads", {
      multipart: { file: { name: "two-shot.mp4", mimeType: "video/mp4", buffer: clip } },
    });
    expect(up.ok()).toBeTruthy();
    const { url: videoUrl } = await up.json();
    expect(videoUrl).toMatch(/^\/files\//);

    // server-side split
    let r = await request.post("/api/re-edit/detect", { data: { video_url: videoUrl } });
    expect(r.ok()).toBeTruthy();
    const det = await r.json();
    expect(det.shots.length).toBeGreaterThanOrEqual(2);
    expect(det.windows).toBe(det.shots.reduce((a: number, s: { windows: unknown[] }) => a + s.windows.length, 0));
    expect(Math.abs(det.probe.duration - 2.2)).toBeLessThan(0.15);
    expect(Math.abs(det.probe.fps - 24)).toBeLessThan(0.01);
    expect(det.probe.has_audio).toBe(true);

    // start - ONE job for the whole edit; steps is a declared param (2-50)
    r = await request.post("/api/re-edit", {
      data: { video_url: videoUrl, flow: "restyle", instructions: "grainy film", resolution: "480p", steps: 6 },
    });
    expect(r.status()).toBe(201);
    const { chain, job } = await r.json();
    // POST returns the public shape - params ride on the jobs API instead
    expect(job).toMatchObject({ status: "queued" });
    expect(job).not.toHaveProperty("params");
    expect(job).not.toHaveProperty("user_id");
    const jr = await request.get(`/api/jobs/${job.id}`);
    expect(jr.ok()).toBeTruthy();
    const { job: jobFull } = await jr.json();
    expect(jobFull.params.chain_id).toBe(chain.id);
    expect(jobFull.params.windows).toBe(det.windows);
    expect(jobFull.params.steps).toBe(6);
    expect(chain.status).toBe("queued");

    // drain - every poll must show exactly one job for the chain, in the
    // public shape (no params/user_id leak)
    let status = "queued", last = chain;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await new Promise((r2) => setTimeout(r2, 1500));
      const g = await request.get(`/api/re-edit/${chain.id}`);
      expect(g.ok()).toBeTruthy();
      const d = await g.json();
      expect(d.jobs.length).toBe(1);
      expect(d.jobs[0]).not.toHaveProperty("params");
      expect(d.jobs[0]).not.toHaveProperty("user_id");
      expect(d.shot_status.length).toBe(det.shots.length);
      status = d.chain.status; last = d.chain;
      if (!["queued", "running", "assembling"].includes(status)) break;
    }
    expect(status).toBe("completed");
    expect(last.result_url).toMatch(/^\/files\/generated\/re-edit\//);

    // the assembled file keeps source properties
    const out = await request.get(last.result_url);
    expect(out.ok()).toBeTruthy();
    const outFile = join(tmp, "assembled.mp4");
    writeFileSync(outFile, await out.body());
    const meta = ffprobeJson(outFile);
    const v = meta.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    expect(v.width).toBe(320); expect(v.height).toBe(180);
    const [rn, rd] = v.avg_frame_rate.split("/").map(Number);
    expect(Math.abs(rn / rd - 24)).toBeLessThan(0.01);
    expect(Math.abs(Number(meta.format.duration) - 2.2)).toBeLessThanOrEqual(0.2);
    expect(meta.streams.some((s: { codec_type: string }) => s.codec_type === "audio")).toBe(true);

    // The chain assembly may finish before its parent job's optional polish.
    // Wait for the actual job to release the free-plan concurrency slot.
    await expect.poll(async () => {
      const current = await request.get(`/api/jobs/${job.id}`);
      return (await current.json()).job.status;
    }, { timeout: 120_000, intervals: [500, 1000] }).toBe("completed");

    // regenerate shot 0 - a second job for the same chain, then complete again
    r = await request.post(`/api/re-edit/${chain.id}/shots/0`, { data: { hint: "more teal" } });
    expect(r.status()).toBe(201);
    const regen = await r.json();
    expect(regen.job).not.toHaveProperty("params");
    const gr = await request.get(`/api/jobs/${regen.job.id}`);
    const { job: regenFull } = await gr.json();
    expect(regenFull.params.regenerate_index).toBe(0);
    // the regen job inherits the start job's steps - not the default
    expect(regenFull.params.steps).toBe(6);

    // a GET while the regen is in flight must leave the chain running - a
    // mid-start job row is not a reason to reconcile the chain to failed
    {
      const inflight = await request.get(`/api/re-edit/${chain.id}`);
      expect(inflight.ok()).toBeTruthy();
      const d = await inflight.json();
      expect(d.chain.status).toBe("running");
      expect(d.jobs.map((j: { id: string }) => j.id)).toContain(regen.job.id);
      expect(d.shot_status[0]).toBe("running");
    }

    status = "running";
    while (Date.now() < deadline) {
      await new Promise((r2) => setTimeout(r2, 1500));
      const g = await request.get(`/api/re-edit/${chain.id}`);
      const d = await g.json();
      status = d.chain.status; last = d.chain;
      if (!["queued", "running", "assembling"].includes(status)) break;
    }
    expect(status).toBe("completed");

    // second POST while… nothing - the chain completed again; concurrent
    // claim is covered by the unit test's two-race assertion.

    // guards: external url → 400 (restyle - reaches the media check)
    r = await request.post("/api/re-edit", {
      data: { video_url: "https://example.com/v.mp4", flow: "restyle" },
    });
    expect(r.status()).toBe(400);
    // preset_id on a non-restyle flow → 400; unknown preset → 400;
    // a real effect preset outside RESTYLE_PRESET_IDS → 400
    r = await request.post("/api/re-edit", {
      data: { video_url: videoUrl, flow: "character-swap", preset_id: "flash-frost" },
    });
    expect(r.status()).toBe(400);
    r = await request.post("/api/re-edit", {
      data: { video_url: videoUrl, flow: "restyle", preset_id: "no-such-preset" },
    });
    expect(r.status()).toBe(400);
    r = await request.post("/api/re-edit", {
      data: { video_url: videoUrl, flow: "restyle", preset_id: "weightless" },
    });
    expect(r.status()).toBe(400);
    // a /files url the user doesn't own → 404 (restyle - well-formed, so the
    // ownership check is what rejects it)
    r = await request.post("/api/re-edit", {
      data: { video_url: "/files/uploads/does-not-exist.mp4", flow: "restyle" },
    });
    expect(r.status()).toBe(404);
    // a photo-driven flow without any reference image → 400 before any IO
    r = await request.post("/api/re-edit", {
      data: { video_url: videoUrl, flow: "character-swap" },
    });
    expect(r.status()).toBe(400);
    // a non-UUID chain id → 404 (no PG uuid cast 500)
    r = await request.get("/api/re-edit/xyz");
    expect(r.status()).toBe(404);
    // a PNG uploaded as the video → 400 on detect
    execFileSync("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi",
      "-i", "color=red:size=64x64:duration=1", "-frames:v", "1", join(tmp, "still.png"),
    ]);
    const png = readFileSync(join(tmp, "still.png"));
    const upPng = await request.post("/api/uploads", {
      multipart: { file: { name: "still.png", mimeType: "image/png", buffer: png } },
    });
    expect(upPng.ok()).toBeTruthy();
    const { url: pngUrl } = await upPng.json();
    r = await request.post("/api/re-edit/detect", { data: { video_url: pngUrl } });
    expect(r.status()).toBe(400);
    // >30 s reference → 400
    const long = makeClip(join(tmp, "long.mp4"), [{ color: "green", dur: 31 }], false);
    const up2 = await request.post("/api/uploads", {
      multipart: { file: { name: "long.mp4", mimeType: "video/mp4", buffer: long } },
    });
    const { url: longUrl } = await up2.json();
    r = await request.post("/api/re-edit/detect", { data: { video_url: longUrl } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("30");
  });

  test("/re-edit-video UI: restyle tiles are exactly the allowlist; a character-swap submit sends no preset_id", async ({ page }) => {
    // Under parallel e2e load the pglite drain can lose a sign-up's user row -
    // the response is still 2xx but the session never reads back. Retry the
    // whole signup (fresh email each try) until /api/me answers 200.
    let attempt = 0;
    await expect.poll(async () => {
      const email = `ws4-ui-${Date.now()}-${attempt++}-${Math.random().toString(36).slice(2, 6)}@test.local`;
      const su = await page.context().request.post("/api/auth/sign-up/email", {
        data: { email, password: "test-pass-1234", name: "WS4 UI" },
      });
      if (!su.ok()) return 0;
      return (await page.context().request.get("/api/me")).status();
    }, { timeout: 90_000, intervals: [1000, 3000, 6000, 10000] }).toBe(200);

    const clipPath = join(tmp, "ui-two-shot.mp4");
    makeClip(clipPath, [{ color: "black", dur: 1.0 }, { color: "white", dur: 1.2 }]);
    const pngPath = join(tmp, "ui-photo.png");
    execFileSync("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi",
      "-i", "color=red:size=64x64:duration=1", "-frames:v", "1", pngPath,
    ]);

    await page.goto("/re-edit-video");
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(clipPath);
    await expect(page.getByText(/shots · \d+ generation windows/)).toBeVisible({ timeout: 60_000 });

    // restyle flow → the tile set equals RESTYLE_PRESET_IDS exactly
    await page.getByRole("button", { name: /Restyle/ }).click();
    const tiles = page.locator(".grid.grid-cols-4 > button");
    // the tiles are the allowlist ∩ the verify-file's visible set
    const expectedTitles = RESTYLE_PRESET_IDS
      .filter((id) => { const s = specById(id); return s && specVisible(s); })
      .map((id) => EFFECT_PRESETS.find((p) => p.id === id)!.title);
    await expect(tiles).toHaveText(expectedTitles);

    // pick a preset, then switch flows - the preset must not leak into the
    // character-swap submit
    await tiles.first().click();
    await page.getByRole("button", { name: /Character swap/ }).click();
    // subject refs are gated: the upload stays disabled until the likeness
    // box is ticked, and the POST carries the assertion
    const photoInput = page.locator('input[type="file"][accept="image/*"]');
    await expect(photoInput).toBeDisabled();
    await page.getByText("I have the right to use this person's likeness").click();
    await expect(photoInput).toBeEnabled();
    await photoInput.setInputFiles(pngPath);
    await expect(page.locator('img[src^="/files/uploads/"]')).toHaveCount(1);

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/re-edit") && r.request().method() === "POST"),
      page.getByRole("button", { name: /Re-edit -/ }).click(),
    ]);
    expect(resp.status()).toBe(201);
    const body = resp.request().postDataJSON();
    expect(body.flow).toBe("character-swap");
    expect(body.image_urls).toHaveLength(1);
    expect(body.likeness_consent).toBe(true);
    expect(body).not.toHaveProperty("preset_id");
  });

  test("a chain started through POST /api/jobs is found by GET /api/re-edit/<id> and regenerates", async ({ request }) => {
    const email = `ws4-jobs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const su = await request.post("/api/auth/sign-up/email", {
      data: { email, password: "test-pass-1234", name: "WS4 Jobs" },
    });
    expect(su.ok()).toBeTruthy();

    const clip = makeClip(join(tmp, "jobs-two-shot.mp4"), [
      { color: "black", dur: 1.0 }, { color: "white", dur: 1.2 },
    ]);
    const up = await request.post("/api/uploads", {
      multipart: { file: { name: "jobs-two-shot.mp4", mimeType: "video/mp4", buffer: clip } },
    });
    const { url: videoUrl } = await up.json();
    const det = await (await request.post("/api/re-edit/detect", { data: { video_url: videoUrl } })).json();

    // the recipe owns the chain - a bare jobs-API submit creates it mid-run
    const r = await request.post("/api/jobs", {
      data: {
        endpoint_id: "motionfield/re-edit/v1.0",
        params: { video_url: videoUrl, flow: "restyle", windows: det.windows, resolution: "480p", steps: 6 },
      },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    expect(r.status()).toBe(201);
    const { job } = await r.json();

    // drain via the jobs API - each GET ticks the recipe
    let full: { status: string; params: Record<string, unknown> } | undefined;
    for (let i = 0; i < 240; i++) {
      full = (await (await request.get(`/api/jobs/${job.id}`)).json()).job;
      if (!["queued", "in_progress"].includes(full!.status)) break;
      await new Promise((r2) => setTimeout(r2, 1500));
    }
    expect(full!.status).toBe("completed");
    const cid = full!.params.chain_id as string;
    expect(cid).toBeTruthy();

    // the chain reads back through the re-edit API and shot 0 regenerates
    const g = await request.get(`/api/re-edit/${cid}`);
    expect(g.ok()).toBeTruthy();
    const d = await g.json();
    expect(d.chain.status).toBe("completed");
    expect(d.chain.result_url).toMatch(/^\/files\/generated\/re-edit\//);
    const rr = await request.post(`/api/re-edit/${cid}/shots/0`, { data: {} });
    expect(rr.status()).toBe(201);
    // let the regen drain so no job outlives the test
    for (let i = 0; i < 240; i++) {
      const g2 = await request.get(`/api/re-edit/${cid}`);
      const d2 = await g2.json();
      if (!["queued", "running", "assembling"].includes(d2.chain.status)) break;
      await new Promise((r2) => setTimeout(r2, 1500));
    }
  });

  test("refs enum guard → 400; Tab to Studio tools opens role=menu, Escape closes it", async ({ page }) => {
    let attempt = 0;
    await expect.poll(async () => {
      const email = `ws4-nav-${Date.now()}-${attempt++}-${Math.random().toString(36).slice(2, 6)}@test.local`;
      const su = await page.context().request.post("/api/auth/sign-up/email", {
        data: { email, password: "test-pass-1234", name: "WS4 Nav" },
      });
      if (!su.ok()) return 0;
      return (await page.context().request.get("/api/me")).status();
    }, { timeout: 90_000, intervals: [1000, 3000, 6000, 10000] }).toBe(200);

    const rr = await page.context().request.get("/api/refs?category=bogus");
    expect(rr.status()).toBe(400);

    // keyboard access: Tabbing onto "Studio tools" opens its dropdown; Escape closes
    await page.goto("/");
    const studio = page.getByRole("link", { name: "Studio tools" });
    for (let i = 0; i < 20 && !(await studio.evaluate((el) => el === document.activeElement)); i++)
      await page.keyboard.press("Tab");
    await expect(studio).toBeFocused();
    const menu = page.getByRole("menu", { name: "Studio tools menu" });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("renamed studio routes answer; the retired slugs 404", async ({ request }) => {
    for (const p of ["/product-ads", "/campaigns"]) {
      const r = await request.get(p);
      expect(r.status(), `${p} should render`).toBe(200);
    }
    for (const p of ["/ads-studio", "/marketing-studio"]) {
      const r = await request.get(p);
      expect(r.status(), `${p} should be gone`).toBe(404);
    }
  });
});
