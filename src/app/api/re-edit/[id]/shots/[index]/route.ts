import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { applyDailyCredits } from "@/lib/jobs";
import { regenerateShot, publicJob } from "@/lib/re-edit";

export const runtime = "nodejs";

/**
 * POST /api/re-edit/[id]/shots/[index] - regenerate one shot's windows and
 * re-assemble. One claim wins: a second POST while a run is live gets 409.
 */
const Body = z.object({ hint: z.string().max(500).optional() });
const Id = z.string().uuid();

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; index: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    await applyDailyCredits(user.id);
    const { id, index } = await params;
    if (!Id.safeParse(id).success) return json({ error: "not found" }, 404);
    const shotIndex = Number(index);
    if (!Number.isInteger(shotIndex) || shotIndex < 0) return json({ error: "bad shot index" }, 400);
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    const { chain, job } = await regenerateShot(user.id, id, shotIndex, parsed.data.hint);
    return json({ chain, job: publicJob(job) }, 201);
  } catch (e) {
    return err(e);
  }
}
