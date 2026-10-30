import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { JobError } from "@/lib/jobs";
import { stageApiUser, loadOwnScene, sceneIdSchema } from "@/lib/stage/api";
import { listRevisions } from "@/lib/stage/revisions";

export const runtime = "nodejs";

/** GET /api/stage/:id/revisions - newest-first, ≤100 entries. Each carries
 *  {revision, source, title, node_count, created_at}; the full scene only
 *  ships on the single-revision GET. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!sceneIdSchema.safeParse(id).success) throw new JobError("not found", 404);
    const auth = await stageApiUser(req);
    const row = await loadOwnScene(auth.userId, id);
    if (!row) throw new JobError("not found", 404);
    return json({ revisions: await listRevisions(id) });
  } catch (e) {
    return err(e);
  }
}
