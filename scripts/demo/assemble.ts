/**
 * assemble.ts — cut the captured clips + rendered cards into the final
 * silent-cut + music-bed MP4. Per shot: clip → normalize to 1920×1080/30fps
 * → speed-to-budget (over-budget clips keep their whole arc, sped, and the
 * overlay says so) → a lower-third title + source chip + "sped up ×N" tag
 * rendered as a transparent PNG (this ffmpeg build has no drawtext) →
 * xfade between every segment → music under the cut → timeline.json +
 * captions.srt.
 *
 * Required shots missing a clip fail the assemble; optional gaps degrade
 * to the cards only.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { ClipMeta } from "./capture";
import { shots as allShots, type Badge } from "./shots";
import { FFMPEG, ffprobe, parseArgs, redactedStringify, resolveDemoOutDir, REPO } from "./util";

export const WIDTH = 1920;
export const HEIGHT = 1080;
export const OUT_FPS = 30;
export const XFADE_S = 0.4;
const FONT_FILE = path.join(REPO, "public", "fonts", "space-grotesk.ttf");

/* ------------------------------ timeline ------------------------------- */

export interface Segment {
  id: string;                    // shot id or card id or "hook"
  kind: "shot" | "card" | "hook";
  title: string;
  file: string;
  duration_s: number;
  badges: Badge[];
  source?: "mac" | "gpu";
  speed?: number;                // >1 = sped up
}

interface OverlayLine { text: string; size: number; color: string; y: number; align?: "right" }

/** The overlay PNG renderer — one shared headless page; the app's own
 *  Space Grotesk is loaded from disk as a data URL so canvas text matches
 *  the product's type. */
let overlayPage: Page | null = null;
async function overlayRenderer(): Promise<Page> {
  if (overlayPage) return overlayPage;
  const browser: Browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const p = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  const fontB64 = fs.readFileSync(FONT_FILE).toString("base64");
  await p.evaluate(async (b64) => {
    const f = new FontFace("Space Grotesk", `url(data:font/ttf;base64,${b64})`, { weight: "500" });
    await f.load();
    document.fonts.add(f);
  }, fontB64);
  overlayPage = p;
  return p;
}

export async function renderOverlayPng(outPath: string, lines: OverlayLine[]): Promise<void> {
  const p = await overlayRenderer();
  const dataUrl = await p.evaluate(async (L) => {
    const cv = document.createElement("canvas");
    cv.width = 1920; cv.height = 1080;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const l of L as OverlayLine[]) {
      ctx.font = `500 ${l.size}px "Space Grotesk", sans-serif`;
      ctx.fillStyle = l.color;
      ctx.shadowColor = "rgba(0,0,0,0.85)";
      ctx.shadowBlur = 0; ctx.shadowOffsetX = 1; ctx.shadowOffsetY = 1;
      const x = l.align === "right" ? cv.width - 48 - ctx.measureText(l.text).width : 48;
      ctx.fillText(l.text, x, l.y);
    }
    return cv.toDataURL("image/png");
  }, lines);
  fs.writeFileSync(outPath, Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
}

/** Burn the shot's identity in-frame via a rendered PNG — lower-third title
 *  + source chip + honest "sped up ×N" tag when the budget squeezed the clip. */
async function overlayFor(meta: ClipMeta, speed: number, outPath: string): Promise<void> {
  const src = meta.source === "gpu" ? "BYO GPU · cloud-recommended, untested" : "on this Mac";
  const lines: OverlayLine[] = [
    { text: meta.title, size: 30, color: "#f2f5ff", y: HEIGHT - 64 },
    { text: src, size: 24, color: "#d4ff3f", y: 66, align: "right" },
  ];
  if (speed > 1.05) lines.push({ text: `sped up ×${speed.toFixed(1)}`, size: 24, color: "#9c9ca6", y: 102, align: "right" });
  await renderOverlayPng(outPath, lines);
}

/** Normalize one captured clip to the assembly format, paced to budget,
 *  with the identity PNG overlaid for the whole segment. */
