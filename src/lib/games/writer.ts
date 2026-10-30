import crypto from "crypto";
import { chatJson } from "@/lib/llm/index";
import { writerReady } from "@/lib/render/generate";
import {
  BEHAVIORS, ENEMY_LOOKS, GENRES, GOALS, PICKUP_LOOKS, PLAYER_LOOKS, THEMES,
  buildGameSpec, draftOf, gameDraftSchema, type GameDraft, type GameSpec, type Genre,
} from "./spec";
import { templateDraft } from "./templates";

/**
 * Prompt → GameSpec. With a writer route (a local model in Settings or
 * LLM_* env) the model designs the game; without one the keyword template
 * stands in and `via` says so. Thinking stays off: the reply is one JSON
 * object and a local model's reasoning only adds latency.
 */

export type GameVia = "llm" | "template";

const SYSTEM = `You design small browser games. Reply with ONE JSON object and nothing else.
Fields:
- genre: one of ${GENRES.join(", ")}
- title (≤48 chars), tagline (≤90 chars)
- story: { intro (≤240), win (≤120), lose (≤120) } - short, playful, second person
- theme: one of ${THEMES.join(", ")} (the background world)
- palette: { sky, ground, player, enemy, pickup, accent } - "#rrggbb" colours; the player, enemies and pickups must stand out from sky and ground
- player: { name (≤24), look: one of ${PLAYER_LOOKS.join(", ")}, speed 1-10, jump 1-10, lives 1-5 }
- enemies: 1-3 of { name (≤24), look: one of ${ENEMY_LOOKS.join(", ")}, behavior: one of ${BEHAVIORS.join(", ")}, speed 1-10 }
- pickup: { name (≤24), look: one of ${PICKUP_LOOKS.join(", ")} }
- goal: { kind: one of ${GOALS.join(", ")}, target 1-500 } - reach_end: finish the level; score: points; survive: seconds; collect: items
- difficulty 1-5, length 1-5
Pick the genre that best fits the idea: platformer (jump between ledges), runner (auto-run, jump obstacles), shooter (fly and fire at waves), adventure (top-down, collect items, avoid guardians), puzzle (match-3 tiles), racer (top-down road, dodge traffic).
Name characters and items after the idea. Keep it fun and fair.`;

function genreHint(genre?: Genre) {
  return genre ? `\nThe genre must be "${genre}".` : "";
}

export async function gameWriterReady(userId?: string): Promise<boolean> {
  return writerReady(userId).catch(() => false);
}

async function llmDraft(userId: string, user: string, signal?: AbortSignal): Promise<GameDraft> {
  const r = await chatJson("writer", gameDraftSchema, {
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
    temperature: 0.8,
    think: false,
    timeoutMs: 120_000,
    signal,
  }, { userId });
  return r.data;
}

/** New game from a prompt. Falls back to the template only when no writer
 *  route exists - a configured model that fails surfaces its error. */
export async function writeGame(
  userId: string, prompt: string, opts: { genre?: Genre; signal?: AbortSignal } = {},
): Promise<{ spec: GameSpec; via: GameVia }> {
  const seed = crypto.randomInt(0, 0x100000000);
  if (!(await gameWriterReady(userId))) {
    return { spec: buildGameSpec(templateDraft(prompt, opts.genre), seed), via: "template" };
  }
  const draft = await llmDraft(userId, `Game idea: ${prompt}${genreHint(opts.genre)}`, opts.signal);
  if (opts.genre) draft.genre = opts.genre;
  return { spec: buildGameSpec(draft, seed), via: "llm" };
}

/** Change an existing game with one sentence ("make it night", "add a boss
 *  that shoots"). Needs a writer route - callers gate on gameWriterReady. */
export async function refineGame(
  userId: string, spec: GameSpec, instruction: string, signal?: AbortSignal,
): Promise<GameSpec> {
  const user = `Current game JSON:\n${JSON.stringify(draftOf(spec))}\n\nChange it: ${instruction}\nKeep everything the change doesn't touch. Reply with the full updated JSON object.`;
  const draft = await llmDraft(userId, user, signal);
  return buildGameSpec(draft, spec.seed);
}
