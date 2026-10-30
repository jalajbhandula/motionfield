import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { createJob, applyDailyCredits } from "@/lib/jobs";
import { resolveOwnedMedia } from "@/lib/media-owned";
import { RestrictedLicenseError } from "@/lib/catalog/license-gate";
import { probeClip } from "@/lib/camera/probe";
import { runBin } from "@/lib/re-edit-ffmpeg";
import {
  VFX_FPS, VFX_ALT_FPS, VFX_MIN_PLATE_SEC, VFX_MAX_PLATE_SEC,
  VFX_ALT_MAX_FRAMES, VFX_LTX_ENGINES, VFX_PLATE_LOCKS, VFX_HOLDS,
  VFX_ALT_STRUCTURES, VFX_ALT_LENGTHS, VFX_LOCK_DENOISE, VFX_LOCK_SIGMAS,
  vfxFrames, vfxDims, vfxAltDims, vfxAltFrames, ltx098Installed,
} from "@/lib/catalog/video/vfx";
import { vfxPresetById, vfxPresetVerified } from "@/lib/catalog/presets/vfx-lab";

export const runtime = "nodejs";

/**
 * POST /api/vfx-lab/submit - create a VFX Lab job. Ownership is enforced on
 * every /files/ ref first (plate + optional target frame), then the probe
 * stamps frames/fps/duration/width/height - those fields are server truth,
 * never client-supplied. `vfx_preset` merges a verified preset's prompt and
 * defaults; an unverified or unknown id is refused before any charge.
 *
 * Path pick: `structure` present → the Wan VACE alt endpoint; otherwise the
 * LTX plate/image endpoint by plate kind and engine.
 */
const Body = z.strictObject({
  video_url: z.string().min(1).max(4096).optional(),
  image_url: z.string().min(1).max(4096).optional(),
  prompt: z.string().max(4000).optional(),
  negative_prompt: z.string().max(2000).optional(),
  engine: z.enum(["ltx098", "ltx095"]).optional(),
  plate_lock: z.enum(["light", "medium", "strong", "full"]).optional(),
  hold: z.number().int().min(0).max(25).optional(),
  structure: z.enum(["depth", "pose", "edges", "image"]).optional(),
  alt_length: z.enum(["preview", "full"]).optional(),
  end_image_url: z.string().min(1).max(4096).optional(),
  target_strength: z.number().min(0.5).max(1.0).optional(),
  resolution: z.enum(["480p", "720p"]).optional(),
  duration: z.number().min(2).max(5).optional(),
  steps: z.number().int().min(2).max(50).optional(),
  seed: z.number().int().min(0).optional(),
  vfx_preset: z.string().max(80).optional(),
  pair_of: z.string().max(64).optional(),
});

