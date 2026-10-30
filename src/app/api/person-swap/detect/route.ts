import { NextRequest } from "next/server";
import { z } from "zod";
import path from "node:path";
import { json, err, requireApiUser } from "@/lib/api";
import { JobError } from "@/lib/jobs";
import { resolveOwnedMedia } from "@/lib/media-owned";
import { probeVideo } from "@/lib/re-edit-ffmpeg";
import {
  personSwapWindows, PERSON_SWAP_MIN_S, PERSON_SWAP_MAX_S, personSwapGalleryFile,
} from "@/lib/generation/recipes/person-swap";
import { PERSON_SWAP_MODES, personSwapLocalEstimateMin, personSwapLocalSteps } from "@/lib/catalog/video/swap";

export const runtime = "nodejs";

/**
 * POST /api/person-swap/detect - probe + window count + local runtime estimate for
 * the UI's estimate block. The run re-probes on POST /api/person-swap; this exists
 * so the client can show the cost and the honest wall-clock before submitting.
 * `gallery_id` probes the manifest clip directly (the submit later copies it
 * into the caller's uploads).
 */
const Body = z.object({
  video_url: z.string().min(1).max(4096).optional(),
  gallery_id: z.string().min(1).max(200).optional(),
  // optional ref ids - the /person-swap?photo=… deep link re-checks that every
  // id is the caller's own media before the page may preload it
  image_urls: z.array(z.string().max(4096)).max(8).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    let file: string;
    let preview: string | undefined;
    if (parsed.data.video_url) {
      file = await resolveOwnedMedia(user.id, parsed.data.video_url);
      preview = parsed.data.video_url;
    } else if (parsed.data.gallery_id) {
      const hit = await personSwapGalleryFile(parsed.data.gallery_id);
      if (!hit) return json({ error: "unknown gallery clip" }, 400);
      file = hit.file;
      preview = `/person-swap/gallery/${path.basename(hit.entry.file)}`;
    } else {
      return json({ error: "video_url or gallery_id is required" }, 400);
    }
    for (const u of parsed.data.image_urls ?? []) await resolveOwnedMedia(user.id, u);
    const probe = await probeVideo(file).catch(() => {
      throw new JobError("unreadable video - upload a readable mp4/webm/mov", 400);
    });
    const inRange = probe.durationSec >= PERSON_SWAP_MIN_S && probe.durationSec <= PERSON_SWAP_MAX_S;
    return json({
      windows: personSwapWindows(probe.durationSec).length,
      ...(preview ? { preview } : {}),
      in_range: inRange,
      probe: {
        duration: probe.durationSec, fps: probe.fps,
        width: probe.width, height: probe.height,
        rotation: probe.rotation, has_audio: probe.hasAudio,
      },
      // honest local runtime - totals per mode × resolution, measured at the
      // 9:16-480p gen box (256×480) on this machine (see docs/SMOKE.md); the
      // client shows the line for its selected mode so the rate and the
      // total can never disagree
      local: {
        steps: personSwapLocalSteps(),
        measured_on: "M1 Pro",
        total_min: Object.fromEntries(["480p", "720p"].map((r) => [r,
          Object.fromEntries(PERSON_SWAP_MODES.map((m) => [m,
            personSwapLocalEstimateMin(probe.width, probe.height, probe.durationSec,
              { resolution: r, mode: m, lip: probe.hasAudio && m !== "environment" })])),
        ])),
      },
    });
  } catch (e) {
    return err(e);
  }
}
