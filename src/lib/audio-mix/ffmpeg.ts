/** audio-mix ffmpeg runner - every process is an execFile argv array, never a
 *  shell string. The spawn dep is injectable so tests can capture argv and
 *  prove no shell and no un-resolved path ever reaches a process. */
import { execFile as _execFile, type ExecFileOptions } from "node:child_process";

export type SpawnFn = typeof _execFile;

export interface MixDeps {
  execFile?: SpawnFn;
  signal?: AbortSignal;
  /** stderr is captured for errors; pass-through for debugging */
  stderrLimit?: number;
}

export const ffmpegBin = () => process.env.FFMPEG_BIN || "ffmpeg";
export const ffprobeBin = () => process.env.FFPROBE_BIN || "ffprobe";

export class FFmpegError extends Error {
  readonly argv: string[];
  readonly stderr: string;
  constructor(bin: string, argv: string[], stderr: string) {
    super(`${bin} failed: ${stderr.trim().split("\n").pop() ?? "unknown error"}`);
    this.name = "FFmpegError";
    this.argv = argv;
    this.stderr = stderr;
  }
}

/** One execFile call as a promise - argv only, shell never involved.
 *  Resolves with captured stdout; rejects FFmpegError with stderr tail. */
export function runArgv(bin: string, argv: string[], deps: MixDeps = {}): Promise<string> {
  const xf = deps.execFile ?? _execFile;
  return new Promise<string>((resolve, reject) => {
    const opts: ExecFileOptions = {
      maxBuffer: 8 * 1024 * 1024,
      // shell stays undefined - execFile never spawns one
    };
    xf(bin, argv, opts, (err, stdout, stderr) => {
      if (err) reject(new FFmpegError(bin, argv, String(stderr ?? "") || String(err.message ?? err)));
      else resolve(String(stdout ?? ""));
    });
  }).then((out) => {
    deps.signal?.throwIfAborted?.();
    return out;
  });
}

/** ffprobe -show_format -show_streams as parsed JSON. */
export async function probeJson(file: string, deps: MixDeps = {}): Promise<{
  format: { duration?: string; tags?: Record<string, string> };
  streams: { codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number; duration?: string }[];
}> {
  const out = await runArgv(ffprobeBin(), [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
  ], deps);
  return JSON.parse(out);
}

/** Container duration in seconds (0 when ffprobe can't read one). */
export async function probeDuration(file: string, deps: MixDeps = {}): Promise<number> {
  const j = await probeJson(file, deps);
  return Number(j.format?.duration ?? 0) || 0;
}

/** True when the file has at least one audio stream. */
export async function probeHasAudio(file: string, deps: MixDeps = {}): Promise<boolean> {
  const j = await probeJson(file, deps);
  return (j.streams ?? []).some((s) => s.codec_type === "audio");
}

/** True when the file has at least one video stream. */
export async function probeHasVideo(file: string, deps: MixDeps = {}): Promise<boolean> {
  const j = await probeJson(file, deps);
  return (j.streams ?? []).some((s) => s.codec_type === "video");
}
