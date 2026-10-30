import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { chat } from "@/lib/llm/index";
import { llmConfigured } from "@/lib/llm/router";
import { stripThink } from "@/lib/llm/types";

export const runtime = "nodejs";

/**
 * POST /api/director/enhance - the Director composer's prompt rewriter.
 * The user's scene text goes through the routed "enhancer" task (local
 * Ollama by default when configured, whatever the user picked in Settings
 * otherwise) and comes back as one director-style shot description. The
 * client shows it for acceptance - the original prompt is only replaced
 * when the user takes it, never silently.
 *
 * 503 NEEDS_LLM when no enhancer route is configured - same envelope
 * /api/audio-mix/video-sfx uses for its vision dependency.
 */
const NEEDS_LLM_BODY = {
  error: "Enhance needs a model - Settings → Models & LLMs (enhancer task)",
  code: "NEEDS_LLM",
};

const Body = z.object({
  prompt: z.string().min(1).max(2000),
  /** the resolved move stack, when one is picked - the rewrite may describe
   *  the camera move but must never contradict it */
  moves: z.string().max(200).optional(),
});

const SYSTEM =
  "You are a cinematography prompt enhancer for a text-to-video director tool. " +
  "Rewrite the user's scene description into a single vivid shot prompt: subject, action, " +
  "setting, lighting, mood - concrete visual details only, ≤60 words, no camera jargon " +
  "unless the user's moves list names one (then honour it exactly, never invent a different move). " +
  "Output ONLY the rewritten prompt - no preamble, no quotes, no alternatives.";

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    const b = parsed.data;

    if (!await llmConfigured(user.id, "enhancer")) return json(NEEDS_LLM_BODY, 503);

    const res = await chat("enhancer", {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: b.moves ? `Scene: ${b.prompt}\nMoves: ${b.moves}` : b.prompt },
      ],
      think: false,
      maxTokens: 200,
    }, { userId: user.id });

    const text = stripThink(res.text).slice(0, 2000).trim();
    if (!text) return json({ error: "the enhancer returned nothing usable" }, 502);
    return json({ prompt: text });
  } catch (e) {
    return err(e);
  }
}
