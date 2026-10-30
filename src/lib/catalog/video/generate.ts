import type { ModelDef, ParamField } from "../types";
import {
  prompt, dur, arVideo, resV, audioBool, negP, fps, steps, firstFrame, camMove, per5s, finish,
} from "./params";
import { COLOR_PALETTES } from "../presets/palettes";
import {
  DIRECTOR_BACKENDS, DIRECTOR_LENS_IDS, DIRECTOR_SENSORS,
  DIRECTOR_APERTURE_IDS, DIRECTOR_BODIES,
  DIRECTOR_EMOTIONS, EMOTION_INTENSITIES,
  DIRECTOR_ERAS, DIRECTOR_GENRES, DIRECTOR_PACING,
  directorFov, apertureBlur, directorClauses, parseLights, directorPost,
  directorBackendFor,
} from "../presets/director";
import { resolveMoves } from "@/lib/camera/moves";
import { KEYFRAME_MOVE_IDS } from "@/lib/camera/keyframe-moves";

export const LTX_VIDEO: ModelDef = {
  id: "ltx-video", label: "LTX-2.5 - LTX-2.x Community License", vendor: "Lightricks", kind: "video",
  description: "LTX-2.5 22B distilled - fast text or image to video with generated audio. License: LTX-2.x Community License (Lightricks) - not an OSI-open license; it carries use restrictions, accepted once before the first run. Fully open alternative right below: Wan 2.2 TI2V 5B (Apache-2.0).",
  workflows: [
    { id: "text-to-video", label: "Text to video", endpointId: "motionfield/ltx-video/text-to-video", kind: "video",
      params: [prompt(), dur([3, 5, 8, 10], 5), arVideo, resV(["480p", "720p"], "720p"), fps, negP, camMove, finish],
      cost: per5s({ "480p": 3, "720p": 5 }),
      providers: { comfy: { workflow: "ltx-txt2video.json" } } },
    { id: "image-to-video", label: "Image to video", endpointId: "motionfield/ltx-video/image-to-video", kind: "video",
      params: [prompt(), firstFrame, dur([3, 5, 8, 10], 5), resV(["480p", "720p"], "720p"), fps, negP, camMove, finish],
      cost: per5s({ "480p": 3, "720p": 5 }),
      providers: { comfy: { workflow: "ltx-img2video.json" } } },
  ],
};

export const WAN_2_1: ModelDef = {
  id: "wan-2-1", label: "Wan 2.1", vendor: "Alibaba (Wan-AI)", kind: "video",
  description: "Apache-2.0 open video model - 1.3B text-to-video, 14B image-to-video.",
  workflows: [
    { id: "text-to-video", label: "Text to video", endpointId: "motionfield/wan-2.1/text-to-video", kind: "video",
      params: [prompt(), dur([3, 5], 5), arVideo, resV(["480p", "720p"], "480p"), negP, finish],
      cost: per5s({ "480p": 5, "720p": 9 }),
      providers: { comfy: { workflow: "wan-txt2video.json" } } },
    { id: "image-to-video", label: "Image to video", endpointId: "motionfield/wan-2.1/image-to-video", kind: "video",
      params: [prompt(), firstFrame, dur([3, 5], 5), resV(["480p", "720p"], "480p"), negP, finish],
      cost: per5s({ "480p": 5, "720p": 9 }),
      providers: { comfy: { workflow: "wan-img2video.json" } },
      heavy: "Wan2.1-I2V-14B fp16 (~28 GB) - Comfy Cloud or a CUDA GPU recommended. Locally, the Director and CameraRig endpoints run Wan VACE 1.3B instead." },
  ],
};

