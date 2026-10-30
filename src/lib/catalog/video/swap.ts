import type { ModelDef } from "../types";
import { prompt, dur, arVideo, resV, steps, negP, firstFrame, per5s, vaceSource, finish } from "./params";
import { catalogSpecs } from "../presets/schema";
import { LIKENESS_CONSENT_FIELD as likenessConsent, likenessConsentCheck } from "../../likeness";
import "../presets/effects"; // registers the effect specs this derives from
import "../presets/person-swap"; // s5b's restyle specs join the same registry - must load before RESTYLE_PRESET_IDS freezes

/** Restyle presets - effect specs whose mechanism is a depth-controlled
 *  v2v restyle on motionfield/wan-vace/restyle and that aren't hidden. (Named
 *  mechanism subset, not "all effect presets".) Visibility for the picker
 *  still requires a verified record - see schema.specVisible. */
export const RESTYLE_PRESET_IDS: readonly string[] = catalogSpecs("effect")
  .filter((s) => s.mechanism.kind === "restyle" && !s.hidden)
  .map((s) => s.id);

/* ------------------------------------------------------------------ */
/* Object-swap matte tracker - the painted frame-0 pick seeds the       */
/* tracker either way. "auto" prefers SAM 3.1's memory tracker when its */
/* gated checkpoint is installed (Meta SAM License, opt-in) and keeps   */
/* the BiRefNet overlap tracker everywhere else.                        */
/* ------------------------------------------------------------------ */
export const SWAP_TRACKERS = ["auto", "sam3", "birefnet"] as const;
export type SwapTracker = (typeof SWAP_TRACKERS)[number];

export const SAM3_CKPT_FILE = "sam3.1_multiplex_fp16.safetensors";
export const SAM3_CKPT_BYTES = 1_745_546_848;

const nodeGet = (m: string) => globalThis.process?.getBuiltinModule?.(m) as
  | Record<string, unknown> | undefined;

/** The SAM 3.1 multiplex checkpoint exists only as the exact installed file
 *  (name + byte size pinned, same probe style as ltx098Installed) - gated HF
 *  download, so an absent or partial file keeps the auto pick on BiRefNet. */
export function sam3Installed(): boolean {
  const fs = nodeGet("node:fs") as typeof import("node:fs") | undefined;
  const os = nodeGet("node:os") as typeof import("node:os") | undefined;
  const path = nodeGet("node:path") as typeof import("node:path") | undefined;
  if (!fs || !os || !path) return false;
  const root = process.env.COMFYUI_DIR ?? path.join(os.homedir(), "comfy", "ComfyUI");
  try {
    return fs.statSync(path.join(root, "models", "checkpoints", SAM3_CKPT_FILE)).size === SAM3_CKPT_BYTES;
  } catch {
    return false;
  }
}

/** Resolved object-swap tracker - explicit `sam3`/`birefnet` picks win;
 *  `auto` takes SAM 3.1 when the checkpoint is really there. Never throws:
 *  the endpoint's own validate() turns an explicit sam3 pick on a machine
 *  without the checkpoint into a submit-time error. */
export function swapTrackerFor(p: Record<string, unknown>): "sam3" | "birefnet" {
  const pick = String(p.mask_tracker ?? "auto");
  if (pick === "sam3") return "sam3";
  if (pick === "birefnet") return "birefnet";
  return sam3Installed() ? "sam3" : "birefnet";
}

/** ReCut flows - each names the vace graph a window runs through. */
export const RE_EDIT_FLOWS = ["character-swap", "motion-transfer", "restyle"] as const;
export type ReEditFlow = (typeof RE_EDIT_FLOWS)[number];
const flowCost = (flow: unknown): number => {
  const wf = WAN_VACE.workflows.find((w) => w.id === flow);
  return wf ? wf.cost({}) : 25;
};