async function probeImageDims(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await runBin(process.env.FFPROBE_BIN || "ffprobe", [
    "-v", "error", "-print_format", "json", "-show_streams",
    "-protocol_whitelist", "file", "-i", file,
  ]);
  const v = (JSON.parse(stdout) as { streams?: { codec_type?: string; width?: number; height?: number }[] })
    .streams?.find((s) => s.codec_type === "video");
  if (!v?.width || !v.height) throw new Error("no readable image dims");
  return { width: v.width, height: v.height };
}

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success)
      return json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    const b = parsed.data;

    const hasVideo = !!b.video_url, hasImage = !!b.image_url;
    if (hasVideo === hasImage)
      return json({ error: "one plate - a clip or a still, not both" }, 400);
    if (b.engine && b.structure)
      return json({ error: "pick an LTX engine OR a Wan structure - not both" }, 400);

    // the preset must exist AND be verified before it may shape a job
    const preset = b.vfx_preset !== undefined ? vfxPresetById(b.vfx_preset) : undefined;
    if (b.vfx_preset !== undefined && !preset)
      return json({ error: "unknown vfx preset" }, 400);
    if (preset && !vfxPresetVerified(preset.id))
      return json({ error: `preset "${preset.label}" has no verified record - unverified presets can't run` }, 400);
    const presetNeg = preset?.negative;

    const res = b.resolution ?? preset?.defaults.resolution ?? "480p";
    // a preset's alt_structure applies only when no LTX engine was picked -
    // an explicit engine wins (the controls are exclusive, see above)
    const structure = b.structure ?? (b.engine ? undefined : preset?.defaults.alt_structure);
    const endStrength = b.target_strength ?? preset?.defaults.target_strength ?? 0.8;

    // ownership before any charge - plate + target frame alike
    if (b.end_image_url) await resolveOwnedMedia(user.id, b.end_image_url);

    if (structure) {
      /* ---------------- Wan VACE alt ---------------- */
      if (structure === "image" ? !hasImage : !hasVideo)
        return json({ error: structure === "image"
          ? "structure image needs a still plate - clips take depth | pose | edges"
          : `structure ${structure} needs a clip plate - stills take "image"` }, 400);
      const len = b.alt_length ?? "preview";
      let srcW: number, srcH: number, srcDur: number;
      if (hasVideo) {
        const file = await resolveOwnedMedia(user.id, b.video_url!);
        let probe;
        try { probe = await probeClip(file); }
        catch (e) { return json({ error: `not a readable video: ${e instanceof Error ? e.message : e}` }, 400); }
        if (probe.frames < 2) return json({ error: "a single frame is an image plate" }, 400);
        srcW = probe.width; srcH = probe.height;
        srcDur = probe.frames / probe.fps;
      } else {
        const file = await resolveOwnedMedia(user.id, b.image_url!);
        if (!/\.(png|jpe?g|webp|gif)$/i.test(file))
          return json({ error: "the image plate must be a still image (png/jpg/webp)" }, 400);
        let dims;
        try { dims = await probeImageDims(file); }
        catch (e) { return json({ error: `not a readable image: ${e instanceof Error ? e.message : e}` }, 400); }
        srcW = dims.width; srcH = dims.height;
        srcDur = len === "full" ? 5 : 2;
      }
      if (srcDur < VFX_MIN_PLATE_SEC)
        return json({ error: `plate is ${srcDur.toFixed(2)} s - needs ≥ ${VFX_MIN_PLATE_SEC} s` }, 400);
      if (hasVideo && srcDur > VFX_MAX_PLATE_SEC)
        return json({ error: `plate is ${srcDur.toFixed(1)} s - the budget is ${VFX_MAX_PLATE_SEC} s` }, 400);
      const frames = vfxAltFrames(srcDur, len);
      if (frames > VFX_ALT_MAX_FRAMES)
        return json({ error: `${frames} frames is over the ${VFX_ALT_MAX_FRAMES}-frame alt budget` }, 400);
      const [width, height] = vfxAltDims(srcW, srcH);

      await applyDailyCredits(user.id);
      const job = await createJob(user.id, {
        endpointId: "motionfield/wan-vace/vfx-lab-alt",
        title: `VFX · ${preset?.label ?? "Wan alt"} · ${structure}`,
        params: {
          video_url: b.video_url, image_url: b.image_url,
          structure, alt_length: len,
          prompt: preset ? `${preset.prompt}${b.prompt ? `, ${b.prompt}` : ""}` : (b.prompt ?? ""),
          negative_prompt: b.negative_prompt ?? presetNeg ?? "",
          end_image_url: b.end_image_url,
          seed: b.seed,
          frames, fps: VFX_ALT_FPS, duration: frames / VFX_ALT_FPS,
          width, height,
          vfx_preset: preset?.id, pair_of: b.pair_of,
        },
      });
      return json({ job }, 201);
    }

    /* ---------------- LTX engines ---------------- */
    const engine = b.engine ?? "ltx095";
    if (!(VFX_LTX_ENGINES as readonly string[]).includes(engine))
      return json({ error: `engine "${engine}" is not an LTX VFX engine` }, 400);
    if (engine === "ltx098" && !ltx098Installed())
      return json({ error: "ltx098 isn't installed - the distilled checkpoint is gated to the exact file; run ltx095 or the wan-alt" }, 400);
    const lock = b.plate_lock ?? preset?.defaults.lock ?? "medium";
    if (!(VFX_PLATE_LOCKS as readonly string[]).includes(lock))
      return json({ error: `plate_lock "${lock}" is not a lock level` }, 400);
    const hold = b.hold ?? preset?.defaults.hold ?? 9;
    if (!(VFX_HOLDS as readonly number[]).includes(hold))
      return json({ error: `hold must be one of ${VFX_HOLDS.join(", ")}` }, 400);

    if (hasImage) {
      const file = await resolveOwnedMedia(user.id, b.image_url!);
      if (!/\.(png|jpe?g|webp|gif)$/i.test(file))
        return json({ error: "the image plate must be a still image (png/jpg/webp)" }, 400);
      let dims;
      try { dims = await probeImageDims(file); }
      catch (e) { return json({ error: `not a readable image: ${e instanceof Error ? e.message : e}` }, 400); }
      const dur = b.duration ?? preset?.defaults.duration ?? 3;
      const frames = vfxFrames(dur);
      const [width, height] = vfxDims(dims.width, dims.height, res, frames);
      await applyDailyCredits(user.id);
      const job = await createJob(user.id, {
        endpointId: "motionfield/ltx-video/vfx-lab-image",
        title: `VFX · ${preset?.label ?? "image plate"} · ${engine}`,
        params: {
          image_url: b.image_url,
          prompt: preset ? `${preset.prompt}${b.prompt ? `, ${b.prompt}` : ""}` : (b.prompt ?? ""),
          negative_prompt: b.negative_prompt ?? presetNeg ?? "",
          engine, end_image_url: b.end_image_url, target_strength: endStrength,
          resolution: res, duration: dur, steps: b.steps ?? 8, seed: b.seed,
          frames, fps: VFX_FPS, width, height,
          sigmas: VFX_LOCK_SIGMAS.full.join(", "),
          vfx_preset: preset?.id, pair_of: b.pair_of,
        },
      });
      return json({ job }, 201);
    }

    const file = await resolveOwnedMedia(user.id, b.video_url!);
    let probe;
    try { probe = await probeClip(file); }
    catch (e) { return json({ error: `not a readable video: ${e instanceof Error ? e.message : e}` }, 400); }
    if (probe.frames < 2) return json({ error: "a single frame is an image plate - use the image pick" }, 400);
    const srcDur = probe.frames / probe.fps;
    if (srcDur < VFX_MIN_PLATE_SEC)
      return json({ error: `plate is ${srcDur.toFixed(2)} s - needs ≥ ${VFX_MIN_PLATE_SEC} s` }, 400);
    if (srcDur > VFX_MAX_PLATE_SEC)
      return json({ error: `plate is ${srcDur.toFixed(1)} s - the budget is ${VFX_MAX_PLATE_SEC} s` }, 400);
    const frames = vfxFrames(srcDur);
    const [width, height] = vfxDims(probe.width, probe.height, res, frames);

    await applyDailyCredits(user.id);
    const job = await createJob(user.id, {
      endpointId: "motionfield/ltx-video/vfx-lab-plate",
      title: `VFX · ${preset?.label ?? "plate"} · ${engine} · ${lock}`,
      params: {
        video_url: b.video_url,
        prompt: preset ? `${preset.prompt}${b.prompt ? `, ${b.prompt}` : ""}` : (b.prompt ?? ""),
        negative_prompt: b.negative_prompt ?? presetNeg ?? "",
        engine, plate_lock: lock, hold,
        end_image_url: b.end_image_url, target_strength: endStrength,
        resolution: res, steps: b.steps ?? 8, seed: b.seed,
        frames, fps: VFX_FPS, duration: srcDur, width, height,
        denoise: VFX_LOCK_DENOISE[lock as keyof typeof VFX_LOCK_DENOISE],
        sigmas: VFX_LOCK_SIGMAS[lock as keyof typeof VFX_LOCK_SIGMAS].join(", "),
        vfx_preset: preset?.id, pair_of: b.pair_of,
      },
    });
    return json({ job }, 201);
  } catch (e) {
    if (e instanceof RestrictedLicenseError) return json(e.body, e.status);
    return err(e);
  }
}
