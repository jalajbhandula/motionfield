import type { ModelDef } from "../types";
import {
  prompt, aspectImage, resImage, seed, numImages, styleId,
  inputImage, steps, denoise, refImages,
} from "./params";
import { LIKENESS_CONSENT_FIELD as likenessConsent, likenessConsentCheck } from "../../likeness";

export const Z_IMAGE_TURBO: ModelDef = {
  id: "z-image-turbo",
  label: "Z-Image-Turbo",
  vendor: "Tongyi-MAI (Alibaba)",
  kind: "image",
  description: "Apache-2.0 open text-to-image (Z-Image-Turbo, 8-step distilled) - the fast local default. Photoreal output, bilingual text rendering, strong instruction adherence. Runs comfortably on Apple Silicon 32 GB.",
  tags: ["photoreal", "fast", "styles"],
  workflows: [
    {
      id: "text-to-image", label: "Generate", endpointId: "motionfield/z-image-turbo/text-to-image", kind: "image",
      /* only params the zimage graph actually consumes (PROMPT, WIDTH,
       * HEIGHT, STEPS, SEED, BATCH, PREFIX → aspect/resolution) - the dead
       * character/strength/auto-prompt/reference controls were removed; look_id
       * stays and lists only verified look presets */
      params: [
        prompt(), aspectImage, resImage(["1K", "720p", "1080p"]), steps(8, "Turbo is distilled - ~8 steps"), styleId,
        seed, numImages,
      ],
      cost: (p) => 0.08 * (Number(p.batch_size) || 1),
      providers: { comfy: { workflow: "zimage-txt2img.json" } },
    },
    {
      id: "img2img", label: "Img2Img", endpointId: "motionfield/z-image-turbo/img2img", kind: "edit",
      params: [prompt(), inputImage(), denoise, seed],
      cost: () => 0.08,
      providers: { comfy: { workflow: "zimage-img2img.json" } },
    },
  ],
};

export const CHARACTER: ModelDef = {
  id: "character",
  label: "Character",
  vendor: "Alibaba (Wan-AI · Qwen)",
  kind: "image",
  description: "Consistent-character images without training - 1-3 reference photos lock the character, the prompt moves them into new scenes/outfits. Runs locally on Wan VACE; a Qwen-Image-Edit multi-reference variant is offered for cloud/GPU.",
  tags: ["character", "character", "consistency"],
  workflows: [
    {
      id: "generate", label: "Generate (local)", endpointId: "motionfield/character/generate", kind: "image",
      params: [
        { name: "image_urls", label: "Character references (1-3)", type: "images", required: true, maxItems: 3, accepts: "image/*" },
        prompt(),
        { ...aspectImage, default: "3:4" }, resImage(["480p", "720p"]),
        { name: "pose_image_url", label: "Pose guide (optional)", type: "image", accepts: "image/*", group: "Consistency",
          description: "A photo or pose render whose framing the character copies." },
        { name: "batch_size", label: "Batch size", type: "select", default: 2, enum: [1, 2, 4] },
        steps(8, "VACE still-image gen - 8-16 for drafts, more for polish"), seed,
      ],
      cost: (p) => 0.4 * (Number(p.batch_size) || 1),
      providers: { comfy: { workflow: "character-vace-image.json" } },
    },
    {
      id: "generate-hd", label: "Generate (multi-ref HD)", endpointId: "motionfield/qwen-image-edit/character", kind: "image",
      params: [
        { name: "image_urls", label: "Character references (1-3)", type: "images", required: true, maxItems: 3, accepts: "image/*" },
        prompt(), aspectImage, resImage(["720p", "1080p"]), seed,
      ],
      cost: (p) => 1.5 * (Number(p.batch_size) || 1),
      providers: { comfy: { workflow: "qwen-character-edit.json" } },
      heavy: "Qwen-Image-Edit-2511 (~29 GB fp8) - Comfy Cloud or a CUDA GPU recommended; not practical on Apple Silicon 32 GB.",
    },
  ],
};

/** FLUX.2 klein 4B - the new local edit backbone + an extra local t2i option.
 *  Apache-2.0, official distilled bf16 (7.75 GB - Comfy-Org/Flux-2-Klein-4B
 *  split_files/diffusion_models/, upstream black-forest-labs/FLUX.2-klein-4B) -
 *  replaces schnell (which could not finish a 4-step job on this box).
 *  Z-Image-Turbo stays the default t2i (klein is weaker at pure generation;
 *  its strength is reference-driven edit). */