async function normalizeShot(meta: ClipMeta, capDir: string, segsDir: string): Promise<Segment> {
  const src = path.join(capDir, meta.clip!);
  const probed = ffprobe(src);
  const speed = Math.min(4, probed.duration / meta.budget_s);
  const target = probed.duration / speed;
  const dst = path.join(segsDir, `seg-${meta.id}.mp4`);
  const ov = path.join(segsDir, `ov-${meta.id}.png`);
  await overlayFor(meta, speed, ov);
  execFileSync(FFMPEG, [
    "-y", "-v", "error", "-i", src, "-loop", "1", "-framerate", "30", "-i", ov,
    "-filter_complex",
    `[0:v]setpts=PTS/${speed.toFixed(4)},scale=${WIDTH}:${HEIGHT},setsar=1[v0];[v0][1:v]overlay=0:0:format=auto[v]`,
    "-map", "[v]", "-t", String(Math.max(0.5, target)),
    "-r", String(OUT_FPS), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", dst,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  return {
    id: meta.id, kind: "shot", title: meta.title, file: dst,
    duration_s: ffprobe(dst).duration, badges: meta.badges,
    source: meta.source, speed: speed > 1.05 ? Math.round(speed * 10) / 10 : undefined,
  };
}

/** The hook — the last beats of the person-swap clip, replayed up front. */
async function hookSegment(capDir: string, segsDir: string): Promise<Segment | null> {
  const src = path.join(capDir, "clips", "person-swap.webm");
  if (!fs.existsSync(src)) return null;
  const probed = ffprobe(src);
  const dst = path.join(segsDir, "seg-hook.mp4");
  const ov = path.join(segsDir, "ov-hook.png");
  await renderOverlayPng(ov, [{ text: "your face, in our clip — one pass", size: 34, color: "#f2f5ff", y: HEIGHT - 110 }]);
  const start = Math.max(0, probed.duration - 3);
  execFileSync(FFMPEG, [
    "-y", "-v", "error", "-ss", String(start), "-i", src, "-loop", "1", "-framerate", "30", "-i", ov,
    "-filter_complex", `[0:v]scale=${WIDTH}:${HEIGHT},setsar=1[v0];[v0][1:v]overlay=0:0:format=auto[v]`,
    "-map", "[v]", "-t", "3", "-r", String(OUT_FPS), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", dst,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  return { id: "hook", kind: "hook", title: "hook — person-swap before/after", file: dst, duration_s: ffprobe(dst).duration, badges: [] };
}

function cardSegment(card: { id: string; file: string }): Segment {
  return { id: `card:${card.id}`, kind: "card", title: `card ${card.id}`, file: card.file, duration_s: ffprobe(card.file).duration, badges: [] };
}

/** concat + xfade the segment list; music (optional wav) under the cut. */
function mux(segments: Segment[], musicFile: string | null, outFile: string): void {
  const ins: string[] = [];
  for (const s of segments) ins.push("-i", s.file);
  const hasAudio = !!musicFile && fs.existsSync(musicFile!);
  let filter = "";
  // normalize every input to the same fps+timebase+PTS origin — xfade
  // refuses mismatched timebases (24fps cards vs 30fps segments)
  for (let i = 0; i < segments.length; i++)
    filter += `[${i}:v]fps=${OUT_FPS},settb=AVTB,setpts=PTS-STARTPTS[nv${i}];`;
  // xfade chain — offsets are cumulative durations minus the xfade overlaps
  let cum = segments[0].duration_s;
  let cur = "nv0";
  for (let i = 1; i < segments.length; i++) {
    const out = `v${i}`;
    filter += `[${cur}][nv${i}]xfade=transition=fade:duration=${XFADE_S}:offset=${(cum - XFADE_S).toFixed(3)}[${out}];`;
    cur = out;
    cum += segments[i].duration_s - XFADE_S;
  }
  const totalS = cum;
  const args = [...ins];
  if (hasAudio) {
    args.push("-stream_loop", "-1", "-i", musicFile!);
    filter += `[${segments.length}:a]atrim=0:${totalS.toFixed(3)},volume=0.10,afade=t=in:st=0:d=0.8,afade=t=out:st=${(totalS - 1.2).toFixed(3)}:d=1.2[aout]`;
    args.push("-filter_complex", filter, "-map", `[${cur}]`, "-map", "[aout]", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(OUT_FPS), "-shortest", outFile);
  } else {
    filter = filter.slice(0, -1);
    args.push("-filter_complex", filter, "-map", `[${cur}]`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(OUT_FPS), "-movflags", "+faststart", outFile);
  }
  execFileSync(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
}

/* ------------------------------- assemble ------------------------------ */

export interface AssembleResult {
  ok: boolean;
  outFile?: string;
  timelinePath?: string;
  captionsPath?: string;
  total_s?: number;
  missing: string[];             // required shots without a clip
  segments: Segment[];
}

const srtTime = (s: number) => {
  const ms = Math.round(s * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, "0");
  const sec = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
  const msec = String(ms % 1000).padStart(3, "0");
  return `${h}:${m}:${sec},${msec}`;
};

export async function assemble(opts: {
  out: string;
  cards: { id: string; file: string }[];
  musicFile?: string | null;
  musicCredit?: string;
}): Promise<AssembleResult> {
  const capDir = path.join(opts.out, "capture");
  const indexPath = path.join(capDir, "index.json");
  if (!fs.existsSync(indexPath)) throw new Error(`no capture index at ${indexPath} — run capture first`);
  const metas = (JSON.parse(fs.readFileSync(indexPath, "utf8")) as { shots: ClipMeta[] }).shots;
  const segsDir = path.join(opts.out, "assemble", "segs");
  fs.mkdirSync(segsDir, { recursive: true });

  const missing: string[] = [];
  const shotSegs: Segment[] = [];
  for (const s of allShots()) {
    const meta = metas.find((m) => m.id === s.id);
    if (!meta?.clip || !meta.ok) {
      if (s.required) missing.push(s.id);
      continue;
    }
    shotSegs.push(await normalizeShot(meta, capDir, segsDir));
  }
  if (missing.length) return { ok: false, missing, segments: [] };

  const cardById = new Map(opts.cards.map((c) => [c.id, c]));
  const hook = await hookSegment(capDir, segsDir);
  const segments: Segment[] = [
    ...(hook ? [hook] : []),
    cardSegment(cardById.get("title")!),
    ...shotSegs,
    cardSegment(cardById.get("outro")!),
    cardSegment(cardById.get("credits")!),
  ];

  const outFile = path.join(opts.out, "demo.mp4");
  mux(segments, opts.musicFile ?? null, `${outFile}.part.mp4`);
  fs.renameSync(`${outFile}.part.mp4`, outFile);

  // timeline + captions — start times account for the xfade overlaps
  let at = 0;
  const rows: { id: string; start_s: number; end_s: number; title: string; badges: Badge[]; source?: string; speed?: number }[] = [];
  const srt: string[] = [];
  segments.forEach((s, i) => {
    const start = i === 0 ? 0 : at - XFADE_S;
    const end = start + s.duration_s;
    rows.push({ id: s.id, start_s: +start.toFixed(2), end_s: +end.toFixed(2), title: s.title, badges: s.badges, source: s.source, speed: s.speed });
    srt.push(`${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${s.title}\n`);
    at = end;
  });
  const total_s = +at.toFixed(2);
  const timelinePath = path.join(opts.out, "timeline.json");
  fs.writeFileSync(timelinePath, redactedStringify({ segments: rows, total_s, music: opts.musicCredit ?? null }));
  const captionsPath = path.join(opts.out, "captions.srt");
  fs.writeFileSync(captionsPath, srt.join("\n"));

  return { ok: true, outFile, timelinePath, captionsPath, total_s, missing, segments };
}

/** release the shared overlay renderer's browser — dry.ts owns the exit. */
export async function closeOverlayRenderer(): Promise<void> {
  const p = overlayPage;
  overlayPage = null;
  if (p) await p.context()?.browser()?.close().catch(() => {});
}

/* -------------------------------- CLI ---------------------------------- */

const isMain = !!process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/demo/assemble.ts");
if (isMain) {
  void (async () => {
    const { opts } = parseArgs(process.argv.slice(2));
    const out = resolveDemoOutDir(String(opts.out ?? "/tmp/of-demo-dev"));
    const cardsDir = path.join(out, "cards", "mp4");
    const cards = fs.readdirSync(cardsDir).filter((f) => f.endsWith(".mp4"))
      .map((f) => ({ id: f.replace(/\.mp4$/, ""), file: path.join(cardsDir, f) }));
    const musicFile = typeof opts.music === "string" ? opts.music : null;
    const res = await assemble({ out, cards, musicFile, musicCredit: opts["music-credit"] as string | undefined });
    await closeOverlayRenderer();
    console.log(redactedStringify({ ok: res.ok, total_s: res.total_s, missing: res.missing, segments: res.segments.length }));
    if (!res.ok) process.exit(1);
  })().catch((e) => { console.error(`assemble: ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
