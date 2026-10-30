import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { applyDailyCredits, createJob } from "@/lib/jobs";
import { resolveOwnedMedia } from "@/lib/media-owned";
import { llmConfigured } from "@/lib/llm/index";
import { RestrictedLicenseError } from "@/lib/catalog/license-gate";
import { probeDuration } from "@/lib/audio-mix/ffmpeg";

export const runtime = "nodejs";

/**
 * POST /api/audio-mix/video-sfx - preflight for the video→sfx recipe, then
 * one job on motionfield/moss/video-sfx. The recipe re-verifies ownership in
 * run; this route exists so the failure modes are HTTP-shaped: logged out
 * 401, foreign/missing media 404, over-long clip 400, and - the one a bare
 * /api/jobs submit can't surface - 503 NEEDS_LLM when the caller has no
 * vision route configured.
 */
/** same NEEDS_LLM envelope /api/stage uses - the human text in `error`,
 *  the machine marker in `code` */
const NEEDS_LLM_BODY = {
  error: "video→SFX needs a vision model - Settings → Models & LLMs",
  code: "NEEDS_LLM",
};

const Body = z.object({
  video_url: z.string().min(1).max(4096),
  prompt: z.string().max(2000).optional(),
  seed: z.number().int().min(0).max(2147483647).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    const b = parsed.data;

    // owned /files media only - 404 for foreign/missing, 400 for externals
    const file = await resolveOwnedMedia(user.id, b.video_url);
    const dur = await probeDuration(file);
    if (!dur || dur > 60)
      return json({ error: `video→sfx supports clips up to 60 s${dur ? ` (got ${dur.toFixed(1)} s)` : ""}` }, 400);

    if (!await llmConfigured(user.id, "vision"))
      return json(NEEDS_LLM_BODY, 503);

    await applyDailyCredits(user.id);
    const job = await createJob(user.id, {
      endpointId: "motionfield/moss/video-sfx",
      params: {
        video_url: b.video_url,
        ...(b.prompt ? { prompt: b.prompt } : {}),
        ...(b.seed !== undefined ? { seed: b.seed } : {}),
      },
      idempotencyKey: req.headers.get("Idempotency-Key") ?? undefined,
    });
    return json({ job }, 201);
  } catch (e) {
    if (e instanceof RestrictedLicenseError) return json(e.body, e.status);
    return err(e);
  }
}
