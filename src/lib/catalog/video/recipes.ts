import type { ModelDef, ParamField } from "../types";
import { steps, arVideo, finish } from "./params";
import { LOOK_VALUES, CAPTION_VALUES, NARRATION_LANGUAGES } from "../presets/explainer";

/**
 * Recipe-backed catalog entries - providers.recipe (server-side pipelines),
 * no bundled Comfy graph. Owner: WS2 after the F0b catalog split.
 */

/** explainer params as a named array so the workflow's own validate() can
 *  walk the enums - a direct /api/jobs submit must be refused at submit
 *  (400), not discovered inside the recipe after credits charged. */
const EXPLAINER_PARAMS: ParamField[] = [
  { name: "prompt", label: "Topic or script", type: "textarea", required: true,
    placeholder: "What should the explainer cover? A topic (needs a writer model) or a pasted script.",
    description: "A topic needs a local writer model - pick it in Settings → Models & LLMs. A pasted script (2+ sentences) is chunked into scenes directly, no model needed." },
  { name: "scenes", label: "Scenes", type: "select", default: 3, enum: [3, 4, 5],
    description: "One keyframe + motion clip + narration line per scene." },
  { name: "look", label: "Look", type: "select", default: "flat-2d", enum: LOOK_VALUES,
    description: "Visual language every scene shares. 'custom' uses the Style text below alone; any other look uses its own style prompt and appends your Style text." },
  { name: "captions", label: "Captions", type: "select", default: "karaoke", enum: CAPTION_VALUES,
    description: "Burned into the final video - karaoke highlights the active word, pop shows whole cues, off skips the burn. Enabled modes also leave .srt/.vtt sidecars next to the mp4." },
  { name: "motion_model", label: "Motion model", type: "select", default: "wan-vace",
    enum: ["wan-vace", "wan22-ti2v", "ltx", "still"],
    description: "wan-vace = Wan 2.1 VACE 1.3B (Apache-2.0, installed) · wan22-ti2v = Wan 2.2 TI2V 5B (Apache-2.0, needs a ~11 GB download) · ltx = LTX-Video 0.9.5 (Open RAIL-M, use-restricted - opt-in) · still = ffmpeg pan/zoom on the keyframe, no model." },
  { name: "voice", label: "Narrator", type: "select", default: "af_heart",
    enum: ["af_heart", "af_bella", "af_nicole", "af_sky", "am_adam", "am_michael", "bf_emma", "bm_george"],
    description: `Kokoro voice - ${NARRATION_LANGUAGES.map((l) => l.label).join("; ")}. The installed set speaks English only, so there is no language picker.` },
  { name: "clip_duration", label: "Motion clip seconds", type: "select", default: 2, enum: [1, 2, 3, 4, 5],
    description: "Length of each generated scene clip - narration plays over it (the clip loops if the line runs longer)." },
  steps(8),
  arVideo,
  { name: "style", label: "Style (custom)", type: "text",
    description: "Free-text style - the whole look when Look is 'custom'; appended to the look's own prompt otherwise." },
  finish,
];

// the writer model is picked in Settings → Models & LLMs (LLM route) - this
// description folds in the old recipes.ts REQUEST comment.
export const EXPLAINER: ModelDef = {
  id: "explainer", label: "Narrated Explainer", vendor: "MotionField", kind: "video",
  description: "Narrated explainer in one job - the writer model picked in Settings → Models & LLMs writes the scene script, Z-Image-Turbo renders each scene, a motion model animates it, Kokoro voices it, and the server stitches the final mp4 with burned-in captions. Without a writer model you can still paste a finished script - it is chunked into scenes as-is.",
  tags: ["explainer", "narrated", "pipeline"],
  workflows: [{
    id: "video", label: "Explainer video", endpointId: "motionfield/explainer/video", kind: "video",
    params: EXPLAINER_PARAMS,
    cost: (p) => 3 + 5 * (Number(p.scenes) || 3),
    validate: (p) => {
      for (const f of EXPLAINER_PARAMS) {
        const v = p[f.name];
        if (v == null || v === "" || !Array.isArray(f.enum) || !f.enum.length) continue;
        if (!f.enum.some((x) => x === v))
          return `unknown ${f.name} "${String(v)}" - pick one of ${f.enum.join(", ")}`;
      }
      return null;
    },
    providers: { recipe: { name: "explainer" } },
  }],
};
