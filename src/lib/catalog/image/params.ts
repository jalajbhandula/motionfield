import type { ParamField } from "../types";

/** Shared param-field factories for the image endpoint definitions. */

export const prompt = (req = true): ParamField => ({
  name: "prompt", label: "Prompt", type: "prompt", required: req,
  placeholder: "Describe the image you want to create…",
});

export const aspectImage: ParamField = {
  name: "aspect_ratio", label: "Aspect ratio", type: "select", default: "4:3",
  enum: ["9:16", "16:9", "4:3", "3:4", "1:1", "2:3", "3:2", "5:4", "4:5", "21:9"],
};

export const resImage = (opts = ["720p", "1080p", "2K", "4K"]): ParamField => ({
  name: "resolution", label: "Resolution", type: "select", default: opts[0], enum: opts,
});

export const seed: ParamField = { name: "seed", label: "Seed", type: "integer", min: 1, max: 1000000, description: "Leave empty for random" };
export const numImages: ParamField = { name: "batch_size", label: "Batch size", type: "select", default: 1, enum: [1, 4] };
/** look_id stays declared - the UI lists only verified look presets and hides
 *  the field entirely while there are none (no silent no-op control). No
 *  default: a look is opt-in, and "general" must not ride every job (the
 *  resolve gate would reject it - the general look is a hidden spec). */
export const styleId: ParamField = { name: "look_id", label: "Look", type: "select", description: "Look preset" };
export const inputImage = (req = true): ParamField => ({ name: "image_url", label: "Image", type: "image", required: req, accepts: "image/*" });
export const steps = (def = 4, note = "distilled - 4 is the sweet spot"): ParamField => ({ name: "steps", label: "Sampler steps", type: "integer", default: def, min: 1, max: 20, description: note });
/** Extra context images for the klein edit/place flows. The API accepts up to
 *  10 (validated server-side); the local Mac graph consumes the first three -
 *  the label says so rather than silently dropping refs. */
export const refImages: ParamField = {
  name: "image_urls", label: "Reference images (0-10)", type: "images", maxItems: 10, accepts: "image/*",
  description: "Optional extra refs (style/identity/material). Uses your first 3 refs on this Mac.",
};
/** The four normalised bbox fields - one per edge so the param layer can
 *  coerce and bound each (0-1). */
export const bboxFields: ParamField[] = ([
  ["bbox_x", "Box left"], ["bbox_y", "Box top"], ["bbox_w", "Box width"], ["bbox_h", "Box height"],
] as const).map(([name, label]) => ({
  name, label, type: "number" as const, min: 0, max: 1, step: 0.01,
  description: "normalised 0-1 of the scene frame - used only with a scene image",
}));
export const denoise: ParamField = { name: "denoise", label: "Denoise", type: "slider", default: 0.75, min: 0.1, max: 1, step: 0.05, description: "How far to move from the source image" };
