/* ============ Director control vocabularies ============
   Every value here has a consumer: lenses/sensors derive focal length → hFOV
   (src/lib/camera/lens.ts) which feeds OF_Trajectory + OF_CameraRig; aperture
   ids map to OF_DepthBlur's blur strength; bodies map to ffmpeg post looks
   (src/lib/grade/post.ts); lights/emotions/era/genre/pacing become prompt
   clauses - the param descriptions mark those as prompt-style so nothing
   claims a structural control it doesn't have. */

import { SENSORS, hFov, type SensorName } from "@/lib/camera/lens";

/* ---- backend ---- */

/** Generation backend pick - "auto" routes each move stack to the engine
 *  that measured best (docs/BENCHMARKS.md); "wan-vace" is the rig+VACE path,
 *  "wan-fun" the Wan2.1-Fun camera-conditioning path, "ltx" the restricted
 *  opt-in (Open RAIL-M, gate via licenseVariants + workflowFor). */
export const DIRECTOR_BACKENDS = ["auto", "wan-vace", "wan-fun", "ltx"] as const;
export type DirectorBackend = (typeof DIRECTOR_BACKENDS)[number];

/** Executable move ids measured stronger on the Wan2.1-Fun camera path -
 *  populated from the docs/BENCHMARKS.md A/B table. "auto" routes a stack
 *  only when EVERY executable id is a fun winner; mixed or unmeasured stacks
 *  stay on the VACE rig. */
export const DIRECTOR_FUN_WINS: ReadonlySet<string> = new Set<string>([]);

/** auto → the concrete backend a submission runs on. References and the
 *  aperture pull the pick back to the VACE rig - WanCameraImageToVideo has
 *  no reference input and the fun path carries no depth for OF_DepthBlur. */
export function directorBackendFor(
  backend: string | undefined,
  executed: readonly string[],
  hasRefs: boolean,
  aperture: string | undefined,
): "wan-vace" | "wan-fun" | "ltx" {
  if (backend === "ltx" || backend === "wan-vace" || backend === "wan-fun") return backend;
  // "auto" (and any unset/unknown pick - the gate names unknowns first)
  if (hasRefs) return "wan-vace";
  if (typeof aperture === "string" && aperture && aperture !== "f8") return "wan-vace";
  if (executed.length && executed.every((id) => DIRECTOR_FUN_WINS.has(id))) return "wan-fun";
  return "wan-vace";
}

/* ---- camera: lens + sensor -> focal mm -> horizontal FOV ---- */

export interface LensPreset { id: string; label: string; mm: number; note?: string }
export const DIRECTOR_LENSES: readonly LensPreset[] = [
  { id: "ultra-wide-14", label: "Ultra-wide 14mm", mm: 14 },
  { id: "wide-24", label: "Wide 24mm", mm: 24 },
  { id: "standard-35", label: "Standard 35mm", mm: 35 },
  { id: "normal-50", label: "Normal 50mm", mm: 50 },
  { id: "portrait-85", label: "Portrait 85mm", mm: 85 },
  { id: "tele-135", label: "Tele 135mm", mm: 135 },
] as const;
export const DIRECTOR_LENS_IDS = DIRECTOR_LENSES.map((l) => l.id);

export const DIRECTOR_SENSORS = Object.keys(SENSORS) as SensorName[];

export function lensPreset(id: string | undefined): LensPreset {
  return DIRECTOR_LENSES.find((l) => l.id === id) ?? DIRECTOR_LENSES[2];
}

/** Horizontal FOV (deg) for a lens id on a sensor preset - the value
 *  OF_Trajectory + OF_CameraRig receive. */
export function directorFov(lensId: string | undefined, sensor: string | undefined): number {
  const mm = lensPreset(lensId).mm;
  const s: SensorName = (DIRECTOR_SENSORS as string[]).includes(sensor ?? "") ? (sensor as SensorName) : "full_frame";
  return Math.round(hFov(mm, s) * 10) / 10;
}