export const WAN_VACE: ModelDef = {
  id: "wan-vace", label: "Wan 2.1 VACE 1.3B - Apache-2.0", vendor: "Alibaba (Wan-AI)", kind: "v2v",
  description: "Wan 2.1 VACE 1.3B (Apache-2.0) - first-frame image-to-video, motion transfer, object/character swap, restyle.",
  workflows: [
    { id: "image-to-video", label: "Image to video", endpointId: "motionfield/wan-vace/image-to-video", kind: "video",
      params: [prompt(), firstFrame, dur([1, 2, 3, 4, 5], 2), arVideo, resV(["480p", "720p"], "480p"),
        { name: "fps", label: "FPS", type: "select", default: 16, enum: [16, 24] },
        steps(8), negP, finish],
      cost: per5s({ "480p": 5, "720p": 9 }),
      providers: { comfy: { workflow: "wan-vace-img2video.json" } } },
    { id: "motion-transfer", label: "Motion transfer", endpointId: "motionfield/wan-vace/motion-transfer", kind: "v2v",
      params: [vaceSource, likenessConsent,
        { name: "image_urls", label: "Subject reference (1)", type: "images", required: true, maxItems: 1, accepts: "image/*" },
        prompt(false), resV(["480p", "720p"], "480p"), finish],
      cost: () => 25,
      validate: likenessConsentCheck("motionfield/wan-vace/motion-transfer"),
      providers: { comfy: { workflow: "vace-motion-transfer.json" } } },
    { id: "object-swap", label: "Object swap", endpointId: "motionfield/wan-vace/object-swap", kind: "v2v",
      params: [vaceSource,
        { name: "mask_url", label: "Frame-0 region", type: "image", required: true, accepts: "image/*",
          description: "Paint or box the object on frame 0 - a white region on a black image at the clip's own size. The tracker carries it across the clip; a BiRefNet track that collapses under 1% coverage refuses instead of regenerating at random." },
        { name: "mask_tracker", label: "Region tracker", type: "select", default: "auto", enum: SWAP_TRACKERS as unknown as string[],
          description: "auto - SAM 3.1 tracked matte when its checkpoint is installed (the GPU pod), else the BiRefNet overlap tracker; sam3/birefnet pin the engine. SAM 3.1 rides under the Meta SAM License (opt-in)." },
        { name: "image_urls", label: "Replacement object ref (1)", type: "images", required: true, maxItems: 1, accepts: "image/*" },
        prompt(false), resV(["480p", "720p"], "480p"), finish],
      // VACE graphs size from WIDTH/HEIGHT/FRAMES - follow the clip, not 16:9 5 s
      sourceGeometry: { param: "video_url", maxFrames: 129 },
      cost: () => 25,
      validate: (p) => String(p.mask_tracker ?? "auto") === "sam3" && !sam3Installed()
        ? "mask_tracker=sam3 needs sam3.1_multiplex_fp16.safetensors in ComfyUI/models/checkpoints - download it via scripts/runpod/setup.sh (Meta SAM License, gated; HF_TOKEN required)"
        : null,
      providers: { comfy: {
        workflow: "vace-object-swap.json",
        workflowFor: (p) => swapTrackerFor(p) === "sam3" ? "vace-object-swap-sam3.json" : "vace-object-swap.json",
        variantParam: { name: "mask_tracker", values: SWAP_TRACKERS },
      } } },
    { id: "character-swap", label: "Character swap", endpointId: "motionfield/wan-vace/character-swap", kind: "v2v",
      params: [vaceSource, likenessConsent,
        { name: "image_urls", label: "New character refs (1-3)", type: "images", required: true, maxItems: 3, accepts: "image/*",
          description: "Clear photo(s) of the person/character to put into the video - the masked pipeline keeps the set and re-renders only the person. Object swap is for props and products - a person's likeness stays on this flow." },
        prompt(false), resV(["480p", "720p"], "480p"), finish],
      // VACE graphs size from WIDTH/HEIGHT/FRAMES - follow the clip, not 16:9 5 s
      sourceGeometry: { param: "video_url", maxFrames: 129 },
      cost: () => 25,
      validate: likenessConsentCheck("motionfield/wan-vace/character-swap"),
      providers: { recipe: { name: "person-swap" } } },
    { id: "restyle", label: "Restyle", endpointId: "motionfield/wan-vace/restyle", kind: "v2v",
      params: [vaceSource,
        { name: "preset_id", label: "Style preset", type: "select", enum: RESTYLE_PRESET_IDS },
        { name: "image_urls", label: "Optional style ref (0-1)", type: "images", maxItems: 1, accepts: "image/*" },
        prompt(false), resV(["480p", "720p"], "480p"), finish],
      cost: () => 20,
      providers: { comfy: { workflow: "vace-restyle.json" } } },
  ],
};

