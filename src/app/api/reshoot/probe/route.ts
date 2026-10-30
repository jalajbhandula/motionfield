import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { resolveOwnedMedia } from "@/lib/media-owned";
import { probeClip } from "@/lib/camera/probe";
import { RESHOOT_LOCAL_MAX_FRAMES, RESHOOT_MAX_FRAMES, reshootDims } from "@/lib/catalog/video/camera";

export const runtime = "nodejs";

/**
 * POST /api/reshoot/probe - ownership-checked ffprobe for the re-shoot
 * form. Returns the same numbers the submit route derives into params
 * (frames/fps/duration/dims) plus the over-budget flag, so the UI can quote
 * honest timing before anything is charged. `frames` counts the video
 * stream's own packets - container duration over-counts whenever the audio
 * runs past the last frame.
 */
const Body = z.object({ video_url: z.string().min(1).max(4096) });

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    const file = await resolveOwnedMedia(user.id, parsed.data.video_url);
    let probe;
    try {
      probe = await probeClip(file);
    } catch (e) {
      // a still image or unreadable container is a bad input, not an
      // internal error - say so at 400 so the card can show the reason
      return json({ error: `not a readable video: ${e instanceof Error ? e.message : e}` }, 400);
    }
    const [rw, rh] = reshootDims(probe.width, probe.height);
    return json({
      probe: {
        // video-stream duration (frames ÷ fps) - the container duration can
        // run long when the audio outlives the last frame
        duration: probe.frames / probe.fps,
        fps: probe.fps,
        width: probe.width,
        height: probe.height,
        rotation: probe.rotation,
        has_audio: probe.hasAudio,
        frames: probe.frames,
        // the working size the clip actually renders at - fitted inside the
        // 832×480 Wan box, multiples of 16, never upscaled
        render_width: rw,
        render_height: rh,
        // over-cap clips are refused at submit, not truncated - the card
        // says "cloud recommended" past the local budget and refuses past
        // the hard cap
        local_cap: RESHOOT_LOCAL_MAX_FRAMES,
        capped_at: Math.min(probe.frames, RESHOOT_MAX_FRAMES),
      },
    });
  } catch (e) {
    return err(e);
  }
}