/* ---- camera: aperture -> OF_DepthBlur blur strength ---- */

export interface AperturePreset { id: string; label: string; /** OF_DepthBlur `aperture` (blur strength 0-24) */ blur: number }
export const DIRECTOR_APERTURES: readonly AperturePreset[] = [
  // mild post-grade: OF_DepthBlur's radius equals this value, and at 832×480
  // on 1.3B output anything >~9px reads as mush - the table stays ordered but
  // every pick is a grade, not a physical CoC
  { id: "f1.4", label: "f/1.4 · wide open", blur: 9 },
  { id: "f2.8", label: "f/2.8 · shallow", blur: 6 },
  { id: "f4", label: "f/4 · moderate", blur: 4 },
  { id: "f8", label: "f/8 · deep", blur: 2 },
  { id: "f16", label: "f/16 · deep focus", blur: 0.5 },
] as const;
export const DIRECTOR_APERTURE_IDS = DIRECTOR_APERTURES.map((a) => a.id);

export function apertureBlur(id: string | undefined): number {
  // param default is "f8" - the same pick applies when the field is omitted
  return DIRECTOR_APERTURES.find((a) => a.id === (id ?? "f8"))?.blur ?? 2;
}

/* ---- camera body -> ffmpeg post look (grade/post.ts) ---- */

export const DIRECTOR_BODIES = ["modern", "35mm-film", "8mm-film", "dv-camcorder"] as const;
export type DirectorBody = (typeof DIRECTOR_BODIES)[number];

/** Body/palette → the post spec the provider stores on job meta. Pure pick -
 *  the ffmpeg chain + LUT materialisation happen server-side in grade/post
 *  (a node-only module this catalog file must never import). */
export function directorPost(params: Record<string, unknown>): { body?: string; palette?: string } | null {
  const body = typeof params.camera_body === "string" && (DIRECTOR_BODIES as readonly string[]).includes(params.camera_body)
    ? params.camera_body : "modern";
  const palette = typeof params.color_palette === "string" && params.color_palette ? params.color_palette : undefined;
  return { body, palette };
}

/* ---- lighting dome - ≤2 structured lights {az, el, color, intensity} ----
   These are the fields s9's OF_Relight consumes; today they build the
   prompt's lighting clause (hence the "prompt-style" tag in the UI). */

export const LIGHT_INTENSITIES = ["soft", "medium", "hard"] as const;
export type LightIntensity = (typeof LIGHT_INTENSITIES)[number];
export const LIGHT_COLORS = ["warm", "neutral", "cool"] as const;

/** One dome light - the params.lights contract. Azimuth/elevation are
 *  degrees around/above the subject; colour is a named temperature or a
 *  #rrggbb hex; intensity is the hardness. */
export interface DomeLight {
  /** azimuth around the subject, deg 0-359: 0 front, 90 frame right, 180 back, 270 frame left */
  az: number;
  /** elevation above the subject, deg 0-90: 0 floor-level, 90 overhead */
  el: number;
  /** warm | neutral | cool | #rrggbb */
  color: string;
  intensity: LightIntensity;
}

const LIGHT_COLOR_SET: ReadonlySet<string> = new Set(LIGHT_COLORS);
const LIGHT_INTENSITY_SET: ReadonlySet<string> = new Set(LIGHT_INTENSITIES);
const LIGHT_HEX_RE = /^#[0-9a-f]{6}$/i;
const LIGHT_COMPACT_RE = /^az(\d{1,3})(?::el(\d{1,3}))?(?::([^:+]*))?(?::([^:+]*))?$/i;

function lightProblem(l: DomeLight): string | null {
  if (!Number.isInteger(l.az) || l.az < 0 || l.az > 359) return "az must be 0-359";
  if (!Number.isInteger(l.el) || l.el < 0 || l.el > 90) return "el must be 0-90";
  if (!(LIGHT_COLOR_SET.has(l.color.toLowerCase()) || LIGHT_HEX_RE.test(l.color))) return "colour must be warm|neutral|cool|#rrggbb";
  if (!LIGHT_INTENSITY_SET.has(l.intensity)) return "intensity must be soft|medium|hard";
  return null;
}

