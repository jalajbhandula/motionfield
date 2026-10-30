/** VFX Lab presets - the 20-row effect catalog (ws3 s10).
 *
 *  A VfxPreset is a named plate effect: a prompt body, an optional negative
 *  hint, the plate-lock/hold defaults it was tuned at, and (for effects that
 *  benefit) a `target` instruction the target-frame maker can run through
 *  klein-edit. Presets are NOT the generic preset catalogs - they never ride
 *  resolveParams; the VFX Lab route merges them into a submit itself.
 *
 *  Honesty gate: a preset is only shown when tests/fixtures/vfx-verify.json
 *  carries a `verified` record whose mechanism_hash matches vfxPresetHash()
 * - the hash covers the prompt, negative, defaults and target text, so
 *  editing a preset drops it out of the grid until a real run re-verifies
 *  it. Mock provider can never write a verified record (the runner requires
 *  GENERATION_PROVIDER=comfy). */
import { canonicalJson } from "./schema";

export type VfxFamily = "material" | "weather" | "arc" | "fracture";

export interface VfxPreset {
  id: string;                    // "vfx-frostbite"
  label: string;
  blurb: string;                 // one-line card copy
  family: VfxFamily;
  /** the effect text - becomes the job's prompt base */
  prompt: string;
  negative?: string;
  /** controls the preset was tuned at - the picker applies them */
  defaults: {
    lock?: "light" | "medium" | "strong" | "full";
    hold?: number;               // 0 | 9 | 17 | 25
    duration?: number;           // image-plate length pick
    resolution?: "480p" | "720p";
    target_strength?: number;
    alt_structure?: "depth" | "pose" | "edges" | "image";
  };
  /** klein instruction for "make a target frame" - when the effect lands
   *  somewhere visibly different from the start */
  target?: { instruction: string };
  /** evidence strip path (tests/artifacts) once verified */
  evidence?: string;
}

