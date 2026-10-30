/* ============ Mini-app catalog (data-driven one-task tools) ============
 *  Every tile declares a PresetSpec (./schema.ts): the mechanism that makes
 *  the label true, the inputs it consumes, and its verification contract.
 *  Deep links carry the mechanism into the studio - `?params=` prefills the
 *  instruction/template into the prompt field so the tile does what it says
 *  without inventing dead query params.
 *
 *  Hidden tiles (no honest executor on trunk) stay in APPS for tooling but
 *  never render - /apps filters by specVisible(). */

import { registerCatalog, type PresetSpec } from "./schema";
import { MOTION_PRESETS, presetTrajectories } from "./trajectories";
import { EFFECT_PRESETS } from "./effects";
import type { PresetDef } from "../types";

export interface AppDef {
  slug: string;
  title: string;
  blurb: string;
  category: "video" | "image" | "audio" | "utility";
  /** route of the studio it deep-links into, with query params */
  href: string;
  posterHue: number;
}

export interface AppSpec extends PresetSpec {
  blurb: string;
  appCategory: AppDef["category"];
  href: string;
}

const hue = (id: string) => Math.abs([...id].reduce((x, c) => x + c.charCodeAt(0), 0)) % 360;

const VACE_I2V = "/ai/video?model=wan-vace&flow=image-to-video";
/** B1 tiles run the local klein edit now - Qwen-Edit stays in the catalog as
 *  the heavy / cloud-recommended option. */
const KLEIN_EDIT = "/ai/image?model=flux2-klein&flow=edit";
const Z_IMAGE = "/ai/image?model=z-image-turbo";

/** deep link that lands with the instruction already in the prompt field */
const prefill = (base: string, text: string) =>
  `${base}&params=${encodeURIComponent(JSON.stringify({ prompt: text }))}`;

const base = (spec: Omit<AppSpec, "catalog" | "tier" | "verify"> & Partial<Pick<AppSpec, "tier" | "verify">>,
  extra?: Partial<AppSpec>): AppSpec => {
  const s: AppSpec = {
    catalog: "app",
    tier: "local",
    verify: {
      checker: "vision",
      question: `does the output deliver what "${spec.label}" promises - ${spec.blurb}`,
      fixture: "portrait.png",
    },
    ...spec,
    ...extra,
  };
  // a deep link's prefilled prompt IS the mechanism text - never a hand-typed
  // variant that could drift from what the tile actually runs
  const m = s.mechanism;
  const mechText = m.kind === "edit_recipe" ? m.instruction : m.kind === "template" ? m.template : null;
  if (mechText && !s.href.includes("params=")) s.href = prefill(s.href, mechText);
  return s;
};

/** every trajectory the camera-motion tile can offer (WS3 ids, read-only) */
const ALL_TRAJECTORY_IDS = [...new Set(MOTION_PRESETS.flatMap((p) => presetTrajectories(p)))].sort();

