import { GENRES, THEMES, type GameDraft, type Genre } from "./spec";

/**
 * The no-LLM path: a hand-tuned starting game per genre, picked (with a
 * theme) from keywords in the prompt. Every game the app makes without a
 * local model comes from here - the UI labels it as a template.
 */

type Theme = (typeof THEMES)[number];

const GENRE_WORDS: [Genre, RegExp][] = [
  ["puzzle", /\b(match|puzzle|candy|jewel|tiles?|swap|connect)\b/i],
  ["racer", /\b(rac(e|er|ing)|cars?|driv(e|ing)|kart|road|highway|traffic|drift)\b/i],
  ["shooter", /\b(shoot(er|ing)?|blast(er)?|invaders?|asteroids?|bullets?|lasers?|spaceships?|starfighter)\b/i],
  ["runner", /\b(runner|endless|dash(ing)?|sprint(ing)?|run(ning)?|chase[ds]?|parkour|rooftops?|escap(e|ing))\b/i],
  ["adventure", /\b(maze|dungeon|adventure|explore|quest|top[- ]?down|labyrinth|treasure)\b/i],
  ["platformer", /\b(platform(er)?|jump(ing)?|levels?|side[- ]?scroll(er|ing)?)\b/i],
];

// prefix matches on purpose: "snowy", "oceanic", "forests" all count
const THEME_WORDS: [Theme, RegExp][] = [
  ["space", /\b(space|galax|planet|alien|starship|cosmic|orbit|moon|asteroid)/i],
  ["ocean", /\b(ocean|sea\b|underwater|fish|reef|shark|coral|submarine|beach|lily|pond|lake|river)/i],
  ["snow", /\b(snow|ice\b|icy|winter|frozen|arctic|penguin|christmas)/i],
  ["desert", /\b(desert|sand|dune|pyramid|egypt|cactus|canyon)/i],
  ["cave", /\b(cave|dungeon|mine\b|crypt|underground|lava|volcan|haunted|tomb)/i],
  ["neon", /\b(neon|synth|retro|cyber|vapor|80s)/i],
  ["city", /\b(city|street|urban|rooftop|downtown|traffic|highway|road)/i],
  ["forest", /\b(forest|jungle|wood|tree|garden|meadow|nature)/i],
];

const LOOK_WORDS: [GameDraft["player"]["look"], RegExp][] = [
  ["frog", /\b(frog|toad)/i],
  ["bird", /\b(bird|chick|parrot|owl|duck|pigeon|eagle)/i],
  ["fish", /\b(fish|goldfish|salmon|whale)/i],
  ["ninja", /\b(ninja|samurai|assassin)/i],
  ["robot", /\b(robot|droid|android|mech|bot\b)/i],
  ["cat", /\b(cat|kitten|kitty|fox|dog|puppy)/i],
  ["knight", /\b(knight|warrior|paladin|soldier|hero(ine)? with a sword)/i],
  ["wizard", /\b(wizard|mage|witch|sorcer)/i],
  ["blob", /\b(blob|slime|jelly|bubble)/i],
  ["ship", /\b(pilot|spaceship|starfighter|ship)/i],
  ["car", /\b(car|kart|truck|taxi)/i],
];

const PALETTES: Record<Theme, GameDraft["palette"]> = {
  forest: { sky: "#8fd3ff", ground: "#3f7d3a", player: "#ff6b3d", enemy: "#7a3fa0", pickup: "#ffd23f", accent: "#ffffff" },
  city: { sky: "#f4a261", ground: "#3d405b", player: "#2ec4b6", enemy: "#e63946", pickup: "#ffd166", accent: "#f1faee" },
  space: { sky: "#0b0d2a", ground: "#2b2d5c", player: "#4cc9f0", enemy: "#f72585", pickup: "#ffd60a", accent: "#e0e1ff" },
  desert: { sky: "#ffcf8b", ground: "#c98b4b", player: "#2a9d8f", enemy: "#9b2226", pickup: "#ffe066", accent: "#fff6e6" },
  ocean: { sky: "#0f5e9c", ground: "#e9c46a", player: "#ff8c42", enemy: "#6a4c93", pickup: "#f9f871", accent: "#d8f3ff" },
  cave: { sky: "#1d1a2f", ground: "#5c4b51", player: "#f4d35e", enemy: "#ee6c4d", pickup: "#7bdff2", accent: "#f2e9e4" },
  snow: { sky: "#cfe8ff", ground: "#f8fbff", player: "#e63946", enemy: "#457b9d", pickup: "#ffb703", accent: "#1d3557" },
  neon: { sky: "#14002e", ground: "#2d0a5a", player: "#00f5d4", enemy: "#ff006e", pickup: "#fee440", accent: "#f9f7ff" },
};

