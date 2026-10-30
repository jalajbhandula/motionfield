/** Record the current UI and assemble saved real outputs. No model submissions. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, type Page } from "playwright-core";
import { renderOverlayPng, closeOverlayRenderer } from "./assemble";

async function main() {
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args[args.indexOf(name) + 1] || fallback;
const base = args.includes("--base") ? option("--base", "") : "http://localhost:3150";
const out = path.resolve(args.includes("--out") ? option("--out", "") : "../of-reports/demo-review");
const media = (name: string) => path.resolve("public/examples/feature", name);
fs.mkdirSync(path.join(out, "raw"), { recursive: true });
fs.mkdirSync(path.join(out, "segments"), { recursive: true });

type Segment = { id: string; source: string; start: number; duration: number; title: string; credit: string; sourceKind: "recorded UI" | "generated output" | "title card" };
const segments: Segment[] = [];
const browser = await chromium.launch({ headless: true });
let submissions = 0;
async function capture(id: string, route: string, selector: string, duration: number, title: string, action?: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: path.join(out, "raw"), size: { width: 1920, height: 1080 } } });
  const page = await context.newPage();
  page.on("request", (request) => { if (request.method() === "POST" && /\/api\/(?:v1\/)?jobs(?:\?|$)/.test(request.url())) submissions++; });
  const began = Date.now();
  await page.goto(base + route, { waitUntil: "domcontentloaded" });
  const target = page.locator(selector).first();
  await target.waitFor({ state: "visible", timeout: 30_000 });
  await target.scrollIntoViewIfNeeded();
  const start = (Date.now() - began) / 1000;
  if (action) await action(page);
  await page.waitForTimeout(duration * 1000);
  const video = page.video()!;
  await context.close();
  segments.push({ id, source: await video.path(), start, duration, title, credit: "Recorded in the running MotionField website", sourceKind: "recorded UI" });
  console.log("captured", id);
}
try {
  segments.push({ id: "ltx", source: media("ltx-video-text-to-video.mp4"), start: 0, duration: 4, title: "MotionField - real local generations", credit: "LTX-2.5 | LTX-2.x Community License", sourceKind: "generated output" });
  await capture("site", "/", "h1", 3, "An open-source studio for image, video, audio and 3D");
  await capture("image-edit", "/ai/image?model=flux2-klein&flow=edit", '[data-example="motionfield/flux2-klein/edit"]', 3, "Instruction editing - compare the real input and output", async (page) => {
    const box = await page.getByTestId("before-after").first().boundingBox();
    if (!box) throw new Error("image comparison missing");
    await page.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2, { steps: 24 });
    await page.mouse.up();
  });
  await capture("play-and-3d", "/", '[aria-label="Play and 3D"]', 5, "A playable game and real orbitable 3D models", async (page) => {
    const frame = page.locator('[data-testid="showcase-game"] iframe');
    await frame.waitFor({ state: "visible" });
    await frame.click();
    await page.keyboard.press("Space");
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(800);
    await page.keyboard.up("ArrowRight");
    const canvas = page.locator('[data-testid="showcase-trellis"] canvas');
    await canvas.waitFor({ state: "visible" });
    const box = await canvas.boundingBox();
    if (!box) throw new Error("3D model canvas missing");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 20 });
    await page.mouse.up();
  });
  segments.push({ id: "camera", source: media("wan22-a14b-t2v.mp4"), start: 0, duration: 4.5, title: "Text to video - a coastal drive", credit: "Wan 2.2 A14B | Apache-2.0", sourceKind: "generated output" });
  segments.push({ id: "sound", source: media("moss-video-sfx.mp4"), start: 0, duration: 4.5, title: "Sound effects planned from video", credit: "MOSS-SoundEffect v2.0 | Apache-2.0 | sound added after generation", sourceKind: "generated output" });
  segments.push({ id: "dub", source: media("dub-es.mp4"), start: 0, duration: 4, title: "Dub and translate - Spanish voice with lip sync", credit: "Kokoro + Chatterbox + MuseTalk | Apache-2.0 / MIT", sourceKind: "generated output" });
  if (submissions) throw new Error(`unexpected generation submissions: ${submissions}`);
} finally { await browser.close(); }

const files: string[] = [];
try {
  for (const segment of segments) {
    const overlay = path.join(out, "segments", `${segment.id}.png`);
    await renderOverlayPng(overlay, [{ text: segment.title, size: 31, color: "#f3f4f6", y: 1023 }, { text: segment.credit, size: 20, color: "#b9bec4", y: 1062 }]);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", segment.source], { encoding: "utf8" })) as { streams: { codec_type: string }[] };
    const hasAudio = probe.streams.some((stream) => stream.codec_type === "audio");
    const destination = path.join(out, "segments", `${segment.id}.mp4`);
    const inputs = ["-ss", String(segment.start), "-i", segment.source, ...(hasAudio ? [] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]), "-loop", "1", "-i", overlay];
    const overlayIndex = hasAudio ? 1 : 2;
    execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-t", String(segment.duration), "-filter_complex", `[0:v]scale=1920:980:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:0:color=0x0b0b0b,fps=24[v];[v][${overlayIndex}:v]overlay=0:0[out]`, "-map", "[out]", "-map", hasAudio ? "0:a" : "1:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", destination], { stdio: "inherit" });
    files.push(destination);
    console.log("assembled", segment.id);
  }
  const list = path.join(out, "concat.txt");
  fs.writeFileSync(list, files.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n"));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", path.join(out, "motionfield-review.mp4")], { stdio: "inherit" });
  fs.writeFileSync(path.join(out, "sources.json"), JSON.stringify({ base, generationSubmissions: submissions, reviewOnly: true, segments }, null, 2));
} finally { await closeOverlayRenderer(); }
console.log(path.join(out, "motionfield-review.mp4"));

}
main().catch((error) => { console.error(error); process.exitCode = 1; });
