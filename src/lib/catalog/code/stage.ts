import type { ModelDef } from "../types";
import { finish } from "../video/params";
import { STAGE_MAX_DURATION_S, STAGE_MAX_FRAMES } from "../../stage/render-plan";

/** the public endpoint id for Stage scene → video renders */
export const STAGE_RENDER_ENDPOINT = "motionfield/stage/render";

/**
 * Catalog entry for the Stage scene → Wan VACE video pipeline.
 * Registered via video-models.ts (CODE_STAGE_MODELS → ALL_MODELS).
 */
export const STAGE_RENDER: ModelDef = {
  id: "stage-render",
  label: "Stage Render",
  vendor: "motionfield",
  kind: "video",
  description:
    "Render a Stage scene to video: headless three.js passes of the pinned scene revision "
    + "(a grey-box previz plus a depth or pose control video) drive Wan 2.1 VACE 1.3B locally - "
    + "480p-class at 16 fps, up to two windows with an 8-frame continuation.",
  tags: ["code", "local", "stage"],
  workflows: [
    {
      id: "render",
      label: "Render video",
      endpointId: STAGE_RENDER_ENDPOINT,
      kind: "video",
      params: [
        { name: "scene_id", label: "Scene", type: "text", required: true, description: "uuid of a Stage scene you own" },
        { name: "revision", label: "Revision", type: "integer", required: true, min: 1, description: "the pinned scene revision - later edits don't move a submitted render" },
        { name: "start_s", label: "Start (s)", type: "number", default: 0, min: 0, max: 60 },
        { name: "duration_s", label: "Duration (s)", type: "number", default: 3, min: 0.25, max: STAGE_MAX_DURATION_S, step: 0.0625 },
        { name: "control", label: "Control pass", type: "select", enum: ["depth", "pose"], default: "depth", description: "pose renders a skeleton pass - needs a mannequin in the scene" },
        { name: "prompt", label: "Prompt", type: "textarea", description: "merged with the per-object prompts of frustum-visible nodes (≤800 chars composed)" },
        { name: "seed", label: "Seed", type: "integer", default: 0, min: 0, max: 2147483647 },
        finish,
      ],
      cost: () => 0,
      validate: (p) => {
        const s = Number(p.start_s ?? 0);
        if (!(s >= 0)) return "start_s must be ≥ 0";
        const d = Number(p.duration_s ?? 3);
        if (!(d > 0)) return "duration_s must be > 0";
        if (d > STAGE_MAX_DURATION_S)
          return `duration ${d}s needs more than the local 2-window ceiling (${STAGE_MAX_FRAMES} frames ≈ ${STAGE_MAX_DURATION_S}s max) - not in this build`;
        return null;
      },
      providers: { recipe: { name: "stage-render" } },
      heavy:
        "Wan 2.1 VACE 1.3B fp16 + umT5-xxl fp8 + Wan 2.1 VAE (Apache-2.0) - already on this Mac, "
        + "no downloads; ~45-60 s/frame on Apple silicon (an 81-frame window is roughly an hour). "
        + "Longer moves aren't in this build - Comfy Cloud / a CUDA GPU recommended for the 14B model.",
    },
  ],
};
export const CODE_STAGE_MODELS: ModelDef[] = [STAGE_RENDER];
