import { sql, tx } from "@/db";
import type { StageScene } from "./scene";

/**
 * The shared stage-commit path: every scene write (PUT autosave, prompt,
 * ops, restore) funnels through commitSceneRevision, which in ONE
 * transaction -
 *   1. locks the scene row (FOR UPDATE) and checks base_revision
 *      (stale → {conflict, head}, nothing written),
 *   2. writes the new head (scene + title + revision+1),
 *   3. appends a stage_revisions row - or, for autosave PUTs carrying the
 *      editor's per-load session_id, slides that session's freshest 'save'
 *      row forward when it's under SAVE_SESSION_WINDOW_MS old,
 *   4. prunes history to the newest MAX_REVISIONS_PER_SCENE rows, head
 *      excluded from pruning so it can never drop out.
 */

export type RevisionSource = "create" | "save" | "prompt" | "ops" | "restore";
export const SAVE_SESSION_WINDOW_MS = 10 * 60 * 1000;
export const MAX_REVISIONS_PER_SCENE = 200;

export type CommitResult =
  | { ok: true; revision: number }
  | { ok: false; head: number };

export async function commitSceneRevision(
  sceneId: string,
  userId: string,
  input: {
    baseRevision: number;
    scene: StageScene;
    title?: string;
    source: RevisionSource;
    sessionId?: string | null;
  },
): Promise<CommitResult> {
  return tx(async (q) => {
    const rows = await q(
      `SELECT revision FROM stage_scenes WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [sceneId, userId],
    );
    const head = rows[0]?.revision as number | undefined;
    if (head === undefined) return { ok: false, head: -1 };
    if (head !== input.baseRevision) return { ok: false, head };

    const nextRev = head + 1;
    const title = input.title ?? input.scene.meta.title;
    await q(
      `UPDATE stage_scenes SET scene = $1, title = $2, revision = $3, updated_at = now() WHERE id = $4`,
      [JSON.stringify(input.scene), title, nextRev, sceneId],
    );

    let slid = false;
    if (input.source === "save" && input.sessionId) {
      const last = await q(
        `SELECT id, created_at FROM stage_revisions
         WHERE scene_id = $1 AND session_id = $2 AND source = 'save'
         ORDER BY created_at DESC LIMIT 1`,
        [sceneId, input.sessionId],
      );
      const row = last[0];
      if (row && Date.now() - new Date(row.created_at).getTime() < SAVE_SESSION_WINDOW_MS) {
        await q(
          `UPDATE stage_revisions SET scene = $1, revision = $2 WHERE id = $3`,
          [JSON.stringify(input.scene), nextRev, row.id],
        );
        slid = true;
      }
    }
    if (!slid) {
      await q(
        `INSERT INTO stage_revisions (scene_id, user_id, revision, source, session_id, scene)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sceneId, userId, nextRev, input.source, input.sessionId ?? null, JSON.stringify(input.scene)],
      );
    }

    // keep the head + newest 199 others - the head can never be pruned.
    // Ordered by revision, not created_at: slid session rows keep their
    // original created_at but their revision is current, so they sort right.
    await q(
      `DELETE FROM stage_revisions
       WHERE scene_id = $1 AND revision <> $2 AND id NOT IN (
         SELECT id FROM stage_revisions WHERE scene_id = $1 AND revision <> $2
         ORDER BY revision DESC LIMIT 199
       )`,
      [sceneId, nextRev],
    );
    return { ok: true, revision: nextRev };
  });
}

/** Record the create-time revision row (fresh scene row - no contention). */
export async function insertCreateRevision(sceneId: string, userId: string, scene: StageScene) {
  await sql(
    `INSERT INTO stage_revisions (scene_id, user_id, revision, source, session_id, scene)
     VALUES ($1, $2, 1, 'create', NULL, $3)`,
    [sceneId, userId, JSON.stringify(scene)],
  );
}

export interface RevisionListRow {
  revision: number;
  source: RevisionSource;
  title: string | null;
  node_count: number;
  created_at: string;
}

/** Newest-first revision list for a scene (≤100), title/node_count derived
 *  from the stored scene - never duplicated columns to drift. */
export async function listRevisions(sceneId: string): Promise<RevisionListRow[]> {
  return sql<RevisionListRow>(
    `SELECT revision, source,
            scene -> 'meta' ->> 'title'        AS title,
            jsonb_array_length(scene->'nodes') AS node_count,
            created_at
     FROM stage_revisions WHERE scene_id = $1
     ORDER BY revision DESC LIMIT 100`,
    [sceneId],
  );
}

export async function getRevisionScene(sceneId: string, revision: number) {
  const rows = await sql<{ scene: unknown; created_at: string; source: string }>(
    `SELECT scene, created_at, source FROM stage_revisions
     WHERE scene_id = $1 AND revision = $2 LIMIT 1`,
    [sceneId, revision],
  );
  return rows[0] ?? null;
}
