import { NextRequest } from "next/server";
import { z } from "zod";
import { requireApiUser } from "@/lib/api";
import { verifyApiKey } from "@/lib/api/apikeys";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { JobError } from "@/lib/jobs";

/**
 * Shared plumbing for the /api/stage routes: caller auth (session cookie OR
 * an `of_` Bearer API key), route-param validation, and the owner-only scene
 * lookup every handler funnels through (a foreign row reads 404, never a
 * leak).
 */

export interface StageAuth {
  userId: string;
  /** "session" | "key" - informational only, never surfaced */
  via: "session" | "key";
}

/** Session cookie via requireApiUser, or `Authorization: Bearer of_…` against
 *  api_keys. A malformed/foreign bearer token 401s outright - no silent
 *  fallback to a session that might belong to someone else. */
export async function stageApiUser(req: NextRequest): Promise<StageAuth> {
  const authz = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authz.trim());
  if (m && m[1].startsWith("of_")) {
    const key = await verifyApiKey(m[1]);
    if (!key) throw new JobError("unauthorized", 401);
    return { userId: key.userId, via: "key" };
  }
  const ctx = await requireApiUser(req); // throws JobError 401 when logged out
  return { userId: ctx.user.id, via: "session" };
}

export const sceneIdSchema = z.uuid();

/** The owner's scene row, or null when missing/foreign - callers 404. */
export async function loadOwnScene(userId: string, id: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.stageScenes)
    .where(eq(schema.stageScenes.id, id)).limit(1);
  if (!row || row.userId !== userId) return null;
  return row;
}
