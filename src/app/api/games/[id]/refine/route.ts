import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { gameView, gamesUser, loadOwnGame, readJson, saveSpec } from "@/lib/games/api";
import { gameWriterReady, refineGame } from "@/lib/games/writer";
import { LlmUnavailable } from "@/lib/llm/types";

export const runtime = "nodejs";

const bodySchema = z.strictObject({ instruction: z.string().trim().min(2).max(600) });

/** POST /api/games/<id>/refine {instruction} - change the game in words.
 *  Needs a local model: 503 NEEDS_LLM before any work otherwise. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await gamesUser(req);
    const { id } = await params;
    const row = await loadOwnGame(userId, id);
    if (!row) return json({ error: "not found" }, 404);
    if (!(await gameWriterReady(userId))) {
      return json({ error: "no local model configured - add one in Settings → Models & LLMs, or edit the game with the controls", code: "NEEDS_LLM" }, 503);
    }
    const body = bodySchema.safeParse(await readJson(req));
    if (!body.success) return json({ error: "send {instruction: 2-600 chars}" }, 400);
    const current = gameView(row, userId).spec;
    if (!current) return json({ error: "stored game is unreadable" }, 409);
    let spec;
    try {
      spec = await refineGame(userId, current, body.data.instruction, req.signal);
    } catch (e) {
      if (e instanceof LlmUnavailable) return json({ error: `the local model couldn't apply that - ${e.message}`, code: "LLM_FAILED" }, 502);
      throw e;
    }
    const saved = await saveSpec(userId, id, spec);
    if (!saved) return json({ error: "not found" }, 404);
    return json({ game: gameView(saved, userId) });
  } catch (e) {
    return err(e);
  }
}
