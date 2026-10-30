import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { JobError } from "@/lib/jobs";
import { stageSceneSchema } from "@/lib/stage/scene";
import { stageApiUser, loadOwnScene, sceneIdSchema } from "@/lib/stage/api";
import { getRevisionScene } from "@/lib/stage/revisions";
import { inspectScene, INSPECT_VIEWS, type InspectView } from "@/lib/stage/inspect";

export const runtime = "nodejs";

const revSchema = z.coerce.number().int().min(1);

/**
 * GET /api/stage/:id/inspect?view=&t=&rev= - the read-only agent view of a
 * scene. `view` names the report: meta | tree | shots | physics | problems
 * (default tree). `t` is the numeric sample time (seconds) - the two are
 * separate params: earlier clients sent the view NAME as `t`, which is
 * still honoured as a compat alias. `rev` inspects a stored revision
 * instead of the head.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!sceneIdSchema.safeParse(id).success) throw new JobError("not found", 404);
    const auth = await stageApiUser(req);
    const row = await loadOwnScene(auth.userId, id);
    if (!row) throw new JobError("not found", 404);

    const url = new URL(req.url);
    const revParam = url.searchParams.get("rev");
    let sceneJson: unknown = row.scene;
    if (revParam !== null) {
      if (!revSchema.safeParse(revParam).success) throw new JobError("invalid rev", 400);
      const revRow = await getRevisionScene(id, Number(revParam));
      if (!revRow) throw new JobError("revision not found", 404);
      sceneJson = revRow.scene;
    }
    let scene;
    try { scene = stageSceneSchema.parse(sceneJson); }
    catch { throw new JobError("stored scene is invalid", 500); }

    const viewRaw = url.searchParams.get("view");
    const tRaw = url.searchParams.get("t");
    // canonical: ?view=<name>. Compat: old sdk/mcp/cli sent the view name
    // as ?t=<name> - a non-numeric t that names a view still routes there;
    // anything else that isn't a number is an explicit invalid-view error.
    let view: InspectView = "tree";
    const viewGuess = viewRaw ?? (tRaw !== null && !Number.isFinite(Number(tRaw)) ? tRaw : null);
    if (viewGuess !== null) {
      if (!(INSPECT_VIEWS as readonly string[]).includes(viewGuess))
        throw new JobError(`view must be one of ${INSPECT_VIEWS.join("|")}`, 400);
      view = viewGuess as InspectView;
    }
    const rawT = Number(tRaw ?? 0);
    const t = Number.isFinite(rawT) ? Math.min(Math.max(rawT, 0), scene.meta.duration) : 0;
    return json(inspectScene(scene, t, view));
  } catch (e) {
    return err(e);
  }
}
