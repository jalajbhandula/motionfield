import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { createJob, applyDailyCredits } from "@/lib/jobs";
import { resolveOwnedMedia } from "@/lib/media-owned";
import { RestrictedLicenseError } from "@/lib/catalog/license-gate";
import { vfxPresetById } from "@/lib/catalog/presets/vfx-lab";

export const runtime = "nodejs";

/**
 * POST /api/vfx-lab/target - make an end keyframe for a plate: runs a real
 * FLUX.2-klein edit job (Apache-2.0 stack) that edits the plate's frame into
 * the effect's destination look. The returned job's image output is meant to
 * be fed back as `end_image_url` on a submit. `vfx_preset` may seed the
 * instruction from the preset's own target recipe; free text always wins.
 */
const Body = z.strictObject({
  image_url: z.string().min(1).max(4096),
  instruction: z.string().max(2000).optional(),
  vfx_preset: z.string().max(80).optional(),
  seed: z.number().int().min(0).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success)
      return json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    const b = parsed.data;
    await resolveOwnedMedia(user.id, b.image_url);
    const preset = b.vfx_preset ? vfxPresetById(b.vfx_preset) : undefined;
    const instruction = b.instruction ?? preset?.target?.instruction;
    if (!instruction)
      return json({ error: "instruction required - describe the frame the run should end on" }, 400);
    await applyDailyCredits(user.id);
    const job = await createJob(user.id, {
      endpointId: "motionfield/flux2-klein/edit",
      title: "VFX target frame",
      params: { image_url: b.image_url, prompt: instruction, seed: b.seed, steps: 4 },
    });
    return json({ job }, 201);
  } catch (e) {
    if (e instanceof RestrictedLicenseError) return json(e.body, e.status);
    return err(e);
  }
}
