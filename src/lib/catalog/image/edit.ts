import type { ModelDef } from "../types";
import { prompt, aspectImage, seed, inputImage, refImages, bboxFields, numImages, steps } from "./params";

export const BIREFNET: ModelDef = {
  id: "birefnet",
  label: "BiRefNet Cutout",
  vendor: "ZhengPeng7 (BiRefNet)",
  kind: "edit",
  description: "Background removal on MIT-licensed BiRefNet weights - upload an image, get a transparent-background PNG plus the matte. Runs natively and fast on Apple Silicon.",
  tags: ["cutout", "utility", "fast"],
  workflows: [{
    id: "remove-background", label: "Remove background", endpointId: "motionfield/birefnet/remove-background", kind: "edit",
    params: [inputImage()],
    cost: () => 0.5,
    providers: { comfy: { workflow: "birefnet-remove-bg.json" } },
  }],
};

const QWEN_EDIT_MODES = ["edit", "angles"] as const;

export const QWEN_IMAGE_EDIT: ModelDef = {
  id: "qwen-image-edit",
  label: "Qwen Image Edit",
  vendor: "Alibaba (Qwen)",
  kind: "edit",
  description: "Instruction-based image editing (Qwen-Image-Edit-2511, Apache-2.0) - describe the change in words. Heavy: ~20B transformer + 7B VL encoder - Comfy Cloud or a CUDA GPU recommended.",
  tags: ["edit", "heavy"],
  workflows: [{
    id: "edit", label: "Edit", endpointId: "motionfield/qwen-image-edit/edit", kind: "edit",
    params: [prompt(), inputImage(),
      { name: "edit_mode", label: "Edit mode", type: "select", default: "edit",
        enum: [...QWEN_EDIT_MODES],
        description: "edit = plain instruction edit · angles = camera/viewpoint moves via the Qwen-Edit Multiple-angles LoRA" },
      { name: "steps", label: "Sampler steps", type: "integer", default: 40, min: 4, max: 80,
        description: "official template default 40 (cfg 4) - drop to ~8 for drafts" }, seed],
    cost: () => 1.5,
    providers: {
      comfy: {
        workflow: "qwenedit2511-edit.json",
        workflowFor: (p) => (p.edit_mode === "angles" ? "qwenedit2511-angles.json" : undefined),
        variantParam: { name: "edit_mode", values: QWEN_EDIT_MODES },
        map: (p) => ({ STEPS: String(p.steps ?? 40) }),
      },
    },
    heavy: "~20B transformer + 7B VL encoder (~29 GB fp8) - Comfy Cloud or a CUDA GPU recommended; not practical on Apple Silicon 32 GB.",
  }],
};

/** Removed in ws4-s7 - see FLUX_SCHNELL's tombstone in ./generate. Providerless
 *  defs never reach the catalog; the ids die with a normal unknown-endpoint. */
export const SCHNELL_IMG2IMG: ModelDef = {
  id: "schnell-img2img",
  label: "FLUX.1 [schnell] Img2Img - removed",
  vendor: "Black Forest Labs",
  kind: "edit",
  description: "Removed - superseded by FLUX.2 klein 4B edit (motionfield/flux2-klein/edit).",
  tags: [],
  workflows: [{
    id: "img2img", label: "Img2Img", endpointId: "motionfield/flux-schnell/img2img", kind: "edit",
    params: [prompt(), inputImage()],
    cost: () => 0,
    providers: {},
  }],
};

export const SCHNELL_INPAINT: ModelDef = {
  id: "schnell-inpaint",
  label: "FLUX.1 [schnell] Inpaint - removed",
  vendor: "Black Forest Labs",
  kind: "edit",
  description: "Removed - superseded by FLUX.2 klein 4B mask edit (motionfield/flux2-klein/inpaint).",
  workflows: [{
    id: "inpaint", label: "Inpaint", endpointId: "motionfield/flux-schnell/inpaint", kind: "edit",
    params: [prompt(), inputImage()],
    cost: () => 0,
    providers: {},
  }],
};

