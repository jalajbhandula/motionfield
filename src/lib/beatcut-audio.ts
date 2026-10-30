import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ffmpegBin } from "./audio-mix/ffmpeg";
import { ANALYSIS_RATE, analyseBeats, type BeatGrid } from "./beatcut";

const execFileP = promisify(execFile);

/** A track decoded to mono float samples at the analysis rate (server-only). */
export async function decodeMono(file: string, signal?: AbortSignal): Promise<Float32Array> {
  const { stdout } = await execFileP(ffmpegBin(), [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-i", file,
    "-vn", "-ac", "1", "-ar", String(ANALYSIS_RATE), "-f", "f32le", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: 120_000, signal });
  const b = Buffer.from(stdout);
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
}

/** Beat grid of an owned track file - the studio preview and the render
 *  both come through here, so they plan from identical beats. */
export async function beatGridOf(file: string, signal?: AbortSignal): Promise<BeatGrid> {
  return analyseBeats(await decodeMono(file, signal));
}
