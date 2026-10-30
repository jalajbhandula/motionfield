import type { ModelDef, ParamField } from "../types";
import { firstFrame, negP, prompt, dur, arVideo, steps, finish } from "./params";
import { CORE_TRAJECTORY_IDS, TRAJECTORY } from "../presets/trajectories";

export const DRAW_TO_VIDEO: ModelDef = {
  id: "draw-to-video", label: "Sketch-guided Video · Wan VACE", vendor: "Alibaba (Wan-AI)", kind: "v2v",
  description: "Sketch on a paused frame - your drawing becomes the motion edit.",
  workflows: [{
    id: "draw", label: "Draw edit", endpointId: "motionfield/draw-to-video/v1.0", kind: "v2v",
    params: [
      { name: "video_url", label: "Source video", type: "video", required: true },
      { name: "image_url", label: "Edited frame", type: "image", required: true, accepts: "image/*", description: "The frame with your sketch/markup" },
      { name: "timestamp", label: "Frame time (s)", type: "number", required: true, min: 0, step: 0.1, description: "Second where the edited frame belongs" },
      prompt(),
      finish,
    ],
    cost: () => 20,
    // the graph loads {{FRAMES}} source frames at 16 fps - follow the clip
    sourceGeometry: { param: "video_url" },
    providers: { comfy: {
      workflow: "vace-draw.json",
      // the edited frame is a stroke on one source frame, not a subject
      // reference. DRAW_SKIP picks that frame out of the clip so OF_DrawMask
      // can diff the ink. image_url already maps to INPUT_IMAGE.
      map: (p) => {
        const t = Number(p.timestamp ?? 0);
        const skip = Number.isFinite(t) ? Math.max(0, Math.round(t * 16)) : 0;
        return { DRAW_SKIP: skip };
      },
    } },
  }],
};

/** Rig output size per aspect - both dims multiples of 16 for WanVaceToVideo. */
const CAM_DIMS: Record<string, [number, number]> = {
  "16:9": [832, 480],
  "9:16": [480, 832],
  "1:1": [624, 624],
};

const CAMERA_MOVE_PARAMS: ParamField[] = [
  firstFrame,
  prompt(false),
  dur([2, 3, 4, 5], 3),
  { ...arVideo, enum: ["16:9", "9:16", "1:1"] },
  // the trajectory stack arrives via params.moves - a "+"-joined string or
  // id array (picker sends the joined form); core ids only, see validate
  { name: "strength", label: "Move strength", type: "slider", group: "Camera", default: 1.0, min: 0.25, max: 2.0, step: 0.05 },
  { name: "distance", label: "Subject distance (m)", type: "number", group: "Camera", default: 4.0, min: 0.5, max: 20, step: 0.5 },
  { name: "fov", label: "Lens FOV (°)", type: "number", group: "Camera", default: 40, min: 10, max: 120, step: 1 },
  steps(8), negP, finish,
];

const CORE_SET: ReadonlySet<string> = new Set(CORE_TRAJECTORY_IDS);

/** The camera endpoint's param gate - runs before charge (createJob) and again
 *  inside the provider submit. `moves` is the contract: a "+"-joined stack or
 *  id array of 1-3 pose-only catalog ids (a legacy `trajectory` value is
 *  accepted). No stack at all means a locked-off shot. Strength, duration,
 *  distance and fov must sit inside their declared fields. The stack is
 *  normalised onto `params.moves` ("a+b"); `params.trajectory` is consumed. */
