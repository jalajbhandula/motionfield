import type { ModelDef, ParamField, WorkflowDef } from "../types";
import { prompt, dur, resV, fps, steps, negP, firstFrame, per5s, finish } from "./params";
import { vfxPresetById, vfxPresetVerified } from "../presets/vfx-lab";

export const LTX_VFX: ModelDef = {
  id: "ltx-vfx", label: "LTX-2.5 · Visual Effects", vendor: "Lightricks", kind: "video",
  description: "Keyframe-locked visual effects on LTX-2.5 - a first-frame image drives the effect, an optional last-frame image pins where it lands.",
  workflows: [
    { id: "vfx-keyframe", label: "Visual effects keyframe", endpointId: "motionfield/ltx-video/vfx-keyframe", kind: "video",
      params: [firstFrame,
        { name: "end_image_url", label: "Last frame (optional)", type: "image", accepts: "image/*", description: "Optional end keyframe - the clip resolves onto this frame." },
        prompt(false), dur([3, 4, 5], 4), resV(["480p", "720p"], "480p"), fps, negP, finish],
      cost: per5s({ "480p": 4, "720p": 7 }),
      providers: { comfy: { workflow: "ltx-vfx-keyframe.json" } } },
  ],
};

/* ------------------------------------------------------------------ */
/* VFX Lab (ws3 s10) - effect passes over your own plate.               */
/*                                                                      */
/* Engines: LTX-Video 2B does the plate/image runs - the distilled       */
/* 0.9.8 checkpoint only when its exact file is installed; the 0.9.5    */
/* checkpoint drives a classic partial-denoise vid2vid. The Wan VACE    */
/* 1.3B alternative is the Apache-2.0 option (structure controls:        */
/* depth / pose / edges / image keyframes).                              */
/* ------------------------------------------------------------------ */

export const VFX_LTX_ENGINES = ["ltx098", "ltx095"] as const;
export type VfxEngine = (typeof VFX_LTX_ENGINES)[number];

/** How hard the run may depart from the plate - sigma tail on the
 *  distilled schedule, denoise on the classic. "full" regenerates and
 *  still pins plate frame 0. */
export const VFX_PLATE_LOCKS = ["light", "medium", "strong", "full"] as const;
export type VfxPlateLock = (typeof VFX_PLATE_LOCKS)[number];

/** Plate frames pinned as the opening guide - 0 = no hold guide. The
 *  choices are 8n+1 counts, what LTXVAddGuide accepts for video guides. */
export const VFX_HOLDS = [0, 9, 17, 25] as const;

export const VFX_ALT_STRUCTURES = ["depth", "pose", "edges", "image"] as const;
export type VfxAltStructure = (typeof VFX_ALT_STRUCTURES)[number];
export const VFX_ALT_LENGTHS = ["preview", "full"] as const;
export type VfxAltLength = (typeof VFX_ALT_LENGTHS)[number];

export const VFX_FPS = 24;            // LTX rate - plates resample to it
export const VFX_ALT_FPS = 16;        // VACE's native rate
export const VFX_MIN_PLATE_SEC = 0.7;
export const VFX_MAX_PLATE_SEC = 10;
export const VFX_MAX_PLATE_FRAMES = 241; // vfxFrames(10s)=233 → next 8n+1 cap
export const VFX_ALT_PREVIEW_FRAMES = 33;
export const VFX_ALT_MAX_FRAMES = 81;

/** Distilled-2B latent-token budget per run on this Mac (temporal × spatial).
 *  97 frames at the 832×480 box fits comfortably; 10 s at 480p shrinks the
 *  working dims until it fits - probe-derived, never silently exceeded. */
export const VFX_LTX_TOKEN_CAP = 7000;

/** Render boxes per resolution pick - the source aspect fits inside,
 *  landscape or portrait, then the token cap may shrink it further. */
export const VFX_RES_BOXES: Record<string, [number, number]> = {
  "480p": [832, 480],
  "720p": [1280, 704],
};

/** The distilled-0.9.8 schedule - every lock level is a tail of it
 *  (light keeps only the last interval; full runs it all). */
