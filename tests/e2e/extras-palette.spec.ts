import { expect, request as playwrightRequest, test, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const base = `http://localhost:${process.env.PORT || "3100"}`;
const FF = process.env.FFMPEG_BIN || "ffmpeg";
const FP = process.env.FFPROBE_BIN || "ffprobe";

test.describe.configure({ mode: "serial" });

let dir = "";
test.beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "of-palette-e2e-"));
  execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x808080:s=320x200", "-frames:v", "1", path.join(dir, "grey.png")]);
  execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:d=2:r=12",
    "-f", "lavfi", "-i", "sine=f=440:d=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(dir, "clip.mp4")]);
});
test.afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

async function signup(label: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`;
  expect((await ctx.post("/api/auth/sign-up/email", { data: { email, password: "test-pass-1234", name: "Palette" } })).ok()).toBe(true);
  return ctx;
}

async function uploadFile(ctx: APIRequestContext, file: string, mimeType: string): Promise<string> {
  const r = await ctx.post("/api/uploads", { multipart: { file: { name: path.basename(file), mimeType, buffer: readFileSync(file) } } });
  expect(r.status()).toBe(201);
  return (await r.json()).url;
}

async function waitJob(ctx: APIRequestContext, id: string) {
  for (let i = 0; i < 120; i++) {
    const { job } = await (await ctx.get(`/api/jobs/${id}`)).json();
    if (!["queued", "in_progress"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("job timed out");
}

/** first pixel of an image/video as [r,g,b] */
function firstPixel(file: string): number[] {
  return [...execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1", "-vf", "crop=1:1:10:10", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])];
}

test("palette page - live look preview, full-res grade lands warm", async ({ page }) => {
  test.setTimeout(180_000);
  const email = `palette-ui-${Date.now()}@test.local`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { email, password: "test-pass-1234", name: "P" }, headers: { origin: base } })).ok()).toBe(true);
  await page.goto("/color-grade");
  await page.getByTestId("palette-source").setInputFiles(path.join(dir, "grey.png"));
  await expect(page.getByTestId("palette-canvas")).toBeVisible();
  await expect(page.getByTestId("palette-looks").locator("button")).toHaveCount(50);
  await page.getByTestId("look-cinema-amber").click();
  await page.getByTestId("palette-intensity").fill("1");

  // split at 50%: left half is the original grey, right half the graded frame
  const halves = await page.getByTestId("palette-canvas").evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext("2d")!;
    const l = ctx.getImageData(5, 5, 1, 1).data, r = ctx.getImageData(c.width - 5, 5, 1, 1).data;
    return { left: [l[0], l[1], l[2]], right: [r[0], r[1], r[2]] };
  });
  expect(halves.left).toEqual([128, 128, 128]);
  expect(halves.right[0]).toBeGreaterThan(halves.right[2]);

  await page.getByTestId("palette-save").click();
  await expect(page.getByTestId("palette-result")).toHaveAttribute("data-status", "completed", { timeout: 120_000 });
  const href = await page.getByTestId("palette-download").getAttribute("href");
  const png = await page.request.get(href!);
  expect(png.headers()["content-type"]).toContain("image/png");
  const out = path.join(dir, "graded.png");
  writeFileSync(out, await png.body());
  const [r, , b] = firstPixel(out);
  expect(r).toBeGreaterThan(b + 5);

  // .cube export downloads a 33³ LUT
  const dl = page.waitForEvent("download");
  await page.getByTestId("palette-cube").click();
  const cube = readFileSync(await (await dl).path()!, "utf8");
  expect(cube).toContain("LUT_3D_SIZE 33");
});

test("palette API - video keeps its sound, palette source, owner-only inputs, bad params 400", async () => {
  test.setTimeout(180_000);
  const a = await signup("palette-a");
  const b = await signup("palette-b");
  const clip = await uploadFile(a, path.join(dir, "clip.mp4"), "video/mp4");

  const made = await a.post("/api/jobs", { data: { endpoint_id: "motionfield/palette/grade-video", params: { video_url: clip, colors: "#001030,#1f4f9f,#cfe0ff", intensity: 1 } } });
  expect(made.status()).toBe(201);
  const job = await waitJob(a, (await made.json()).job.id);
  expect(job.status).toBe("completed");
  const mp4 = path.join(dir, "graded.mp4");
  writeFileSync(mp4, await (await a.get(job.outputs[0].url)).body());
  const streams = execFileSync(FP, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", mp4], { encoding: "utf8" });
  expect(streams).toContain("video");
  expect(streams).toContain("audio");

  // someone else's upload is not yours to grade
  expect((await b.post("/api/jobs", { data: { endpoint_id: "motionfield/palette/grade-video", params: { video_url: clip, look: "cinema-amber" } } })).status()).toBeGreaterThanOrEqual(400);
  // exactly one grade source, known looks only
  expect((await a.post("/api/jobs", { data: { endpoint_id: "motionfield/palette/grade-video", params: { video_url: clip } } })).status()).toBe(400);
  expect((await a.post("/api/jobs", { data: { endpoint_id: "motionfield/palette/grade-video", params: { video_url: clip, look: "../x" } } })).status()).toBe(400);
  expect((await a.post("/api/jobs", { data: { endpoint_id: "motionfield/palette/grade-video", params: { video_url: clip, colors: "red,green,blue" } } })).status()).toBe(400);
  await Promise.all([a.dispose(), b.dispose()]);
});
