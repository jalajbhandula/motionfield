/** Director move-field resolution - the one place a `moves` value becomes
 *  either an executable stack (catalog trajectory ids the rig runs) or a
 *  prompt clause ("prompt-guided" - the phrase steers the text because the
 *  graph can't run it). Client + server share this: the workflow's validate
 *  normalises params with it, the picker renders the parsed-id chips and the
 *  "prompt-guided" chip from the same answer. */
import { TRAJECTORIES, isCoreTrajectory, trajectoryOf } from "@/lib/catalog/presets/trajectories";

/** Moves the director's graph executes beyond the camera-rig core set: its
 *  chain carries OF_DepthBlur, which reads per-pose `focus` fields - the
 *  focus pull lands. Other post-tagged ids (fisheye, shutter-drag,
 *  time-samples) have no executor downstream and stay prompt-guided. */
const DIRECTOR_EXTRA: ReadonlySet<string> = new Set(["rack-focus-near-to-far"]);
export const isDirectorMove = (id: string): boolean => isCoreTrajectory(id) || DIRECTOR_EXTRA.has(id);

export interface MovesResolution {
  /** what OF_Trajectory receives - the executable stack, or "locked-off"
   *  when the pick was prompt-guided */
  moves: string;
  /** non-empty when part of the pick went to the prompt instead of the rig */
  guided?: string;
  /** catalog ids that parsed into the executable stack (UI chips) */
  executed: string[];
  /** every chunk was a catalog id - a pure stack, no free text */
  stack: boolean;
}

/** Loose chunk → catalog id: ids and labels match ignoring case, spaces,
 *  hyphens and punctuation ("Dolly In" → dolly-in). Exact ids are indexed
 *  first so a label can never shadow a different id. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const BY_NORM = (() => {
  const m = new Map<string, string>();
  for (const t of TRAJECTORIES) m.set(norm(t.id), t.id);
  for (const t of TRAJECTORIES) { const k = norm(t.label); if (!m.has(k)) m.set(k, t.id); }
  return m;
})();
/** Spoken-word aliases - consulted after ids and labels so they can never
 *  shadow a real catalog entry. */
const BY_ALIAS: Record<string, string> = {
  orbitleft: "arc-left-45",
  orbitright: "arc-right-45",
};
const matchMove = (chunk: string): string | null =>
  trajectoryOf(chunk)?.id ?? BY_NORM.get(norm(chunk)) ?? BY_ALIAS[norm(chunk)] ?? null;

/** Chunks of a move field: explicit separators plus the connective words -
 *  "dolly in then pan left" and "dolly-in+pan-left" split the same way. */
const splitMoves = (raw: string): string[] =>
  raw.split(/\s*(?:\+|,|;|\bthen\b|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean);

/** Resolve a moves value: catalog ids (typed loosely or "+"-joined) that the
 *  endpoint's rig runs form the executable stack - at most 3; every other
 *  chunk (free text, or catalog moves the rig can't run) becomes the
 *  prompt-guided clause. A pure catalog stack of more than 3 ids is refused
 *  (null) - the caller rejects it. `exec` names the ids that run here: the
 *  Director's rig (default) also runs the focus pull; re-shoot passes
 *  isReshootMove so only its video-capable pose paths execute. */
export function resolveMoves(value: unknown, exec: (id: string) => boolean = isDirectorMove): MovesResolution | null {
  if (value === undefined || value === null || value === "") return { moves: "locked-off", executed: [], stack: true };
  const raw = Array.isArray(value) ? value.join("+") : String(value);
  const trimmed = raw.trim();
  if (!trimmed) return { moves: "locked-off", executed: [], stack: true };
  const chunks = splitMoves(trimmed);
  const matched = chunks.map(matchMove);
  // a "+"-joined stack of id-shaped tokens is still a stack attempt even when
  // a token missed the catalog ("arc-left" for "arc-left-45") - >3 refuses
  if (chunks.length > 3 && chunks.every((c) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(c))) return null;
  if (matched.every((id) => id !== null)) {
    // a pure catalog stack: the ids the caller's rig runs execute; every
    // other id lands in `guided` - a runnable id never goes prompt-guided
    // just because its stack-mate can't run
    if (chunks.length > 3) return null; // refuses - "a 1-3 stack"
    const ids = matched as string[];
    if (ids.every(exec)) return { moves: ids.join("+"), executed: ids, stack: true };
    const executed = ids.filter(exec);
    const guided = ids.filter((id) => !exec(id)).map((id) => trajectoryOf(id)!.label);
    return { moves: executed.join("+") || "locked-off", guided: guided.join(" + "), executed, stack: true };
  }
  // mixed phrase - each chunk either names a catalog move or is free text;
  // the first 3 runnable matches execute, the rest steers the prompt
  const executed: string[] = [];
  const guided: string[] = [];
  chunks.forEach((chunk, i) => {
    const id = matched[i];
    if (id && exec(id) && executed.length < 3) executed.push(id);
    else guided.push(id ? trajectoryOf(id)!.label : chunk);
  });
  return {
    moves: executed.join("+") || "locked-off",
    guided: guided.length ? guided.join(", ") : undefined,
    executed,
    stack: false,
  };
}