export const WAN_2_2: ModelDef = {
  id: "wan-2-2", label: "Wan 2.2 TI2V 5B - Apache-2.0", vendor: "Alibaba (Wan-AI)", kind: "video",
  description: "Wan 2.2 TI2V 5B (Apache-2.0) - higher-fidelity image-to-video. Not downloaded locally: weights are ~11 GB.",
  workflows: [
    { id: "image-to-video", label: "Image to video", endpointId: "motionfield/wan-2.2/image-to-video", kind: "video",
      params: [prompt(), firstFrame, dur([1, 2, 3, 4, 5], 3), resV(["480p", "720p"], "720p"),
        { name: "fps", label: "FPS", type: "select", default: 24, enum: [16, 24] },
        steps(20), negP, finish],
      cost: per5s({ "480p": 8, "720p": 14 }),
      providers: { comfy: { workflow: "wan22-ti2v-img2video.json" } },
      heavy: "Cloud tier · not validated on this Mac yet (~11 GB)" },
    { id: "a14b-i2v", label: "A14B I2V (cloud quality)", endpointId: "motionfield/wan-2.2/a14b-i2v", kind: "video",
      params: [prompt(), firstFrame, dur([3, 5], 5), resV(["720p"], "720p"), negP, steps(20), finish],
      cost: per5s({ "720p": 18 }),
      providers: {
        comfy: {
          workflow: "wan22a14b-i2v.json",
          map: (p) => ({
            STEPS_HALF: String(Math.ceil((Number(p.steps) || 20) / 2)),
            // These graphs export at 16 fps, independently of the generic 25 fps default.
            FRAMES: String(Math.round(((Number(p.duration) || 5) * 16 - 1) / 4) * 4 + 1),
          }),
        },
      },
      heavy: "Cloud quality tier - two Wan2.2 A14B MoE DiTs fp8 (~29 GB combined). Pod only; do not default locally." },
    { id: "a14b-t2v", label: "A14B T2V (cloud quality)", endpointId: "motionfield/wan-2.2/a14b-t2v", kind: "video",
      params: [prompt(), dur([3, 5], 5), resV(["720p"], "720p"), negP, steps(20), finish],
      cost: per5s({ "720p": 18 }),
      providers: {
        comfy: {
          workflow: "wan22a14b-t2v.json",
          map: (p) => ({
            STEPS_HALF: String(Math.ceil((Number(p.steps) || 20) / 2)),
            // These graphs export at 16 fps, independently of the generic 25 fps default.
            FRAMES: String(Math.round(((Number(p.duration) || 5) * 16 - 1) / 4) * 4 + 1),
          }),
        },
      },
      heavy: "Cloud quality tier - two Wan2.2 A14B MoE DiTs fp8 (~29 GB combined). Pod only; do not default locally." }],
};

export const LENS: ModelDef = {
  id: "lens", label: "LTX-2.5 · Camera Motion (opt-in)", vendor: "Lightricks", kind: "video",
  description: "LTX-2.5 driven by named camera-motion presets. LTX-2.x Community License - explicit opt-in only; the open camera path is CameraRig / Camera Control (Wan VACE).",
  workflows: [
    { id: "image-to-video", label: "Image to video", endpointId: "motionfield/lens/standard/image-to-video", kind: "video",
      params: [prompt(), firstFrame,
        { name: "camera_movement", label: "Camera move", type: "select", default: "dolly-in", enum: KEYFRAME_MOVE_IDS,
          description: "Real move: the clip resolves onto a crop of your still where the camera lands (moves that stay inside the frame only). Smoothest on still or slow subjects - a fast-moving subject can make the move land late." },
        dur([3, 5], 3), { ...arVideo, enum: ["16:9", "9:16", "1:1", "4:3", "3:4"] }, resV(["480p", "720p"], "720p"), fps, finish],
      cost: per5s({ "480p": 4, "720p": 7 }),
      cameraKeyframe: { image: "image_url", move: "camera_movement" },
      providers: { comfy: { workflow: "ltx-vfx-keyframe.json" } } },
    { id: "text-to-video", label: "Text to video", endpointId: "motionfield/lens/standard/text-to-video", kind: "video",
      params: [prompt(),
        { name: "camera_movement", label: "Camera move", type: "select", default: "dolly-in", enum: KEYFRAME_MOVE_IDS,
          description: "Real move: Z-Image renders the opening frame, the clip resolves onto a crop of it where the camera lands." },
        dur([3, 5], 3), { ...arVideo, enum: ["16:9", "9:16", "1:1", "4:3", "3:4"] }, resV(["480p", "720p"], "720p"), fps, finish],
      cost: per5s({ "480p": 5, "720p": 8 }),
      providers: { comfy: { workflow: "ltx-lens-t2v.json" } } },
  ],
};

/* ============ Director ============ */

/** Rig/output size per aspect - Wan VACE 1.3B is a 480p model; both dims
 *  must be multiples of 16. */
const DIRECTOR_DIMS: Record<string, [number, number]> = {
  "16:9": [832, 480],
  "9:16": [480, 832],
  "1:1": [640, 640],
  "4:3": [640, 480],
  "3:4": [480, 640],
  "21:9": [928, 400],
};

const DIRECTOR_ASPECTS = Object.keys(DIRECTOR_DIMS) as readonly string[];