function camValidate(params: Record<string, unknown>): string | null {
  const raw = params.moves ?? params.trajectory;
  let ids: string[] = [];
  if (raw !== undefined && raw !== null && raw !== "") {
    if (typeof raw !== "string" && !Array.isArray(raw))
      return "moves must be a '+'-joined string or an array of move ids";
    ids = (Array.isArray(raw) ? raw : raw.split("+"))
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter(Boolean);
  }
  if (!ids.length) ids = ["locked-off"];
  if (ids.length > 3) return "moves must be 1-3 catalog move ids";
  const hidden = ids.filter((id) => TRAJECTORY.get(id)?.hidden === true);
  if (hidden.length)
    return hidden.map((id) => `${id} is not available on this endpoint`).join("; ");
  const unknown = ids.filter((id) => !TRAJECTORY.has(id));
  if (unknown.length) return `unknown trajectory moves: ${unknown.join(", ")}`;
  const rig = ids.filter((id) => !CORE_SET.has(id));
  if (rig.length)
    return `moves need the rig modes - this endpoint executes pose-only moves: ${rig.join(", ")}`;
  params.moves = ids.join("+");
  delete params.trajectory;
  // the conditioning backend is hidden while it stays unverified: "rig" (or
  // missing) is the only path a job may take - anything else is refused here,
  // before any charge. cam_scale belonged to that path; drop it silently.
  if (params.camera_path !== undefined && params.camera_path !== "rig")
    return `camera_path "${params.camera_path}" is not available on this endpoint yet`;
  delete params.cam_scale;
  for (const name of ["strength", "duration", "distance", "fov"] as const) {
    const f = CAMERA_MOVE_PARAMS.find((x) => x.name === name)!;
    const v = params[name];
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n)) return `${name} must be a number`;
    if (f.enum && !f.enum.map(Number).includes(n)) return `${name} must be one of ${f.enum.join(", ")}`;
    if (f.min !== undefined && n < f.min) return `${name} must be ≥ ${f.min}`;
    if (f.max !== undefined && n > f.max) return `${name} must be ≤ ${f.max}`;
  }
  return null;
}

/** Derived placeholders for cam-i2v.json - the pose stream runs at a fixed
 *  16 fps so CAM_FRAMES (=16·duration+1) always satisfies VACE's 4n+1, and the
 *  rig renders at VACE's own dims so control/mask sizes line up. */
function camPlaceholders(p: Record<string, unknown>): Record<string, unknown> {
  const moves = Array.isArray(p.moves) ? p.moves.join("+") : String(p.moves ?? "");
  const duration = Math.max(2, Math.min(30, Math.round(Number(p.duration) || 3)));
  const [w, h] = CAM_DIMS[String(p.aspect_ratio ?? "16:9")] ?? CAM_DIMS["16:9"];
  return {
    MOVES: moves || "locked-off",
    DURATION: String(duration),
    FPS: "16",
    CAM_FRAMES: String(duration * 16 + 1),
    CAM_W: String(w),
    CAM_H: String(h),
    DISTANCE: String(p.distance ?? 4),
    FOV: String(p.fov ?? 40),
    STRENGTH: String(p.strength ?? 1),
    // Fun path only (smoke harness): Plücker translation lever - poses are
    // metres, the conditioning expects a canonical range
    CAM_SCALE: "1",
  };
}

/** MotionField CameraRig - the trajectory stack actually re-renders the start
 *  frame; VACE fills the disocclusions. Core (pose-only) moves only. */
export const CAMERA_RIG: ModelDef = {
  id: "camera-rig", label: "CameraRig · Wan VACE", vendor: "Alibaba (Wan-AI) + MotionField", kind: "v2v",
  description: "Real camera moves: the trajectory re-renders your start frame and Wan VACE fills what the move uncovers. Open (Apache-2.0/MIT) stack.",
  workflows: [{
    id: "image-to-video", label: "Camera move", endpointId: "motionfield/camera/image-to-video", kind: "v2v",
    executesTrajectory: true,
    params: CAMERA_MOVE_PARAMS,
    validate: camValidate,
    cost: (p) => Math.max(1, Math.round(8 * ((Number(p.duration) || 3) / 5))),
    providers: {
      comfy: {
        workflow: "cam-i2v.json",
        workflowFor: (p) => (p.camera_path === "fun" ? "cam-i2v-fun.json" : undefined),
        map: camPlaceholders,
      },
    },
  }],
};

/* ---------------------------------------------------------------- re-shoot */