export const WAN_ANIMATE: ModelDef = {
  id: "wan-animate", label: "Wan 2.2 Animate", vendor: "Alibaba (Wan-AI)", kind: "v2v",
  description: "Wan2.2-Animate 14B bf16 - character replacement with pose, face and background handled separately (Mix/Move modes). Bring your own GPU - cloud-recommended.",
  workflows: [{ id: "character-swap", label: "Character swap", endpointId: "motionfield/wan-animate/character-swap", kind: "v2v",
    params: [vaceSource, likenessConsent,
      { name: "image_urls", label: "New character ref", type: "images", required: true, maxItems: 1, accepts: "image/*" },
      { name: "mask_url", label: "Person mask (optional)", type: "image", accepts: "image/*",
        description: "White marks the character region - keeps the original background (replace mode)." },
      prompt(false), resV(["480p", "720p"], "480p"), steps(6), finish],
    // the animate graph sizes from WIDTH/HEIGHT/FRAMES - follow the clip,
    // same as the VACE swaps (a portrait source rendered at the 16:9 default
    // crops the subject's head)
    sourceGeometry: { param: "video_url", maxFrames: 129 },
    cost: () => 40,
    validate: likenessConsentCheck("motionfield/wan-animate/character-swap"),
    providers: { comfy: { workflow: "wan-animate-character-swap.json" } },
    heavy: "Wan2.2-Animate 14B bf16 (~33 GB) + CLIP-ViT-H - not installed locally; Comfy Cloud or a CUDA GPU recommended. The Wan VACE character-swap above runs here." }],
};

export const RE_EDIT: ModelDef = {
  id: "re-edit", label: "Re-edit Video · Wan VACE", vendor: "Alibaba (Wan-AI)", kind: "v2v",
  description: "Rebuild a reference edit with your own subjects: the server splits it into shots, regenerates each on Wan 2.1 VACE, and returns one file with the original shot order, timing, aspect, fps and soundtrack.",
  workflows: [{
    id: "edit", label: "Re-edit Video · Wan VACE", endpointId: "motionfield/re-edit/v1.0", kind: "v2v",
    params: [
      { name: "video_url", label: "Reference edit (1-30 s)", type: "video", required: true },
      { name: "flow", label: "Flow", type: "select", default: "character-swap", enum: RE_EDIT_FLOWS,
        description: "character-swap puts your people in the shots · motion-transfer keeps the motion on a new subject · restyle re-renders the look" },
      likenessConsent,
      { name: "image_urls", label: "Subject refs", type: "images", maxItems: 3, accepts: "image/*",
        description: "character-swap takes up to 3; motion-transfer/restyle use the first one" },
      { name: "instructions", label: "Instructions", type: "textarea",
        placeholder: "e.g. Keep the opening wide shot, put my product in the hero frame…" },
      { name: "preset_id", label: "Style preset (restyle)", type: "select", enum: RESTYLE_PRESET_IDS },
      resV(["480p", "720p"], "480p"),
      // no declared default - a blank steps means each flow graph runs its
      // own; declaring one would fill it into the params and silently
      // override the graphs
      { name: "steps", label: "Sampler steps", type: "integer", min: 2, max: 50,
        description: "blank = the flow graph's own default" },
      { name: "windows", label: "Shot windows", type: "integer", required: true, min: 1, max: 24,
        description: "Detected shot windows to regenerate - the run fails if the video needs more than paid for" },
      finish,
    ],
    cost: (p) => (Number(p.windows) || 1) * flowCost(p.flow),
    validate: likenessConsentCheck("motionfield/re-edit/v1.0"),
    providers: { recipe: { name: "re-edit-assemble" } },
  }],
};