const DIRECTOR_PARAMS: ParamField[] = [
  prompt(),
  { name: "image_url", label: "Start frame", type: "image", accepts: "image/*",
    description: "optional - a Z-Image keyframe renders the first frame when empty" },
  dur([2, 3, 4, 5], 3),
  { ...arVideo, enum: DIRECTOR_ASPECTS },
  resV(["480p"], "480p"),
  steps(8), negP,
  { name: "seed", label: "Seed", type: "integer", description: "empty = random" },
  { name: "add_sound", label: "Add sound", type: "boolean", default: false, group: "Sound",
    description: "after the shot lands, a chained video→sfx job mixes sound under it - tagged post-mix, never original audio" },
  { name: "backend", label: "Backend", type: "select", default: "auto",
    enum: [...DIRECTOR_BACKENDS],
    description: "auto routes each move stack to the engine that measured best - currently wan-vace; wan-fun (Wan2.1-Fun camera) is cloud-recommended and untested on this machine (clip_vision_h absent), so auto never picks it here; ltx is an explicit restricted opt-in" },
  // the move stack - "+"-joined catalog ids execute on the rig; a typed
  // phrase or locked/rig-mode ids steer the prompt instead (prompt-guided)
  { name: "moves", label: "Camera moves", type: "text", group: "Camera",
    placeholder: "dolly-in+pan-left, or: dolly in then pan left",
    description: "1-3 catalog moves execute on the camera rig - ids or names ('dolly in then pan left' parses to dolly-in+pan-left); the rest is prompt-guided" },
  { name: "strength", label: "Move strength", type: "slider", group: "Camera", default: 1.0, min: 0.25, max: 2.0, step: 0.05 },
  { name: "distance", label: "Subject distance (m)", type: "number", group: "Camera", default: 4.0, min: 0.5, max: 50, step: 0.5,
    description: "sets the depth scale + the DoF focus distance" },
  { name: "camera_lens", label: "Lens", type: "select", group: "Camera", default: "standard-35",
    enum: DIRECTOR_LENS_IDS, description: "focal length + sensor → hFOV on the rig" },
  { name: "camera_sensor", label: "Sensor", type: "select", group: "Camera", default: "full_frame",
    enum: [...DIRECTOR_SENSORS], description: "format gate for the focal→FOV conversion" },
  { name: "camera_aperture", label: "Aperture", type: "select", group: "Camera", default: "f8",
    enum: DIRECTOR_APERTURE_IDS, description: "f-stop → depth-of-field blur on the render" },
  { name: "camera_body", label: "Camera body", type: "select", group: "Camera", default: "modern",
    enum: [...DIRECTOR_BODIES], description: "film/digital look - ffmpeg post grade on the output" },
  // style - prompt-style: each pick adds one clause to the generation prompt
  { name: "era", label: "Era", type: "select", group: "Look", enum: DIRECTOR_ERAS,
    description: "prompt-style - period styling clause" },
  { name: "genre", label: "Genre", type: "select", group: "Look", enum: DIRECTOR_GENRES,
    description: "prompt-style - tone clause" },
  { name: "pacing", label: "Pacing", type: "select", group: "Look", enum: DIRECTOR_PACING,
    description: "prompt-style - tempo clause" },
  { name: "color_palette", label: "Color palette", type: "select", group: "Look", enum: COLOR_PALETTES,
    description: "deterministic .cube LUT graded over the render" },
  { name: "emotion", label: "Emotion", type: "select", group: "Performance", enum: DIRECTOR_EMOTIONS,
    description: "prompt-style - performance clause" },
  { name: "emotion_intensity", label: "Intensity", type: "select", group: "Performance", enum: EMOTION_INTENSITIES,
    description: "emotion strength (subtle when unset)" },
  { name: "lights", label: "Dome lights (≤2)", type: "text", group: "Light",
    description: "prompt-style - up to 2 lights, each az<0-359>:el<0-90>:<warm|neutral|cool|#hex>:<soft|medium|hard>, '+'-joined" },
  { name: "image_urls", label: "References", type: "images", accepts: "image/*", maxItems: 50, group: "References",
    description: "Up to 50 - we pick the best few (one per @element, max 3): identity/style refs feeding VACE conditioning" },
  finish,
];

/** The director's param gate - pure check (no mutation); the map re-derives
 *  everything from the same values so the job record keeps what the user
 *  asked for. */
