import { expect, request as playwrightRequest, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const base = `http://localhost:${process.env.PORT || "3100"}`;
const FF = process.env.FFMPEG_BIN || "ffmpeg";
const FP = process.env.FFPROBE_BIN || "ffprobe";

test.describe.configure({ mode: "serial" });

// a synthetic speaker (macOS `say`) over a test pattern - never a real person
let dir = "";
let clip = "";
test.beforeAll(() => {
  test.skip(!existsSync("/usr/bin/say"), "needs macOS say for a synthetic speaker");
  dir = mkdtempSync(path.join(tmpdir(), "of-dub-e2e-"));
  const speech = path.join(dir, "speech.aiff");
  execFileSync("/usr/bin/say", ["-o", speech, "Hello and welcome to the studio. Today we are testing a dubbed clip. Thanks for watching."]);
  clip = path.join(dir, "talk.mp4");
  execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=24", "-i", speech,
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clip]);
});
test.afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const probe = (file: string) => JSON.parse(execFileSync(FP, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]).toString());

test("dub - upload, pick French, consent, get a dubbed clip of the same length with subtitles", async ({ page }) => {
  test.setTimeout(240_000);
  const email = `dub-${Date.now()}@test.local`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { email, password: "test-pass-1234", name: "D" }, headers: { origin: base } })).ok()).toBe(true);
  await page.goto("/dub-translate");
  await page.getByTestId("dub-source").setInputFiles(clip);
  await expect(page.locator("video").first()).toBeVisible();
  await page.getByTestId("dub-lang-fr").click();
  await page.getByTestId("dub-go").click();
  await expect(page.getByRole("alert").filter({ hasText: /right to use/ })).toContainText(/right to use/);
  await page.getByTestId("dub-consent").check();
  await page.getByTestId("dub-go").click();
  await expect(page.getByTestId("dub-result")).toBeVisible({ timeout: 180_000 });

  const url = await page.getByTestId("dub-download").getAttribute("href");
  expect(url).toMatch(/^\/files\/generated\/(?:finish\/[^/]+|dub\/.+\/dub-fr)\.mp4$/);
  const out = path.join(dir, "out.mp4");
  require("node:fs").writeFileSync(out, Buffer.from(await (await page.request.get(url!)).body()));
  const src = probe(clip), got = probe(out);
  expect(got.streams.some((s: { codec_type: string }) => s.codec_type === "audio")).toBe(true);
  expect(Math.abs(Number(got.format.duration) - Number(src.format.duration))).toBeLessThan(0.35);
  const subtitleUrl = await page.getByRole("link", { name: "Subtitles (.srt)" }).getAttribute("href");
  expect(subtitleUrl).toMatch(/^\/files\/generated\/dub\/.+\/dub-fr\.srt$/);
  const subtitles = await page.request.get(subtitleUrl!);
  expect(subtitles.ok()).toBe(true);
  const srt = await subtitles.text();
  expect(srt).toMatch(/00:00:0\d,\d{3} --> /);
  expect(srt).toMatch(/\[fr\] .*welcome/i); // mock path tags lines instead of calling an LLM
});

test("dub API - consent required, unknown language refused, someone else's clip is a 404", async () => {
  const mk = async (label: string) => {
    const ctx = await playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
    expect((await ctx.post("/api/auth/sign-up/email", { data: { email: `${label}-${Date.now()}@test.local`, password: "test-pass-1234", name: label } })).ok()).toBe(true);
    return ctx;
  };
  const a = await mk("dub-a"), b = await mk("dub-b");
  const up = await a.post("/api/uploads", { multipart: { file: { name: "talk.mp4", mimeType: "video/mp4", buffer: readFileSync(clip) } } });
  expect(up.status()).toBe(201);
  const video_url = (await up.json()).url;
  const post = (ctx: typeof a, params: Record<string, unknown>) => ctx.post("/api/jobs", { data: { endpoint_id: "motionfield/dub/v1", params } });
  expect((await post(a, { video_url, language: "es" })).status()).toBe(400);
  expect((await post(a, { video_url, language: "de", likeness_consent: true })).status()).toBe(400);
  const stolen = await post(b, { video_url, language: "es", likeness_consent: true });
  expect(stolen.status()).toBe(404);
  await a.dispose(); await b.dispose();
});
