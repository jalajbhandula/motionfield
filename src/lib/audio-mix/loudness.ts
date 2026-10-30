/** Two-pass EBU R128 loudness normalization - pass 1 measures with loudnorm,
 *  pass 2 applies the linear gain manually through an oversampled hard
 *  limiter so the output lands within spec, not just close. (loudnorm's
 *  own linear=true silently falls back to dynamic mode when LRA > 11 or
 *  the TP would overshoot - the file comes out at the wrong loudness and
 *  nothing reports it.) Used for every audio artifact MotionField ships
 *  (music -14 LUFS, cues -16). */
import { promises as fs } from "node:fs";
import { runArgv, ffmpegBin, type MixDeps } from "./ffmpeg";

export interface LoudTarget {
  /** integrated loudness target, LUFS - music -14, sfx cues -16 */
  i: number;
  /** true peak ceiling, dBTP - always ≤ -1 */
  tp: number;
  /** loudness range target - 11 is the streaming default */
  lra: number;
}

export const MUSIC_TARGET: LoudTarget = { i: -14, tp: -1, lra: 11 };
export const SFX_TARGET: LoudTarget = { i: -16, tp: -1, lra: 11 };
/** keep-mode post-mix: the video's own track normalized to speech level */
export const SOURCE_TARGET: LoudTarget = { i: -16, tp: -1, lra: 11 };
/** …and the bed pushed under it (not a delivery loudness on its own) */
export const BED_TARGET: LoudTarget = { i: -20, tp: -1, lra: 11 };

/** Measured values loudnorm prints at the end of pass 1 - the trailing JSON
 *  block lands on stderr when the chain ends at `-f null -`. */
export interface LoudMeasured {
  input_i: number; input_tp: number; input_lra: number; input_thresh: number;
  target_i: number; target_tp: number; target_lra: number; target_thresh: number;
  normalization_type: string;
}

const MEASURE_RE = /\{\s*"input_i"[\s\S]*?\}/;

/** Pass 1: measure integrated/tp/lra for the target. Throws when the file
 *  can't be measured (corrupt, no audio). */
export async function measureLoudness(file: string, target: LoudTarget, deps: MixDeps = {}): Promise<LoudMeasured> {
  const { execFile } = await import("node:child_process");
  const xf = deps.execFile ?? execFile;
  const args = [
    "-hide_banner", "-nostats", "-i", file, "-vn",
    "-af", `loudnorm=I=${target.i}:TP=${target.tp}:LRA=${target.lra}:print_format=json`,
    "-f", "null", "-",
  ];
  const stderr = await new Promise<string>((resolve) => {
    xf(ffmpegBin(), args, { maxBuffer: 4 * 1024 * 1024 }, (_e, _out, err) => resolve(err ?? ""));
  });
  const m = MEASURE_RE.exec(stderr);
  if (!m) throw new Error(`loudnorm measure produced no json for ${file}`);
  const j = JSON.parse(m[0]) as Record<string, string>;
  const num = (k: string) => Number.parseFloat(j[k] ?? "NaN");
  return {
    input_i: num("input_i"), input_tp: num("input_tp"), input_lra: num("input_lra"),
    input_thresh: num("input_thresh"),
    target_i: num("target_i"), target_tp: num("target_tp"), target_lra: num("target_lra"),
    target_thresh: num("target_thresh"),
    normalization_type: j.normalization_type ?? "dynamic",
  };
}

/** Pass 2: apply the measured linear gain manually (target_i − input_i dB),
 *  then oversample to 192 kHz and hard-limit at 0.79 (≈−2 dBFS) so the
 *  true-peak ceiling holds on inter-sample peaks - level=0 means it caps,
 *  never re-loudens. Back down to a 48 kHz s16 wav. */
export async function normalizeToWav(
  src: string, dst: string, target: LoudTarget,
  measured: LoudMeasured, deps: MixDeps = {},
): Promise<void> {
  const gainDb = target.i - measured.input_i;
  const af =
    `volume=${gainDb.toFixed(2)}dB,` +
    "aresample=192000,alimiter=limit=0.79:level=0,aresample=48000";
  await runArgv(ffmpegBin(), [
    "-y", "-hide_banner", "-i", src,
    "-af", af, "-ar", "48000", "-c:a", "pcm_s16le", dst,
  ], deps);
}

/** measure → apply in one call. Returns the measured pass-1 summary.
 *  A silent input measures −inf - applying those gains divides by zero, so
 *  the honest normalized output for silence is the source copied through. */
export async function loudnormTwoPass(
  src: string, dst: string, target: LoudTarget, deps: MixDeps = {},
): Promise<LoudMeasured> {
  const m = await measureLoudness(src, target, deps);
  if (!Number.isFinite(m.input_i)) {
    await fs.copyFile(src, dst);
    return m;
  }
  await normalizeToWav(src, dst, target, m, deps);
  return m;
}
