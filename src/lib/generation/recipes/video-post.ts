import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RecipeFn } from "../recipe";
import { saveBytes } from "../../storage";
import { resolveOwnedMedia } from "../../media-owned";
import { ffmpegBin, probeHasAudio } from "../../audio-mix/ffmpeg";
import {
  LUT_EXPORT, buildLut, gradeTitle, labStats, toCube, withIntensity, type GradeSpec,
} from "../../grade/palette";
import { paletteSpecFromParams } from "../../catalog/video/post";

const execFileP = promisify(execFile);

/** Decode a few small frames of an owned image/video to RGBA bytes - enough
 *  for colour statistics, never the full file. */
async function sampleRgba(file: string, isVideo: boolean, signal: AbortSignal): Promise<Uint8Array> {
  // video: one small frame a second, up to 8 - the stats run over all of them
  const vf = isVideo ? "fps=1,scale=96:-2" : "scale=192:-2";
  const { stdout } = await execFileP(ffmpegBin(), [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-i", file, "-vf", vf, "-frames:v", isVideo ? "8" : "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 60_000, signal });
  return new Uint8Array(stdout);
}

/**
 * Palette grade - `motionfield/palette/grade-image` and `/grade-video`. One
 * LUT (a Director look, a reference match, or a colour palette) rasterised
 * at 33³ with the intensity baked in, applied by ffmpeg's lut3d at full
 * resolution. Video keeps its audio untouched.
 */
export const videoPostRecipe: RecipeFn = async (input, ctx) => {
  const p = input.params;
  const owner = input.userId ?? "";
  const isVideo = input.workflow.kind === "v2v";
  const src = await resolveOwnedMedia(owner, String((isVideo ? p.video_url : p.image_url) ?? ""));
  ctx.progress(5, "reading colours");

  let spec: GradeSpec = paletteSpecFromParams(p);
  if (spec.kind === "match") {
    // the client's stats are only a preview hint - measure both sides here
    const ref = await resolveOwnedMedia(owner, String(p.reference_url ?? ""));
    spec = {
      kind: "match",
      source: labStats(await sampleRgba(src, isVideo, ctx.signal)),
      reference: labStats(await sampleRgba(ref, false, ctx.signal)),
    };
  }
  const intensity = typeof p.intensity === "number" ? p.intensity : 0.8;
  const cube = toCube(withIntensity(buildLut(spec, LUT_EXPORT), intensity), gradeTitle(spec));

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "of-palette-"));
  try {
    const lut = path.join(dir, "grade.cube");
    await fs.writeFile(lut, cube);
    const out = path.join(dir, isVideo ? "out.mp4" : "out.png");
    ctx.progress(20, "grading");
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", src, "-vf", `lut3d=file='${lut}':interp=tetrahedral`];
    if (isVideo) {
      args.push("-map", "0:v:0", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
      if (await probeHasAudio(src)) args.push("-map", "0:a:0", "-c:a", "copy");
    } else {
      args.push("-frames:v", "1");
    }
    args.push(out);
    await execFileP(ffmpegBin(), args, { timeout: 15 * 60_000, signal: ctx.signal, maxBuffer: 4 * 1024 * 1024 });
    ctx.progress(95, "saving");
    const url = await saveBytes(`generated/palette/${input.jobId}.${isVideo ? "mp4" : "png"}`, await fs.readFile(out));
    return [{ type: isVideo ? "video" : "image", url }];
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};