/** PersonSwap - identity swap on a finished clip. The recipe (windowed VACE
 *  passes behind motionfield/person-swap/v1.0) owns probing, windowing, the person /
 *  environment / both mode split, matte coverage gating and assembly. Person
 *  mode needs 1-3 identity refs; environment takes an optional setting ref
 *  and a prompt. `windows` is detected + charged server-side by /api/person-swap -
 *  a direct job submit that under-declares windows fails inside the run. */
export const PERSON_SWAP_MODES = ["person", "environment", "both"] as const;
export const PERSON_SWAP: ModelDef = {
  id: "person-swap", label: "Person Swap · Wan VACE", vendor: "Alibaba (Wan-AI)", kind: "v2v",
  description: "Person Swap - put a consented identity into a finished clip, or move the same person into a new setting. The server cuts the clip into ≤5 s windows, mattes the person with BiRefNet, runs masked Wan 2.1 VACE 1.3B passes per window, then re-assembles at the original fps with the original soundtrack - optional MuseTalk pass re-times the swapped person's lips to it.",
  workflows: [{
    id: "swap", label: "Person Swap", endpointId: "motionfield/person-swap/v1.0", kind: "v2v",
    params: [
      { name: "video_url", label: "Source clip (1-30 s)", type: "video",
        description: "your uploaded clip - or send gallery_id for a ready gallery clip instead" },
      { name: "gallery_id", label: "Gallery clip", type: "text",
        description: "id of a ready clip from the Person Swap gallery manifest - the server resolves it into your uploads; send this OR video_url, never a path" },
      { name: "mode", label: "Mode", type: "select", default: "person", enum: PERSON_SWAP_MODES,
        description: "person - replace the person, keep the set · environment - keep the person, re-create the set · both - new person, new set" },
      likenessConsent,
      { name: "image_urls", label: "Reference images", type: "images", maxItems: 8, accepts: "image/*",
        description: "person/both - 1-8 clear photos of the identity to apply (required; the best 3 by cut-out matte coverage drive the swap) · environment - optional setting reference" },
      { name: "prompt", label: "Direction", type: "textarea",
        placeholder: "person/both - who the new person is, how they look · environment - the setting to re-create" },
      { name: "env_prompt", label: "Setting prompt", type: "textarea",
        description: "environment/both - the setting to re-create around the person, best-effort (the model keeps the performer; the set takes the direction, not a guarantee); falls back to prompt when unset" },
      { name: "quick", label: "Quick person swap", type: "boolean", default: false,
        description: "the shortest path - exactly 1 photo, one clip ≤15 s (or a gallery_id), person mode only, Quick defaults; anything else is rejected" },
      { name: "aspect", label: "Aspect", type: "select", default: "source", enum: ["source", "9:16", "16:9"],
        description: "Quick - centre-crop the clip to this ratio before the swap (crops your clip); source keeps the clip's frame" },
      { name: "lip_sync", label: "Restore lip sync", type: "boolean", default: true,
        description: "person/both only - after assembly, MuseTalk re-times the swapped person's mouth to the original soundtrack (skipped silently when the clip has no audio)" },
      resV(["480p", "720p"], "480p"),
      // VACE 1.3B under ~12 steps renders the DWPose control skeleton itself
      // in place of the person (graded on the A100: 6 steps = glowing
      // skeleton, 16 steps = the reference character)
      steps(16),
      { name: "draft", label: "Draft first", type: "boolean", default: false,
        description: "run the first window at low steps as a cheap preview - the matte + a short render come back for review, then the approved draft's seed and mattes carry into the full run" },
      { name: "draft_of", label: "Approved draft", type: "text",
        description: "job id of a completed Person Swap draft this run approves - the final reuses its seed and recomputes the same mattes on the same frames" },
      { name: "windows", label: "Generation windows", type: "integer", required: true, min: 1, max: 24,
        description: "Detected ≤5 s windows the clip splits into - the run refuses if it needs more than paid for" },
      finish,
    ],
    cost: (p) => {
      const pass = String(p.mode ?? "person") === "both" ? 50 : 25;
      // a draft pays one window's pass - no lip, no extra windows
      if (p.draft === true) return pass;
      const w = Math.min(Math.max(Number(p.windows) || 1, 1), 24);
      const lip = p.lip_sync !== false && String(p.mode ?? "person") !== "environment" ? 10 : 0;
      return w * pass + lip;
    },
    validate: (p) => {
      const consent = likenessConsentCheck("motionfield/person-swap/v1.0")(p);
      if (consent) return consent;
      if (!p.video_url && !p.gallery_id)
        return "video_url is required - or send gallery_id for a ready gallery clip";
      if (p.quick === true) {
        if (String(p.mode ?? "person") !== "person") return "Quick person swap runs person mode only";
        const imgs = Array.isArray(p.image_urls) ? p.image_urls.filter(Boolean) : [];
        if (imgs.length !== 1) return "Quick person swap takes exactly one reference photo";
      }
      if (p.draft === true && p.quick === true) return "Quick person swap is already the fast path - no draft";
      if (p.draft === true && p.draft_of) return "a draft can't approve another draft";
      if (String(p.mode ?? "person") !== "environment" &&
          (!Array.isArray(p.image_urls) || p.image_urls.length === 0))
        return "person and both modes need at least one identity ref in image_urls";
      return null;
    },
    providers: { recipe: { name: "person-swap" } },
  }],
};