export const LTX098_SIGMAS = [1.0, 0.9937, 0.9875, 0.9812, 0.975, 0.9094, 0.725, 0.4219, 0.0] as const;
export const VFX_LOCK_SIGMAS: Record<VfxPlateLock, readonly number[]> = {
  light: [0.4219, 0.0],
  medium: [0.725, 0.4219, 0.0],
  strong: [0.9094, 0.725, 0.4219, 0.0],
  full: LTX098_SIGMAS,
};
/** Same lock levels expressed as the classic path's denoise. */
export const VFX_LOCK_DENOISE: Record<VfxPlateLock, number> = {
  light: 0.4, medium: 0.6, strong: 0.8, full: 1.0,
};

export const VFX_LTX098_FILE = "ltxv-2b-0.9.8-distilled.safetensors";
export const VFX_LTX098_BYTES = 6_340_744_492;
export const VFX_LTX098_SHA256 = "76aa8c4786af752fa6f951947129d5290c3c6c0b2fadcadea6b5e114ae2cad8f";

const nodeGet = (m: string) => globalThis.process?.getBuiltinModule?.(m) as
  | Record<string, unknown> | undefined;

/** The distilled engine exists only when its exact checkpoint sits in
 *  ComfyUI's checkpoints dir - name + byte size pinned, so an absent or
 *  partial download stays hidden. The app never installs it itself, and a
 *  present file is what licenses of-licenses-v2 + the endpoint's licence row. */
export function ltx098Installed(): boolean {
  const fs = nodeGet("node:fs") as typeof import("node:fs") | undefined;
  const os = nodeGet("node:os") as typeof import("node:os") | undefined;
  const path = nodeGet("node:path") as typeof import("node:path") | undefined;
  if (!fs || !os || !path) return false;
  const root = process.env.COMFYUI_DIR ?? path.join(os.homedir(), "comfy", "ComfyUI");
  try {
    return fs.statSync(path.join(root, "models", "checkpoints", VFX_LTX098_FILE)).size === VFX_LTX098_BYTES;
  } catch {
    return false;
  }
}

/** Largest 8n+1 count at 24 fps no bigger than `sec` (LTX temporal patch) -
 *  minimum 17 so even a sub-second plate runs a real clip. */
export function vfxFrames(sec: number): number {
  const target = Math.round(sec * VFX_FPS);
  return Math.max(17, Math.floor((target - 1) / 8) * 8 + 1);
}

/** Latent tokens the LTX run consumes: 32× spatial, 8× temporal (+1 lead). */
export function vfxTokens(frames: number, w: number, h: number): number {
  return (Math.floor((frames - 1) / 8) + 1) * (w / 32) * (h / 32);
}

/** Working dims: source aspect inside the res box (landscape or portrait),
 *  multiples of 32, never upscaled - then shrunk (aspect kept) until the
 *  latent-token count fits the local budget. */
export function vfxDims(srcW: number, srcH: number, res = "480p", frames = 97): [number, number] {
  const [bw0, bh0] = VFX_RES_BOXES[res] ?? VFX_RES_BOXES["480p"];
  const [bw, bh] = srcH > srcW ? [bh0, bw0] : [bw0, bh0];
  let s = Math.min(1, bw / srcW, bh / srcH);
  let w = Math.max(32, Math.floor((srcW * s) / 32 + 1e-9) * 32);
  let h = Math.max(32, Math.floor((srcH * s) / 32 + 1e-9) * 32);
  for (let i = 0; i < 400 && vfxTokens(frames, w, h) > VFX_LTX_TOKEN_CAP && w > 32 && h > 32; i++) {
    s *= 0.94;
    w = Math.max(32, Math.floor((srcW * s) / 32 + 1e-9) * 32);
    h = Math.max(32, Math.floor((srcH * s) / 32 + 1e-9) * 32);
  }
  return [w, h];
}

/** Working dims for the Wan VACE alt - same fit inside the Wan box, multiples
 *  of 16 (VACE's own latent patch). */
