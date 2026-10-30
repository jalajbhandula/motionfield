import type { ModelDef } from "../types";

/** the public endpoint id for SceneSpec → MP4 renders */
export const MOTION_RENDER_ENDPOINT = "motionfield/motion-render/mp4";

/**
 * Catalog entry for the SceneSpec → MP4 motion-render pipeline.
 * Registered via video-models.ts (CODE_MOTION_MODELS → ALL_MODELS).
 */
export const MOTION_RENDER: ModelDef = {
  id: "motion-render",
  label: "Motion Render",
  vendor: "motionfield",
  kind: "video",
  description: "Deterministic three.js motion-graphics renderer - a stored SceneSpec rendered to MP4 by the local exporter.",
  tags: ["code", "deterministic", "local"],
  workflows: [
    {
      id: "mp4",
      label: "Render MP4",
      endpointId: "motionfield/motion-render/mp4",
      kind: "video",
      params: [
        { name: "spec_id", label: "Spec", type: "text", required: true, description: "uuid of a render_specs row you own" },
        // `values` (param-id → number map) passes through unvalidated by design
      ],
      cost: () => 0, // local render - free
      providers: { recipe: { name: "motion-render" } },
    },
  ],
};
export const CODE_MOTION_MODELS: ModelDef[] = [MOTION_RENDER];
