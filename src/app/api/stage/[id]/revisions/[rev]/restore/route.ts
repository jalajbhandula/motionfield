import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { JobError } from "@/lib/jobs";
import { readCappedText } from "@/lib/render/body";
import { stageSceneSchema } from "@/lib/stage/scene";
import { stageApiUser, loadOwnScene, sceneIdSchema } from "@/lib/stage/api";
import { commitSceneRevision, getRevisionScene } from "@/lib/stage/revisions";

export const runtime = "nodejs";

const revSchema = z.coerce.number().int().min(1);
const RestoreBody = z.strictObject({ base_revision: z.number().int().min(1) });

/**
 * POST /api/stage/:id/revisions/:rev/restore {base_revision} - copy the
 * historical scene onto a NEW head (head+1, source 'restore'). History is
 * append-only: the restored-from row and everything around it stay intact.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; rev: string }> }) {
  try {
    const { id, rev } = await ctx.params;
    if (!sceneIdSchema.safeParse(id).success || !revSchema.safeParse(rev).success) {
      throw new JobError("not found", 404);
    }
    const auth = await stageApiUser(req);
    const parsed = RestoreBody.safeParse(
      JSON.parse(await readCappedText(req, 8 * 1024)),
    );
    if (!parsed.success) {
      throw new JobError("invalid body - expected { base_revision }", 400);
    }

    const row = await loadOwnScene(auth.userId, id);
    if (!row) throw new JobError("not found", 404);
    const revRow = await getRevisionScene(id, Number(rev));
    if (!revRow) throw new JobError("not found", 404);
    let scene;
    try { scene = stageSceneSchema.parse(revRow.scene); }
    catch { throw new JobError("stored revision is invalid", 500); }

    const commit = await commitSceneRevision(id, auth.userId, {
      baseRevision: parsed.data.base_revision,
      scene,
      source: "restore",
    });
    if (!commit.ok) {
      if (commit.head === -1) return json({ error: "not found" }, 404); // vanished mid-request
      return json({ error: "stale base_revision", head_revision: commit.head }, 409);
    }
    return json({ revision: commit.revision, scene });
  } catch (e) {
    if (e instanceof SyntaxError) return err(new JobError("invalid JSON body", 400));
    return err(e);
  }
}
