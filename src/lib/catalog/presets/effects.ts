import type { PresetDef } from "../types";
import { posterFor } from "./poster";
import { registerCatalog, type PresetSpec } from "./schema";

/* ============ VFX effect presets ============
 *  Effect = a named mechanism applied to an uploaded image on the video
 *  workflows. Each entry carries a PresetSpec (see ./schema.ts) - a real
 *  mechanism that consumes the input, a verification contract, and
 *  hidden:{reason} where no honest executor exists on trunk.
 *
 *  The legacy PresetDef array is derived from the specs below so older
 *  pickers and findPreset keep working. */

export interface EffectSpec extends PresetSpec {
  apply?: Record<string, unknown>;
  promptFragment?: string;
  credits?: number;
  modelHint?: string;
}

const hue = (id: string) => Math.abs([...id].reduce((a, c) => a + c.charCodeAt(0), 0)) % 360;

const VACE_I2V = "motionfield/wan-vace/image-to-video";
const VACE_RESTYLE = "motionfield/wan-vace/restyle";
const LTX_VFX = "motionfield/ltx-video/vfx-keyframe";

/** instruction-steered image-to-video on Wan VACE - image is the first
 *  frame, the recipe text lands in PROMPT */
const fx = (id: string, label: string, description: string, extra: Partial<EffectSpec> = {}): EffectSpec => ({
  id, label, description, catalog: "effect",
  inputs: ["image", "prompt"],
  mechanism: { kind: "edit_recipe", endpoint: VACE_I2V, instruction: description },
  tier: "local",
  verify: { checker: "vision", question: `does the clip show this: ${description}`, fixture: "portrait.png" },
  promptFragment: description,
  credits: 49,
  modelHint: "wan-vace",
  ...extra,
});

/** depth-controlled v2v restyle - the input clip survives as structure */
const rs = (id: string, label: string, description: string, credits = 49): EffectSpec => ({
  id, label, description, catalog: "effect", collection: "restyle",
  inputs: ["video", "prompt"],
  mechanism: { kind: "restyle", endpoint: VACE_RESTYLE, control: "depth" },
  tier: "local",
  verify: { checker: "vision", question: `does the clip look like this - ${description}`, fixture: "clip-2s.mp4" },
  promptFragment: description,
  credits,
  modelHint: "wan-vace",
});

/** a conditioning layer that merges structured params into the job's own
 *  workflow (the params reach real graph inputs - NEGATIVE & co.) plus a
 *  conditioning prompt line; combinable by design */
const post = (id: string, label: string, description: string, params: Record<string, unknown>): EffectSpec => ({
  id, label, description, catalog: "effect", collection: "post",
  inputs: ["image", "prompt"],
  mechanism: { kind: "post", params },
  tier: "local",
  verify: { checker: "vision", question: `does the clip show this: ${description}`, fixture: "portrait.png" },
  promptFragment: description,
  credits: 29,
  modelHint: "wan-vace",
});

/** keyframe-guided VFX - the start/end-frame executor is WS3's ltx-vfx work;
 *  hidden until it lands (and ltx is opt-in anyway) */
const kf = (id: string, label: string, description: string, recipe: string, negative: string): EffectSpec => ({
  id, label, description, catalog: "effect",
  inputs: ["image", "prompt"],
  mechanism: { kind: "keyframe_edit", endpoint: LTX_VFX, recipe },
  tier: "local",
  verify: { checker: "vision", question: `does the clip show this: ${description}`, fixture: "portrait.png" },
  apply: { negative_prompt: negative },
  promptFragment: recipe,
  modelHint: "ltx-vfx",
  hidden: { reason: "executor pending WS3 - the ltx-vfx keyframe path isn't wired on trunk" },
});

const VFX_NEG = "worst quality, warped face, extra limbs, jittery motion, frame skipping, flicker, watermark, text";

