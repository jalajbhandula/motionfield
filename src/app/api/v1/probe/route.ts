import { NextRequest } from "next/server";
import { z } from "zod";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err, v1error } from "@/lib/api/v1";
import { resolveOwnedMedia } from "@/lib/media-owned";
import { probeClip } from "@/lib/camera/probe";
import { reshootDims } from "@/lib/catalog/video/camera";
import { detectVideo } from "@/lib/re-edit";

export const runtime = "nodejs";

const Body = z.object({ video_url: z.string().min(1).max(4096) });

/**
 * POST /api/v1/probe { video_url } - bearer-authed, ownership-checked probe
 * for endpoints whose params must carry probe truth (re-shoot's frame-exact claim,
 * the VFX plate's frame math, ReCut's window count). Returns the same
 * numbers the session routes derive - ffprobe facts plus the render dims
 * and the detected shot-window count. A still image or unreadable
 * container is a bad input, not an internal error.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return v1error("bad_request", "body must be JSON: { video_url }", 400);
    const file = await resolveOwnedMedia(auth.userId, parsed.data.video_url);
    let probe;
    try {
      probe = await probeClip(file);
    } catch {
      // ffprobe's stderr tail names the on-disk path - return a fixed string
      return v1error("bad_request", "not a readable video", 400);
    }
    const [rw, rh] = reshootDims(probe.width, probe.height);
    let windows: number | null = null;
    try {
      windows = (await detectVideo(file)).shots.reduce((a, s) => a + s.windows.length, 0);
    } catch {
      // shot detection is best-effort - the probe facts still stand
    }
    return v1json({
      probe: {
        duration: probe.frames / probe.fps,
        fps: probe.fps,
        width: probe.width,
        height: probe.height,
        rotation: probe.rotation,
        has_audio: probe.hasAudio,
        frames: probe.frames,
        render_width: rw,
        render_height: rh,
        windows,
      },
    });
  } catch (e) {
    return v1err(e);
  }
}
