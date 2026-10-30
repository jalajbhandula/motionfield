import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RecipeCtx, RecipeFn } from "../recipe";
import { saveBytes } from "../../storage";
import { resolveOwnedMedia } from "../../media-owned";
import { ffmpegBin, probeDuration, runArgv } from "../../audio-mix/ffmpeg";
import { BEAT_CUT_FPS as FPS, beatCutParamsSchema, framePlan, planEdit } from "../../beatcut";
import { beatGridOf } from "../../beatcut-audio";

/**
 * Cut to music - `motionfield/re-edit/beat-cut`. Host-side only (no weights):
 * the track's beat grid plans the edit (src/lib/beatcut.ts), each shot is
 * cut from its clip at the output size, and the shots are joined with
 * straight cuts or ffmpeg xfade transitions centred on the beat, counted
 * in whole frames (framePlan) so long edits never drift.
 */

const SIZES: Record<string, [number, number]> = { "9:16": [1080, 1920], "1:1": [1080, 1080], "16:9": [1920, 1080] };

const ff = (argv: string[], ctx: RecipeCtx) =>
  runArgv(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...argv], { signal: ctx.signal });

export const beatCutRecipe: RecipeFn = async (input, ctx) => {
  const p = beatCutParamsSchema.parse(input.params);
  const owner = input.userId ?? "";
  const clips = await Promise.all(p.video_urls.map((u) => resolveOwnedMedia(owner, u)));
  const music = await resolveOwnedMedia(owner, p.audio_url);

  ctx.progress(3, "finding the beat");
  if ((await probeDuration(music)) > 600) throw new Error("tracks up to 10 minutes");
  const grid = await beatGridOf(music, ctx.signal);
  if (grid.beats.length < 4) throw new Error("couldn't find a steady beat in this track - try one with a clear rhythm");
  const start = Math.min(p.music_start, Math.max(0, grid.duration - 5));
  const length = Math.min(p.length, grid.duration - start);
  if (!(length >= 3)) throw new Error("the track is too short from that start point");
  const durations = await Promise.all(clips.map((c) => probeDuration(c)));
  durations.forEach((d, i) => { if (!(d > 0.3)) throw new Error(`clip ${i + 1} has no readable video`); });
  const plan = planEdit(grid, durations.map((duration) => ({ duration })), { pace: p.pace, style: p.style, length, start });
  if (!plan.length) throw new Error("nothing to cut - try a longer length");
  const shots = framePlan(plan);

  const [W, H] = SIZES[p.aspect_ratio];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "of-beatcut-"));
  try {
    const segs: string[] = [];
    for (const [i, s] of shots.entries()) {
      ctx.progress(8 + Math.round((i / shots.length) * 70), `cutting shot ${i + 1} of ${shots.length}`);
      const seg = path.join(dir, `s${i}.mp4`);
      await ff([
        ...(s.cut.loops ? ["-stream_loop", "-1"] : []),
        "-ss", Math.max(0, s.cut.srcIn - s.head / FPS).toFixed(3), "-i", clips[s.cut.clip], "-an",
        "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1,fps=${FPS},format=yuv420p,tpad=stop_mode=clone:stop_duration=2`,
        "-frames:v", String(s.frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", seg,
      ], ctx);
      segs.push(seg);
    }

    ctx.progress(80, "joining on the beat");
    const filters = segs.map((_, i) => `[${i}:v]fps=${FPS},settb=AVTB,setpts=PTS-STARTPTS[v${i}]`);
    let cur = "v0";
    for (let i = 1; i < shots.length; i++) {
      const out = `j${i}`, s = shots[i];
      filters.push(s.xfade > 0
        ? `[${cur}][v${i}]xfade=transition=${s.cut.transition}:duration=${s.xfade.toFixed(4)}:offset=${s.offset.toFixed(4)}[${out}]`
        : `[${cur}][v${i}]concat=n=2:v=1:a=0[${out}]`);
      cur = out;
    }
    const fadeOut = Math.min(1.2, length / 4);
    filters.push(`[${segs.length}:a]atrim=0:${length.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.03,afade=t=out:st=${(length - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[aout]`);
    const out = path.join(dir, "out.mp4");
    await ff([
      ...segs.flatMap((s) => ["-i", s]), "-ss", start.toFixed(3), "-i", music,
      "-filter_complex", filters.join(";"), "-map", `[${cur}]`, "-map", "[aout]", "-t", length.toFixed(3),
      "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS),
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out,
    ], ctx);
    ctx.progress(96, "saving");
    const url = await saveBytes(`generated/beat-cut/${input.jobId}.mp4`, await fs.readFile(out));
    return [{ type: "video", url }];
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};