export const EFFECT_SPECS: EffectSpec[] = [
  fx("weightless", "Weightless", "The subject floats upward as gravity lets go - clothes and limbs drifting in slow suspension."),
  fx("slow-mo-flip", "Slow-Mo Flip", "The subject launches into a backflip, held in slow motion at the top of the arc."),
  fx("ember-double", "Ember Double", "A figure made of flame steps out in front of the subject and reaches for a handshake."),
  fx("torn-paper", "Torn Paper", "The frame tears into layered paper pieces that rearrange around the subject."),
  rs("comic-panel", "Comic Panel", "Live action snaps into inked comic panels with halftone shading."),
  fx("world-keeps-moving", "World Keeps Moving", "The subject locks mid-action while the world keeps moving around them."),
  fx("particle-dissolve", "Particle Dissolve", "The subject breaks apart into glowing particles that scatter on the wind."),
  fx("flock-takeoff", "Flock Takeoff", "A flock of pigeons erupts behind the subject in slow motion."),
  rs("old-master-portrait", "Old Master Portrait", "A painterly relight - soft window light and oil-paint texture like a classical portrait."),
  fx("floor-glide", "Floor Glide", "The subject glides sideways across a seamless studio floor."),
  fx("tilting-room", "Tilting Room", "The set rolls around the subject as the whole frame tilts."),
  post("candid-take", "Candid Take", "A loose handheld pass - the subject caught mid-gesture in natural light.",
    { negative_prompt: "posed, stiff composition, studio lighting, overproduced" }),
  fx("giant-mimic", "Giant Mimic", "A huge creature steps in behind the subject and mirrors their pose."),
  fx("self-squad", "Self Squad", "Exact copies of the subject walk in and take formation."),
  fx("paper-cutout", "Paper Cutout", "The subject is trimmed out of the scene and dropped into a layered paper world."),
  fx("power-aura", "Power Aura", "Energy flares around the subject while dust and debris lift off the ground."),
  fx("heat-blink", "Heat Blink", "The subject blinks out of the frame, leaving a rippling heat outline."),
  fx("glide-step", "Glide Step", "The subject slides backwards in a smooth, floating walk."),
  fx("iris-dive", "Iris Dive", "An extreme push into the subject's eye, where a reflected world appears."),
  fx("tiny-town", "Tiny Town", "The subject towers over a miniature-looking street."),
  fx("liquify", "Liquify", "The scene drips - the subject and set liquify into flowing color."),
  fx("rolling-street", "Rolling Street", "A ripple travels down the street, rolling through walls and rooftops like water."),
  rs("marble-gold", "Marble & Gold", "A classical-epic restyle - carved marble, gilded light, laurel tones.", 39),
  fx("sky-eye", "Sky Eye", "The world peels open into a single enormous eye watching the subject."),
  rs("living-canvas", "Living Canvas", "Brushstrokes paint the scene in real time around the subject."),
  fx("target-lock", "Target Lock", "A tracking HUD - scan lines and targeting graphics follow the subject."),
  rs("kaleidoscope", "Kaleidoscope", "Chromatic bleed and mirrored edges fold the scene into a moving pattern."),
  rs("underwater-drift", "Underwater Drift", "The scene sinks below the surface - caustic light and drifting particles."),
  fx("rodeo-shake", "Rodeo Shake", "Violent shake and dust - bucking momentum under the subject."),
  fx("shifting-worlds", "Shifting Worlds", "The environment morphs continuously - city to forest to ocean in one shot."),
  fx("glass-shatter", "Glass Shatter", "Glass explodes in slow motion as the subject reaches through the frame."),
  fx("mirror-loop", "Mirror Loop", "The subject holds a screen showing themselves, nested to infinity."),
  rs("crystal-bloom", "Crystal Bloom", "Frosted crystalline growth creeps over the subject's silhouette."),
  fx("paper-ride", "Paper Ride", "The subject steps into a giant ticket stub and rides it out of frame."),
  rs("point-cloud", "Point Cloud", "A laser-scan pass dissolves the scene into colored depth dots."),
  fx("light-wings", "Light Wings", "Feathers drift down as luminous wings flare behind the subject."),
  fx("horizon-crowd", "Horizon Crowd", "Copies of the subject multiply to the horizon."),
  post("camera-flashes", "Camera Flashes", "A barrage of press flashes and glam wind - an instant spotlight moment.",
    { negative_prompt: "flat ambient light, dim shadows, washed out" }),
  fx("pup-fly-by", "Pup Fly-by", "A dog on a skateboard rips through the foreground mid-shot."),
  fx("frozen-rain", "Frozen Rain", "Time stops - raindrops hang mid-air while the subject keeps moving."),
  fx("screen-wall", "Screen Wall", "Reality tiles into a wall of screens, each showing the subject."),
  fx("painted-backdrop", "Painted Backdrop", "The backdrop blooms into a hand-painted fantasy castle."),
  fx("living-paint", "Living Paint", "The subject steps through an oversized painter's palette into wet color."),

  /* keyframe VFX - hidden until WS3's ltx-vfx keyframe path lands */
  kf("scatter-to-ash", "Scatter to Ash",
    "The subject's silhouette flakes into a cloud of glowing embers that drift away on the wind.",
    "the subject's edges crumble into thousands of glowing embers and ash particles that scatter on the wind, the figure disintegrating inward until only drifting dust remains, cinematic volumetric lighting",
    VFX_NEG),
  kf("rift-gate", "Rift Gate",
    "A searing energy portal tears open beside the subject and pulls them through in a streak of light.",
    "a swirling portal of electric blue energy tears open next to the subject, sparks arcing off its rim, the subject stretches into a streak of light and is pulled through as the portal snaps shut",
    VFX_NEG),
  kf("cinder-burst", "Cinder Burst",
    "A ring of fire erupts around the subject - slow-motion embers and sparks fill the frame.",
    "a ring of fire erupts outward from the subject, embers and sparks bursting in slow motion, flames curling at the frame edges with heat shimmer and drifting smoke",
    VFX_NEG),
  kf("flash-frost", "Flash Frost",
    "Ice races in from the frame edges and freezes the whole scene over in pale blue crystal.",
    "ice crystals race inward from the edges of the frame, frost crawling over the subject's skin and clothes until the entire scene freezes solid, pale blue rim light, breath fogging the air",
    VFX_NEG),
];

registerCatalog("effect", () => EFFECT_SPECS);

export const EFFECT_PRESETS: PresetDef[] = EFFECT_SPECS.map((s) => ({
  id: s.id,
  title: s.label,
  description: s.description ?? "",
  kind: "effect",
  category: "vfx",
  apply: s.apply ?? (s.mechanism.kind === "post" ? { ...s.mechanism.params } : {}),
  inputRequired: s.inputs.includes("video") ? "video" : "image",
  credits: s.credits,
  promptFragment: s.promptFragment,
  modelHint: s.modelHint,
  posterHue: hue(s.id),
  poster: posterFor("effect", s.id),
}));
