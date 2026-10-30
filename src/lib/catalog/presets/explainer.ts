/**
 * Explainer looks - the visual language every scene keyframe shares.
 *
 *  A look is honest because it is only ever these strings: the recipe folds
 *  `prompt` into every scene image's prompt text and passes `negative` to the
 *  motion endpoints that declare a negative_prompt field (Wan VACE, Wan 2.2,
 *  LTX - the still path takes nothing). Ids and labels are our own words -
 *  no artist, studio or brand names.
 *
 *  The `look` endpoint param enumerates the nine ids plus "custom" (the
 *  free-text `style` field takes over). An unknown id is refused at plan
 *  validation, at job submit, and inside the recipe.
 */

export interface ExplainerLook {
  id: string;
  label: string;
  /** style clause folded into every scene keyframe prompt */
  prompt: string;
  /** negative steering for the motion endpoints that accept one */
  negative: string;
}

export const EXPLAINER_LOOKS: readonly ExplainerLook[] = [
  { id: "pixel-art", label: "Pixel Art",
    prompt: "pixel art illustration, chunky visible pixels, limited retro palette, crisp square edges",
    negative: "blurry gradients, photorealism, smooth anti-aliasing, watermark" },
  { id: "clay", label: "Clay",
    prompt: "handmade clay stop-motion look, matte sculpted shapes, visible fingerprints, soft studio lighting",
    negative: "glossy plastic, photorealism, flat vector, lens flare" },
  { id: "collage", label: "Collage",
    prompt: "paper collage illustration, torn paper edges, layered cut-out shapes, subtle grain texture",
    negative: "smooth gradients, photorealism, clean 3d render" },
  { id: "flat-2d", label: "Flat 2D",
    prompt: "flat 2d vector illustration, clean geometric shapes, muted palette, minimal shading",
    negative: "photorealism, heavy texture, 3d depth, film grain" },
  { id: "whiteboard", label: "Whiteboard",
    prompt: "whiteboard marker sketch, hand-drawn black line art on a white background, simple annotations",
    negative: "full color fill, photorealism, glossy finish, gradients" },
  { id: "low-poly", label: "Low Poly",
    prompt: "low-poly 3d illustration, faceted geometric surfaces, flat-shaded triangles, clean render",
    negative: "photorealism, smooth subdivision, skin pores, heavy texture" },
  { id: "glossy-3d", label: "Glossy 3D",
    prompt: "glossy 3d render, smooth rounded shapes, soft studio reflections, pastel materials",
    negative: "flat vector, rough texture, film grain, sketch lines" },
  { id: "isometric", label: "Isometric",
    prompt: "isometric illustration, strict 30-degree grid, clean technical lines, flat colors with subtle depth",
    negative: "perspective distortion, photorealism, painterly strokes" },
  { id: "plush", label: "Plush",
    prompt: "soft plush toy look, fuzzy fabric texture, stitched seams, rounded cuddly proportions, warm light",
    negative: "hard edges, metallic surfaces, photorealistic skin" },
];

/** enum values the `look` param offers - the nine looks plus "custom" */
export const EXPLAINER_LOOK_IDS: readonly string[] = EXPLAINER_LOOKS.map((l) => l.id);
export const LOOK_VALUES: readonly string[] = [...EXPLAINER_LOOK_IDS, "custom"];

/** caption modes the `captions` param offers - karaoke/pop burn in, off skips */
export const CAPTION_VALUES: readonly string[] = ["karaoke", "pop", "off"];

/**
 * Narration languages the installed Kokoro voices actually speak: the af_/am_
 * voices are US English, bf_/bm_ are UK English - English is all this
 * machine's voice set produces. No language picker exists until a smoke
 * proves a wider set; this list is the honest record.
 */
export const NARRATION_LANGUAGES: readonly { id: string; label: string }[] = [
  { id: "en-US", label: "English (US) - af_/am_ voices" },
  { id: "en-GB", label: "English (UK) - bf_/bm_ voices" },
];
