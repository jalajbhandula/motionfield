/** Sound-effect cue schema - the shape the vision route must return for
 *  video→sfx. The model's output is parsed by chatJson's repair pass, then
 *  sanitizeCues drops anything out of bounds rather than trusting the wire. */
import { z } from "zod";

/** one cue: [t_start, t_end) window + the foley prompt. Max 30 s per cue -
 *  MOSS tops out at 30; longer windows are split downstream anyway. */
export const sfxCueSchema = z.strictObject({
  t_start: z.number().min(0),
  t_end: z.number().min(0),
  prompt: z.string().min(1).max(300),
});
export type SfxCue = z.infer<typeof sfxCueSchema>;

/** the LLM envelope - lenient on purpose: rows arrive as unknown and are
 *  each safeParsed against the strict cue schema, so one malformed row (or
 *  an extra key the model invented) drops that row alone instead of failing
 *  the whole plan. The 64-row cap just bounds the scan. */
export const sfxCuesEnvelopeSchema = z.object({
  cues: z.array(z.unknown()).max(64),
});

/** Prompt the vision model answers to - frames arrive as image parts in
 *  time order, each introduced by a text part naming its timestamp. */
export const VIDEO_SFX_SYSTEM_PROMPT =
  "You are a foley cue planner. You receive video frames in time order, " +
  "each introduced by its timestamp in seconds. Reply with ONLY a JSON " +
  "object {\"cues\": [{\"t_start\": <sec>, \"t_end\": <sec>, \"prompt\": " +
  "\"sound-effect description\"}]} - up to 12 cues covering the audible " +
  "moments (impacts, ambience, movement, machines). Each cue 0.2-10 s long, " +
  "times inside the video duration, prompts concrete and under 60 words. " +
  "No dialogue, no music, no commentary, no markdown.";

/**
 * Keep only cues the video can actually use: inside [0,duration), end after
 * start, ≥0.2 s, ≤30 s, first 12 win. A cue whose end runs past the clip is
 * clamped to the duration; anything still out of bounds is dropped - never
 * evaluated.
 */
export function sanitizeCues(raw: SfxCue[], durationSec: number): SfxCue[] {
  const out: SfxCue[] = [];
  for (const c of raw) {
    if (!Number.isFinite(c.t_start) || !Number.isFinite(c.t_end)) continue;
    if (c.t_start < 0 || c.t_end <= c.t_start) continue;
    if (c.t_start >= durationSec) continue;
    if (!c.prompt.trim() || c.prompt.length > 300) continue;
    const end = Math.min(c.t_end, durationSec);
    const len = end - c.t_start;
    if (len < 0.2 || len > 30) continue;
    out.push({ t_start: c.t_start, t_end: end, prompt: c.prompt });
    if (out.length >= 12) break;
  }
  return out;
}
