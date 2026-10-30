import type { Cue, GroupOptions, Word } from "./types";

/**
 * Group consecutive words into cues:
 *  - a cue holds ≤ lines×maxChars characters
 *  - a cue never runs longer than maxCue seconds
 *  - a silence gap > breakGap forces a break
 * The renderer's overlay groups the same way - keep the two in sync.
 */
export function toCues(words: Word[], opts: GroupOptions = {}): Cue[] {
  const maxChars = opts.maxChars ?? 32;
  const maxLines = opts.lines ?? 2;
  const maxCue = opts.maxCue ?? 3.5;
  const breakGap = opts.breakGap ?? 0.35;
  const cap = maxChars * maxLines;

  const cues: Cue[] = [];
  let cur: Word[] = [];
  let chars = 0;
  const flush = () => {
    if (!cur.length) return;
    cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    cur = [];
    chars = 0;
  };
  for (const w of words) {
    const add = w.text.length + (cur.length ? 1 : 0);
    if (cur.length && (
      w.start - cur[cur.length - 1].end > breakGap
      || w.end - cur[0].start > maxCue
      || chars + add > cap
    )) {
      flush();
    }
    cur.push(w);
    chars += add;
  }
  flush();
  return cues;
}