const BASE: Record<Genre, Omit<GameDraft, "title" | "theme" | "palette">> = {
  platformer: {
    genre: "platformer",
    tagline: "Run, jump and grab everything shiny.",
    story: { intro: "The path home is broken into floating ledges. Jump the gaps, dodge the locals and reach the flag.", win: "You made it home!", lose: "Down you go - try again." },
    player: { name: "Pip", look: "hero", speed: 6, jump: 6, lives: 3 },
    enemies: [{ name: "Grumble", look: "slime", behavior: "patrol", speed: 4 }, { name: "Flapper", look: "bat", behavior: "zigzag", speed: 5 }],
    pickup: { name: "coin", look: "coin" },
    goal: { kind: "reach_end", target: 1 },
    difficulty: 2, length: 3,
  },
  runner: {
    genre: "runner",
    tagline: "Don't stop. Don't look back.",
    story: { intro: "Something is right behind you. Keep running, jump the obstacles and survive as long as you can.", win: "You outran it!", lose: "Caught! Run again." },
    player: { name: "Dash", look: "cat", speed: 6, jump: 6, lives: 3 },
    enemies: [{ name: "Spike", look: "spike", behavior: "patrol", speed: 5 }, { name: "Swoop", look: "bat", behavior: "zigzag", speed: 5 }],
    pickup: { name: "star", look: "star" },
    goal: { kind: "survive", target: 45 },
    difficulty: 2, length: 3,
  },
  shooter: {
    genre: "shooter",
    tagline: "Hold the line against the swarm.",
    story: { intro: "Wave after wave is coming in. Fly, fire and keep them off the station.", win: "The swarm retreats. Station saved!", lose: "Ship down. Relaunch?" },
    player: { name: "Nova", look: "ship", speed: 6, jump: 5, lives: 3 },
    enemies: [{ name: "Drone", look: "drone", behavior: "zigzag", speed: 4 }, { name: "Gunner", look: "beetle", behavior: "shoot", speed: 3 }, { name: "Rock", look: "rock", behavior: "fall", speed: 4 }],
    pickup: { name: "power cell", look: "bolt" },
    goal: { kind: "score", target: 200 },
    difficulty: 2, length: 3,
  },
  adventure: {
    genre: "adventure",
    tagline: "Find every gem. Then find the way out.",
    story: { intro: "The old ruins hide scattered gems. Collect them all to unlock the exit - but the guardians are awake.", win: "Treasure claimed. The door swings open!", lose: "The guardians win this time." },
    player: { name: "Ari", look: "knight", speed: 5, jump: 5, lives: 3 },
    enemies: [{ name: "Guardian", look: "ghost", behavior: "chase", speed: 3 }, { name: "Crawler", look: "beetle", behavior: "patrol", speed: 4 }],
    pickup: { name: "gem", look: "gem" },
    goal: { kind: "collect", target: 12 },
    difficulty: 2, length: 3,
  },
  puzzle: {
    genre: "puzzle",
    tagline: "Line up three. Watch them pop.",
    story: { intro: "Swap neighbouring tiles to make lines of three or more before you run out of moves.", win: "Board cleared - brilliant!", lose: "Out of moves. One more go?" },
    player: { name: "You", look: "blob", speed: 5, jump: 5, lives: 1 },
    enemies: [{ name: "Blocker", look: "rock", behavior: "fall", speed: 3 }],
    pickup: { name: "gem", look: "gem" },
    goal: { kind: "score", target: 300 },
    difficulty: 2, length: 3,
  },
  racer: {
    genre: "racer",
    tagline: "Thread the traffic. Beat the clock.",
    story: { intro: "The road is packed and the finish line is far. Steer through traffic and grab boosts on the way.", win: "First across the line!", lose: "Wrecked! Back to the grid." },
    player: { name: "Bolt", look: "car", speed: 7, jump: 5, lives: 3 },
    enemies: [{ name: "Traffic", look: "car", behavior: "patrol", speed: 4 }, { name: "Cone", look: "spike", behavior: "fall", speed: 3 }],
    pickup: { name: "boost", look: "bolt" },
    goal: { kind: "reach_end", target: 1 },
    difficulty: 2, length: 3,
  },
};

const DEFAULT_THEME: Record<Genre, Theme> = {
  platformer: "forest", runner: "city", shooter: "space", adventure: "cave", puzzle: "neon", racer: "city",
};

export function detectGenre(prompt: string): Genre {
  for (const [g, re] of GENRE_WORDS) if (re.test(prompt)) return g;
  return "platformer";
}

export function detectTheme(prompt: string, genre: Genre): Theme {
  for (const [t, re] of THEME_WORDS) if (re.test(prompt)) return t;
  return DEFAULT_THEME[genre];
}

/** "a tiny frog jumping across lily pads" → "Tiny Frog Jumping" */
export function titleFrom(prompt: string): string {
  const STOP = new Set(["a", "an", "the", "of", "to", "in", "on", "and", "with", "game", "make", "me", "where", "who", "that", "for", "about", "my", "i", "want"]);
  const words = prompt.replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter((w) => w && !STOP.has(w.toLowerCase()));
  const title = words.slice(0, 3).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  return (title || "Untitled Game").slice(0, 48);
}

export function detectLook(prompt: string): GameDraft["player"]["look"] | null {
  for (const [l, re] of LOOK_WORDS) if (re.test(prompt)) return l;
  return null;
}

export function templateDraft(prompt: string, genre?: Genre): GameDraft {
  const g = genre && GENRES.includes(genre) ? genre : detectGenre(prompt);
  const theme = detectTheme(prompt, g);
  const base = structuredClone(BASE[g]);
  const look = detectLook(prompt);
  // normalizeDraft keeps vehicles to the genres that use them
  if (look) base.player.look = look;
  return { ...base, title: titleFrom(prompt), theme, palette: { ...PALETTES[theme] } };
}

export { PALETTES as THEME_PALETTES };
