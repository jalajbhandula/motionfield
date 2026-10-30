/** Effect-presence proof for vfx-verify (ws3 s11) - a "verified" record
 *  must mean the mid span visibly departed from the plate, not that a job
 *  completed. Two review rounds of plate-reproduction outputs forced this.
 *
 *  The check: ~6 output frames sampled across the mid span - past the
 *  pinned head (the plate run's HOLD guide; still plates anchor ~9 opening
 *  frames) and before the pinned tail frame - each squeezed to a 64×36
 *  luma plane and diffed against the plate frame at the same timestamp
 *  (or the still itself for image runs). The metric is the mean absolute
 *  pixel difference on the 0-255 luma scale: a re-rendered plate sits
 *  under ~8 while a landed effect lives far above EFFECT_DIFF_MIN.
 *
 *  ffmpeg-only, local files, no GPU - the unit test exercises it on lavfi
 *  fixtures. */
import { execFileSync } from "node:child_process";

const FFMPEG = () => process.env.FFMPEG_BIN || "ffmpeg";

export const EFFECT_DIFF_SAMPLES = 6;
/** mean |Δ| on 64×36 gray - a plate re-render measures ~4-8, a landed
 *  effect ~40+. 12 keeps a clear margin over cosmetic drift. */
export const EFFECT_DIFF_MIN = 12;
export const EFFECT_DIFF_W = 64;
export const EFFECT_DIFF_H = 36;
/** Still-run heads to skip - the image guide pins the opening frames. */
export const EFFECT_DIFF_IMAGE_SKIP = 9;

export interface EffectDiff {
  /** output frame indices that were sampled */
  frames: number[];
  /** mean |Δ| 0-255 per sampled frame - NaN where a frame couldn't decode */
  per_frame: number[];
  /** mean over the readable frames - NaN when nothing compared */
  mean: number;
  /** weakest sampled frame - the span's most plate-faithful moment */
  min: number;
}

/** Output indices the check samples: `skipHead` pinned opening frames and
 *  never the tail frame (an end keyframe pins it when one is set). */
export function effectSampleFrames(frames: number, skipHead: number): number[] {
  const hi = Math.max(0, frames - 2);
  const lo = Math.max(0, Math.min(skipHead, hi));
  const idx = new Set<number>();
  for (let i = 0; i < EFFECT_DIFF_SAMPLES; i++)
    idx.add(Math.round(lo + ((hi - lo) * i) / (EFFECT_DIFF_SAMPLES - 1)));
  return [...idx].sort((a, b) => a - b);
}

/** One frame → a 64×36 luma plane (scale-to-cover + centre crop, gray)
 *  returned as raw bytes - 2304 B. */
function grayFrame(file: string, frame?: number, time?: number): Buffer {
  const sel = frame === undefined ? "" : `select=eq(n\\,${frame}),`;
  const vf = `${sel}scale=${EFFECT_DIFF_W}:${EFFECT_DIFF_H}:force_original_aspect_ratio=increase,crop=${EFFECT_DIFF_W}:${EFFECT_DIFF_H},format=gray`;
  const args = [
    "-nostdin", "-v", "error", "-protocol_whitelist", "file",
    ...(time === undefined ? [] : ["-ss", time.toFixed(4)]),
    "-i", file, "-vf", vf, "-frames:v", "1", "-f", "rawvideo", "-",
  ];
  try {
    return execFileSync(FFMPEG(), args, { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return Buffer.alloc(0);
  }
}

/** mean |Δ| of two same-size byte planes - NaN on a decode miss. */
export function meanAbsDiff(a: Buffer, b: Buffer): number {
  if (!a.length || a.length !== b.length) return NaN;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** The measured departure of `outFile`'s mid span from `plateFile`.
 *  `skipHead` = the plate run's HOLD count (0 for the wan alt); still
 *  plates always skip the first ~9 frames and diff against the still. */
export function effectDiff(opts: {
  outFile: string;
  outFrames: number;
  outFps: number;
  plateFile: string;
  plateIsStill: boolean;
  skipHead?: number;
}): EffectDiff {
  const skip = opts.plateIsStill ? EFFECT_DIFF_IMAGE_SKIP : Math.max(0, opts.skipHead ?? 0);
  const frames = effectSampleFrames(opts.outFrames, skip);
  const still = opts.plateIsStill ? grayFrame(opts.plateFile) : null;
  const perFrame = frames.map((n) => {
    const a = grayFrame(opts.outFile, n);
    const b = still ?? grayFrame(opts.plateFile, undefined, n / opts.outFps);
    return meanAbsDiff(a, b);
  });
  const ok = perFrame.filter((d) => Number.isFinite(d));
  const mean = ok.length ? ok.reduce((s, d) => s + d, 0) / ok.length : NaN;
  return {
    frames,
    per_frame: perFrame.map((d) => Math.round(d * 100) / 100),
    mean: Math.round(mean * 100) / 100,
    min: ok.length ? Math.round(Math.min(...ok) * 100) / 100 : NaN,
  };
}
