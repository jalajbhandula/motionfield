import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { JobError } from "@/lib/jobs";
import { stageApiUser, loadOwnScene, sceneIdSchema } from "@/lib/stage/api";
import { getRevisionScene } from "@/lib/stage/revisions";

export const runtime = "nodejs";

const revSchema = z.coerce.number().int().min(1);

/** GET /api/stage/:id/revisions/:rev - the full stored scene, read-only.
 *  Never mutates the head; restores go through the restore route. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; rev: string }> }) {
  try {
    const { id, rev } = await ctx.params;
    if (!sceneIdSchema.safeParse(id).success || !revSchema.safeParse(rev).success) {
      throw new JobError("not found", 404);
    }
    const auth = await stageApiUser(req);
    const row = await loadOwnScene(auth.userId, id);
    if (!row) throw new JobError("not found", 404);
    const revRow = await getRevisionScene(id, Number(rev));
    if (!revRow) throw new JobError("not found", 404);
    return json({
      revision: Number(rev),
      source: revRow.source,
      scene: revRow.scene,
      created_at: revRow.created_at,
    });
  } catch (e) {
    return err(e);
  }
}
