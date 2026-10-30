/**
 * PersonSwap Quick e2e (GENERATION_PROVIDER=mock - the plumbing and the gates;
 * real pixels are the gpu-smoke lane):
 *  - /person-swap/quick gates the same likeness consent → 1 photo + clip → a
 *    completed person run and the before/after slider
 *  - the API enforces Quick server-side: >1 photo / a >15 s clip / any
 *    non-person mode / batch fields are 400s with clear messages
 *  - the gallery lists only VERIFIED manifest entries and shows the real
 *    count; picking one submits gallery_id (server resolves + copies) and
 *    the job completes
 *  - "both" mode on the full page exposes two prompt fields, and the job
 *    params carry prompt + env_prompt separately (each drives its own pass)
 */
import { test, expect, request as pwRequest, type APIRequestContext, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
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
const clipPath = (t: TestInfo, name: string) => t.outputPath(name);

type DoneRow = {
  status: string; error: string | null;
  outputs: { type: string; url: string }[];
  meta: { windows?: number; lip?: string | null } | null;
};
async function waitDone(request: APIRequestContext, id: string, timeoutMs = 180_000): Promise<DoneRow> {
  let row: DoneRow | null = null;
  await expect.poll(async () => {
    const g = await request.get(`/api/person-swap/${id}`);
    row = (await g.json()).job;
    return row!.status === "completed" ? "done" : row!.status === "failed" ? `FAILED:${row!.error}` : null;
  }, { timeout: timeoutMs, intervals: [2000] }).toBe("done");
  return row!;
}

type GalleryManifest = { clips: { id: string; file: string; verified?: boolean }[] };
function manifest(): GalleryManifest {
  return JSON.parse(readFileSync(`${process.cwd()}/public/person-swap/gallery/manifest.json`, "utf8")) as GalleryManifest;
}

test.describe("ws4 person-swap quick", () => {
  test("quick UI: consent gate → 1 photo + 3 s clip → done → before/after", async ({ page }, testInfo) => {
    await expect.poll(async () => {
      const email = `ws4-qui-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
      const su = await page.context().request.post("/api/auth/sign-up/email", {
        data: { email, password: "test-pass-1234", name: "WS4 Quick UI" },
      });
      if (!su.ok()) return 0;
      return (await page.context().request.get("/api/me")).status();
    }, { timeout: 90_000, intervals: [1000, 3000, 6000, 10000] }).toBe(200);

    const srcClip = makeClip(clipPath(testInfo, "quick-src.mp4"), 3, true);
    const pngPath = clipPath(testInfo, "quick-ref.png");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=red:size=64x64", "-frames:v", "1", pngPath]);

    await page.goto("/person-swap/quick");
    await expect(page.getByRole("heading", { name: "Quick Person Swap" })).toBeVisible();

    // every likeness input stays disabled until the consent box is ticked
    const consentBox = page.locator("#quick-consent");
    const photoInput = page.getByLabel(/Identity photo/i);
    const clipInput = page.getByLabel(/Clip \(1-15 s\)/i);
    await expect(consentBox).not.toBeChecked();
    await expect(photoInput).toBeDisabled();
    await expect(clipInput).toBeDisabled();
    await expect(page.getByRole("button", { name: /Run quick person swap/i })).toBeDisabled();
    await consentBox.check();
    await expect(photoInput).toBeEnabled();
    await expect(clipInput).toBeEnabled();

    await clipInput.setInputFiles(srcClip);
    await expect(page.getByText(/generation window/)).toBeVisible({ timeout: 60_000 });
    // the honest ETA is shown before submit - incl. the cold-load line
    await expect(page.getByText(/min total/)).toBeVisible();
    await expect(page.getByText(/model load/)).toBeVisible();

    await photoInput.setInputFiles(pngPath);
    await expect(page.getByRole("button", { name: /Run quick person swap/i })).toBeEnabled({ timeout: 15_000 });
    await page.getByRole("button", { name: /Run quick person swap/i }).click();
    await expect(page.getByText(/queued|in_progress/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/completed/).first()).toBeVisible({ timeout: 180_000 });

    // before/after slider + the full-controls link only show on a result
    await expect(page.getByText("Source ↔ swapped")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('input[aria-label="Compare source and result"]')).toBeVisible();
    // the link carries the same clip + photo into full PersonSwap
    const personSwapHref = await page.getByRole("link", { name: /Open in Person Swap/i }).getAttribute("href");
    expect(personSwapHref).toMatch(/^\/person-swap\?(clip=.+|gallery=.+)&photo=/);
  });

  test("quick API: 2 photos / 20 s clip / environment mode are 400s", async ({ request }, testInfo) => {
    await signUp(request, "ws4-quick-api");
    const img = await uploadFile(request, "q.png", "image/png", PNG);
    const clip = await uploadClip(request, clipPath(testInfo, "quick-clip.mp4"), 3, true);
    const long = await uploadClip(request, clipPath(testInfo, "quick-long.mp4"), 20, false);

    let r = await request.post("/api/person-swap", {
      data: { quick: true, video_url: clip, image_urls: [img, img], likeness_consent: true },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("exactly one reference photo");

    r = await request.post("/api/person-swap", {
      data: { quick: true, video_url: long, image_urls: [img], likeness_consent: true },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("15");

    r = await request.post("/api/person-swap", {
      data: { quick: true, video_url: clip, mode: "environment", image_urls: [img], likeness_consent: true },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("person mode");

    r = await request.post("/api/person-swap", {
      data: {
        quick: true, video_url: clip, image_urls: [img], likeness_consent: true,
        identities: [{ image_urls: [img] }],
      },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("batch");
  });

  test("gallery: only verified entries show; pick → gallery_id job completes", async ({ request }, testInfo) => {
    await signUp(request, "ws4-quick-gal");
    const img = await uploadFile(request, "g.png", "image/png", PNG);

    const verified = manifest().clips.filter((c) => c.verified === true);
    const gal = await request.get("/api/person-swap/gallery");
    expect(gal.status()).toBe(200);
    const g = await gal.json();
    // the count shown is the real verified count - no padding
    expect(g.count).toBe(verified.length);
    expect(g.clips.length).toBe(verified.length);
    for (const c of g.clips)
      expect(verified.some((v) => v.id === c.id)).toBeTruthy();
    // an unknown id 400s - never a file read on the client's word
    const bad = await request.post("/api/person-swap", {
      data: { quick: true, gallery_id: "no-such-clip-zzz", image_urls: [img], likeness_consent: true },
    });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error).toContain("unknown gallery clip");

    if (verified.length === 0) {
      testInfo.annotations.push({ type: "note", description: "gallery empty - night batch pending; pick path not exercised" });
      return;
    }
    const pick = verified[0];
    const r = await request.post("/api/person-swap", {
      data: { quick: true, gallery_id: pick.id, image_urls: [img], likeness_consent: true },
    });
    expect(r.status()).toBe(201);
    const { jobs } = await r.json();
    // the job recorded the gallery pick, not a client path
    const jrow = await (await request.get(`/api/jobs/${jobs[0].id}`)).json();
    expect(jrow.job.params.gallery_id).toBe(pick.id);
    const done = await waitDone(request, jobs[0].id);
    expect(String(done.outputs[0].url)).toMatch(/^\/files\/generated\//);
  });

  test("takedown: DELETE removes the output file, asset rows and publishes nothing", async ({ request }, testInfo) => {
    await signUp(request, "ws4-quick-del");
    const img = await uploadFile(request, "d.png", "image/png", PNG);
    const clip = await uploadClip(request, clipPath(testInfo, "del-clip.mp4"), 3, true);

    const r = await request.post("/api/person-swap", {
      data: { quick: true, video_url: clip, image_urls: [img], likeness_consent: true },
    });
    expect(r.status()).toBe(201);
    const { jobs } = await r.json();
    const done = await waitDone(request, jobs[0].id);
    const outUrl = String(done.outputs[0].url);
    expect(outUrl).toMatch(/^\/files\/generated\/(person-swap-|finish\/)/);
    // served for real before the takedown
    expect((await request.get(outUrl)).status()).toBe(200);

    const del = await request.delete(`/api/person-swap/${jobs[0].id}`);
    expect(del.status()).toBe(200);
    const body = await del.json();
    expect(body.ok).toBe(true);
    expect(body.removed).toContain(`generated/.person_swap/${jobs[0].id}/`);
    expect(body.removed).toContain(outUrl.replace(/^\/files\//, ""));

    // the published file is gone
    expect((await request.get(outUrl)).status()).toBe(404);
    // the job row no longer publishes anything
    const g = await request.get(`/api/person-swap/${jobs[0].id}`);
    expect(g.status()).toBe(200);
    expect((await g.json()).job.outputs).toEqual([]);

    // a second user can't reach the row at all
    const ctxB = await pwRequest.newContext({ baseURL: testInfo.project.use.baseURL as string });
    await signUp(ctxB, "ws4-quick-del2");
    expect((await ctxB.delete(`/api/person-swap/${jobs[0].id}`)).status()).toBe(404);
    await ctxB.dispose();
  });

  test("both mode: two prompt fields → params carry prompt + env_prompt", async ({ page }, testInfo) => {
    await expect.poll(async () => {
      const email = `ws4-both-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
      const su = await page.context().request.post("/api/auth/sign-up/email", {
        data: { email, password: "test-pass-1234", name: "WS4 Both" },
      });
      if (!su.ok()) return 0;
      return (await page.context().request.get("/api/me")).status();
    }, { timeout: 90_000, intervals: [1000, 3000, 6000, 10000] }).toBe(200);

    const srcClip = makeClip(clipPath(testInfo, "both-src.mp4"), 2, true);
    const pngPath = clipPath(testInfo, "both-ref.png");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=red:size=64x64", "-frames:v", "1", pngPath]);

    await page.goto("/person-swap");
    await page.locator("#person-swap-consent").check();
    await page.getByRole("button", { name: /Both/i }).click();
    // both exposes the person + setting fields separately
    const person = page.getByPlaceholder("Who the new person is, how they look, styling…");
    const setting = page.getByPlaceholder("The setting to re-create around the person…");
    await expect(person).toBeVisible();
    await expect(setting).toBeVisible();
    await expect(page.getByText("helps when refs are few")).toBeVisible();
    await person.fill("a young woman with short black hair");
    await setting.fill("a snowy pine forest, daylight");

    await page.getByLabel(/Source clip/i).setInputFiles(srcClip);
    await expect(page.getByText(/generation window/)).toBeVisible({ timeout: 60_000 });
    // keep the test inside the ~60 cr signup budget - the point is the two
    // prompt fields, not the lip pass
    const lipBox = page.getByLabel(/Restore lip sync/i);
    if (await lipBox.isVisible().catch(() => false)) await lipBox.uncheck();
    await page.getByLabel(/Identity refs/i).setInputFiles(pngPath);
    await expect(page.getByRole("button", { name: /Run (?:person-swap|draft)/i })).toBeEnabled({ timeout: 15_000 });
    await page.getByRole("button", { name: /Run (?:person-swap|draft)/i }).click();
    await expect(page.getByText(/completed/).first()).toBeVisible({ timeout: 180_000 });

    // the run's params carry both fields - each drives its own pass
    const api = page.context().request;
    const list = await api.get("/api/person-swap");
    const jobs = (await list.json()).jobs;
    expect(jobs.length).toBeGreaterThan(0);
    const jrow = await (await api.get(`/api/jobs/${jobs[0].id}`)).json();
    expect(jrow.job.params.prompt).toBe("a young woman with short black hair");
    expect(jrow.job.params.env_prompt).toBe("a snowy pine forest, daylight");
  });
});
