import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { applyDailyCredits } from "@/lib/jobs";
import { startChain, RE_EDIT_IMAGE_CAP, publicJob } from "@/lib/re-edit";
import { RE_EDIT_FLOWS } from "@/lib/catalog/video/swap";
import { specById, specVisible } from "@/lib/catalog/presets/schema";
import { RE_EDIT_MAX_WINDOWS } from "@/lib/re-edit-ffmpeg";

export const runtime = "nodejs";

/**
 * POST /api/re-edit - start a ReCut chain. The server detects the shots itself;
 * callers only get to pass a per-shot hint list and pick the flow.
 * The whole run is ONE job (re-edit-assemble recipe) - no child jobs.
 */
const Body = z.object({
  video_url: z.string().min(1).max(4096),
  flow: z.enum(RE_EDIT_FLOWS).default("character-swap"),
  image_urls: z.array(z.string().max(4096)).max(3).default([]),
  instructions: z.string().max(2000).optional(),
  hints: z.array(z.string().max(500)).max(RE_EDIT_MAX_WINDOWS).optional(),
  preset_id: z.string().max(200).optional(),
  likeness_consent: z.boolean().optional(),
  resolution: z.enum(["480p", "720p"]).default("480p"),
  steps: z.number().int().min(2).max(50).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    await applyDailyCredits(user.id);
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    const b = parsed.data;
    if (b.image_urls.length > RE_EDIT_IMAGE_CAP[b.flow])
      return json({ error: `${b.flow} takes at most ${RE_EDIT_IMAGE_CAP[b.flow]} reference image(s)` }, 400);
    // the photo-driven flows are meaningless without a reference image
    if (b.flow !== "restyle" && b.image_urls.length === 0)
      return json({ error: `${b.flow} needs at least one image_urls entry` }, 400);
    if (b.preset_id) {
      if (b.flow !== "restyle")
        return json({ error: "preset_id only applies to the restyle flow" }, 400);
      // only a verified restyle-mechanism preset may run - same gate as the
      // picker tiles and /api/jobs resolveParams
      const spec = specById(b.preset_id);
      if (!spec || spec.mechanism.kind !== "restyle" || !specVisible(spec))
        return json({ error: "preset not available" }, 400);
    }
    const { chain, job } = await startChain(user.id, {
      videoUrl: b.video_url,
      flow: b.flow,
      imageUrls: b.image_urls,
      instructions: b.instructions,
      hints: b.hints,
      presetId: b.preset_id,
      likenessConsent: b.likeness_consent,
      resolution: b.resolution,
      ...(b.steps !== undefined ? { steps: b.steps } : {}),
    });
    return json({ chain, job: publicJob(job) }, 201);
  } catch (e) {
    return err(e);
  }
}
