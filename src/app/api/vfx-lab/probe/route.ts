import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { resolveOwnedMedia } from "@/lib/media-owned";
import { probeClip } from "@/lib/camera/probe";
import { runBin } from "@/lib/re-edit-ffmpeg";
import {
  VFX_FPS, VFX_ALT_FPS, VFX_MIN_PLATE_SEC, VFX_MAX_PLATE_SEC,
  VFX_ALT_PREVIEW_FRAMES, VFX_ALT_MAX_FRAMES, VFX_LTX_TOKEN_CAP,
  VFX_LTX098_FILE,
  vfxFrames, vfxDims, vfxAltDims, vfxAltFrames, vfxTokens,
  vfxEtaSec, vfxAltEtaSec, ltx098Installed,
} from "@/lib/catalog/video/vfx";
import { vfxVisiblePresets } from "@/lib/catalog/presets/vfx-lab";

export const runtime = "nodejs";

/**
 * POST /api/vfx-lab/probe - ownership-checked probe for the VFX Lab plate
 * card. One input: `video_url` (a clip) or `image_url` (a still plate).
 * Returns the numbers the submit route derives into params - the fitted
 * render dims, 8n+1 frame count, latent-token count - plus per-engine wall
 * estimates and the verified-preset list, so the page quotes honest timing
 * before anything is charged. `frames`/`duration` are the video stream's own
 * packets ÷ fps - the container can't lie about the plate.
 */
const Body = z.object({
  video_url: z.string().min(1).max(4096).optional(),
  image_url: z.string().min(1).max(4096).optional(),
  resolution: z.enum(["480p", "720p"]).optional(),
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
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    const b = parsed.data;
    if (!b.video_url === !b.image_url)
      return json({ error: "one plate - a clip or a still, not both" }, 400);
    const res = b.resolution ?? "480p";
    const presets = vfxVisiblePresets().map((p) => ({
      id: p.id, label: p.label, blurb: p.blurb, family: p.family,
      defaults: p.defaults, target: !!p.target,
    }));

    if (b.image_url) {
      const file = await resolveOwnedMedia(user.id, b.image_url);
      if (!/\.(png|jpe?g|webp|gif)$/i.test(file))
        return json({ error: "the image plate must be a still image (png/jpg/webp)" }, 400);
      let dims;
      try {
        dims = await probeImageDims(file);
      } catch (e) {
        return json({ error: `not a readable image: ${e instanceof Error ? e.message : e}` }, 400);
      }
      const dur = 3;
      const frames = vfxFrames(dur);
      const [rw, rh] = vfxDims(dims.width, dims.height, res, frames);
      const [aw, ah] = vfxAltDims(dims.width, dims.height);
      return json({
        probe: {
          kind: "image",
          width: dims.width, height: dims.height,
          duration: dur, fps: VFX_FPS,
          render_frames: frames, render_width: rw, render_height: rh,
          render_tokens: vfxTokens(frames, rw, rh), token_cap: VFX_LTX_TOKEN_CAP,
          alt_frames: VFX_ALT_PREVIEW_FRAMES, alt_frames_full: VFX_ALT_MAX_FRAMES,
          alt_fps: VFX_ALT_FPS, alt_render_width: aw, alt_render_height: ah,
          ltx098: ltx098Installed(), ltx098_file: VFX_LTX098_FILE,
          estimates: {
            ltx095: Math.round(vfxEtaSec("ltx095", frames, rw, rh)),
            ltx098: Math.round(vfxEtaSec("ltx098", frames, rw, rh)),
            wan_alt: Math.round(vfxAltEtaSec(VFX_ALT_PREVIEW_FRAMES, aw, ah)),
          },
          presets,
        },
      });
    }

    const file = await resolveOwnedMedia(user.id, b.video_url!);
    let probe;
    try {
      probe = await probeClip(file);
    } catch (e) {
      // a still image or unreadable container is a bad input, not a 500
      return json({ error: `not a readable video: ${e instanceof Error ? e.message : e}` }, 400);
    }
    if (probe.frames < 2)
      return json({ error: "that's a single frame - an image plate; use the image pick" }, 400);
    // stream-truth duration (frames ÷ stream fps) - the container can run
    // long when audio outlives the last video frame
    const dur = probe.frames / probe.fps;
    if (dur < VFX_MIN_PLATE_SEC)
      return json({ error: `plate is ${dur.toFixed(2)} s - the lab needs ≥ ${VFX_MIN_PLATE_SEC} s to run an effect` }, 400);
    if (dur > VFX_MAX_PLATE_SEC)
      return json({ error: `plate is ${dur.toFixed(1)} s - the lab budget is ${VFX_MAX_PLATE_SEC} s on this Mac` }, 400);

    const frames = vfxFrames(dur);
    const [rw, rh] = vfxDims(probe.width, probe.height, res, frames);
    const tokens = vfxTokens(frames, rw, rh);
    const [aw, ah] = vfxAltDims(probe.width, probe.height);
    const altPreview = vfxAltFrames(dur, "preview");
    const altFull = vfxAltFrames(dur, "full");
    return json({
      probe: {
        kind: "video",
        frames: probe.frames,
        src_fps: probe.fps,
        duration: dur,
        width: probe.width, height: probe.height,
        has_audio: probe.hasAudio,
        fps: VFX_FPS,
        render_frames: frames, render_width: rw, render_height: rh,
        render_tokens: tokens, token_cap: VFX_LTX_TOKEN_CAP,
        alt_fps: VFX_ALT_FPS,
        alt_frames: altPreview, alt_frames_full: altFull,
        alt_render_width: aw, alt_render_height: ah,
        // the full-length alt truncates when the plate outlasts 81 frames -
        // the card says so, and the submit params carry the real number
        alt_truncates: altFull < Math.floor(dur * VFX_ALT_FPS),
        ltx098: ltx098Installed(), ltx098_file: VFX_LTX098_FILE,
        estimates: {
          ltx095: Math.round(vfxEtaSec("ltx095", frames, rw, rh)),
          ltx098: Math.round(vfxEtaSec("ltx098", frames, rw, rh)),
          wan_alt: Math.round(vfxAltEtaSec(altPreview, aw, ah)),
          wan_alt_full: Math.round(vfxAltEtaSec(altFull, aw, ah)),
        },
        presets,
      },
    });
  } catch (e) {
    return err(e);
  }
}
