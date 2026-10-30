/** Director post-looks - the camera body + color palette controls' consumer.
 *
 *  The provider stores a PostSpec on job meta; when the run finishes, every
 *  video output is graded host-side with ffmpeg before it lands as an asset:
 *    body   → noise + unsharp (+ eq where the look calls for it)
 *    palette→ lut3d of the deterministic .cube (grade/lut.ts)
 *  "modern" runs no grade (a clean digital body produces the file as-rendered);
 *  any other declared body always produces a real filter chain.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { DIRECTOR_BODIES } from "@/lib/catalog/presets/director";
import { lutPathFor } from "./lut";

const execFileP = promisify(execFile);
const FFMPEG = () => process.env.FFMPEG_BIN || "ffmpeg";

/** ffmpeg -vf fragments per body id (the look, in application order). */
const BODY_LOOKS: Record<string, string[]> = {
  // clean digital - deliberately nothing (the honest "no look" body)
  modern: [],
  // 35mm: fine animated grain, mild micro-contrast
  "35mm-film": ["noise=alls=6:allf=t+u", "unsharp=7:7:0.25"],
  // 8mm: heavier grain, softer gate
  "8mm-film": ["noise=alls=14:allf=t+u", "unsharp=9:9:-0.2"],
  // DV camcorder: mid grain, sharpened edges, slightly clipped saturation
  "dv-camcorder": ["noise=alls=8:allf=t", "unsharp=5:5:0.65", "eq=saturation=0.88"],
};

/** The resolved ffmpeg chain - distinct from catalog/types' PostSpec (the
 *  {body,palette} record parked on job meta). */
export interface PostChain {
  /** complete ffmpeg -vf chain, or null when nothing applies */
  vf: string | null;
  /** what the spec carries - surfaced in job meta for the record */
  body?: string;
  palette?: string;
}

/** Resolve the post spec for a set of job params - async because a palette
 *  has to materialise its .cube on disk first. */
export async function postSpecFor(params: Record<string, unknown>): Promise<PostChain> {
  const body = typeof params.camera_body === "string" && (DIRECTOR_BODIES as readonly string[]).includes(params.camera_body)
    ? params.camera_body : "modern";
  const palette = typeof params.color_palette === "string" && params.color_palette ? params.color_palette : null;
  const chain: string[] = [];
  if (palette) chain.push(`lut3d='${await lutPathFor(palette)}'`);
  chain.push(...(BODY_LOOKS[body] ?? []));
  return { vf: chain.length ? chain.join(",") : null, body, palette: palette ?? undefined };
}

/** Run `vf` over a video blob - in and out through temp files the call
 *  always removes. Throws on ffmpeg failure (the job then fails honestly -
 *  shipping an ungraded file would lie about the look). */
export async function ffmpegVideo(bytes: Uint8Array, vf: string): Promise<Uint8Array> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "of-post-"));
  const src = path.join(dir, "in.mp4");
  const dst = path.join(dir, "out.mp4");
  try {
    await fs.writeFile(src, bytes);
    await execFileP(FFMPEG(), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", src, "-vf", vf,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", dst,
    ], { timeout: 180_000 });
    return await fs.readFile(dst);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