/** Frames a re-shoot will process at all - the graph's structural ceiling
 *  (~20 s at 24 fps); past it the submit refuses rather than truncating. */
export const RESHOOT_MAX_FRAMES = 481;
/** The local Mac budget - Wan 2.1's native 81-frame length; over it the page
 *  says "cloud recommended" and a local submit errors before charge. A
 *  measured smoke can raise it; the cloud graph carries clips to the hard
 *  cap on the user's own GPU. */
export const RESHOOT_LOCAL_MAX_FRAMES = 81;

/** Working size for a re-shoot: the source aspect fitted inside the Wan
 *  budget box (832×480 landscape, 480×832 portrait), each dim floored to a
 *  multiple of 16 - never upscaling a smaller source. */
export const RESHOOT_MAX_W = 832;
export const RESHOOT_MAX_H = 480;
export function reshootDims(w: number, h: number): [number, number] {
  const [bw, bh] = h > w ? [RESHOOT_MAX_H, RESHOOT_MAX_W] : [RESHOOT_MAX_W, RESHOOT_MAX_H];
  const s = Math.min(1, bw / w, bh / h);
  // +1e-9 rescues an exact box edge from binary float dust (w·(bw/w) ≈ bw)
  return [
    Math.max(16, Math.floor((w * s) / 16 + 1e-9) * 16),
    Math.max(16, Math.floor((h * s) / 16 + 1e-9) * 16),
  ];
}

/** Measured seconds per (frame × output pixel × sampler step) on the Mac -
 *  filled in by the re-shoot smoke in tests/artifacts/reshoot-evidence.json;
 *  the page's ETA multiplies it back out and labels itself an estimate.
 *  Measured 2026-10-25 on 73 f @832×480 Wan VACE 1.3B: ~470 s/step. */
export const RESHOOT_ETA_S_PER_PIXEL_STEP = 1.6e-5;

/** The DA3 windowed pass + matte/rig preamble that precedes sampling -
 *  ~20 min cold on a 73 f clip (first submit); warm re-submits of the same
 *  clip hit the OF_DA3Windowed session cache and skip most of it. */
export const RESHOOT_ETA_FIXED_S = 1200;

/** Moves dropped from the re-shoot picker: at full strength their rendered
 *  last frame is ~100% disoccluded holes and the subject leaves the shot -
 *  VACE would invent the whole clip, so nothing of the source is "re-shot".
 *  (CPU rig sweep: whip-pans, snap-tilt-down, drone-flyover and the
 *  motion-control sweep all end ≥98% holes; they stay in the library for
 *  prompt-text use, just not sold as clip re-shoots.) */
const RESHOOT_DROPPED: ReadonlySet<string> = new Set([
  "whip-pan-left", "whip-pan-right", "snap-tilt-down", "drone-flyover",
  "motion-control-sweep",
]);

/** Trajectory ids the clip re-shoot executes - the pose-only core set minus
 *  stills-only rows (e.g. frozen-moment-arc applies to images) and minus
 *  the all-generated drops above. High-disocclusion rows that stay offered
 *  carry an honest_note in the trajectory table and render "partial" chips. */
export const RESHOOT_TRAJECTORY_IDS: readonly string[] =
  CORE_TRAJECTORY_IDS.filter((id) => TRAJECTORY.get(id)?.inputs.includes("video")
    && !RESHOOT_DROPPED.has(id));
const RESHOOT_SET: ReadonlySet<string> = new Set(RESHOOT_TRAJECTORY_IDS);
export const isReshootMove = (id: string): boolean => RESHOOT_SET.has(id);