/** One compact token → DomeLight ("az45:el30:warm:soft" - colour defaults
 *  neutral, intensity medium, el 0). null when it isn't light-shaped. */
function compactLight(token: string): DomeLight | null {
  const m = LIGHT_COMPACT_RE.exec(token.trim());
  if (!m) return null;
  const color = (m[3] || "neutral").toLowerCase();
  return {
    az: parseInt(m[1], 10),
    el: m[2] ? parseInt(m[2], 10) : 0,
    color: LIGHT_HEX_RE.test(m[3] ?? "") ? (m[3] as string) : color,
    intensity: ((m[4] || "medium").toLowerCase()) as LightIntensity,
  };
}

export interface ParsedLights { lights: DomeLight[]; bad: string[] }

/** params.lights → structured lights: an array of {az,el,color,intensity}
 *  entries or compact strings, or a "+"-joined compact string. `bad` names
 *  the entries that failed so the gate refuses them verbatim. */
export function parseLights(v: unknown): ParsedLights {
  const tokens = Array.isArray(v) ? v
    : typeof v === "string" ? v.split("+").map((s) => s.trim()).filter(Boolean) : [];
  const lights: DomeLight[] = [];
  const bad: string[] = [];
  for (const t of tokens) {
    let l: DomeLight | null = null;
    if (typeof t === "string") l = compactLight(t);
    else if (t && typeof t === "object") {
      const o = t as Record<string, unknown>;
      l = { az: Number(o.az), el: Number(o.el), color: String(o.color ?? "neutral"), intensity: String(o.intensity ?? "medium") as LightIntensity };
    }
    const why = l ? lightProblem(l) : "not a light spec";
    if (l && !why) lights.push(l);
    else bad.push(`${typeof t === "string" ? t : JSON.stringify(t)}${why ? ` - ${why}` : ""}`);
  }
  return { lights, bad };
}

/** Parsed lights only - failures dropped (the strict view is parseLights). */
export const lightsOf = (v: unknown): DomeLight[] => parseLights(v).lights;

/** azimuth → where the light reads from ("side, back or front" per spec). */
export const azimuthTerm = (az: number): string =>
  az < 45 || az >= 315 ? "from the front" : az < 135 ? "from frame right" : az < 225 ? "from behind" : "from frame left";
/** elevation → low / eye level / high / overhead. */
export const elevationTerm = (el: number): string =>
  el < 20 ? "low" : el <= 50 ? "eye-level" : el < 75 ? "high" : "overhead";

/** One light → its clause fragment: direction + height + colour + intensity. */
function lightClause(l: DomeLight): string {
  const color = LIGHT_HEX_RE.test(l.color) ? `${l.color}-tinted` : l.color;
  return elevationTerm(l.el) === "overhead"
    ? `a ${l.intensity} ${color} light from directly overhead`
    : `a ${l.intensity} ${color} ${elevationTerm(l.el)} light ${azimuthTerm(l.az)}`;
}

/** ≤2 dome lights → one prompt clause ("lit with X and Y"). */
export function lightsClause(lights: readonly DomeLight[]): string | null {
  if (!lights.length) return null;
  return lights.length === 1
    ? `lit with ${lightClause(lights[0])}`
    : `lit with ${lightClause(lights[0])} and ${lightClause(lights[1])}`;
}

/* ---- emotion wheel - 8 emotions × 3 intensities -> performance clause ---- */

export const DIRECTOR_EMOTIONS = ["joy", "sorrow", "fear", "anger", "surprise", "calm", "longing", "resolve"] as const;
export type DirectorEmotion = (typeof DIRECTOR_EMOTIONS)[number];
export const EMOTION_INTENSITIES = ["subtle", "moderate", "intense"] as const;
export type EmotionIntensity = (typeof EMOTION_INTENSITIES)[number];