function directorValidate(params: Record<string, unknown>): string | null {
  if (resolveMoves(params.moves) === null)
    return "moves must be 1-3 catalog move ids ('+'-joined), or a plain-language move (prompt-guided)";
  const { lights, bad } = parseLights(params.lights);
  if (lights.length + bad.length > 2) return "lights: pick at most 2 dome lights";
  if (bad.length) return `bad light spec: ${bad[0]} - want az<0-359>:el<0-90>:<warm|neutral|cool|#hex>:<soft|medium|hard>`;
  const refs = params.image_urls;
  if (refs !== undefined && (!Array.isArray(refs) || refs.length > 50))
    return "image_urls: at most 50 references";
  if (params.backend !== undefined && !(DIRECTOR_BACKENDS as readonly string[]).includes(String(params.backend)))
    return `unknown backend "${params.backend}"`;
  // controls with no consumer on the picked path refuse rather than silently
  // drop - "auto" reroutes instead (refs/aperture pull it back to wan-vace)
  if (params.backend === "wan-fun") {
    if (Array.isArray(refs) && refs.length)
      return "references feed the wan-vace rig - wan-fun has no reference input (pick wan-vace or auto)";
    const ap = params.camera_aperture;
    if (typeof ap === "string" && ap && ap !== "f8")
      return "aperture drives OF_DepthBlur on the wan-vace rig - wan-fun carries no depth (pick wan-vace or auto)";
  }
  for (const [name, lo, hi] of [["strength", 0.25, 2], ["distance", 0.5, 50]] as const) {
    const v = params[name];
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n)) return `${name} must be a number`;
    if (n < lo || n > hi) return `${name} must be ${lo}-${hi}`;
  }
  return null;
}

/** Backend + anchoring pick: auto routes the resolved move stack to the
 *  measured winner (DIRECTOR_FUN_WINS, docs/BENCHMARKS.md); each Wan backend
 *  branches image-anchored vs the Z-Image keyframe; ltx is the restricted
 *  opt-in kept behind the badge. */
function directorWorkflow(p: Record<string, unknown>): string {
  const img = typeof p.image_url === "string" && !!p.image_url;
  const refs = p.image_urls;
  const backend = directorBackendFor(
    typeof p.backend === "string" ? p.backend : undefined,
    resolveMoves(p.moves)?.executed ?? [],
    Array.isArray(refs) && refs.length > 0,
    typeof p.camera_aperture === "string" ? p.camera_aperture : undefined,
  );
  if (backend === "ltx") return img ? "ltx-img2video.json" : "ltx-txt2video.json";
  if (backend === "wan-fun") return img ? "director-wan-fun.json" : "director-wan-fun-txt.json";
  return img ? "director-wan.json" : "director-wan-txt.json";
}

/** Derived placeholders - the move stack resolves here (executable ids feed
 *  OF_Trajectory; anything else becomes a prompt clause), style picks become
 *  clauses, lens+sensor becomes the FOV, the f-stop becomes the blur radius. */
function directorPlaceholders(p: Record<string, unknown>): Record<string, unknown> {
  const duration = Math.max(2, Math.min(5, Math.round(Number(p.duration) || 3)));
  const [w, h] = DIRECTOR_DIMS[String(p.aspect_ratio ?? "16:9")] ?? DIRECTOR_DIMS["16:9"];
  const moves = resolveMoves(p.moves) ?? { moves: "locked-off", executed: [] as string[], stack: true };
  const clauses = directorClauses(p);
  const vace = [p.prompt, ...clauses, moves.guided ? `camera move: ${moves.guided}` : ""]
    .filter(Boolean).join(". ");
  // the keyframe is a still - motion clauses don't belong in it
  const keyframe = [p.prompt, ...clauses].filter(Boolean).join(". ");
  return {
    PROMPT: vace,
    KEYFRAME_PROMPT: keyframe,
    MOVES: moves.moves,
    DURATION: String(duration),
    CAM_FRAMES: String(duration * 16 + 1),
    CAM_W: String(w),
    CAM_H: String(h),
    KF_W: String(w * 2),
    KF_H: String(h * 2),
    DISTANCE: String(p.distance ?? 4),
    FOV: String(directorFov(
      typeof p.camera_lens === "string" ? p.camera_lens : undefined,
      typeof p.camera_sensor === "string" ? p.camera_sensor : undefined,
    )),
    APERTURE: String(apertureBlur(typeof p.camera_aperture === "string" ? p.camera_aperture : undefined)),
    CAM_SCALE: "1",
    STRENGTH: String(p.strength ?? 1),
    FPS: "16",
    // the refgrid / keyframe SaveImage nodes carry their own prefixes - never
    // {{PREFIX}}, so they can't be mistaken for the job's video output
    REFGRID_PREFIX: `of_dir_${crypto.randomUUID().slice(0, 8)}-refgrid`,
    KEYFRAME_PREFIX: `of_dir_${crypto.randomUUID().slice(0, 8)}-keyframe`,
  };
}

