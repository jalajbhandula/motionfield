import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { readCappedText } from "@/lib/render/body";
import { assertSceneFits, MAX_SCENE_BYTES, parseStageScene } from "@/lib/stage/scene";
import { unownedModelSrcs } from "@/lib/stage/refs";
import { stageApiUser, loadOwnScene, sceneIdSchema } from "@/lib/stage/api";
import { commitSceneRevision } from "@/lib/stage/revisions";
import { JobError } from "@/lib/jobs";

export const runtime = "nodejs";

const MAX_BODY = MAX_SCENE_BYTES + 4 * 1024; // 256 KB scene + envelope/headroom

const putSchema = z.strictObject({
  base_revision: z.number().int().min(1),
  scene: z.unknown().optional(),
  title: z.string().min(1).max(120).optional(),
  /** the editor's per-load id - saves from one session collapse into one
   *  'save' revision row (see commitSceneRevision) */
  session_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
});

/** GET /api/stage/:id - the owner's scene row. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await stageApiUser(req);
    const { id } = await ctx.params;
    if (!sceneIdSchema.safeParse(id).success) return json({ error: "not found" }, 404);
    const row = await loadOwnScene(userId, id);
    if (!row) return json({ error: "not found" }, 404);
    return json({
      id: row.id, title: row.title, scene: row.scene, refs: row.refs,
      refs_read: row.refsRead,
      revision: row.revision, created_at: row.createdAt, updated_at: row.updatedAt,
    });
  } catch (e) {
    return err(e);
  }
}

/** PUT /api/stage/:id - save scene/title with optimistic concurrency.
 *  A stale base_revision answers 409 + the head revision, never a clobber.
 *  Every save lands through commitSceneRevision - the shared transaction
 *  that also writes the revision-history row. */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await stageApiUser(req);
    const { id } = await ctx.params;
    if (!sceneIdSchema.safeParse(id).success) return json({ error: "not found" }, 404);

    let text: string;
    try {
      text = await readCappedText(req, MAX_BODY);
    } catch (e) {
      if (e instanceof JobError && e.status === 413) return json({ error: `body too large (max ${MAX_BODY / 1024} KB)` }, 413);
      throw e;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    const body = putSchema.safeParse(raw);
    if (!body.success) return json({ error: body.error.issues[0]?.message ?? "bad body" }, 400);
    if (!body.data.scene && !body.data.title) {
      return json({ error: "nothing to save - pass scene and/or title" }, 400);
    }

    let scene;
    if (body.data.scene !== undefined) {
      try {
        scene = parseStageScene(body.data.scene);
        assertSceneFits(scene);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }

    const row = await loadOwnScene(userId, id);
    if (!row) return json({ error: "not found" }, 404);
    if (scene) {
      // model nodes may only reference the caller's own /files/….glb
      const unowned = await unownedModelSrcs(scene, userId);
      if (unowned.length) {
        return json({ error: `model src isn't one of your files: ${unowned[0]}` }, 404);
      }
    }
    if (row.revision !== body.data.base_revision) {
      return json({ error: "scene changed on the server - reload to continue", head_revision: row.revision }, 409);
    }

    // a title-only PUT must rename inside the stored scene too - the editor
    // reads scene.meta.title, so row.title alone would revert on next save
    let nextScene = scene;
    if (body.data.title !== undefined && !nextScene) {
      try {
        nextScene = parseStageScene(row.scene);
      } catch {
        return json({ error: "stored scene is invalid" }, 500);
      }
    }
    if (body.data.title !== undefined && nextScene) {
      nextScene.meta.title = body.data.title;
    }
    if (!nextScene) return json({ error: "nothing to save" }, 400);

    // scene saves carry meta.title - the row title follows it so My Scenes
    // never shows a stale name; an explicit title param still wins
    const title = body.data.title ?? scene?.meta.title ?? row.title;
    const commit = await commitSceneRevision(id, userId, {
      baseRevision: body.data.base_revision,
      scene: nextScene,
      title,
      source: "save",
      sessionId: body.data.session_id ?? null,
    });
    if (!commit.ok) {
      if (commit.head === -1) return json({ error: "not found" }, 404); // vanished mid-request
      // a concurrent save landed between the pre-check and the row lock
      return json({ error: "scene changed on the server - reload to continue", head_revision: commit.head }, 409);
    }
    return json({ id, revision: commit.revision });
  } catch (e) {
    return err(e);
  }
}

/** DELETE /api/stage/:id - owner-only. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await stageApiUser(req);
    const { id } = await ctx.params;
    if (!sceneIdSchema.safeParse(id).success) return json({ error: "not found" }, 404);
    const row = await loadOwnScene(userId, id);
    if (!row) return json({ error: "not found" }, 404);
    const db = await getDb();
    await db.delete(schema.stageScenes).where(eq(schema.stageScenes.id, id));
    return json({ ok: true });
  } catch (e) {
    return err(e);
  }
}
