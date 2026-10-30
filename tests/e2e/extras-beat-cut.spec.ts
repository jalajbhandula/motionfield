import { expect, request as playwrightRequest, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const base = `http://localhost:${process.env.PORT || "3100"}`;
const FF = process.env.FFMPEG_BIN || "ffmpeg";
const FP = process.env.FFPROBE_BIN || "ffprobe";

test.describe.configure({ mode: "serial" });

// three solid-colour clips (so every cut is a clean scene change) and a
// synthetic 120 BPM drum loop: a low kick on each bar, a higher hit on every beat
let dir = "";
const clips: string[] = [];
let track = "";
test.beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "of-beatcut-e2e-"));
  for (const [i, c] of ["0xd83a3a", "0x2f7fd8", "0x34b36a"].entries()) {
    const f = path.join(dir, `clip${i}.mp4`);
    execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${c}:s=360x640:r=24:d=${4 + i}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", f]);
    clips.push(f);
  }
  track = path.join(dir, "drums.wav");
  execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
    "aevalsrc='0.9*sin(2*PI*55*mod(t-0.25,2))*exp(-mod(t-0.25,2)*28)*gte(t,0.25)+0.35*sin(2*PI*210*mod(t-0.25,0.5))*exp(-mod(t-0.25,0.5)*35)*gte(t,0.25)':s=44100:d=16",
    track]);
});
test.afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const probe = (file: string) => JSON.parse(execFileSync(FP, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]).toString());
/** times where the (solid) picture changes colour - one 1×1 RGB pixel per frame */
const colourCuts = (file: string, fps = 30) => {
  const px = execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const t: number[] = [];
  for (let i = 3; i + 2 < px.length; i += 3)
    if (Math.abs(px[i] - px[i - 3]) + Math.abs(px[i + 1] - px[i - 2]) + Math.abs(px[i + 2] - px[i - 1]) > 60) t.push(i / 3 / fps);
  return t;
};

test("cut to music - clips + a drum track → finds 120 BPM, previews the plan, renders cuts on the beat", async ({ page }) => {
  test.setTimeout(240_000);
  const email = `beatcut-${Date.now()}@test.local`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { email, password: "test-pass-1234", name: "B" }, headers: { origin: base } })).ok()).toBe(true);
  await page.goto("/re-edit-video?mode=music");
  await expect(page.getByRole("tab", { name: "Cut to music" })).toHaveAttribute("aria-selected", "true");

  await page.getByTestId("bc-clip-input").setInputFiles(clips);
  await expect(page.getByTestId("bc-clips").locator("figure")).toHaveCount(3, { timeout: 30_000 });
  await page.getByTestId("bc-music-input").setInputFiles(track);
  await expect(page.getByTestId("bc-bpm")).toContainText(/^120 BPM/, { timeout: 30_000 });

  await page.getByTestId("bc-pace").getByRole("button", { name: "2 beats" }).click();
  await page.getByTestId("bc-style").getByRole("button", { name: /Straight cuts/ }).click();
  await page.getByTestId("bc-length").fill("10");
  const shots = page.getByTestId("bc-timeline").locator("div[title]");
  await expect(shots.first()).toBeVisible();
  const planned = await shots.count();
  expect(planned).toBeGreaterThanOrEqual(9); // a cut every second over 10 s
  await expect(page.getByTestId("bc-preview")).toBeVisible();

  await page.getByTestId("bc-go").click();
  await expect(page.getByTestId("bc-result")).toBeVisible({ timeout: 180_000 });
  const url = await page.getByTestId("bc-download").getAttribute("href");
  expect(url).toMatch(/^\/files\/generated\/beat-cut\/.+\.mp4$/);
  const out = path.join(dir, "out.mp4");
  writeFileSync(out, Buffer.from(await (await page.request.get(url!)).body()));

  const p = probe(out);
  const v = p.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  expect([v.width, v.height]).toEqual([1080, 1920]);
  expect(p.streams.some((s: { codec_type: string }) => s.codec_type === "audio")).toBe(true);
  expect(Math.abs(Number(p.format.duration) - 10)).toBeLessThan(0.1);

  // every hard cut in the render lands on a beat of the track (0.25 + n·0.5 s,
  // minus the start offset the studio picked - a bar line, so also on the grid)
  const cuts = colourCuts(out);
  expect(cuts.length).toBe(planned - 1);
  for (const t of cuts) {
    const phase = ((t - 0.25) % 0.5 + 0.5) % 0.5;
    expect(Math.min(phase, 0.5 - phase), `cut at ${t}s is off the beat`).toBeLessThan(0.05);
  }
});

test("cut to music API - needs two clips, and someone else's track is a 404", async () => {
  const mk = async (label: string) => {
    const ctx = await playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
    expect((await ctx.post("/api/auth/sign-up/email", { data: { email: `${label}-${Date.now()}@test.local`, password: "test-pass-1234", name: label } })).ok()).toBe(true);
    return ctx;
  };
  const a = await mk("bc-a"), b = await mk("bc-b");
  const up = async (ctx: typeof a, file: string, mimeType: string) => {
    const r = await ctx.post("/api/uploads", { multipart: { file: { name: path.basename(file), mimeType, buffer: readFileSync(file) } } });
    expect(r.ok()).toBe(true);
    return (await r.json()).url as string;
  };
  const aTrack = await up(a, track, "audio/wav");
  const bClip = await up(b, clips[0], "video/mp4");

  const one = await b.post("/api/jobs", { data: { endpoint_id: "motionfield/re-edit/beat-cut", params: { video_urls: [bClip], audio_url: aTrack } } });
  expect(one.status()).toBe(400);
  expect((await one.json()).error).toMatch(/at least 2 clips/);

  expect((await b.post("/api/re-edit/beats", { data: { audio_url: aTrack } })).status()).toBe(404);
  const own = await a.post("/api/re-edit/beats", { data: { audio_url: aTrack } });
  expect(own.ok()).toBe(true);
  const { grid } = await own.json();
  expect(Math.round(grid.bpm)).toBe(120);
  await a.dispose(); await b.dispose();
});