export function vfxAltDims(srcW: number, srcH: number): [number, number] {
  const [bw, bh] = srcH > srcW ? [480, 832] : [832, 480];
  const s = Math.min(1, bw / srcW, bh / srcH);
  return [
    Math.max(16, Math.floor((srcW * s) / 16 + 1e-9) * 16),
    Math.max(16, Math.floor((srcH * s) / 16 + 1e-9) * 16),
  ];
}

/** Frame count the alt run takes from the plate at 16 fps. */
export function vfxAltFrames(sec: number, len: VfxAltLength): number {
  const at16 = Math.max(1, Math.floor((Math.round(sec * VFX_ALT_FPS) - 1) / 4) * 4 + 1);
  return Math.min(len === "full" ? VFX_ALT_MAX_FRAMES : VFX_ALT_PREVIEW_FRAMES, at16);
}

/** Measured local rate - s/(latent token × sampler step) - from the LTX
 *  keyframe smoke (864×480×17f×6st ≈ 81 s → ~0.0111, cfg 3 included). The
 *  distilled engine is cfg-free - roughly half the per-step cost; its factor
 *  is a promise, not a measurement (the weights aren't on this Mac). The
 *  page labels every number an estimate. */
export const VFX_ETA_S_PER_TOKEN_STEP = 0.0111;
export const VFX_LTX_STEPS = 8;
export function vfxEtaSec(engine: VfxEngine, frames: number, w: number, h: number): number {
  return vfxTokens(frames, w, h) * VFX_LTX_STEPS * VFX_ETA_S_PER_TOKEN_STEP * (engine === "ltx095" ? 1 : 0.5);
}
/** Wan-alt estimate - measured on this Mac's VACE smoke rows
 *  (480×272×17f×6st ≈ 224-425 s → ~0.005 mid). */
export const VFX_ALT_ETA_S_PER_TOKEN_STEP = 0.005;
export function vfxAltEtaSec(frames: number, w: number, h: number): number {
  return (Math.floor((frames - 1) / 4) + 1) * (w / 8) * (h / 8) * 6 * VFX_ALT_ETA_S_PER_TOKEN_STEP;
}

const VFX_ENGINE_PARAM: ParamField = {
  name: "engine", label: "Engine", type: "select", default: "ltx095",
  enum: [...VFX_LTX_ENGINES],
  description: "ltx095 - LTX-Video 2B v0.9.5 (on this Mac) · ltx098 - the distilled 0.9.8 checkpoint, only when that exact file is installed",
};
const VFX_LOCK_PARAM: ParamField = {
  name: "plate_lock", label: "Plate lock", type: "select", default: "medium",
  enum: [...VFX_PLATE_LOCKS],
  description: "how hard the run may depart from the plate - sigma tail (distilled) or denoise (classic); full regenerates and still pins frame 0",
};
const VFX_HOLD_PARAM: ParamField = {
  name: "hold", label: "Hold plate", type: "select", default: 9,
  enum: [...VFX_HOLDS],
  description: "plate frames pinned as the opening guide - 0 runs no hold guide",
};
const VFX_TARGET_PARAM: ParamField = {
  name: "end_image_url", label: "Target frame (optional)", type: "image", accepts: "image/*",
  description: "an end keyframe - the run resolves onto this frame (frame 0..len-1)",
};
const VFX_TARGET_STRENGTH: ParamField = {
  name: "target_strength", label: "Target strength", type: "slider", default: 0.8, min: 0.5, max: 1.0, step: 0.05,
  description: "how hard the target frame pulls - only applies when one is set",
};

const VFX_PLATE_KEYS = new Set([
  "video_url", "prompt", "negative_prompt", "engine", "plate_lock", "hold",
  "end_image_url", "target_strength", "resolution", "steps", "seed",
  "frames", "fps", "duration", "width", "height", "denoise", "sigmas",
  "vfx_preset", "pair_of", "finish",
]);

function vfxLock(p: Record<string, unknown>): VfxPlateLock {
  const l = String(p.plate_lock ?? "medium");
  return (VFX_PLATE_LOCKS as readonly string[]).includes(l) ? (l as VfxPlateLock) : "medium";
}

