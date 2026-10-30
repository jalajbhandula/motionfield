/* Catalog aggregator - one entry point for the whole catalog surface.
 *  Import everything through here in new code; the old top-level files
 *  (video-models, image-models, presets, skills, plans, serialize) stay as
 *  back-compat barrels.
 *
 *  Pure data + pure functions only - this module must stay client-safe
 *  (no fs/db imports; the license gate lives in ./license-gate). */

export * from "./types";
export * from "./video-models";
export * from "./image-models";
export * from "./presets";
export * from "./skills";
export * from "./plans";
export * from "./serialize";
export * from "./licenses";
export * from "./licenses.generated";

// domain files - future per-workstream exports aggregate through here
export * from "./video/generate";
export * from "./video/camera";
export * from "./video/vfx";
export * from "./video/swap";
export * from "./video/post";
export * from "./video/recipes";
export * from "./image/generate";
export * from "./image/edit";
export * from "./image/relight";
export * from "./image/angles";
export * from "./audio/voice";
export * from "./audio/music";
export * from "./code/motion";
export * from "./code/games";
export * from "./presets/trajectories";
export * from "./presets/director";
export * from "./presets/palettes";
export * from "./presets/effects";
export * from "./presets/styles";
export * from "./presets/apps";
export * from "./presets/person-swap";
