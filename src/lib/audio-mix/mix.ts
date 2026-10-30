/** audio-mix graph building - one ffmpeg filter_complex per call:
 *  normalized beds/cue wavs summed with normalize=0, the bus capped at
 *  −1 dBTP, everything merged to a single aac track while the h264 stream
 *  is copied untouched. Container metadata marks the result as post-mix -
 *  ffprobe can read it back. */
import { runArgv, ffmpegBin, type MixDeps } from "./ffmpeg";

/** a normalized cue ready to place - file on disk, position in seconds */
export interface CueFile { file: string; tStart: number }

export interface PostMixTags {
  /** always "post-mix" - the honest marker the spec requires */
  audio?: string;
  /** human-readable provenance line */
  comment?: string;
  /** JSON cue list when the mix was cue-driven */
  cues?: string;
}

function metadataArgs(tags: PostMixTags): string[] {
  const out = ["-metadata", `audio=${tags.audio ?? "post-mix"}`];
  if (tags.comment) out.push("-metadata", `comment=${tags.comment}`);
  if (tags.cues) out.push("-metadata", `cues=${tags.cues}`);
  return out;
}

const duckDbParam = (d: number | undefined) => -Math.abs(d ?? 6);

/** every shipped track caps at −1 dBTP - the summed bus is oversampled to
 *  192 kHz so the limiter catches inter-sample peaks the aac encode would
 *  otherwise exceed (level=0: it caps, never re-loudens). The 0.79 ceiling
 *  is the same one the two-pass normalize applies. */
const TP_LIMIT = "aresample=192000,alimiter=limit=0.79:level=0,aresample=48000";

/**
 * Post-mix: video file + one bed track (music/sfx wav) → mp4. The bed - and
 * `src`, the video's own audio extracted and normalized by the caller -
 * arrive loudness-normalized already: keep mode mixes the source at −16
 * over the bed at −20; with no src (replace mode, silent or absent source)
 * the bed carries the mix alone at −14.
 * Output: -c:v copy, aac 48k stereo audio.
 */
export async function muxBedOntoVideo(opts: {
  video: string; bed: string; out: string;
  /** normalized source-audio wav - mixed over the bed; absent = bed alone */
  src?: string;
  durationSec?: number;
  tags?: PostMixTags; deps?: MixDeps;
}): Promise<void> {
  const inputs = ["-i", opts.video, "-i", opts.bed];
  if (opts.src) inputs.push("-i", opts.src);
  const fc = opts.src
    ? "[2:a]aresample=48000[src];[1:a]aresample=48000[bed]" +
      `;[src][bed]amix=inputs=2:duration=first:normalize=0,${TP_LIMIT}[aout]`
    : `[1:a]aresample=48000,${TP_LIMIT}[aout]`;
  const args = [
    "-y", "-hide_banner", ...inputs,
    "-filter_complex", fc,
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    ...(opts.durationSec ? ["-t", String(opts.durationSec)] : []),
    // use_metadata_tags - arbitrary keys (audio=post-mix, cues) only survive
    // the mp4 muxer in an mdta atom; without it ffmpeg silently drops them
    "-movflags", "+faststart+use_metadata_tags",
    ...metadataArgs(opts.tags ?? {}),
    opts.out,
  ];
  await runArgv(ffmpegBin(), args, opts.deps ?? {});
}

/**
 * Cue mix: video file + N normalized cue wavs placed at their t_start → mp4.
 * Source audio (when present) is lowered `duckDb` under the summed cue bus.
 * cues[i] arrives already loudness-normalized by the caller.
 */
export async function muxCuesOntoVideo(opts: {
  video: string; cues: CueFile[]; out: string;
  durationSec: number; sourceHasAudio: boolean; duckDb?: number;
  tags?: PostMixTags; deps?: MixDeps;
}): Promise<void> {
  const n = opts.cues.length;
  if (!n) throw new Error("muxCuesOntoVideo needs at least one cue");
  const inputs: string[] = ["-i", opts.video];
  for (const c of opts.cues) inputs.push("-i", c.file);

  const parts: string[] = [];
  const cueLabels: string[] = [];
  opts.cues.forEach((c, i) => {
    const ms = Math.max(0, Math.round(c.tStart * 1000));
    parts.push(`[${i + 1}:a]aresample=48000,adelay=${ms}|${ms}[cue${i}]`);
    cueLabels.push(`[cue${i}]`);
  });
  if (n === 1) {
    parts.push("[cue0]anull[cuebus]");
  } else {
    parts.push(`${cueLabels.join("")}amix=inputs=${n}:duration=longest:normalize=0[cuebus]`);
  }

  if (opts.sourceHasAudio) {
    parts.push(`[0:a]aresample=48000,volume=${duckDbParam(opts.duckDb)}dB[src]`);
    parts.push(`[src][cuebus]amix=inputs=2:duration=first:normalize=0,${TP_LIMIT}[aout]`);
  } else {
    parts.push(`[cuebus]${TP_LIMIT}[aout]`);
  }

  const args = [
    "-y", "-hide_banner", ...inputs,
    "-filter_complex", parts.join(";"),
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-t", String(opts.durationSec),
    "-movflags", "+faststart+use_metadata_tags",
    ...metadataArgs(opts.tags ?? {}),
    opts.out,
  ];
  await runArgv(ffmpegBin(), args, opts.deps ?? {});
}
