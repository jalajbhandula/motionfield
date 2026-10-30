import crypto from "crypto";
import { sql } from "@/db";

/**
 * Idempotency-Key handling for POST /api/stage/:id/ops.
 * Keys are scoped per user: (user_id, key) is unique, 24 h expiry (swept
 * lazily on every keyed request). Replays are exact - same key + same scene
 * + same body returns the stored response with no new revision; a key
 * reused against a different scene or body is a 422 mismatch, not a replay.
 */

export const OP_IDEM_KEY = /^[A-Za-z0-9_-]{1,128}$/;
export const OP_IDEM_TTL_MS = 24 * 60 * 60 * 1000;

export const isValidOpKey = (k: string) => OP_IDEM_KEY.test(k);
export const hashOpBody = (rawBody: string) =>
  crypto.createHash("sha256").update(rawBody, "utf8").digest("hex");

export interface OpKeyRow {
  id: string;
  user_id: string;
  scene_id: string;
  body_hash: string;
  status: number;
  response: unknown;
  created_at: string | Date;
}

export type IdemVerdict = "fresh" | "replay" | "mismatch";

/** pure verdict - the row was already scoped to this user by the query. */
export function decideOpReplay(
  stored: Pick<OpKeyRow, "scene_id" | "body_hash"> | null | undefined,
  sceneId: string,
  bodyHash: string,
): IdemVerdict {
  if (!stored) return "fresh";
  if (stored.scene_id !== sceneId) return "mismatch"; // same key, another scene
  return stored.body_hash === bodyHash ? "replay" : "mismatch";
}

/** freshest live key row for (user, key); sweeps expired rows first. */
export async function lookupOpKey(userId: string, key: string): Promise<OpKeyRow | null> {
  await sql(`DELETE FROM stage_op_keys WHERE created_at < now() - interval '24 hours'`);
  const rows = await sql<OpKeyRow>(
    `SELECT id, user_id, scene_id, body_hash, status, response, created_at
     FROM stage_op_keys WHERE user_id = $1 AND key = $2
       AND created_at >= now() - interval '24 hours'
     LIMIT 1`,
    [userId, key],
  );
  return rows[0] ?? null;
}

/** Persist a response under the key. A racing same-key insert loses to the
 *  unique (user_id, key) index - we return the winner's row so the caller
 *  can replay or 422 it, never double-apply. */
export async function storeOpKey(
  userId: string,
  key: string,
  sceneId: string,
  bodyHash: string,
  status: number,
  response: unknown,
): Promise<{ stored: true } | { raced: OpKeyRow | null }> {
  try {
    await sql(
      `INSERT INTO stage_op_keys (user_id, key, scene_id, body_hash, status, response)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, key, sceneId, bodyHash, status, JSON.stringify(response)],
    );
    return { stored: true };
  } catch (e) {
    if (String((e as { code?: string }).code ?? "") === "23505") {
      return { raced: await lookupOpKey(userId, key) };
    }
    throw e;
  }
}
