import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { createJob, applyDailyCredits } from "@/lib/jobs";
import { findEndpoint } from "@/lib/catalog/video-models";
import { MOTION_RENDER_ENDPOINT } from "@/lib/catalog/code/motion";
import { filesPathSchema } from "@/lib/render/spec";

export const runtime = "nodejs";

const MOTION_ENDPOINT = MOTION_RENDER_ENDPOINT;

const bodySchema = z.strictObject({
  values: z.record(z.string(), z.number().finite()).optional(),
  // overlay mode: a "/files/…" video the user owns - validated for shape
  // here, for ownership inside the recipe (it knows the job's user)
  source: filesPathSchema.optional(),
});

/**
 * POST /api/render/motion/:id/render - create a render job for a stored spec.
 * Gated on the motion catalog entry actually being registered: while
 * src/lib/catalog/code/motion.ts isn't wired into ALL_MODELS this returns
 * 503 and the UI keeps the button hidden.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await ctx.params;
    if (!z.uuid().safeParse(id).success) return json({ error: "not found" }, 404);
    const parsed = bodySchema.safeParse((await req.json().catch(() => null)) ?? {});
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "bad body" }, 400);

    const db = await getDb();
    const [row] = await db.select({ userId: schema.renderSpecs.userId })
      .from(schema.renderSpecs).where(eq(schema.renderSpecs.id, id)).limit(1);
    if (!row || row.userId !== user.id) return json({ error: "not found" }, 404);

    if (!findEndpoint(MOTION_ENDPOINT)) {
      return json({ error: "motion render isn't configured in the catalog yet" }, 503);
    }
    await applyDailyCredits(user.id);
    const job = await createJob(user.id, {
      endpointId: MOTION_ENDPOINT,
      params: { spec_id: id, values: parsed.data.values, source: parsed.data.source },
    });
    return json({ job_id: job.id }, 201);
  } catch (e) {
    return err(e);
  }
}
