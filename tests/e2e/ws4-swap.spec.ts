/**
 * ws4 swap lanes e2e (GENERATION_PROVIDER=mock - plumbing + gates; pixels are
 * the gpu-smoke lane):
 *  E1 - Quick→PersonSwap deep link: /person-swap?clip=&photo= preselects the same
 *       server-side media (detect re-checks ownership - foreign ids 404)
 *  E2 - object lane: /object-swap renders; the endpoint 400s without the
 *       frame-0 mask and completes with mask_url + consent
 *  E3 - restyle lane: /restyle shows only VERIFIED presets with the
 *       real count; an unverified preset is a 400, a verified one completes
 *  E4 - s7b photo face swap: the /apps tile is verified-gated, /edit
 *       redirects into the face-edit flow, and the endpoint's likeness
 *       consent gate 400s an unticked submit
 *  E5 - cancel-before-save: a mid-run DELETE leaves no person-swap-<id>-*.mp4
 *       on disk and no published output
 */
import { test, expect, type APIRequestContext, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
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

async function signUp(request: APIRequestContext, tag: string) {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const su = await request.post("/api/auth/sign-up/email", {
    data: { email, password: "test-pass-1234", name: tag },
  });
  expect(su.ok()).toBeTruthy();
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

async function waitJob(request: APIRequestContext, id: string, timeoutMs = 120_000): Promise<{ status: string; params: Record<string, unknown>; outputs: { type: string; url: string }[] }> {
  let row: { status: string; params: Record<string, unknown>; outputs: { type: string; url: string }[]; error?: string | null } | null = null;
  await expect.poll(async () => {
    const g = await request.get(`/api/jobs/${id}`);
    row = (await g.json()).job;
    return ["completed", "failed", "canceled", "nsfw"].includes(row!.status) ? row!.status : null;
  }, { timeout: timeoutMs, intervals: [1500] }).toBeTruthy();
  return row!;
}

test.describe("ws4 swap lanes", () => {
  test("E1 deep link: /person-swap?clip=&photo= preselects the same media", async ({ page }, testInfo) => {
    await signUp(page.context().request, "ws4-link");
    const request = page.context().request;
    const clip = await uploadClip(request, testInfo.outputPath("link-clip.mp4"), 2, true);
    const img = await uploadFile(request, "link.png", "image/png", PNG);

    await page.goto(`/person-swap?clip=${encodeURIComponent(clip)}&photo=${encodeURIComponent(img)}`);
    await expect(page.getByRole("heading", { name: "Person Swap" })).toBeVisible();
    // the clip is preloaded - the estimate needs a real probe, not a guess
    await expect(page.locator(`video[src="${clip}"]`).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/generation window/)).toBeVisible({ timeout: 60_000 });
    // the ref photo lands in the identity list (its thumbnail is the img)
    await expect(page.locator(`img[alt="ref"][src="${img}"]`)).toBeVisible();
    // the consent box is still untouched - deep links never pre-tick it
    await expect(page.locator("#person-swap-consent")).not.toBeChecked();
  });

  test("E2 object: page renders; mask_url required; masked submit completes", async ({ page, request }, testInfo) => {
    await signUp(request, "ws4-obj");
    const clip = await uploadClip(request, testInfo.outputPath("obj-clip.mp4"), 5, true);
    const img = await uploadFile(request, "obj.png", "image/png", PNG);
    const mask = await uploadFile(request, "obj-mask.png", "image/png", PNG);

    // API: the frame-0 pick is required - no mask_url is a 400
    let r = await request.post("/api/jobs", {
      data: {
        endpoint_id: "motionfield/wan-vace/object-swap",
        params: { video_url: clip, image_urls: [img], likeness_consent: true },
      },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("mask_url");

    r = await request.post("/api/jobs", {
      data: {
        endpoint_id: "motionfield/wan-vace/object-swap",
        params: { video_url: clip, mask_url: mask, image_urls: [img], likeness_consent: true },
      },
    });
    expect(r.status()).toBe(201);
    const { job } = await r.json();
    const done = await waitJob(request, job.id);
    expect(done.status).toBe("completed");
    expect(String(done.params.mask_url)).toBe(mask);

    // UI: the Object tab + the frame-0 pick surface render
    await page.goto("/object-swap");
    await expect(page.getByRole("heading", { name: "Object Swap" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Person/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Restyle/ })).toBeVisible();
    await expect(page.getByText(/tracked across the clip/)).toBeVisible();
    await expect(page.getByText("+ Drop a clip - then drag a box over the object")).toBeVisible();
    await expect(page.getByLabel(/Source clip/i)).toBeAttached();
    await expect(page.getByText("Replacement object photo (1)", { exact: true })).toBeVisible();
    await expect(page.getByLabel(/Replacement object photo/i)).toBeAttached();
  });

  test("E3 restyle: verified-only grid + real count + verified submit", async ({ page, request }, testInfo) => {
    await signUp(request, "ws4-restyle");

    // UI: exactly the verified subset shows - the fixture verifies
    // comic-panel + cel-shade, so the count is 2 and unverified presets
    // never render
    await page.goto("/restyle");
    await expect(page.getByRole("heading", { name: "Video Restyle" })).toBeVisible();
    await expect(page.getByText("2 verified")).toBeVisible();
    await expect(page.getByRole("button", { name: /Cel Shade/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Comic Panel/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Wet Neon/ })).toBeHidden();
    await expect(page.getByRole("button", { name: /Claymation/ })).toBeHidden();

    // API: an unverified preset is a 400 "preset not available" - the picker
    // isn't the only gate
    const clip = await uploadClip(request, testInfo.outputPath("restyle-clip.mp4"), 5, true);
    let r = await request.post("/api/jobs", {
      data: {
        endpoint_id: "motionfield/wan-vace/restyle",
        params: { video_url: clip, preset_id: "neon-noir" },
      },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("preset not available");

    // a verified preset completes under the mock provider
    r = await request.post("/api/jobs", {
      data: {
        endpoint_id: "motionfield/wan-vace/restyle",
        params: { video_url: clip, preset_id: "cel-shade" },
      },
    });
    expect(r.status()).toBe(201);
    const { job } = await r.json();
    const done = await waitJob(request, job.id);
    expect(done.status).toBe("completed");
    expect(done.params.preset_id).toBe("cel-shade");
    // restyle is not a likeness flow - no consent needed and none recorded
    expect(done.params.likeness_consent).not.toBe(true);
  });

  test("E4 face swap: verified tile → /edit redirect → consent gate", async ({ page, request }, testInfo) => {
    await signUp(request, "ws4-face");
    const imgA = await uploadFile(request, "face-a.png", "image/png", PNG);
    const imgB = await uploadFile(request, "face-b.png", "image/png", PNG);

    // the tile is verification-gated like every app
    await page.goto("/apps");
    const tile = page.getByRole("link", { name: /Face Swap/ });
    await expect(tile).toBeVisible();
    const href = await tile.getAttribute("href");
    expect(href).toContain("/edit?");
    expect(href).toContain("preset=photo-face-swap");

    // /edit lands in the image studio at the face-edit flow with the preset
    await page.goto(href!);
    await expect(page).toHaveURL(/\/ai\/image\?.*flow=face-edit.*preset=photo-face-swap/);

    // consent gate: unticked submit → 400 likeness consent required
    let r = await request.post("/api/jobs", {
      data: {
        endpoint_id: "motionfield/flux2-klein-4b/face-edit",
        params: { image_url: imgA, image_urls: [imgB] },
      },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("likeness consent required");

    // ticked + both photos + the verified preset → accepted
    r = await request.post("/api/jobs", {
      data: {
        endpoint_id: "motionfield/flux2-klein-4b/face-edit",
        params: { image_url: imgA, image_urls: [imgB], likeness_consent: true, preset_id: "photo-face-swap" },
      },
    });
    expect(r.status()).toBe(201);
    const { job } = await r.json();
    const done = await waitJob(request, job.id);
    expect(done.status).toBe("completed");
  });

  test("E5 cancel: DELETE mid-run leaves no person-swap-<id>-*.mp4", async ({ request }, testInfo) => {
    await signUp(request, "ws4-cancel");
    const img = await uploadFile(request, "c.png", "image/png", PNG);
    const clip = await uploadClip(request, testInfo.outputPath("cancel-clip.mp4"), 6, true);

    const r = await request.post("/api/person-swap", {
      data: { video_url: clip, mode: "person", image_urls: [img], likeness_consent: true, windows: 2 },
    });
    expect(r.status()).toBe(201);
    const { jobs } = await r.json();
    const id = jobs[0].id;

    // delete while the recipe is still cutting/probing - the final save is
    // gated on a live status, so no output may land afterwards
    const del = await request.delete(`/api/person-swap/${id}`);
    expect(del.status()).toBe(200);

    await expect.poll(async () => {
      const g = await request.get(`/api/person-swap/${id}`);
      const j = (await g.json()).job;
      return ["completed", "failed", "canceled"].includes(j.status) ? j.status : null;
    }, { timeout: 120_000, intervals: [2000] }).toBeTruthy();

    const generated = readdirSync(`${process.cwd()}/public/files/generated`)
      .filter((n) => n.startsWith(`person-swap-${id}-`) && n.endsWith(".mp4"));
    expect(generated).toEqual([]);
    const g = await request.get(`/api/person-swap/${id}`);
    expect((await g.json()).job.outputs).toEqual([]);
  });
});