export const VFX_PRESETS: readonly VfxPreset[] = [
  /* ---- material (5) ---- */
  { id: "vfx-frostbite", label: "Frostbite", family: "material",
    blurb: "Frost creeps over the plate - edges freeze first, surfaces ice over.",
    prompt: "the whole scene frozen solid under a thick sparkling layer of frost and ice - white frost crystals crusting every surface, icicles hanging from the edges, pale cold breath mist drifting through, deep blue winter light, everything perfectly still and frozen",
    negative: "melting, warm colours, summer, rain",
    defaults: { lock: "strong", hold: 9, duration: 3, target_strength: 0.9 },
    target: { instruction: "flash-freeze this scene - frost over every surface, ice crystals on the edges, cold blue cast" } },
  { id: "vfx-stone-set", label: "Stone Set", family: "material",
    blurb: "The scene turns to weathered stone - texture mineralises, motion slows to a statue's.",
    prompt: "turn the scene to weathered grey stone: mineral texture, hairline cracks, dust settling - motion slows to a statue's stillness",
    negative: "soft fabric, wet, glossy plastic",
    defaults: { lock: "medium", hold: 9, duration: 3, target_strength: 0.9 },
    target: { instruction: "turn everything in this scene to weathered grey stone with mineral texture" } },
  { id: "vfx-molten", label: "Molten", family: "material",
    blurb: "Surfaces run molten - glowing cracks, heat shimmer, slow lava crawl.",
    prompt: "the whole scene melting into glowing molten rock - bright orange cracks splitting every surface, liquid lava crawling slowly over the edges, fierce heat shimmer rising, everything glowing orange-hot and dripping molten",
    negative: "cold, ice, frost, blue light",
    defaults: { lock: "strong", hold: 9, duration: 3, target_strength: 0.85 },
    target: { instruction: "turn the surfaces of this scene to glowing molten rock with orange cracks" } },
  { id: "vfx-gilded", label: "Gilded", family: "material",
    blurb: "The plate turns gold-leaf - metallic sheen, warm reflections, engraved detail.",
    prompt: "turn the scene to polished gold leaf: metallic sheen on every surface, warm reflections, engraved ornament detail",
    defaults: { lock: "medium", hold: 9, duration: 3 } },
  { id: "vfx-glasswork", label: "Glasswork", family: "material",
    blurb: "Surfaces become blown glass - refraction, caustics, light through edges.",
    prompt: "turn the scene's surfaces to clear blown glass: refraction, caustic light pooling under edges, internal glow",
    defaults: { lock: "medium", hold: 9, duration: 3 } },
  /* ---- weather (9) ---- */
  { id: "vfx-ashfall", label: "Ashfall", family: "weather",
    blurb: "Volcanic ash drifts through the air - visibility drops, surfaces grey out.",
    prompt: "heavy volcanic ash pouring down over the whole scene - thick grey ash flakes filling the air and blanketing every surface in grey dust, visibility collapsing to a few metres, dark ashen sky, ash drifting and settling everywhere",
    defaults: { lock: "strong", hold: 9, duration: 4 } },
  { id: "vfx-sand-slip", label: "Sand Slip", family: "weather",
    blurb: "Sand streams off surfaces - wind-blown grit, dunes creeping over edges.",
    prompt: "wind-blown sand streams across the scene: grit lifting off surfaces, small dunes creeping over the edges, haze",
    defaults: { lock: "light", hold: 9, duration: 4 } },
  { id: "vfx-pixel-drift", label: "Pixel Drift", family: "weather",
    blurb: "The scene sheds luminous pixels - a soft datamosh shimmer over the plate.",
    prompt: "the scene sheds drifting luminous pixels: blocks lifting off surfaces and dissolving upward, soft shimmer, edges refracting",
    defaults: { lock: "light", hold: 9, duration: 3 } },
  { id: "vfx-ink-smoke", label: "Ink Smoke", family: "weather",
    blurb: "Black ink bleeds through the frame - tendrils swirling in the air.",
    prompt: "black ink bleeds through the air like smoke: swirling tendrils spreading through the scene, edges dissolving into pigment",
    defaults: { lock: "light", hold: 9, duration: 4 } },
  { id: "vfx-whiteout", label: "Whiteout", family: "weather",
    blurb: "A blizzard whiteout swallows the plate - snow streaks, ground vanishes.",
    prompt: "a blizzard whiteout swallows the scene: hard horizontal snow, visibility collapsing to a few metres, white sky",
    defaults: { lock: "light", hold: 9, duration: 4 } },
  { id: "vfx-downpour", label: "Downpour", family: "weather",
    blurb: "Torrential rain sheets through the plate - splashes on every surface.",
    prompt: "torrential rain sheets down through the scene: water splashing off every surface, drips, darker wet ground",
    defaults: { lock: "light", hold: 9, duration: 4 } },
  { id: "vfx-fog-bank", label: "Fog Bank", family: "weather",
    blurb: "A fog bank rolls in and swallows the scene - depth gone, silhouettes only.",
    prompt: "a thick fog bank rolls in and swallows the scene: low cloud hugging the ground, depth gone, silhouettes only",
    defaults: { lock: "light", hold: 9, duration: 4 } },
  { id: "vfx-ember-storm", label: "Ember Storm", family: "weather",
    blurb: "Glowing embers swirl through the frame - sparks trailing off edges.",
    prompt: "a storm of glowing embers swirls through the scene: orange sparks trailing, tiny fires landing and dying, smoke",
    defaults: { lock: "light", hold: 9, duration: 4 } },
  { id: "vfx-overgrowth", label: "Overgrowth", family: "weather",
    blurb: "Vines and moss surge across the plate - greenery claiming the scene.",
    prompt: "vines and moss surge across every surface: greenery claiming the scene, leaves uncurling, tendrils climbing edges",
    // pose control renders the skeleton's palette INTO the output - depth is
    // the structure this effect verifies on
    defaults: { lock: "medium", hold: 9, duration: 4, alt_structure: "depth" },
    target: { instruction: "cover this scene in fast-growing vines, moss and greenery - nature reclaiming it" } },
  /* ---- arc (3) ---- */
  { id: "vfx-arc-charge", label: "Arc Charge", family: "arc",
    blurb: "Electric arcs crackle across the plate - blue-white discharge crawling edges.",
    prompt: "electric arcs crackle across the scene: blue-white discharge crawling over edges and jumping between surfaces, ozone glow",
    defaults: { lock: "medium", hold: 9, duration: 3 } },
  { id: "vfx-neon-trace", label: "Neon Trace", family: "arc",
    blurb: "Neon light traces the scene's edges - glowing outlines pulsing.",
    prompt: "neon light traces the scene's edges: glowing outlines pulsing along contours, soft bloom, dark contrast",
    defaults: { lock: "medium", hold: 9, duration: 3 } },
  { id: "vfx-rift", label: "Rift", family: "arc",
    blurb: "A glowing rift tears through the plate - light pours from the seam.",
    prompt: "a glowing rift tears through the scene: a seam of blinding light opening, edges distorting as it widens",
    defaults: { lock: "medium", hold: 9, duration: 3 },
    target: { instruction: "tear a glowing rift through this scene - a seam of blinding light opening" } },
  /* ---- fracture (3) ---- */
  { id: "vfx-shockwave", label: "Shockwave", family: "fracture",
    blurb: "A shockwave blasts through the frame - debris rippling outward.",
    prompt: "a shockwave blasts through the scene: dust and debris rippling outward from the centre, edges blurring with the force",
    defaults: { lock: "strong", hold: 9, duration: 3 } },
  { id: "vfx-fracture", label: "Fracture", family: "fracture",
    blurb: "The plate fractures like glass - cracks spidering, slivers lifting.",
    prompt: "the scene fractures like glass: cracks spidering outward, thin slivers lifting off the surface, light catching the fault lines",
    defaults: { lock: "strong", hold: 9, duration: 3 },
    target: { instruction: "fracture this scene like broken glass - cracks spidering outward" } },
  { id: "vfx-glass-burst", label: "Glass Burst", family: "fracture",
    blurb: "Shards burst outward from the centre - splinters flying at camera.",
    prompt: "glass shards burst outward from the centre of the scene: splinters flying toward camera, sharp glints, dust behind",
    defaults: { lock: "strong", hold: 9, duration: 3 },
    target: { instruction: "shatter this scene outward from the centre - glass shards bursting toward the camera" } },
];

