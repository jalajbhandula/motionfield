import { NextRequest } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { json, err } from "@/lib/api";
import { getDb, schema } from "@/db";
import { gameView, gamesUser, gamesViewer, loadOwnGame, loadVisibleGame, readJson, saveSpec } from "@/lib/games/api";
import { buildGameSpec, gameDraftSchema } from "@/lib/games/spec";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.strictObject({
  /** the full edited draft (the seed stays the game's own) */
  draft: gameDraftSchema.optional(),
  public: z.boolean().optional(),
  /** re-roll the level layout */
  reseed: z.literal(true).optional(),
}).refine((b) => b.draft || b.public !== undefined || b.reseed, { message: "nothing to change" });

/** GET /api/games/<id> - owner, or anyone when shared. */
export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const viewer = await gamesViewer(req);
    const row = await loadVisibleGame(viewer, id);
    if (!row) return json({ error: "not found" }, 404);
    return json({ game: gameView(row, viewer) });
  } catch (e) {
    return err(e);
  }
}

/** PATCH /api/games/<id> {draft?, public?, reseed?} - owner only. */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const userId = await gamesUser(req);
    const { id } = await params;
    const row = await loadOwnGame(userId, id);
    if (!row) return json({ error: "not found" }, 404);
    const body = patchSchema.safeParse(await readJson(req));
    if (!body.success) return json({ error: body.error.issues[0]?.message ?? "invalid body" }, 400);
    const current = gameView(row, userId).spec;
    if (!current) return json({ error: "stored game is unreadable" }, 409);
    const seed = body.data.reseed ? Math.floor(Math.random() * 0x100000000) : current.seed;
    const spec = buildGameSpec(body.data.draft ?? current, seed);
    const saved = await saveSpec(userId, id, spec, { isPublic: body.data.public });
    if (!saved) return json({ error: "not found" }, 404);
    return json({ game: gameView(saved, userId) });
  } catch (e) {
    return err(e);
  }
}

/** DELETE /api/games/<id> - owner only. */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const userId = await gamesUser(req);
    const { id } = await params;
    if (!(await loadOwnGame(userId, id))) return json({ error: "not found" }, 404);
    const db = await getDb();
    await db.delete(schema.games).where(and(eq(schema.games.id, id), eq(schema.games.userId, userId)));
    return json({ ok: true });
  } catch (e) {
    return err(e);
  }
}