function vfxEngine(p: Record<string, unknown>): VfxEngine {
  return p.engine === "ltx098" ? "ltx098" : "ltx095";
}

/** Effective hold frames - "full" lock always pins plate frame 0 (a 1-frame
 *  guide) even when the pick says 0. */
function vfxHold(p: Record<string, unknown>): number {
  const h = Number(p.hold ?? 9);
  return vfxLock(p) === "full" ? Math.max(1, h) : h;
}

function checkEndImage(p: Record<string, unknown>): string | null {
  if (p.end_image_url === undefined || p.end_image_url === null || p.end_image_url === "") return null;
  const e = p.end_image_url;
  if (typeof e !== "string" || !/^\/files\//.test(e)) return "end_image_url must be an owned /files/ asset";
  if (/\.\.|\\|%|\0/i.test(e)) return "end_image_url: path traversal is not allowed";
  return null;
}

function checkMediaRef(p: Record<string, unknown>, key: "video_url" | "image_url"): string | null {
  const v = p[key];
  if (typeof v !== "string" || !/^\/files\//.test(v))
    return `${key} must be an owned /files/ upload - external refs can't run here`;
  if (/\.\.|\\|%|\0/i.test(v)) return `${key}: path traversal is not allowed`;
  return null;
}

function checkDims(p: Record<string, unknown>, mod = 32): string | null {
  for (const d of ["width", "height"] as const) {
    const n = Number(p[d]);
    if (!Number.isInteger(n) || n < 32 || n > 4096 || n % mod)
      return `${d} must be a multiple of ${mod}, 32-4096`;
  }
  return null;
}

function checkPreset(p: Record<string, unknown>): string | null {
  if (p.vfx_preset === undefined || p.vfx_preset === null || p.vfx_preset === "") return null;
  const id = p.vfx_preset;
  if (typeof id !== "string" || !vfxPresetById(id)) return "unknown vfx preset";
  if (!vfxPresetVerified(id)) return `vfx preset "${id}" has no verified record - the page only ships verified presets`;
  return null;
}

/** Shared lock/engine/denoise/sigmas checks for the two LTX endpoints -
 *  `lock` is the caller's pick on the plate endpoint and always "full" on
 *  the image endpoint (a still has no plate to hold - the run is a full
 *  generation either way). */
function checkEngine(p: Record<string, unknown>, lock: VfxPlateLock): string | null {
  const engine = vfxEngine(p);
  if (p.engine !== undefined && !(VFX_LTX_ENGINES as readonly string[]).includes(String(p.engine)))
    return `engine "${p.engine}" is not an LTX VFX engine`;
  if (engine === "ltx098" && !ltx098Installed())
    return "ltx098 isn't installed - the distilled checkpoint is gated to the exact file; run ltx095 or the wan-alt";
  if (engine === "ltx095") {
    // the lock table owns the diffusion strength - a hand-built denoise that
    // doesn't match the lock is refused, never silently normalised
    if (p.denoise !== undefined && Math.abs(Number(p.denoise) - VFX_LOCK_DENOISE[lock]) > 1e-9)
      return `denoise ${p.denoise} doesn't match plate_lock ${lock} (${VFX_LOCK_DENOISE[lock]})`;
  } else if (p.sigmas !== undefined && String(p.sigmas) !== VFX_LOCK_SIGMAS[lock].join(", ")) {
    return `sigmas don't match the ${lock} tail of the distilled schedule`;
  }
  if (p.hold !== undefined && !(VFX_HOLDS as readonly number[]).includes(Number(p.hold)))
    return `hold must be one of ${VFX_HOLDS.join(", ")}`;
  if (p.target_strength !== undefined) {
    const ts = Number(p.target_strength);
    if (!Number.isFinite(ts) || ts < 0.5 || ts > 1.0) return "target_strength must be 0.5-1.0";
  }
  if (p.steps !== undefined) {
    const st = Number(p.steps);
    if (!Number.isInteger(st) || st < 2 || st > 50) return "steps must be 2-50";
  }
  if (p.resolution !== undefined && !VFX_RES_BOXES[String(p.resolution)])
    return `resolution "${p.resolution}" is not a VFX res`;
  const fpsN = Number(p.fps);
  if (p.fps !== undefined && Math.abs(fpsN - VFX_FPS) > 1e-6)
    return `fps must be ${VFX_FPS} - the plate resamples to the LTX rate`;
  return checkPreset(p);
}

/** The plate endpoint's gate - a strict key list first (a submit that can't
 *  name its controls doesn't get in: no workflow/ckpt/sigmas smuggling),
 *  then the probe-stamped fields a hand-rolled caller can't fake. */
function vfxPlateValidate(p: Record<string, unknown>): string | null {
  for (const k of Object.keys(p))
    if (!VFX_PLATE_KEYS.has(k)) return `unexpected param ${k}`;
  const bad = checkMediaRef(p, "video_url") ?? checkEndImage(p) ?? checkEngine(p, vfxLock(p));
  if (bad) return bad;
  // probe-derived fields - the submit route owns these; missing or malformed
  // means the caller bypassed the probe and the plate truth can't be verified
  const frames = Number(p.frames);
  if (!Number.isInteger(frames) || frames < 17 || frames > VFX_MAX_PLATE_FRAMES)
    return `frames must be an integer 17-${VFX_MAX_PLATE_FRAMES} (from the plate probe)`;
  if ((frames - 1) % 8 !== 0) return `frames must be 8n+1 (got ${frames})`;
  const fps = Number(p.fps);
  if (!Number.isFinite(fps) || fps !== VFX_FPS) return `fps must be ${VFX_FPS}`;
  const duration = Number(p.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > VFX_MAX_PLATE_SEC)
    return `duration must be ≤ ${VFX_MAX_PLATE_SEC} s (from the plate probe)`;
  const dims = checkDims(p);
  if (dims) return dims;
  if (vfxTokens(frames, Number(p.width), Number(p.height)) > VFX_LTX_TOKEN_CAP)
    return `frames×dims are over the ${VFX_LTX_TOKEN_CAP}-token budget - shorter plate or 480p`;
  return null;
}

const VFX_IMAGE_KEYS = new Set([
  "image_url", "prompt", "negative_prompt", "engine", "end_image_url",
  "target_strength", "resolution", "duration", "steps", "seed",
  "frames", "fps", "width", "height", "denoise", "sigmas",
  "vfx_preset", "pair_of", "finish",
]);

/** The image endpoint's gate - the plate here is a still; `duration` is the
 *  ONLY honest length knob (the route stamps frames/fps from it). */
function vfxImageValidate(p: Record<string, unknown>): string | null {
  for (const k of Object.keys(p))
    if (!VFX_IMAGE_KEYS.has(k)) return `unexpected param ${k}`;
  const bad = checkMediaRef(p, "image_url") ?? checkEndImage(p) ?? checkEngine(p, "full");
  if (bad) return bad;
  const durN = Number(p.duration);
  if (!Number.isFinite(durN) || durN < 2 || durN > 5)
    return "duration must be 2-5 s - the still has no length of its own";
  const frames = Number(p.frames);
  if (!Number.isInteger(frames) || frames < 17 || frames > VFX_MAX_PLATE_FRAMES || (frames - 1) % 8 !== 0)
    return "frames must be an 8n+1 count (route derives it from duration)";
  const fps = Number(p.fps);
  if (!Number.isFinite(fps) || fps !== VFX_FPS) return `fps must be ${VFX_FPS}`;
  const dims = checkDims(p);
  if (dims) return dims;
  if (vfxTokens(frames, Number(p.width), Number(p.height)) > VFX_LTX_TOKEN_CAP)
    return `frames×dims are over the ${VFX_LTX_TOKEN_CAP}-token budget`;
  return null;
}

const VFX_ALT_KEYS = new Set([
  "video_url", "image_url", "end_image_url", "prompt", "negative_prompt",
  "structure", "alt_length", "seed", "frames", "fps", "duration",
  "width", "height", "vfx_preset", "pair_of", "finish",
]);

/** The Wan VACE alt's gate - video plates take a structure control; image
 *  plates take the first(+last) keyframe variant. Exactly one plate kind. */
function vfxAltValidate(p: Record<string, unknown>): string | null {
  for (const k of Object.keys(p))
    if (!VFX_ALT_KEYS.has(k)) return `unexpected param ${k}`;
  const structure = String(p.structure ?? "");
  if (!(VFX_ALT_STRUCTURES as readonly string[]).includes(structure))
    return `structure "${p.structure}" is not a VACE structure (depth | pose | edges | image)`;
  const hasVideo = typeof p.video_url === "string" && p.video_url !== "";
  const hasImage = typeof p.image_url === "string" && p.image_url !== "";
  if (hasVideo === hasImage) return "the alt needs exactly one plate - a clip or a still, not both";
  if (structure === "image" && !hasImage)
    return `structure "image" needs an image plate - video plates take depth | pose | edges`;
  if (structure !== "image" && !hasVideo)
    return `structure "${structure}" needs a video plate - stills take "image"`;
  if (hasVideo) { const b = checkMediaRef(p, "video_url"); if (b) return b; }
  if (hasImage) { const b = checkMediaRef(p, "image_url"); if (b) return b; }
  const len = String(p.alt_length ?? "preview");
  if (!(VFX_ALT_LENGTHS as readonly string[]).includes(len))
    return `alt_length "${p.alt_length}" is not preview | full`;
  const frames = Number(p.frames);
  if (!Number.isInteger(frames) || frames < 5 || frames > VFX_ALT_MAX_FRAMES)
    return `frames must be an integer 5-${VFX_ALT_MAX_FRAMES} (route derives from the probe)`;
  if ((frames - 1) % 4 !== 0) return `frames must be 4n+1 for VACE (got ${frames})`;
  const fps = Number(p.fps);
  if (!Number.isFinite(fps) || fps !== VFX_ALT_FPS) return `fps must be ${VFX_ALT_FPS}`;
  const durN = Number(p.duration);
  if (!Number.isFinite(durN) || durN <= 0 || durN > VFX_MAX_PLATE_SEC)
    return `duration must be ≤ ${VFX_MAX_PLATE_SEC} s (from the plate probe)`;
  const dims = checkDims(p, 16); // the alt fits to 16s - comfortably inside the Wan VAE's 8× spatial need
  if (dims) return dims;
  if (structure === "image") {
    // the end keyframe is optional - it may carry either the plate image or
    // a made target; the route resolves it before the graph sees it
    const b = checkEndImage(p);
    if (b) return b;
  }
  return checkPreset(p);
}

/** Plate-map placeholders - the lock decides the diffusion strength (sigma
 *  tail on distilled / denoise on classic) and the hold-guide branch drops
 *  entirely at hold 0. End frames pin on the last generated frame. */
function vfxPlatePlaceholders(p: Record<string, unknown>): Record<string, unknown> {
  const lock = vfxLock(p);
  const engine = vfxEngine(p);
  const hold = vfxHold(p);
  const frames = Number(p.frames) || 17;
  return {
    LTX098_CKPT: engine === "ltx098" ? VFX_LTX098_FILE : undefined,
    INPUT_VIDEO: p.video_url,
    PROMPT: String(p.prompt ?? p.text ?? "natural motion"),
    NEGATIVE: String(p.negative_prompt ?? "blur, distortion, low quality, watermark"),
    FPS: String(VFX_FPS),
    FRAMES: String(frames),
    WIDTH: String(p.width ?? 832),
    HEIGHT: String(p.height ?? 480),
    SIGMAS: VFX_LOCK_SIGMAS[lock].join(", "),
    DENOISE: String(VFX_LOCK_DENOISE[lock]),
    STEPS: String(p.steps ?? VFX_LTX_STEPS),
    END_IMAGE: p.end_image_url,
    END_FRAME: p.end_image_url ? String(frames - 1) : undefined,
    TARGET_STRENGTH: String(p.target_strength ?? 0.8),
    HOLD_FRAMES: hold > 0 ? String(hold) : undefined,
    HOLD_IDX: hold > 0 ? "0" : undefined,
    PREFIX: `of_vfx_${engine}_${lock}`,
  };
}

function vfxImagePlaceholders(p: Record<string, unknown>): Record<string, unknown> {
  const engine = vfxEngine(p);
  const frames = Number(p.frames) || 49;
  return {
    LTX098_CKPT: engine === "ltx098" ? VFX_LTX098_FILE : undefined,
    INPUT_IMAGE: p.image_url,
    PROMPT: String(p.prompt ?? p.text ?? "natural motion"),
    NEGATIVE: String(p.negative_prompt ?? "blur, distortion, low quality, watermark"),
    FPS: String(VFX_FPS),
    FRAMES: String(frames),
    WIDTH: String(p.width ?? 832),
    HEIGHT: String(p.height ?? 480),
    SIGMAS: LTX098_SIGMAS.join(", "),      // image plates always run the full schedule
    STEPS: String(p.steps ?? VFX_LTX_STEPS),
    END_IMAGE: p.end_image_url,
    END_FRAME: p.end_image_url ? String(frames - 1) : undefined,
    TARGET_STRENGTH: String(p.target_strength ?? 0.8),
    PREFIX: `of_vfx_${engine}_img`,
  };
}

function vfxAltPlaceholders(p: Record<string, unknown>): Record<string, unknown> {
  const structure = String(p.structure ?? "depth");
  const frames = Number(p.frames) || 33;
  return {
    INPUT_VIDEO: p.video_url,
    INPUT_IMAGE: p.image_url,
    // with no target, the last frame's control slot carries the plate image
    // itself - the mask marks it reactive (generate), so it's inert either way
    END_IMAGE: p.end_image_url ?? p.image_url,
    END_MASK: p.end_image_url ? "0" : "16777215",
    PROMPT: String(p.prompt ?? p.text ?? "natural motion"),
    NEGATIVE: String(p.negative_prompt ?? "worst quality, inconsistent motion, blurry, jittery, distorted"),
    FPS: String(VFX_ALT_FPS),
    FRAMES: String(frames),
    FRAMES_M2: String(Math.max(1, frames - 2)),
    WIDTH: String(p.width ?? 832),
    HEIGHT: String(p.height ?? 480),
    STEPS: "6",
    SEED: String(p.seed ?? 7),
    PREFIX: `of_vfx_wan_${structure}`,
  };
}

const VFX_PLATE_COST = (p: Record<string, unknown>) =>
  Math.max(1, Math.ceil(((Number(p.frames) || 97) / 97) * (String(p.resolution) === "720p" ? 7 : 4)));
const VFX_IMAGE_COST = (p: Record<string, unknown>) =>
  Math.max(1, Math.ceil(((Number(p.frames) || 73) / 97) * (String(p.resolution) === "720p" ? 7 : 4)));
const VFX_ALT_COST = (p: Record<string, unknown>) =>
  String(p.alt_length ?? "preview") === "full" ? 6 : 2;

const VFX_PLATE_PARAMS: ParamField[] = [
  { name: "video_url", label: "Plate - a clip", type: "video", required: true, accepts: "video/*",
    description: "0.7-10 s; timing stays the plate's own - the run can't drift its length" },
  prompt(false),
  VFX_ENGINE_PARAM, VFX_LOCK_PARAM, VFX_HOLD_PARAM,
  VFX_TARGET_PARAM, VFX_TARGET_STRENGTH,
  resV(["480p", "720p"], "480p"), steps(8), negP, finish,
];

const VFX_IMAGE_PARAMS: ParamField[] = [
  { name: "image_url", label: "Plate - a still", type: "image", required: true, accepts: "image/*" },
  prompt(false), VFX_ENGINE_PARAM,
  dur([2, 3, 4, 5], 3),
  VFX_TARGET_PARAM, VFX_TARGET_STRENGTH,
  resV(["480p", "720p"], "480p"), steps(8), negP, finish,
];

const VFX_ALT_PARAMS: ParamField[] = [
  { name: "video_url", label: "Plate - a clip", type: "video", accepts: "video/*",
    description: "for depth/pose/edges structures - the clip supplies the structure" },
  { name: "image_url", label: "Plate - a still", type: "image", accepts: "image/*",
    description: "for the image structure - a first (+ optional last) keyframe" },
  { name: "end_image_url", label: "End keyframe (optional)", type: "image", accepts: "image/*" },
  { name: "structure", label: "Structure", type: "select", default: "depth",
    enum: [...VFX_ALT_STRUCTURES],
    description: "what guides the generation - the plate's depth map, pose, edge map, or image keyframes" },
  { name: "alt_length", label: "Length", type: "select", default: "preview",
    enum: [...VFX_ALT_LENGTHS],
    description: "preview ≈ 2 s (33 frames) · full ≈ up to 5 s (81 frames) - the VACE budget at 16 fps" },
  prompt(false), negP,
];

/** VFX Lab - the plate endpoints ride LTX_VFX's model card; the alt gets its
 *  own card so the Apache alternative is visible as such. Both are honest
 *  about what is on this Mac: ltx098's weights aren't - its option only
 *  exists when the exact checkpoint file does. */
const VFX_LAB_PLATE: WorkflowDef = {
  id: "vfx-lab-plate", label: "Visual effects · plate", endpointId: "motionfield/ltx-video/vfx-lab-plate", kind: "v2v",
  params: VFX_PLATE_PARAMS,
  validate: vfxPlateValidate,
  cost: VFX_PLATE_COST,
  providers: {
    comfy: {
      workflow: "vfx-ltx-plate-classic.json",
      workflowFor: (p) => (p.engine === "ltx098" ? "vfx-ltx-plate.json" : undefined),
      variantParam: { name: "engine", values: VFX_LTX_ENGINES },
      map: vfxPlatePlaceholders,
    },
  },
};
const VFX_LAB_IMAGE: WorkflowDef = {
  id: "vfx-lab-image", label: "Visual effects · image plate", endpointId: "motionfield/ltx-video/vfx-lab-image", kind: "v2v",
  params: VFX_IMAGE_PARAMS,
  validate: vfxImageValidate,
  cost: VFX_IMAGE_COST,
  providers: {
    comfy: {
      workflow: "vfx-ltx-image-classic.json",
      workflowFor: (p) => (p.engine === "ltx098" ? "vfx-ltx-image.json" : undefined),
      variantParam: { name: "engine", values: VFX_LTX_ENGINES },
      map: vfxImagePlaceholders,
    },
  },
};

export const VFX_ALT: ModelDef = {
  id: "vfx-alt", label: "Visual Effects alt · Wan VACE", vendor: "Alibaba (Wan-AI)", kind: "v2v",
  description: "The Apache-2.0 option - Wan 2.1 VACE 1.3B driven by the plate's own structure (depth / pose / edges) or first+last keyframes.",
  workflows: [{
    id: "vfx-lab-alt", label: "Visual effects · Wan alt", endpointId: "motionfield/wan-vace/vfx-lab-alt", kind: "v2v",
    params: VFX_ALT_PARAMS,
    validate: vfxAltValidate,
    cost: VFX_ALT_COST,
    providers: {
      comfy: {
        workflow: "vfx-wan-alt-depth.json",
        workflowFor: (p) => {
          const s = String(p.structure ?? "depth");
          return `vfx-wan-alt-${(VFX_ALT_STRUCTURES as readonly string[]).includes(s) ? s : "depth"}.json`;
        },
        variantParam: { name: "structure", values: VFX_ALT_STRUCTURES },
        map: vfxAltPlaceholders,
      },
    },
  }],
};

/** Ordered catalog contribution of this file - barrels concatenate these. */
export const VIDEO_VFX_MODELS: ModelDef[] = [
  { ...LTX_VFX, workflows: [...LTX_VFX.workflows, VFX_LAB_PLATE, VFX_LAB_IMAGE] },
  VFX_ALT,
];
