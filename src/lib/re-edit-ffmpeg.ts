/**
 * ReCut media plumbing - ffprobe/ffmpeg only, no Comfy calls.
 *
 *  - probeVideo: duration/fps/size/rotation/audio of the reference edit
 *  - detectCuts: ffmpeg scene-cut detection (frame-diff `select` + showinfo)
 *  - buildShots: cut times → shots → ≤5 s generation windows (≤24 total)
 *  - cutSegment: re-encode one window for the VACE graph (16 fps, no audio)
 *  - assembleWindows: conform every window output to its exact frame count
 *    at the source fps, concat in shot order, mux the original soundtrack
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

const execFileP = promisify(execFile);

export const RE_EDIT_MAX_WINDOWS = 24;
export const RE_EDIT_WINDOW_MAX_S = 5;
export const RE_EDIT_MIN_SHOT_S = 0.4;
export const RE_EDIT_SCENE_THR = 0.3;
export const RE_EDIT_GEN_FPS = 16;
export const RE_EDIT_MIN_S = 1;
export const RE_EDIT_MAX_S = 30;

export interface ProbeInfo {
  path: string;
  durationSec: number;
  fps: number;
  /** display dimensions - rotation already applied */
  width: number;
  height: number;
  rotation: number;
  hasAudio: boolean;
}

export interface ShotSpan { start: number; end: number }
export interface ShotSpec extends ShotSpan {
  index: number;
  hint?: string;
  windows: ShotSpan[];
}

const FFMPEG = () => process.env.FFMPEG_BIN || "ffmpeg";
const FFPROBE = () => process.env.FFPROBE_BIN || "ffprobe";

/** Run a binary with an argv array; throw with the stderr tail on failure.
 *  `signal` aborts the child process (execFile kills it). */
export async function runBin(bin: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(bin, args, { maxBuffer: 32 * 1024 * 1024, ...(signal ? { signal } : {}) });
    return { stdout: String(stdout), stderr: String(stderr) };
  } catch (e) {
    const stderr = String((e as { stderr?: string }).stderr ?? "");
    const tail = stderr.split("\n").filter(Boolean).slice(-12).join("\n").slice(0, 500);
    throw new Error(`${bin} failed${tail ? `: ${tail}` : ""}`);
  }
}

export const ff = (args: string[], signal?: AbortSignal) => runBin(FFMPEG(), ["-nostdin", "-v", "error", ...args], signal);

/** Inputs are always local files - whitelist the file protocol so a crafted
 *  path can't make ffmpeg reach out over the network. */
const FILE_ONLY = ["-protocol_whitelist", "file"];

/** Pixel size of a still (or a video's first stream). */
export async function probeImageSize(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await runBin(FFPROBE(), [
    "-v", "error", "-print_format", "json", "-show_streams", ...FILE_ONLY, "-i", file,
  ]);
  const v = ((JSON.parse(stdout) as { streams?: { width?: number; height?: number }[] }).streams ?? []).find((s) => s.width && s.height);
  if (!v?.width || !v.height) throw new Error("no image stream");
  return { width: v.width, height: v.height };
}

export async function probeVideo(file: string): Promise<ProbeInfo> {
  const { stdout } = await runBin(FFPROBE(), [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
    ...FILE_ONLY, "-i", file,
  ]);
  const meta = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: {
      codec_type?: string; width?: number; height?: number;
      avg_frame_rate?: string; r_frame_rate?: string;
      side_data_list?: { rotation?: number }[];
      tags?: { rotate?: string };
    }[];
  };
  const v = (meta.streams ?? []).find((s) => s.codec_type === "video");
  if (!v?.width || !v.height) throw new Error("no video stream");
  const durationSec = Number(meta.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("no readable duration");
  const rate = (v.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v.r_frame_rate) ?? "0/1";
  const [rn, rd] = rate.split("/").map(Number);
  const fps = rd ? rn / rd : 0;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("no readable frame rate");
  const sideRot = v.side_data_list?.find((s) => typeof s.rotation === "number")?.rotation;
  const rotation = Math.abs(Number(sideRot ?? v.tags?.rotate ?? 0)) % 360;
  const swap = rotation === 90 || rotation === 270;
  return {
    path: file,
    durationSec,
    fps,
    width: swap ? v.height : v.width,
    height: swap ? v.width : v.height,
    rotation,
    hasAudio: (meta.streams ?? []).some((s) => s.codec_type === "audio"),
  };
}

/** ffmpeg scene-detection - returns candidate cut times in seconds. The
 *  frames are downscaled and converted to planar RGB first so the scene
 *  score sees chroma changes too (an equal-luma colour swap is still a cut).
 *  A failed detection logs and returns [] - buildShots then falls back to a
 *  single shot covering the whole clip. */
export async function detectCuts(file: string): Promise<number[]> {
  const { stderr } = await runBin(FFMPEG(), [
    "-nostdin", "-hide_banner", ...FILE_ONLY, "-i", file,
    "-vf", `scale=320:-2,format=gbrp,select='gt(scene\\,${RE_EDIT_SCENE_THR})',showinfo`, "-f", "null", "-",
  ]).catch((e) => {
    console.warn(`re-edit: scene detection failed on input - treating as one shot (${String((e as Error).message ?? e).slice(0, 200)})`);
    return { stderr: "" };
  });
  const cuts: number[] = [];
  for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) cuts.push(Number(m[1]));
  return cuts.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
}

const windowsOf = (start: number, end: number): ShotSpan[] => {
  const len = end - start;
  const n = Math.max(1, Math.ceil(len / RE_EDIT_WINDOW_MAX_S - 1e-9));
  const step = len / n;
  return Array.from({ length: n }, (_, i) => ({
    start: start + i * step,
    end: i === n - 1 ? end : start + (i + 1) * step,
  }));
};
const windowCountOf = (len: number) => Math.max(1, Math.ceil(len / RE_EDIT_WINDOW_MAX_S - 1e-9));

