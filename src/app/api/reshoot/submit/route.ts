import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { createJob, applyDailyCredits } from "@/lib/jobs";
import { resolveOwnedMedia } from "@/lib/media-owned";
import { probeClip } from "@/lib/camera/probe";
import { RESHOOT_LOCAL_MAX_FRAMES, RESHOOT_MAX_FRAMES, reshootDims } from "@/lib/catalog/video/camera";

export const runtime = "nodejs";

/**
 * POST /api/reshoot/submit - create a re-shoot job. Ownership of video_url
 * is enforced here (resolveOwnedMedia - upload or generated asset only),
 * then the probe writes the frame/fps/duration/dims the endpoint gate
 * requires - so the frame-exact timing params are server truth, never client text.
 * `frames` is the video stream's packet count (audio can't inflate it) and
 * the dims are the source aspect fitted inside 832×480. The graph muxes the
 * source audio track back on (VHS audio → VideoCombine, capped at the video
 * length), so a silent source just gets a silent track.
 */
const Body = z.object({
  video_url: z.string().min(1).max(4096),
  moves: z.string().max(200).optional(),
  prompt: z.string().max(4000).optional(),
  negative_prompt: z.string().max(2000).optional(),
  backend: z.enum(["local", "cloud"]).optional(),
  strength: z.number().min(0.25).max(2).optional(),
  distance: z.number().min(0.5).max(20).optional(),
  steps: z.number().int().min(1).max(50).optional(),
  seed: z.number().int().min(0).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success)
      return json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    const b = parsed.data;

    // ownership before any charge - an upload row or a generated asset the
    // caller owns, resolving to a real file on disk
    const file = await resolveOwnedMedia(user.id, b.video_url);
    let probe;
    try {
      probe = await probeClip(file);
    } catch (e) {
      // still/non-video uploads are bad input - 400, not a 500
      return json({ error: `not a readable video: ${e instanceof Error ? e.message : e}` }, 400);
    }
    // VHS_LoadVideo's force_rate tops out at 60 - refuse before any charge
    if (probe.fps > 60)
      return json({ error: `${probe.fps.toFixed(2)} fps - re-shoot tops out at 60 fps` }, 400);
    // frame budget - over-cap clips are refused BEFORE charge, never
    // truncated: past RESHOOT_LOCAL_MAX_FRAMES the Mac is out of budget and
    // the cloud graph takes over on the user's own GPU; past
    // RESHOOT_MAX_FRAMES no graph can take it
    const probed = probe.frames;
    const backend = b.backend ?? "local";
    if (probed > RESHOOT_MAX_FRAMES)
      return json({ error: `${probed} frames is over the ${RESHOOT_MAX_FRAMES}-frame re-shoot budget` }, 400);
    if (backend === "local" && probed > RESHOOT_LOCAL_MAX_FRAMES)
      return json({ error: `${probed} frames is over the ${RESHOOT_LOCAL_MAX_FRAMES}-frame local budget - re-shoot on cloud instead` }, 400);
    const frames = Math.max(2, probed);
    const [width, height] = reshootDims(probe.width, probe.height);

    await applyDailyCredits(user.id);
    const job = await createJob(user.id, {
      endpointId: "motionfield/reshoot/video",
      title: `Re-shoot · ${b.moves?.split("+").join(" + ") || "locked-off"}`,
      params: {
        video_url: b.video_url,
        moves: b.moves ?? "",
        prompt: b.prompt ?? "",
        negative_prompt: b.negative_prompt ?? "",
        backend,
        strength: b.strength ?? 1.0,
        distance: b.distance ?? 4.0,
        steps: b.steps ?? 8,
        seed: b.seed,
        // probed - the endpoint gate refuses hand-built numbers; duration is
        // the video stream's (frames ÷ fps), not the container's - audio can
        // run past the last frame - the claim tracks the video frames exactly
        frames,
        fps: probe.fps,
        duration: frames / probe.fps,
        width,
        height,
      },
    });
    return json({ job }, 201);
  } catch (e) {
    return err(e);
  }
}