export const DIRECTOR: ModelDef = {
  id: "director", label: "Camera Control · Wan VACE", vendor: "Alibaba (Wan-AI) + MotionField", kind: "video",
  description: "Directed shots - camera moves on the trajectory rig, lens/sensor, aperture, body look, lighting and 50 palette LUTs. Runs Wan VACE 1.3B locally; LTX is an explicit restricted opt-in.",
  workflows: [{
    id: "generate", label: "Generate", endpointId: "motionfield/director/generate", kind: "video",
    executesTrajectory: true,
    params: DIRECTOR_PARAMS,
    validate: directorValidate,
    cost: (p) => Math.max(1, Math.round(8 * ((Number(p.duration) || 3) / 5))),
    providers: {
      comfy: {
        workflow: "director-wan.json",
        workflowFor: directorWorkflow,
        variantParam: { name: "backend", values: DIRECTOR_BACKENDS },
        map: directorPlaceholders,
        // body look + palette LUT run host-side over the rendered clip -
        // the spec rides job meta, applied when the outputs land (pure pick
        // - the ffmpeg chain materialises server-side in grade/post)
        post: async (p) => directorPost(p),
      },
    },
  }],
};

/** Ordered catalog contribution of this file - barrels concatenate these.
 *  WAN_2_1 leads so the Video Studio opens on an open-licensed model; the
 *  restricted LTX entries sit last. */
/** LTX-2.5 leads (featured, license shown + accepted inline); Wan 2.2 5B
 *  (Apache-2.0) sits right next to it as the fully open pick. */
export const VIDEO_GENERATE_MODELS: ModelDef[] = [LTX_VIDEO, WAN_2_2, WAN_2_1, DIRECTOR, LENS];

/* ============ C1 video menu data ============ */

/** One row of the C1 video picker - which catalog model/workflow fills each
 *  slot, where its weights run, and whether it sits behind the licence
 *  opt-in. Pure data; the picker maps ids onto VIDEO_MODELS. */
export interface VideoMenuEntry {
  /** catalog model id (VIDEO_MODELS) */
  model: string;
  /** workflow id inside that model */
  workflow: string;
  /** picker row label */
  label: string;
  /** where the weights run - this machine vs the pod tier */
  tier: "local" | "cloud";
  /** names the surface this row opens selected on */
  default?: "director-ui" | "video-studio";
  /** restricted licence - hidden until the Settings → Licenses opt-in */
  optIn?: boolean;
}

export const VIDEO_MENU: readonly VideoMenuEntry[] = [
  // the two surfaces' defaults: the Director leads /generate, plain Wan 2.1
  // leads the generic video studio - both open-licensed
  { model: "director", workflow: "generate", label: "Camera Control - directed shot (Wan VACE)", tier: "local", default: "director-ui" },
  { model: "wan-2-1", workflow: "text-to-video", label: "Wan 2.1 - text to video", tier: "local", default: "video-studio" },
  // local image-to-video is the VACE rig (CameraRig) - Wan2.1-I2V-14B (~28 GB)
  // is a cloud row, never presented as local
  { model: "camera-rig", workflow: "image-to-video", label: "CameraRig - image to video (Wan VACE)", tier: "local" },
  { model: "wan-2-1", workflow: "image-to-video", label: "Wan 2.1 I2V 14B - image to video (~28 GB)", tier: "cloud" },
  { model: "wan-2-2", workflow: "image-to-video", label: "Wan 2.2 TI2V-5B - balanced", tier: "cloud" },
  { model: "wan-2-2", workflow: "a14b-i2v", label: "Wan 2.2 A14B - I2V quality", tier: "cloud" },
  { model: "wan-2-2", workflow: "a14b-t2v", label: "Wan 2.2 A14B - T2V quality", tier: "cloud" },
  { model: "ltx-video", workflow: "text-to-video", label: "LTX-Video - opt-in", tier: "local", optIn: true },
  { model: "ltx-video", workflow: "image-to-video", label: "LTX-Video - image to video (opt-in)", tier: "local", optIn: true },
  { model: "lens", workflow: "image-to-video", label: "LTX camera motion - opt-in", tier: "local", optIn: true },
];