export const APP_SPECS: AppSpec[] = [
  base({
    id: "lead-swap", label: "Lead Swap", blurb: "Swap a video's lead for your own character.",
    appCategory: "video", collection: "swap",
    inputs: ["video", "image"],
    mechanism: { kind: "composite", endpoint: "motionfield/wan-vace/character-swap" },
    href: "/ai/video?model=wan-vace&flow=character-swap",
  }),
  base({
    id: "camera-motion", label: "Camera Motion", blurb: "Apply cinematic camera moves to a still.",
    appCategory: "video", collection: "camera",
    inputs: ["image"],
    mechanism: { kind: "trajectory", ids: ALL_TRAJECTORY_IDS },
    href: VACE_I2V,
  }),
  base({
    id: "outfit-swap", label: "Outfit Swap", blurb: "Try a new outfit on a photo.",
    appCategory: "image", collection: "photo-edits",
    inputs: ["image", "prompt"], tier: "local",
    mechanism: { kind: "edit_recipe", endpoint: "motionfield/flux2-klein/edit",
      instruction: "dress the subject in the outfit described below; keep the face, pose and background identical" },
    href: KLEIN_EDIT,
  }),
  base({
    id: "outfit-try-on", label: "Outfit Try-On", blurb: "Wardrobe and styling - try a new look on a photo.",
    appCategory: "image",
    inputs: ["image", "prompt"], tier: "local",
    mechanism: { kind: "edit_recipe", endpoint: "motionfield/flux2-klein/edit",
      instruction: "restyle the subject's full wardrobe and styling; keep identity and pose" },
    href: KLEIN_EDIT,
    hidden: { reason: "until WS4 s16 - the wardrobe-diffusion path it promises isn't wired yet" },
  }),
  base({
    id: "relight", label: "Relight", blurb: "Change the lighting of a photo.",
    appCategory: "image", collection: "photo-edits",
    inputs: ["image", "prompt"], tier: "local",
    mechanism: { kind: "edit_recipe", endpoint: "motionfield/flux2-klein/edit",
      instruction: "relight the scene per the prompt - keep the subject and composition identical" },
    href: KLEIN_EDIT,
  }),
  base({
    id: "expand-image", label: "Expand Image", blurb: "Outpaint beyond the frame.",
    appCategory: "image", collection: "photo-edits",
    inputs: ["image", "prompt"], tier: "local",
    mechanism: { kind: "edit_recipe", endpoint: "motionfield/flux2-klein/edit",
      instruction: "extend the scene beyond the frame - outpaint the surrounding context seamlessly" },
    href: KLEIN_EDIT,
  }),
  base({
    id: "color-grading", label: "Color Grading", blurb: "Film-style grading on footage.",
    appCategory: "video", collection: "restyle",
    inputs: ["video", "prompt"],
    mechanism: { kind: "restyle", endpoint: "motionfield/wan-vace/restyle", control: "depth" },
    verify: { checker: "vision", question: "is the footage regraded without losing motion or structure?", fixture: "clip-2s.mp4" },
    href: "/ai/video?model=wan-vace&flow=restyle",
  }),
  base({
    id: "skin-retouch", label: "Skin Retouch", blurb: "Beauty retouch pass.",
    appCategory: "image", collection: "photo-edits",
    inputs: ["image"], tier: "local",
    mechanism: { kind: "edit_recipe", endpoint: "motionfield/flux2-klein/edit",
      instruction: "even out skin, remove blemishes and shine; keep identity, texture and lighting" },
    href: KLEIN_EDIT,
  }),
  base({
    id: "transitions", label: "Transitions", blurb: "Generate a bridging shot that blends two scenes.",
    appCategory: "video",
    inputs: ["image", "image"],
    mechanism: { kind: "keyframe_edit", endpoint: "motionfield/ltx-video/vfx-keyframe",
      recipe: "bridge shot morphing scene A into scene B" },
    href: "/ai/video",
    hidden: { reason: "needs an Apache start+end-frame bridge (WS3 s6) - the only keyframe endpoint today is Open RAIL-M restricted" },
  }),
  base({
    id: "new-angle", label: "New Angle", blurb: "Re-render a shot from a different camera angle.",
    appCategory: "image", collection: "photo-edits",
    inputs: ["image", "prompt"], tier: "local",
    mechanism: { kind: "edit_recipe", endpoint: "motionfield/flux2-klein/edit",
      instruction: "re-render the scene from the camera angle in the prompt; keep subject and style" },
    href: KLEIN_EDIT,
  }),
  base({
    id: "shot-coverage", label: "Shot Coverage", blurb: "Break a scene into a set of covering shots.",
    appCategory: "video",
    inputs: ["video", "prompt"],
    mechanism: { kind: "pipeline", pipeline: "shot-coverage" },
    href: "/generate",
    hidden: { reason: "needs a mechanism - no coverage-split pipeline exists on trunk" },
  }),
  base({
    id: "3d-render", label: "3D-Look Render", blurb: "Render an image with a turntable 3D look.",
    appCategory: "image", collection: "ads",
    inputs: ["prompt"], tier: "local",
    mechanism: { kind: "template", endpoint: "motionfield/z-image-turbo/text-to-image",
      template: "{input} - stylized 3D turntable render, clean studio lighting, product-shot finish" },
    verify: { checker: "vision", question: "is the output a 3D-look product render?" },
    href: Z_IMAGE,
  }),
  base({
    id: "figure-mockup", label: "Figure Mockup", blurb: "Character figure mockup renders.",
    appCategory: "image", collection: "ads",
    inputs: ["prompt"], tier: "local",
    mechanism: { kind: "template", endpoint: "motionfield/z-image-turbo/text-to-image",
      template: "{input} - collectible figure mockup, blister-pack product shot, soft studio light" },
    verify: { checker: "vision", question: "does the output look like a character figure mockup?" },
    href: Z_IMAGE,
  }),
  base({
    id: "orbit-shot", label: "Orbit Shot", blurb: "Circle a product or character on camera.",
    appCategory: "video", collection: "camera",
    inputs: ["image"],
    mechanism: { kind: "trajectory", ids: ["orbit-360"] },
    verify: { checker: "vision", question: "does the camera orbit the subject?", fixture: "product.png" },
    href: `${VACE_I2V}&preset=360-orbit`,
  }),
  base({
    id: "packshot", label: "Packshot", blurb: "Clean studio product shots.",
    appCategory: "image", collection: "swap",
    inputs: ["image", "prompt"], tier: "local",
    mechanism: { kind: "composite", endpoint: "motionfield/product-placement" },
    verify: { checker: "vision", question: "is the product placed into a clean studio shot?", fixture: "product.png" },
    href: "/ai/image?model=product-placement&flow=place",
  }),
  base({
    id: "poster", label: "Poster", blurb: "Poster-style key art from a prompt.",
    appCategory: "image", collection: "ads",
    inputs: ["prompt"], tier: "local",
    mechanism: { kind: "template", endpoint: "motionfield/z-image-turbo/text-to-image",
      template: "{input} - poster key art, bold composition, cinematic grade" },
    verify: { checker: "vision", question: "does the output read as poster key art?" },
    href: Z_IMAGE,
  }),
  base({
    id: "sparkle-sticker", label: "Sparkle Sticker", blurb: "Die-cut sticker versions of a photo.",
    appCategory: "image", collection: "photo-edits",
    inputs: ["image"], tier: "local",
    mechanism: { kind: "edit_recipe", endpoint: "motionfield/flux2-klein/edit",
      instruction: "turn the subject into a die-cut sticker with a white border and sparkle accents" },
    href: KLEIN_EDIT,
  }),
  base({
    id: "plush-toy", label: "Plush Toy", blurb: "Turn anything into a plush toy render.",
    appCategory: "image", collection: "photo-edits",
    inputs: ["image"], tier: "local",
    mechanism: { kind: "edit_recipe", endpoint: "motionfield/flux2-klein/edit",
      instruction: "re-render the subject as a soft plush toy - fabric texture, stitched seams" },
    href: KLEIN_EDIT,
  }),
  base({
    id: "meme-generator", label: "Meme Generator", blurb: "Prompt-to-meme images.",
    appCategory: "image", collection: "ads",
    inputs: ["prompt"], tier: "local",
    mechanism: { kind: "template", endpoint: "motionfield/z-image-turbo/text-to-image",
      template: "{input} - meme image, punchy framing, readable at thumbnail size" },
    verify: { checker: "vision", question: "does the output read as a meme image?" },
    href: Z_IMAGE,
  }),
  base({
    id: "making-of-stills", label: "Making-of Stills", blurb: "Behind-the-scenes style stills of your scene.",
    appCategory: "image", collection: "ads",
    inputs: ["prompt"], tier: "local",
    mechanism: { kind: "template", endpoint: "motionfield/z-image-turbo/text-to-image",
      template: "{input} - behind-the-scenes production still, candid set photo, archival look" },
    verify: { checker: "vision", question: "does the output read as a behind-the-scenes still?" },
    href: Z_IMAGE,
  }),
  base({
    id: "frozen-orbit-scene", label: "Frozen Orbit", blurb: "Freeze the moment while the camera circles.",
    appCategory: "video", collection: "camera",
    inputs: ["image"],
    mechanism: { kind: "trajectory", ids: ["frozen-moment-arc"] },
    href: `${VACE_I2V}&preset=frozen-orbit`,
  }),
  base({
    id: "macro-shot", label: "Macro Shot", blurb: "Extreme close-up detail worlds.",
    appCategory: "video", collection: "camera",
    inputs: ["image"],
    mechanism: { kind: "trajectory", ids: ["crash-zoom-in"] },
    verify: { checker: "vision", question: "does the camera push into extreme close-up?" },
    /* re-pointed off the restricted director/ltx endpoint - Wan 2.2 i2v
     * (Apache) + the crash-zoom trajectory preset */
    href: "/ai/video?model=wan-2-2&flow=image-to-video&preset=snap-zoom-in",
  }),
  base({
    id: "url-to-ad", label: "URL to Ad", blurb: "Paste a product link, get an ad.",
    appCategory: "utility", collection: "ads",
    inputs: ["prompt"],
    mechanism: { kind: "pipeline", pipeline: "ad-lab" },
    verify: { checker: "vision", question: "does the output look like a product ad?", fixture: "product.png" },
    href: "/product-ads",
    hidden: { reason: "executor pending - Ad Lab runner (s11)" },
  }),
  /* s7b - consented face swap into one photo. The tile is also the spec for
   * the photo-face-swap preset (shared id → one verified mechanism); the
   * endpoint gates consent, the graph masks the face region itself, and the
   * output PNG is prov-tagged. */
  base({
    id: "photo-face-swap", label: "Face Swap", blurb: "Swap the face in a photo for a consented identity.",
    appCategory: "image", collection: "swap",
    inputs: ["image", "image"],
    mechanism: { kind: "image_edit", endpoint: "motionfield/flux2-klein-4b/face-edit" },
    verify: { checker: "vision", question: "does the photo show the identity photo's face on the source's pose and scene?", fixture: "portrait.png" },
    href: `/edit?params=${encodeURIComponent(JSON.stringify({ preset_id: "photo-face-swap" }))}&preset=photo-face-swap`,
  }),
];

/* The param-side def for the face-swap tile - preset_id resolution needs a
 * PresetDef in a findPreset registry; its spec is the app tile above (the
 * shared photo-face-swap id), so the same verify record gates both. */
const PHOTO_FACE_SWAP_DEF: PresetDef = {
  id: "photo-face-swap",
  title: "Face Swap",
  description: "Consented face swap into one photo - the face region is masked, the identity edited in, output is prov-tagged.",
  kind: "effect",
  category: "photo-edits",
  apply: {},
  inputRequired: "image",
  credits: 1,
  modelHint: "flux2-klein",
};
EFFECT_PRESETS.push(PHOTO_FACE_SWAP_DEF);

registerCatalog("app", () => APP_SPECS);

export const APPS: AppDef[] = APP_SPECS.map((s) => ({
  slug: s.id,
  title: s.label,
  blurb: s.blurb,
  category: s.appCategory,
  href: s.href,
  posterHue: hue(s.id),
}));