export const REFRAME: ModelDef = {
  id: "reframe", label: "Reframe · Wan VACE", vendor: "Alibaba (Wan-AI)", kind: "v2v",
  description: "Recompose a finished video for a new aspect ratio without cropping the subject.",
  workflows: [{
    id: "reframe", label: "Reframe", endpointId: "motionfield/reframe/v1.0", kind: "v2v",
    params: [
      { name: "video_url", label: "Source video", type: "video", required: true },
      { name: "aspect_ratio", label: "Target ratio", type: "select", required: true, enum: ["16:9", "9:16", "1:1", "4:5", "4:3", "3:4"] },
      resV(["480p", "720p", "1080p"], "480p"),
      { name: "mode", label: "Mode", type: "select", default: "smart", enum: ["smart", "outpaint", "crop-safe"], description: "How to fill/compose the new frame" },
      { name: "reference_image_urls", label: "Style refs", type: "media", maxItems: 4, accepts: "image/*" },
      finish,
    ],
    cost: () => 18,
    providers: { comfy: { workflow: "vace-reframe.json" } },
  }],
};

export const VIDEO_SWAP_MODELS: ModelDef[] = [WAN_VACE, WAN_ANIMATE, RE_EDIT, PERSON_SWAP, REFRAME];

/**
 * Local PersonSwap runtime - measured on this machine (M1 Pro, Wan 2.1 VACE 1.3B,
 * 8 sampler steps) at the 9:16 480p generation box (256×480 × 16 fps), the
 * box a phone-portrait clip lands in. docs/SMOKE.md carries the runs these
 * come from (ws4-s5fix + ws4-s5fix2); /api/person-swap/detect turns them into
 * per-mode totals and the recipe's per-step deadline derives from the same
 * numbers.
 *
 *   warm person window  617 s for a 2 s window   → 5.1 min/s
 *   warm env window     233 s for a 2 s window   → 1.9 min/s
 *   person job fixed    37 s matte preflight + 9 s ref cut-out + ~5 s assemble
 *   lip restore          69 s for a 2 s clip      → 0.6 min/s
 *   cold first run      ~+3-4 min one-time model load (env cold total 787 s)
 *
 * Rates are warm-path; a first-ever run adds the model load once - the
 * overhead constant covers part of it and the step cap is 3× the estimate.
 */
