import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { detectVideo } from "@/lib/re-edit";
import { resolveOwnedMedia } from "@/lib/media-owned";

export const runtime = "nodejs";

/**
 * POST /api/re-edit/detect - probe + server-side shot split for the UI's
 * shot list. The real split is re-done on POST /api/re-edit; this exists so
 * the client can show shots and collect per-shot hints without starting
 * anything.
 */
const Body = z.object({ video_url: z.string().min(1).max(4096) });

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    const file = await resolveOwnedMedia(user.id, parsed.data.video_url);
    const { probe, shots } = await detectVideo(file);
    return json({
      shots,
      windows: shots.reduce((a, s) => a + s.windows.length, 0),
      probe: {
        duration: probe.durationSec, fps: probe.fps,
        width: probe.width, height: probe.height,
        rotation: probe.rotation, has_audio: probe.hasAudio,
      },
    });
  } catch (e) {
    return err(e);
  }
}