/* ------------------------------------------------------------------ */
/* verify store - tests/fixtures/vfx-verify.json                        */
/* ------------------------------------------------------------------ */

export interface VfxVerifyRecord {
  mechanism_hash: string;
  /** "weak" = the run completed but the mid span stayed within the
   *  plate-diff floor (the effect didn't land) - it never satisfies
   *  vfxPresetVerified; only "verified" does */
  status: "verified" | "weak" | "failed" | "pending";
  /** what the run measured - output dims/frames/fps + wall seconds */
  out?: { width?: number; height?: number; frames?: number; fps?: number; wall_s?: number };
  /** the effect-presence metric - mean |Δ| over the sampled mid span
   *  (64×36 luma, 0-255) vs the plate at the same timestamps; `frames`
   *  are the sampled output indices, `min` the weakest frame */
  effect_diff?: { mean: number; min: number; frames: number[]; per_frame: number[] };
  artifact_sha256?: string;
  /** side-by-side strip under tests/artifacts/ */
  sheet?: string;
  note?: string;
  date?: string;
}

interface VfxVerifyFile { version?: number; records?: Record<string, VfxVerifyRecord> }

export const VFX_VERIFY_FILE_ENV = "VFX_VERIFY_FILE";
export const VFX_VERIFY_FILE_DEFAULT = "tests/fixtures/vfx-verify.json";

export function vfxVerifyFilePath(): string {
  const p = process.env[VFX_VERIFY_FILE_ENV];
  return p && p.trim() ? p : `${process.cwd()}/${VFX_VERIFY_FILE_DEFAULT}`;
}

let cache: { file: string; mtimeMs: number; records: Record<string, VfxVerifyRecord> } | null = null;

/** Sync read, memoised by mtime. Missing file → {} - fail closed, nothing
 *  is verified. Client bundles get {} (no fs). */
export function loadVfxVerifyRecords(): Record<string, VfxVerifyRecord> {
  const get = globalThis.process?.getBuiltinModule?.bind(globalThis.process);
  if (!get) return {};
  try {
    const fs = get("node:fs") as typeof import("node:fs");
    const file = vfxVerifyFilePath();
    const mtimeMs = fs.statSync(file).mtimeMs;
    if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.records;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as VfxVerifyFile;
    const records = parsed?.records && typeof parsed.records === "object" ? parsed.records : {};
    cache = { file, mtimeMs, records };
    return records;
  } catch {
    return {};
  }
}

/** sha256 of the preset's canonical mechanism payload - prompt, negative,
 *  defaults and target text. Editing any of it invalidates the record. */
export function vfxPresetHash(p: VfxPreset): string {
  const get = globalThis.process?.getBuiltinModule?.bind(globalThis.process);
  const crypto = get?.("node:crypto") as typeof import("node:crypto") | undefined;
  if (!crypto) throw new Error("vfxPresetHash needs node:crypto (server-side only)");
  return crypto.createHash("sha256")
    .update(canonicalJson({ prompt: p.prompt, negative: p.negative, defaults: p.defaults, target: p.target }))
    .digest("hex");
}

export function vfxPresetById(id: string): VfxPreset | undefined {
  return VFX_PRESETS.find((p) => p.id === id);
}

/** A preset is offerable iff its verify record exists, says `verified`, pins
 *  the CURRENT payload hash - and carries the effect-diff measurement (s11:
 *  a `verified` stamp from before the metric existed proved nothing). */
export function vfxPresetVerified(id: string, records = loadVfxVerifyRecords()): boolean {
  const p = vfxPresetById(id);
  if (!p) return false;
  const r = records[id];
  return !!r && r.status === "verified" && r.mechanism_hash === vfxPresetHash(p)
    && r.effect_diff != null;
}

export function vfxVisiblePresets(records = loadVfxVerifyRecords()): VfxPreset[] {
  return VFX_PRESETS.filter((p) => vfxPresetVerified(p.id, records));
}