export const FLUX2_KLEIN: ModelDef = {
  id: "flux2-klein",
  label: "FLUX.2 klein 4B",
  vendor: "Black Forest Labs",
  kind: "image",
  description: "Apache-2.0 FLUX.2 klein 4B (4-step distilled) - the Mac default for instruction edit and masked remove, and an extra local text-to-image beside Z-Image-Turbo (weaker at pure t2i - Z-Image stays the default there).",
  tags: ["edit", "inpaint", "photoreal", "fast"],
  workflows: [
    {
      id: "text-to-image", label: "Generate", endpointId: "motionfield/flux2-klein/text-to-image", kind: "image",
      params: [
        prompt(), aspectImage, resImage(["720p", "1080p"]), steps(4), styleId, seed, numImages,
      ],
      cost: (p) => 0.12 * (Number(p.batch_size) || 1),
      providers: { comfy: { workflow: "klein-txt2img.json", map: (p) => ({ STEPS: String(p.steps ?? 4) }) } },
    },
    {
      id: "edit", label: "Edit (instruction)", endpointId: "motionfield/flux2-klein/edit", kind: "edit",
      params: [prompt(), inputImage(), refImages, steps(4), seed],
      cost: () => 0.15,
      providers: { comfy: { workflow: "klein-edit.json", map: (p) => ({ STEPS: String(p.steps ?? 4) }) } },
      validate: (p) => Array.isArray(p.image_urls) && p.image_urls.length > 10
        ? "image_urls: at most 10 reference images" : null,
    },
    {
      id: "inpaint", label: "Mask edit / remove", endpointId: "motionfield/flux2-klein/inpaint", kind: "edit",
      params: [
        prompt(), inputImage(),
        { name: "mask_url", label: "Mask image", type: "image", required: true, description: "Brushed mask - white marks the region to change (paint it in any editor and upload). Pixels outside it keep the source." },
        { name: "mode", label: "Mode", type: "select", default: "inpaint", enum: ["inpaint", "remove"], description: "inpaint: fill the region per the prompt · remove: erase the object and fill with matching background" },
        steps(4), seed,
      ],
      cost: () => 0.15,
      providers: {
        comfy: {
          workflow: "klein-inpaint.json",
          map: (p) => ({
            STEPS: String(p.steps ?? 4),
            ...(p.mode === "remove"
              ? { PROMPT: `Remove the object in the marked region completely and fill the area with background that matches the surrounding scene. ${p.prompt ?? ""}` }
              : {}),
          }),
        },
      },
    },
    {
      /* s7b - the consented photo face swap. DWPose+BiRefNet mask the
       * source's face region inside the graph, klein edits the identity in,
       * and the output PNG is prov-tagged. Consent gates both identity
       * uploads - a person's photo IS the likeness here. */
      id: "face-edit", label: "Face swap (photo)", endpointId: "motionfield/flux2-klein-4b/face-edit", kind: "edit",
      params: [
        { ...inputImage(), label: "Source photo", description: "The photo whose face is replaced - pixels outside the face region stay yours." },
        likenessConsent,
        { name: "image_urls", label: "Identity photo (1)", type: "images", required: true, maxItems: 1, accepts: "image/*",
          description: "A clear photo of the person whose face goes in - the consented identity." },
        prompt(false), steps(4), seed,
      ],
      cost: () => 0.15,
      providers: {
        comfy: {
          workflow: "klein-faceswap.json",
          map: (p) => ({
            STEPS: String(p.steps ?? 4),
            PROMPT: `Photorealistic identity transplant: the person in the first image now has the exact face and identity of the person in the second image - same facial features, same eyes, same nose, same mouth, same skin texture. Keep the first image's hair, pose, clothing, lighting and background completely unchanged. ${String(p.prompt ?? "")}`.trim(),
          }),
        },
      },
      validate: likenessConsentCheck("motionfield/flux2-klein-4b/face-edit"),
    },
  ],
};

/** Removed in ws4-s7 - schnell never completed a smoke on this box (~4
 *  min/step under swap) and its workflows are deleted. Tombstone kept so the
 *  image-models barrel still resolves; provider-less defs never reach the
 *  catalog, so the old endpoint ids answer the normal unknown-endpoint 404. */
export const FLUX_SCHNELL: ModelDef = {
  id: "flux-schnell",
  label: "FLUX.1 [schnell] - removed",
  vendor: "Black Forest Labs",
  kind: "image",
  description: "Removed - replaced by FLUX.2 klein 4B (faster, commercial-friendly). The schnell endpoints no longer resolve.",
  tags: [],
  workflows: [{
    id: "text-to-image", label: "Generate", endpointId: "motionfield/flux-schnell/text-to-image", kind: "image",
    params: [prompt()],
    cost: () => 0,
    providers: {},
  }],
};

export const IMAGE_GENERATE_MODELS: ModelDef[] = [Z_IMAGE_TURBO, CHARACTER, FLUX2_KLEIN];
