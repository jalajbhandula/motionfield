import { NextRequest } from "next/server";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { json, err } from "@/lib/api";
import { getDb, schema } from "@/db";
import { gameView, gamesUser, readJson } from "@/lib/games/api";
import { GENRES } from "@/lib/games/spec";
import { writeGame } from "@/lib/games/writer";
import { LlmUnavailable } from "@/lib/llm/types";

export const runtime = "nodejs";

const createSchema = z.strictObject({
  prompt: z.string().trim().min(3).max(2000),
  genre: z.enum(GENRES).optional(),
});

/** GET /api/games - the caller's games, newest first (≤100). */
export async function GET(req: NextRequest) {
  try {
    const userId = await gamesUser(req);
    const db = await getDb();
    const rows = await db.select().from(schema.games)
      .where(eq(schema.games.userId, userId))
      .orderBy(desc(schema.games.updatedAt))
      .limit(100);
    return json({ games: rows.map((r: typeof schema.games.$inferSelect) => gameView(r, userId)) });
  } catch (e) {
    return err(e);
  }
}

/**
 * POST /api/games {prompt, genre?} - design a game and save it. With a local
 * model configured it designs the game; without one the keyword template
 * builds it and `via: "template"` says so.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await gamesUser(req);
    const body = createSchema.safeParse(await readJson(req));
    if (!body.success) return json({ error: "send {prompt: 3-2000 chars, genre?}" }, 400);
    let made;
    try {
      made = await writeGame(userId, body.data.prompt, { genre: body.data.genre, signal: req.signal });
    } catch (e) {
      if (e instanceof LlmUnavailable) return json({ error: `the local model couldn't design this game - ${e.message}`, code: "LLM_FAILED" }, 502);
      throw e;
    }
    const db = await getDb();
    const [row] = await db.insert(schema.games).values({
      userId, title: made.spec.title, prompt: body.data.prompt, spec: made.spec, via: made.via,
    }).returning();
    return json({ game: gameView(row, userId) }, 201);
  } catch (e) {
    return err(e);
  }
}