/**
 * Cut times → shots. Shots shorter than RE_EDIT_MIN_SHOT_S fold into their
 * predecessor; shots longer than RE_EDIT_WINDOW_MAX_S split into equal windows
 * ≤ 5 s that keep their parent shot index. If the split would exceed
 * RE_EDIT_MAX_WINDOWS, adjacent shots merge until it fits.
 */
export function buildShots(cuts: number[], durationSec: number): ShotSpec[] {
  const bounds = [0, ...cuts.filter((t) => t > 0 && t < durationSec), durationSec];
  const raw: ShotSpan[] = [];
  for (let i = 0; i < bounds.length - 1; i++)
    raw.push({ start: bounds[i], end: bounds[i + 1] });

  // merge shots below the minimum length into their predecessor
  const shots: ShotSpan[] = [];
  for (const s of raw) {
    if (s.end - s.start < RE_EDIT_MIN_SHOT_S && shots.length) {
      shots[shots.length - 1].end = s.end;
    } else shots.push({ ...s });
  }
  while (shots.length > 1 && shots[0].end - shots[0].start < RE_EDIT_MIN_SHOT_S) {
    shots[1].start = shots[0].start;
    shots.shift();
  }

  const total = () => shots.reduce((a, s) => a + windowCountOf(s.end - s.start), 0);
  while (total() > RE_EDIT_MAX_WINDOWS && shots.length > 1) {
    // merge the adjacent pair that saves the most windows (ties: shortest merge)
    let best = 0, bestSave = -Infinity, bestLen = Infinity;
    for (let i = 0; i < shots.length - 1; i++) {
      const merged = shots[i + 1].end - shots[i].start;
      const save = windowCountOf(shots[i].end - shots[i].start)
        + windowCountOf(shots[i + 1].end - shots[i + 1].start) - windowCountOf(merged);
      if (save > bestSave || (save === bestSave && merged < bestLen)) {
        best = i; bestSave = save; bestLen = merged;
      }
    }
    shots[best].end = shots[best + 1].end;
    shots.splice(best + 1, 1);
  }

  return shots.map((s, index) => ({ index, ...s, windows: windowsOf(s.start, s.end) }));
}

/** Frames a window occupies on the source timeline at `fps`. */
export const windowFrames = (span: ShotSpan, fps: number) =>
  Math.max(1, Math.round(span.end * fps) - Math.round(span.start * fps));

/** Nearest supported aspect ratio for a display size. */
export function chooseAspect(w: number, h: number): string {
  const ratios: [string, number][] = [
    ["1:1", 1], ["4:3", 4 / 3], ["16:9", 16 / 9], ["21:9", 21 / 9],
    ["3:4", 3 / 4], ["9:16", 9 / 16],
  ];
  const r = w / h;
  return ratios.reduce((a, b) => (Math.abs(b[1] - r) < Math.abs(a[1] - r) ? b : a))[0];
}

export const even = (n: number) => Math.max(2, Math.round(n) & ~1);

/** Re-encode a window of the source for the VACE graph: target box keeping
 *  the source aspect, RE_EDIT_GEN_FPS, no audio. Autorotation is applied. */
export async function cutSegment(src: string, dst: string, span: ShotSpan, w: number, h: number, signal?: AbortSignal): Promise<void> {
  await ff([
    "-y", "-ss", span.start.toFixed(6), "-to", span.end.toFixed(6), ...FILE_ONLY, "-i", src,
    "-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${RE_EDIT_GEN_FPS}`,
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", dst,
  ], signal);
}

/**
 * Conform each window output to exactly its window's frame count at the
 * source fps (trim the tail, clone the last frame when short), scale/pad
 * each to the source display size, concat in order, and mux the source
 * soundtrack cut to the assembled length.
 */
export async function assembleWindows(inputs: { file: string; span: ShotSpan }[], probe: ProbeInfo, outPath: string, signal?: AbortSignal): Promise<void> {
  if (!inputs.length) throw new Error("assemble: no windows");
  if (signal?.aborted) throw new Error("canceled");
  const fps = probe.fps;
  const w = even(probe.width), h = even(probe.height);
  const srcIdx = inputs.length;
  const parts: string[] = [];
  let totalFrames = 0;
  inputs.forEach((inp, i) => {
    const need = windowFrames(inp.span, fps);
    totalFrames += need;
    parts.push(
      // crop=iw:ih-2:0:2 - shave the dark top-edge line VACE leaves at the
      // frame edge; the scale below stretches the remainder back (≤1%)
      `[${i}:v]fps=${fps},crop=iw:ih-2:0:2,scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
      `tpad=stop_mode=clone:stop=${(need / fps).toFixed(3)},trim=end_frame=${need},setpts=N/${fps}/TB[v${i}]`);
  });
  parts.push(inputs.map((_, i) => `[v${i}]`).join("") + `concat=n=${inputs.length}:v=1:a=0[v]`);
  const totalSec = totalFrames / fps;
  await ff([
    "-y",
    ...inputs.flatMap((inp) => [...FILE_ONLY, "-i", inp.file]),
    ...FILE_ONLY, "-i", probe.path,
    "-filter_complex", parts.join(";"),
    "-map", "[v]", "-map", `${srcIdx}:a:0?`,
    "-t", totalSec.toFixed(6),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart", outPath,
  ], signal);
}

/** A scratch dir callers must remove in `finally` (or use withTempDir). */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "of-re-edit-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