const BBOX_KEYS = ["bbox_x", "bbox_y", "bbox_w", "bbox_h"] as const;

export const PRODUCT_PLACEMENT: ModelDef = {
  id: "product-placement",
  label: "Product Placement · FLUX.2 klein",
  vendor: "Black Forest Labs",
  kind: "edit",
  description: "Your product, actually placed: with a scene photo it is BiRefNet-cut, pasted inside your drawn box, and the product's own pixels are kept - klein only blends the edges, shadow and light around it, and pixels outside the region stay yours. With no scene, klein generates one around the product (the Ad Lab / packshot path).",
  workflows: [{
    id: "place", label: "Place", endpointId: "motionfield/product-placement", kind: "edit",
    params: [
      { name: "product_image_url", label: "Product image", type: "image", required: true,
        description: "The product shot - with a scene it is cut out and pasted inside the box; the product's own pixels are kept and klein only blends the edges, shadow and light around it." },
      { ...inputImage(false), label: "Scene image (optional)",
        description: "Paste target - with a scene, draw the placement box below; without one klein generates the scene around the product." },
      prompt(false),
      ...bboxFields,
      refImages,
      { ...aspectImage, label: "Aspect ratio (no scene)", description: "Only used when no scene image is supplied - with a scene the output keeps the scene's frame" },
      numImages, steps(4), seed,
    ],
    cost: (p) => 0.2 * (Number(p.batch_size) || 1),
    providers: {
      comfy: {
        workflow: "klein-product-scene.json",
        workflowFor: (p) => (p.image_url ? "klein-product-compose.json" : undefined),
        map: (p) => ({
          STEPS: String(p.steps ?? 4),
          PROMPT: p.image_url
            ? String(p.prompt || "Blend the product naturally into the scene - match lighting, shadow and perspective.")
            : `Product advertisement: ${String(p.prompt || "clean studio product shot")}. The product in the reference image must appear in the scene.`,
        }),
      },
    },
    validate: (p) => {
      const refs = p.image_urls;
      if (Array.isArray(refs) && refs.length > 10) return "image_urls: at most 10 reference images";
      const hasScene = typeof p.image_url === "string" && p.image_url !== "";
      if (hasScene) {
        for (const k of BBOX_KEYS) {
          const v = p[k];
          if (v === undefined || v === null || v === "") return `${k} is required when a scene image is supplied`;
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0 || n > 1) return `${k}: expected a number between 0 and 1`;
        }
        if (Number(p.bbox_w) <= 0 || Number(p.bbox_h) <= 0) return "bbox_w/bbox_h must be > 0";
        if (Number(p.bbox_x) + Number(p.bbox_w) > 1 || Number(p.bbox_y) + Number(p.bbox_h) > 1)
          return "the placement box must fit inside the frame (x+w and y+h ≤ 1)";
      }
      // no scene → the generated-scene arm: bbox_* fields are ignored (skills
      // like ugc-ad always send their defaults)
      return null;
    },
  }],
};

export const UPSCALER: ModelDef = {
  id: "upscaler",
  label: "Real-ESRGAN 4×",
  vendor: "Tencent ARC",
  kind: "upscale",
  description: "Upscale images with Real-ESRGAN x4plus (BSD-3).",
  workflows: [{
    id: "upscale", label: "Upscale", endpointId: "motionfield/upscale/image", kind: "upscale",
    params: [inputImage(), { name: "scale", label: "Scale", type: "select", default: 2, enum: [2, 4] }],
    cost: (p) => (Number(p.scale) === 4 ? 2 : 1),
    // the ESRGAN model is fixed 4x - ×2 downsamples its output (lanczos) so
    // the "Scale" choice is honoured instead of always returning 4x
    providers: { comfy: { workflow: "upscale-4x.json", map: (p) => ({ SCALE_BY: Number(p.scale) === 4 ? 1 : 0.5 }) } },
  }],
};

export const IMAGE_EDIT_MODELS: ModelDef[] = [BIREFNET, QWEN_IMAGE_EDIT, PRODUCT_PLACEMENT, UPSCALER];