export const PERSON_SWAP_LOCAL_PERSON_MIN_PER_SEC = 5.2;
export const PERSON_SWAP_LOCAL_ENV_MIN_PER_SEC = 2.0;
/** matte preflight + one identity-ref cut-out + final assembly - the fixed
 *  cost every person/both job pays regardless of clip length */
export const PERSON_SWAP_LOCAL_OVERHEAD_MIN = 0.9;
export const PERSON_SWAP_LIP_MIN_PER_SEC = 0.6; // MuseTalk pass per clip second
export const PERSON_SWAP_LOCAL_DEFAULT_STEPS = 16;
const LOCAL_REF_PX = 256 * 480;

/** Sampler steps for the local runs - env override, catalog default 16. */
export function personSwapLocalSteps(): number {
  const n = Number(process.env.PERSON_SWAP_LOCAL_STEPS);
  return Number.isFinite(n) && n >= 2 ? Math.min(50, Math.trunc(n)) : PERSON_SWAP_LOCAL_DEFAULT_STEPS;
}

const PERSON_SWAP_ASPECTS: [string, number][] = [
  ["1:1", 1], ["4:3", 4 / 3], ["16:9", 16 / 9], ["21:9", 21 / 9],
  ["3:4", 3 / 4], ["9:16", 9 / 16],
];

const round32 = (v: number) => Math.max(32, Math.round(v / 32) * 32);

/** Generation box the recipe puts the clip into - mirrors the graph's
 *  {{WIDTH}}/{{HEIGHT}} substitution exactly: the resolution is the HEIGHT
 *  and the width follows the nearest supported aspect, 32-rounded by the
 *  provider's placeholder pass (portrait 9:16 at 480p lands at 256×480 -
 *  small boxes are the local-perf trade). Cutting and the graph share this
 *  box - drifting off it rescales the footage inside VACE. */
export function personSwapGenBox(srcW: number, srcH: number, resolution = "480p"): [number, number] {
  const [, ratio] = PERSON_SWAP_ASPECTS.reduce((a, b) => (Math.abs(b[1] - srcW / srcH) < Math.abs(a[1] - srcW / srcH) ? b : a));
  const hi = resolution === "720p" ? 720 : 480;
  return [round32(hi * ratio), hi];
}

/** One generation-window pass at this clip's gen box - the per-step estimate
 *  the recipe's deadline derives from (no fixed overhead, no lip). */
export function personSwapWindowPassMin(
  srcW: number, srcH: number, winSec: number,
  pass: "person" | "environment", resolution = "480p",
): number {
  const [w, h] = personSwapGenBox(srcW, srcH, resolution);
  const rate = pass === "person" ? PERSON_SWAP_LOCAL_PERSON_MIN_PER_SEC : PERSON_SWAP_LOCAL_ENV_MIN_PER_SEC;
  return winSec * rate * ((w * h) / LOCAL_REF_PX);
}

/** Estimated wall-clock minutes for a whole person-swap job of `clipSec` seconds -
 *  per-mode window rates scaled by gen-box pixels over the 9:16 480p
 *  reference, plus the person-side fixed overhead and the lip pass. "both" is
 *  a person pass AND an environment pass per window. */
export function personSwapLocalEstimateMin(
  srcW: number, srcH: number, clipSec: number,
  opts: { resolution?: string; mode?: string; lip?: boolean } = {},
): number {
  let min = 0;
  if (opts.mode !== "environment") {
    min += personSwapWindowPassMin(srcW, srcH, clipSec, "person", opts.resolution) + PERSON_SWAP_LOCAL_OVERHEAD_MIN;
    if (opts.lip) min += PERSON_SWAP_LIP_MIN_PER_SEC * clipSec;
  }
  if (opts.mode !== "person") min += personSwapWindowPassMin(srcW, srcH, clipSec, "environment", opts.resolution);
  return min;
}