/** Deterministic clause per emotion×intensity - a performance note the model
 *  can act on, not a mood adjective. */
export const EMOTION_CLAUSES: Record<DirectorEmotion, Record<EmotionIntensity, string>> = {
  joy: {
    subtle: "the subject carries a faint warmth - relaxed posture, a hint of a smile",
    moderate: "the subject is openly happy - easy smile, loose shoulders",
    intense: "the subject radiates joy - beaming, bright-eyed, animated",
  },
  sorrow: {
    subtle: "the subject holds a quiet heaviness - subdued, eyes low",
    moderate: "the subject looks quietly sad - dropped shoulders, slow movements",
    intense: "the subject is grief-stricken - crumpled posture, distant stare",
  },
  fear: {
    subtle: "the subject is uneasy - quick glances, held breath",
    moderate: "the subject is scared - tense shoulders, scanning the room",
    intense: "the subject is terrified - frozen, wide-eyed",
  },
  anger: {
    subtle: "the subject simmers - tight jaw, clipped movements",
    moderate: "the subject is angry - set jaw, sharp gestures",
    intense: "the subject is furious - shaking, squared stance",
  },
  surprise: {
    subtle: "the subject registers a small surprise - raised brow, a pause",
    moderate: "the subject is startled - sudden intake, stepping back",
    intense: "the subject is stunned - wide eyes, mouth open",
  },
  calm: {
    subtle: "the subject is at ease - unhurried, settled",
    moderate: "the subject is serene - even breathing, still shoulders",
    intense: "the subject is completely still - meditative, unblinking calm",
  },
  longing: {
    subtle: "the subject drifts wistful - a far-away look",
    moderate: "the subject aches with longing - gazing off, hands idle",
    intense: "the subject yearns - leaning toward the distance, heavy eyes",
  },
  resolve: {
    subtle: "the subject is quietly determined - chin set",
    moderate: "the subject is resolute - direct stare, steady breathing",
    intense: "the subject is defiant - forward lean, unflinching",
  },
};

export function emotionClause(emotion: string | undefined, intensity: string | undefined): string | null {
  const e = (DIRECTOR_EMOTIONS as readonly string[]).includes(emotion ?? "") ? (emotion as DirectorEmotion) : null;
  if (!e) return null;
  const i = (EMOTION_INTENSITIES as readonly string[]).includes(intensity ?? "") ? (intensity as EmotionIntensity) : "subtle";
  return EMOTION_CLAUSES[e][i];
}

/* ---- prompt-style selectors (labels say so - these steer text only) ---- */

export const DIRECTOR_ERAS = ["1960s", "1970s", "1980s", "1990s", "2000s", "2020s"] as const;
export const DIRECTOR_GENRES = ["epic", "drama", "noir", "comedy", "horror", "action"] as const;
export const DIRECTOR_PACING = ["contemplative", "steady", "dynamic", "frenetic"] as const;

/** Each prompt-style field maps to one clause, or null when unset - the map
 *  joins them into PROMPT (and KEYFRAME_PROMPT for the text-only variant). */
export function directorClauses(params: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof params.era === "string" && (DIRECTOR_ERAS as readonly string[]).includes(params.era))
    out.push(`${params.era} period styling`);
  if (typeof params.genre === "string" && (DIRECTOR_GENRES as readonly string[]).includes(params.genre))
    out.push(`${params.genre} tone`);
  if (typeof params.pacing === "string" && (DIRECTOR_PACING as readonly string[]).includes(params.pacing))
    out.push(params.pacing === "contemplative" ? "slow, contemplative pacing"
      : params.pacing === "frenetic" ? "frantic, fast-cut energy" : `${params.pacing} pacing`);
  const emo = emotionClause(params.emotion as string | undefined, params.emotion_intensity as string | undefined);
  if (emo) out.push(emo);
  const lit = lightsClause(lightsOf(params.lights));
  if (lit) out.push(lit);
  return out;
}
