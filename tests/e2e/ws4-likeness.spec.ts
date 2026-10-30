/**
 * Likeness consent e2e (GENERATION_PROVIDER=mock):
 *  - every identity endpoint answers 400 "likeness consent required" unless
 *    params carry likeness_consent: true - UI, REST and v1 hit the same gate
 *  - /api/refs person/character rows need the box; prop refs don't
 *  - /api/re-edit character-swap with subject refs 400s without it; regen
 *    reuses the consent captured at chain start
 *  - /api/characters POST is gone (reference-based characters - no training)
 *  - the studio renders the box unticked and keeps the upload disabled
 */
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const tmp = mkdtempSync(join(tmpdir(), "of-ws4-likeness-"));

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

function makeClip(file: string) {
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi",
    "-i", "color=black:size=320x180:rate=24:duration=1.5",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
  ]);
  return file;
}

test.describe("ws4 likeness consent", () => {
  test("identity endpoints 400 without consent, run with it", async ({ request }) => {
    const email = `ws4-likeness-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const su = await request.post("/api/auth/sign-up/email", {
      data: { email, password: "test-pass-1234", name: "WS4 Likeness" },
    });
    expect(su.ok()).toBeTruthy();

    const post = (data: Record<string, unknown>) =>
      request.post("/api/jobs", { data });

    // wan-vace character-swap - image_urls is the identity param
    for (const params of [
      { video_url: "/files/uploads/fake.mp4", image_urls: ["/files/uploads/fake.png"], prompt: "swap" },
      { video_url: "/files/uploads/fake.mp4", image_urls: ["/files/uploads/fake.png"], prompt: "swap", likeness_consent: false },
    ]) {
      const r = await post({ endpoint_id: "motionfield/wan-vace/character-swap", params });
      expect(r.status()).toBe(400);
      expect((await r.json()).error).toContain("likeness consent required");
    }
    // with consent the submit reaches the media gates - video_url is an
    // owned ≥4 s upload, not a fake path (probed before any charge)
    const clipPath = join(tmp, "swap-src.mp4");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi",
      "-i", "color=black:size=320x180:rate=24:duration=4.5",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", clipPath]);
    const upVid = await request.post("/api/uploads", {
      multipart: { file: { name: "swap-src.mp4", mimeType: "video/mp4", buffer: readFileSync(clipPath) } },
    });
    expect(upVid.ok()).toBeTruthy();
    const { url: clipUrl } = await upVid.json();

    let r = await post({
      endpoint_id: "motionfield/wan-vace/character-swap",
      params: { video_url: clipUrl, image_urls: ["/files/uploads/fake.png"], prompt: "swap", likeness_consent: true },
    });
    expect(r.status()).toBe(201);
    // free-tier concurrency is 1 active job - release it before the next create
    const { job: j1 } = await r.json();
    await request.post(`/api/jobs/${j1.id}/cancel`);

    // musetalk talking-portrait - image_url is the identity param
    r = await post({
      endpoint_id: "motionfield/musetalk/talking-portrait",
      params: { image_url: "/files/uploads/fake.png", audio_url: "/files/uploads/fake.mp3" },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("likeness consent required");
    r = await post({
      endpoint_id: "motionfield/musetalk/talking-portrait",
      params: { image_url: "/files/uploads/fake.png", audio_url: "/files/uploads/fake.mp3", likeness_consent: true },
    });
    expect(r.status()).toBe(201);
    const { job: j2 } = await r.json();
    await request.post(`/api/jobs/${j2.id}/cancel`);

    // a non-identity surface - restyle with no refs - isn't gated
    r = await post({
      endpoint_id: "motionfield/re-edit/v1.0",
      params: { video_url: "/files/uploads/fake.mp4", flow: "restyle", windows: 1, resolution: "480p" },
    });
    expect(r.status()).toBe(201);
  });

  test("/api/refs: person+character need consent, prop doesn't; /api/characters POST is gone", async ({ request }) => {
    const email = `ws4-refs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const su = await request.post("/api/auth/sign-up/email", {
      data: { email, password: "test-pass-1234", name: "WS4 Refs" },
    });
    expect(su.ok()).toBeTruthy();

    const up = await request.post("/api/uploads", {
      multipart: { file: { name: "ref.png", mimeType: "image/png", buffer: PNG } },
    });
    const { url: img } = await up.json();

    let r = await request.post("/api/refs", {
      data: { name: "hero", kind: "person", category: "character", images: [img] },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("likeness consent required");

    r = await request.post("/api/refs", {
      data: { name: "hero", kind: "person", category: "character", images: [img], likeness_consent: true },
    });
    expect(r.status()).toBe(201);

    // character category alone is an identity point too
    r = await request.post("/api/refs", {
      data: { name: "look", category: "character", images: [img] },
    });
    expect(r.status()).toBe(400);

    // prop refs carry no likeness - no box needed
    r = await request.post("/api/refs", {
      data: { name: "prop-a", category: "prop", kind: "prop", images: [img] },
    });
    expect(r.status()).toBe(201);

    // the training mock is gone - reference-based characters only
    r = await request.post("/api/characters", {
      data: { name: "x", input_images: [img] },
    });
    expect([404, 405]).toContain(r.status());
  });

  test("/api/re-edit character-swap needs consent; regen reuses the stored flag", async ({ request }) => {
    const email = `ws4-re-editlk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const su = await request.post("/api/auth/sign-up/email", {
      data: { email, password: "test-pass-1234", name: "WS4 ReCut LK" },
    });
    expect(su.ok()).toBeTruthy();

    const clipPath = makeClip(join(tmp, "clip.mp4"));
    const up = await request.post("/api/uploads", {
      multipart: { file: { name: "clip.mp4", mimeType: "video/mp4", buffer: readFileSync(clipPath) } },
    });
    const { url: videoUrl } = await up.json();
    const upImg = await request.post("/api/uploads", {
      multipart: { file: { name: "s.png", mimeType: "image/png", buffer: PNG } },
    });
    const { url: img } = await upImg.json();

    // no consent → 400 with the fixed reason
    let r = await request.post("/api/re-edit", {
      data: { video_url: videoUrl, flow: "character-swap", image_urls: [img], resolution: "480p" },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("likeness consent required");

    // consent → chain starts; the stored flag is what regen carries
    r = await request.post("/api/re-edit", {
      data: { video_url: videoUrl, flow: "character-swap", image_urls: [img], resolution: "480p", likeness_consent: true },
    });
    expect(r.status()).toBe(201);
    const { chain } = await r.json();
    // clean up - the mock provider run continues in the background otherwise
    await request.delete(`/api/re-edit/${chain.id}`);

    // motion-transfer re-renders the supplied subject - gated like the swap
    r = await request.post("/api/re-edit", {
      data: { video_url: videoUrl, flow: "motion-transfer", image_urls: [img], resolution: "480p" },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("likeness consent required");
    r = await request.post("/api/re-edit", {
      data: { video_url: videoUrl, flow: "motion-transfer", image_urls: [img], resolution: "480p", likeness_consent: true },
    });
    expect(r.status()).toBe(201);
    const d = await r.json();
    await request.delete(`/api/re-edit/${d.chain.id}`);
  });

  test("/ai/video: the swap studio shows the box unticked and keeps the upload disabled", async ({ page }) => {
    let attempt = 0;
    await expect.poll(async () => {
      const email = `ws4-lkui-${Date.now()}-${attempt++}-${Math.random().toString(36).slice(2, 6)}@test.local`;
      const su = await page.context().request.post("/api/auth/sign-up/email", {
        data: { email, password: "test-pass-1234", name: "WS4 LK UI" },
      });
      if (!su.ok()) return 0;
      return (await page.context().request.get("/api/me")).status();
    }, { timeout: 90_000, intervals: [1000, 3000, 6000, 10000] }).toBe(200);

    await page.goto("/ai/video?model=wan-vace&flow=character-swap");
    // the field renders the label twice (header + checkbox caption) - pin
    // the box itself
    const box = page.locator('input[type="checkbox"]').first();
    await expect(box).toBeVisible();
    await expect(box).not.toBeChecked();
    await expect(page.getByText("I have the right to use this person's likeness").first()).toBeVisible();

    // the identity upload's file input stays disabled until the box is ticked
    const inputs = page.locator('input[type="file"][accept="image/*"]');
    await expect(inputs.first()).toBeDisabled();
    await box.check();
    await expect(inputs.first()).toBeEnabled();

    // a crafted deep link must NOT pre-tick the box - consent is an
    // assertion, never a prefill param
    await page.goto(`/ai/video?model=wan-vace&flow=character-swap&params=${encodeURIComponent('{"likeness_consent":true,"prompt":"hi"}')}`);
    const box2 = page.locator('input[type="checkbox"]').first();
    await expect(box2).toBeVisible();
    await expect(box2).not.toBeChecked();
    await expect(page.locator('input[type="file"][accept="image/*"]').first()).toBeDisabled();
  });

  test("/characters states reference-based characters; /audio shows the watermark note on voice-clone", async ({ page }) => {
    await expect.poll(async () => {
      const email = `ws4-pages-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
      const su = await page.context().request.post("/api/auth/sign-up/email", {
        data: { email, password: "test-pass-1234", name: "WS4 Pages" },
      });
      if (!su.ok()) return 0;
      return (await page.context().request.get("/api/me")).status();
    }, { timeout: 90_000, intervals: [1000, 3000, 6000, 10000] }).toBe(200);

    await page.goto("/characters");
    await expect(page.getByText(/Reference-based characters/i)).toBeVisible();
    await expect(page.getByText(/no model training/i).first()).toBeVisible();

    await page.goto("/audio?flow=voice-clone");
    await expect(page.getByRole("button", { name: /Voice clone/i })).toBeVisible();
    await expect(page.getByText(/watermark/i).first()).toBeVisible();
  });
});
