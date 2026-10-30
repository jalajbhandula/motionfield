import type { Word } from "./types";

const MIN_WORD = 0.12; // seconds - no word ever reads faster than this
const PAUSE_WEIGHT = 3; // punctuation pause, in word-length units

/** Keep ASR offsets inside the media; do not invent timing for words after EOF. */
export function wordsWithinDuration(words: Word[], duration: number): Word[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  return words.flatMap((word) => {
    const start = Math.max(0, word.start);
    const end = Math.min(duration, word.end);
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      ? [{ ...word, start, end }]
      : [];
  });
}

/**
 * Estimate word timestamps when there is no ASR: split `text` on whitespace,
 * spread words over `duration` weighted by character length, add a pause after
 * sentence punctuation, and clamp every word to ≥ MIN_WORD. Deterministic and
 * clearly flagged `estimated` - callers must not present these as real ASR.
 */
export function wordsFromScript(text: string, duration: number): { words: Word[]; estimated: true } {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length || !(duration > 0)) return { words: [], estimated: true };

  const pauseAfter = (tok: string) => /[,;:.!?]["'”’)]?$/.test(tok);
  // weight units: word length + a pause weight after sentence punctuation
  const units = tokens.map((t) => ({ len: Math.max(1, t.length), pause: pauseAfter(t) ? PAUSE_WEIGHT : 0 }));
  const totalUnits = units.reduce((a, u) => a + u.len + u.pause, 0);
  const secPerUnit = duration / totalUnits;

  const words: Word[] = [];
  let t = 0;
  for (let i = 0; i < tokens.length; i++) {
    const start = Math.min(t, duration);
    const end = start + Math.max(MIN_WORD, units[i].len * secPerUnit);
    // words may overflow `duration` when there is too much text - a cue past
    // the clip end simply never displays; a zero-length word would be invalid
    words.push({ text: tokens[i], start, end });
    t = end + units[i].pause * secPerUnit;
  }
  return { words, estimated: true };
}
