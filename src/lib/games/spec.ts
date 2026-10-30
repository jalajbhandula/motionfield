import { z } from "zod";

/**
 * GameSpec v1 - the whole game as data. A local model writes the draft half
 * (everything but version + seed); our own runtime (public/games/runtime.js)
 * plays it inside a sandboxed iframe. Model output is JSON + zod only - it is
 * never eval'd, and the runtime clamps every number again on its side.
 */

export const GAME_SPEC_VERSION = 1;

export const GENRES = ["platformer", "runner", "shooter", "adventure", "puzzle", "racer"] as const;
export const THEMES = ["forest", "city", "space", "desert", "ocean", "cave", "snow", "neon"] as const;
export const PLAYER_LOOKS = ["hero", "knight", "robot", "blob", "cat", "ship", "car", "wizard", "frog", "bird", "fish", "ninja"] as const;
export const ENEMY_LOOKS = ["slime", "bat", "drone", "ghost", "spike", "rock", "car", "beetle"] as const;
export const BEHAVIORS = ["patrol", "chase", "zigzag", "shoot", "fall"] as const;
export const PICKUP_LOOKS = ["coin", "gem", "star", "heart", "bolt", "key", "fruit"] as const;
export const GOALS = ["reach_end", "score", "survive", "collect"] as const;

export type Genre = (typeof GENRES)[number];
export type Goal = (typeof GOALS)[number];

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a #rrggbb colour");
const level = z.number().int().min(1).max(10);
const name = z.string().trim().min(1).max(24);

export const paletteSchema = z.strictObject({
  sky: hex,
  ground: hex,
  player: hex,
  enemy: hex,
  pickup: hex,
  accent: hex,
});

export const gameDraftSchema = z.strictObject({
  genre: z.enum(GENRES),
  title: z.string().trim().min(1).max(48),
  tagline: z.string().trim().max(90),
  story: z.strictObject({
    intro: z.string().trim().max(240),
    win: z.string().trim().max(120),
    lose: z.string().trim().max(120),
  }),
  theme: z.enum(THEMES),
  palette: paletteSchema,
  player: z.strictObject({
    name,
    look: z.enum(PLAYER_LOOKS),
    speed: level,
    jump: level,
    lives: z.number().int().min(1).max(5),
  }),
  enemies: z.array(z.strictObject({
    name,
    look: z.enum(ENEMY_LOOKS),
    behavior: z.enum(BEHAVIORS),
    speed: level,
  })).min(1).max(3),
  pickup: z.strictObject({ name, look: z.enum(PICKUP_LOOKS) }),
  goal: z.strictObject({
    kind: z.enum(GOALS),
    /** reach_end: ignored · score: points · survive: seconds · collect: items */
    target: z.number().int().min(1).max(500),
  }),
  difficulty: z.number().int().min(1).max(5),
  length: z.number().int().min(1).max(5),
});
export type GameDraft = z.infer<typeof gameDraftSchema>;

export const gameSpecSchema = gameDraftSchema.extend({
  version: z.literal(GAME_SPEC_VERSION),
  seed: z.number().int().min(0).max(0xffffffff),
});
export type GameSpec = z.infer<typeof gameSpecSchema>;

/** Which goals each genre's rules can actually end on - the first is the
 *  genre's natural goal, used when a draft picks one the genre can't play. */
export const GENRE_GOALS: Record<Genre, readonly Goal[]> = {
  platformer: ["reach_end", "collect", "score"],
  runner: ["survive", "score", "collect"],
  shooter: ["score", "survive"],
  adventure: ["collect", "score", "survive"],
  puzzle: ["score"],
  racer: ["reach_end", "survive", "collect"],
};

/** Keep targets inside what one run can reach, so no game is unwinnable. */
const TARGET_RANGE: Record<Goal, [number, number]> = {
  reach_end: [1, 1],
  score: [50, 500],
  survive: [20, 180],
  collect: [5, 60],
};

/**
 * Coerce a valid draft into one the runtime can always finish: a goal the
 * genre supports, a target inside the reachable range, vehicle looks only
 * where a vehicle makes sense. Never throws - the draft already passed zod.
 */
export function normalizeDraft(d: GameDraft): GameDraft {
  const goals = GENRE_GOALS[d.genre];
  const kind = goals.includes(d.goal.kind) ? d.goal.kind : goals[0];
  const [lo, hi] = TARGET_RANGE[kind];
  const target = Math.min(hi, Math.max(lo, d.goal.target));
  let look = d.player.look;
  if (d.genre === "racer") look = "car";
  else if (d.genre === "shooter" && look !== "ship" && look !== "robot" && look !== "wizard") look = "ship";
  else if (d.genre !== "shooter" && (look === "car" || look === "ship")) look = "hero";
  return { ...d, goal: { kind, target }, player: { ...d.player, look } };
}

export function buildGameSpec(draft: GameDraft, seed: number): GameSpec {
  return gameSpecSchema.parse({ ...normalizeDraft(draft), version: GAME_SPEC_VERSION, seed: seed >>> 0 });
}

export function draftOf(spec: GameSpec): GameDraft {
  const { version: _v, seed: _s, ...draft } = spec;
  return draft;
}

/** Controls shown under the player - keyboard and touch. */
export const CONTROLS: Record<Genre, string> = {
  platformer: "←/→ or A/D to move · Space/↑ to jump",
  runner: "Space/↑ to jump · ↓ to duck",
  shooter: "Arrows/WASD to move · Space to fire",
  adventure: "Arrows/WASD to move · Space to swing",
  puzzle: "Click two neighbouring tiles to swap · or arrows + Space",
  racer: "←/→ to steer · ↑ to boost",
};
