import { NextRequest } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { apiUser } from "@/lib/api";
import { getDb, schema } from "@/db";
import { JobError } from "@/lib/jobs";
import { readCappedText } from "@/lib/render/body";
import { stageApiUser } from "@/lib/stage/api";
import { gameSpecSchema, type GameSpec } from "./spec";

/**
 * Shared plumbing for /api/games: caller auth (session or `of_` API key, the
 * same rule as /api/stage), id validation, owner-only and owner-or-public
 * lookups (a foreign private row reads 404, never a leak), and the one JSON
 * view every route returns.
 */

export const gameIdSchema = z.uuid();
export const MAX_BODY = 32 * 1024;

export async function gamesUser(req: NextRequest): Promise<string> {
  return (await stageApiUser(req)).userId;
}

/** Signed-in user id or null - public share links work logged out. */
export async function gamesViewer(req: NextRequest): Promise<string | null> {
  const ctx = await apiUser(req).catch(() => null);
  return ctx?.user.id ?? null;
}

export async function readJson(req: NextRequest): Promise<unknown> {
  const text = await readCappedText(req, MAX_BODY);
  try { return JSON.parse(text); } catch { throw new JobError("invalid JSON body", 400); }
}

type GameRow = typeof schema.games.$inferSelect;

export function gameView(r: GameRow, viewerId: string | null) {
  const parsed = gameSpecSchema.safeParse(r.spec);
  return {
    id: r.id,
    title: r.title,
    prompt: r.userId === viewerId ? r.prompt : undefined,
    spec: parsed.success ? parsed.data : null,
    via: r.via,
    public: r.isPublic,
    mine: r.userId === viewerId,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

export async function loadOwnGame(userId: string, id: string): Promise<GameRow | null> {
  if (!gameIdSchema.safeParse(id).success) return null;
  const db = await getDb();
  const [r] = await db.select().from(schema.games)
    .where(and(eq(schema.games.id, id), eq(schema.games.userId, userId))).limit(1);
  return r ?? null;
}

/** The owner's row, or anyone's public row. */
export async function loadVisibleGame(viewerId: string | null, id: string): Promise<GameRow | null> {
  if (!gameIdSchema.safeParse(id).success) return null;
  const db = await getDb();
  const [r] = await db.select().from(schema.games).where(eq(schema.games.id, id)).limit(1);
  if (!r) return null;
  return r.isPublic || r.userId === viewerId ? r : null;
}

export async function saveSpec(userId: string, id: string, spec: GameSpec, extra: { isPublic?: boolean } = {}) {
  const db = await getDb();
  const [r] = await db.update(schema.games)
    .set({ spec, title: spec.title, updatedAt: new Date(), ...(extra.isPublic === undefined ? {} : { isPublic: extra.isPublic }) })
    .where(and(eq(schema.games.id, id), eq(schema.games.userId, userId)))
    .returning();
  return r ?? null;
}
