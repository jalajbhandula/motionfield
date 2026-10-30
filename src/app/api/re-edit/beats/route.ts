import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { resolveOwnedMedia } from "@/lib/media-owned";
import { beatGridOf } from "@/lib/beatcut-audio";
import { probeDuration } from "@/lib/audio-mix/ffmpeg";

export const runtime = "nodejs";

/**
 * POST /api/re-edit/beats - tempo, beats, bar phase and per-beat energy of an
 * owned music track, for the cut-to-music preview. The render re-analyses
 * the same file the same way, so the preview is the edit you get.
 */
const Body = z.object({ audio_url: z.string().min(1).max(4096) });

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    const file = await resolveOwnedMedia(user.id, parsed.data.audio_url);
    if ((await probeDuration(file)) > 600) return json({ error: "tracks up to 10 minutes" }, 400);
    const grid = await beatGridOf(file, req.signal);
    if (grid.beats.length < 4) return json({ error: "couldn't find a steady beat in this track - try one with a clear rhythm" }, 422);
    return json({ grid });
  } catch (e) {
    return err(e);
  }
}