const RESHOOT_PARAMS: ParamField[] = [
  { name: "video_url", label: "Source clip", type: "video", required: true, accepts: "video/*", description: "Your clip - re-shot along the new path; timing stays frame-exact, source audio kept" },
  prompt(false),
  { name: "backend", label: "Engine", type: "select", enum: ["local", "cloud"], default: "local", description: "local = Mac DA3 + rig + Wan VACE · cloud = Uni3C 14B - cloud-recommended, untested (needs your own ComfyUI GPU)" },
  { name: "strength", label: "Move strength", type: "slider", group: "Camera", default: 1.0, min: 0.25, max: 2.0, step: 0.05 },
  { name: "distance", label: "Subject distance (m)", type: "number", group: "Camera", default: 4.0, min: 0.5, max: 20, step: 0.5 },
  steps(8), negP, finish,
];

/** Re-shoot gate - runs before charge (createJob) and inside provider submit.
 *  Moves must be 1-3 video-capable pose-path ids; the probe-derived fields
 *  (fps/frames/duration/width/height) are REQUIRED so a hand-built submit
 *  can't silently break the frame-exact timing claim - /api/reshoot/submit sets them
 *  from the real probe and owns that truth. */
function reshootValidate(params: Record<string, unknown>): string | null {
  const v = params.video_url;
  if (typeof v !== "string" || !/^\/files\//.test(v))
    return "video_url must be an owned /files/ upload - external refs can't be re-shot";
  if (/\.\.|\\|%|\0/i.test(v)) return "video_url: path traversal is not allowed";

  const raw = params.moves ?? params.trajectory;
  let ids: string[] = [];
  if (raw !== undefined && raw !== null && raw !== "") {
    if (typeof raw !== "string" && !Array.isArray(raw))
      return "moves must be a '+'-joined string or an array of move ids";
    ids = (Array.isArray(raw) ? raw : raw.split("+"))
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter(Boolean);
  }
  if (!ids.length) ids = ["locked-off"];
  if (ids.length > 3) return "moves must be 1-3 catalog move ids";
  const hidden = ids.filter((id) => TRAJECTORY.get(id)?.hidden === true);
  if (hidden.length)
    return hidden.map((id) => `${id} is not available on this endpoint`).join("; ");
  const unknown = ids.filter((id) => !TRAJECTORY.has(id));
  if (unknown.length) return `unknown trajectory moves: ${unknown.join(", ")}`;
  const stills = ids.filter((id) => !TRAJECTORY.get(id)!.inputs.includes("video"));
  if (stills.length)
    return `${stills.join(", ")} appl${stills.length === 1 ? "ies" : "y"} to stills - clips can't take this path`;
  const rig = ids.filter((id) => !RESHOOT_SET.has(id));
  if (rig.length)
    return `re-shoot executes pose-path moves only: ${rig.join(", ")}`;
  params.moves = ids.join("+");
  delete params.trajectory;

  if (params.backend !== undefined && params.backend !== "local" && params.backend !== "cloud")
    return `backend "${params.backend}" is not available (local or cloud)`;
  for (const name of ["strength", "distance"] as const) {
    const f = RESHOOT_PARAMS.find((x) => x.name === name)!;
    const v2 = params[name];
    if (v2 === undefined || v2 === null || v2 === "") continue;
    const n = Number(v2);
    if (!Number.isFinite(n)) return `${name} must be a number`;
    if (f.min !== undefined && n < f.min) return `${name} must be ≥ ${f.min}`;
    if (f.max !== undefined && n > f.max) return `${name} must be ≤ ${f.max}`;
  }
  // probe-derived fields - the submit route owns these; missing or malformed
  // means the caller bypassed the probe and the frame-exact claim can't be verified
  const frames = Number(params.frames);
  if (!Number.isInteger(frames) || frames < 2 || frames > RESHOOT_MAX_FRAMES)
    return `frames must be an integer 2..${RESHOOT_MAX_FRAMES} (from the source probe)`;
  if (params.backend !== "cloud" && frames > RESHOOT_LOCAL_MAX_FRAMES)
    return `frames ≤ ${RESHOOT_LOCAL_MAX_FRAMES} on local - cloud takes up to ${RESHOOT_MAX_FRAMES}`;
  const fps = Number(params.fps);
  if (!Number.isFinite(fps) || fps < 1 || fps > 60)
    return "fps must be 1..60 - the clip loader's force_rate tops out there (from the source probe)";
  const duration = Number(params.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 31)
    return "duration must be 0..31 s (from the source probe)";
  for (const dim of ["width", "height"] as const) {
    const n = Number(params[dim]);
    if (!Number.isInteger(n) || n < 16 || n > 4096 || n % 16)
      return `${dim} must be a multiple of 16, 16..4096`;
  }
  // the working box is the Wan budget on either backend - bigger re-shoots
  // are refused, not silently downscaled inside the graph
  if (Number(params.width) * Number(params.height) > RESHOOT_MAX_W * RESHOOT_MAX_H)
    return `re-shoot renders inside ${RESHOOT_MAX_W}×${RESHOOT_MAX_H} - width×height ${params.width}×${params.height} is over it`;
  const res = params.da3_res === undefined ? 504 : Number(params.da3_res);
  if (!Number.isInteger(res) || res < 140 || res > 2520 || res % 14)
    return "da3_res must be a multiple of 14, 140..2520";
  return null;
}

/** Probe-derived placeholders for reshoot-{video,uni3c}.json - the frame
 *  stream keeps the source's own count and rate; PAD_FRAMES is the 4n+1 the
 *  latent wants (the decode trims the tail back to FRAMES). */
function reshootPlaceholders(p: Record<string, unknown>): Record<string, unknown> {
  const moves = Array.isArray(p.moves) ? p.moves.join("+") : String(p.moves ?? "");
  const frames = Math.round(Number(p.frames) || 49);
  const fps = Number(p.fps) || 24;
  return {
    MOVES: moves || "locked-off",
    STRENGTH: String(p.strength ?? 1),
    DISTANCE: String(p.distance ?? 4),
    PROMPT: String(p.prompt ?? p.text ?? "natural motion, the same action"),
    NEGATIVE: String(p.negative_prompt ?? "worst quality, inconsistent motion, blurry, jittery, distorted"),
    FPS: String(fps),
    FRAMES: String(frames),
    PAD_FRAMES: String(frames + ((4 - ((frames - 1) % 4)) % 4)),
    DURATION: String((frames - 1) / fps),
    WIDTH: String(Math.round(Number(p.width) || 480)),
    HEIGHT: String(Math.round(Number(p.height) || 272)),
    DA3_RES: String(Math.round(Number(p.da3_res) || 504)),
    STEPS: String(p.steps ?? 8),
  };
}

/** Re-shoot - the same action from a new camera path. DA3 recovers the
 *  source camera; the composed path re-anchors on its first pose; the rig
 *  re-projects each frame through its own recovered pose and splats along
 *  the new one; VACE fills only the disocclusions. The source audio track
 *  is muxed back on; frame count and fps are preserved. */
export const RESHOOT: ModelDef = {
  id: "reshoot", label: "New Camera Move · DA3 + Wan VACE", vendor: "ByteDance (DA3) + Alibaba (Wan-AI) + MotionField", kind: "v2v",
  description: "Your clip, a new camera path - the source's own move is replaced, timing stays frame-exact, source audio kept. Open (Apache-2.0/MIT) stack.",
  workflows: [{
    id: "reshoot-video", label: "New Camera Move", endpointId: "motionfield/reshoot/video", kind: "v2v",
    executesTrajectory: true,
    params: RESHOOT_PARAMS,
    validate: reshootValidate,
    cost: (p) => Math.max(1, Math.round(10 * (Number(p.frames) || 49) / 81)),
    providers: {
      comfy: {
        workflow: "reshoot-video.json",
        workflowFor: (p) => (p.backend === "cloud" ? "reshoot-uni3c.json" : undefined),
        variantParam: { name: "backend", values: ["local", "cloud"] },
        map: reshootPlaceholders,
      },
    },
  }],
};

/** Ordered catalog contribution of this file - barrels concatenate these. */
export const VIDEO_CAMERA_MODELS: ModelDef[] = [DRAW_TO_VIDEO, CAMERA_RIG, RESHOOT];
