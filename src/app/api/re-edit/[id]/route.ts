import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { cancelChain, getChain } from "@/lib/re-edit";

export const runtime = "nodejs";

const Id = z.string().uuid();

/** GET /api/re-edit/[id] - chain status + jobs (live jobs get an opportunistic tick). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    if (!Id.safeParse(id).success) return json({ error: "not found" }, 404);
    const out = await getChain(user.id, id);
    if (!out) return json({ error: "not found" }, 404);
    // public job shape - the raw row also carries user_id, params and
    // provider ids the chain API doesn't expose
    const jobs = out.jobs.map((j) =>
      ({ id: j.id, status: j.status, progress: j.progress, error: j.error, created_at: j.created_at ?? null }));
    return json({ chain: out.chain, jobs, shot_status: out.shotStatus });
  } catch (e) {
    return err(e);
  }
}

/** DELETE /api/re-edit/[id] - cancel a live chain; a finished one is a 409. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    if (!Id.safeParse(id).success) return json({ error: "not found" }, 404);
    const chain = await cancelChain(user.id, id);
    if (!chain) return json({ error: "not found" }, 404);
    return json({ chain });
  } catch (e) {
    return err(e);
  }
}
