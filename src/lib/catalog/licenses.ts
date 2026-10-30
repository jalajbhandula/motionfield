import type { ComponentClass, LicenseClass, LicenseComponent, LicenseInfo, ModelDef, WorkflowDef } from "./types";
import { LICENSE_CLASS_ORDER } from "./types";
import { WORKFLOW_LICENSES, KNOWN_NODE_CLASSES, ENDPOINT_GRAPHS } from "./licenses.generated";

/** Hand-written license table for the weight/ sources in licenses.generated.ts.
 *  Every entry cites MODELS.md or the repo's own license page - anything that
 *  can't be confirmed goes in as class "restricted" (fail-safe).
 *
 *  NOTE: this module is pure data + pure functions (client-safe). The DB gate
 *  is ./license-gate.ts (server-only); the generated map is
 *  ./licenses.generated.ts (written by scripts/gen-licenses.ts).
 */

/** Version string recorded on license_optins rows - bump when the restricted
 *  set changes so existing opt-ins can be re-asked. */
export const LICENSE_VERSION = "of-licenses-v1";

type WeightEntry = Omit<LicenseComponent, "name">;

const w = (license: string, url: string, cls: ComponentClass = "open"): WeightEntry =>
  ({ license, url, class: cls });

/* Weight filename - exactly as it appears in the workflow JSON inputs. */
export const WEIGHT_LICENSES: Record<string, WeightEntry> = {
  // Z-Image-Turbo (MODELS.md: Apache-2.0)
  "z_image_turbo_int8_convrot.safetensors": w("Apache-2.0", "https://huggingface.co/Tongyi-MAI/Z-Image-Turbo"),
  "qwen_3_4b_fp8_mixed.safetensors": w("Apache-2.0", "https://huggingface.co/Qwen/Qwen3-4B"),
  "ae.safetensors": w("Apache-2.0", "https://huggingface.co/Comfy-Org/z_image_turbo"),
  // BiRefNet (MIT)
  "birefnet.safetensors": w("MIT", "https://huggingface.co/ZhengPeng7/BiRefNet"),
  // FLUX.1 [schnell] (Apache-2.0) + encoders - workflows removed in ws4-s7;
  // rows kept so historical manifests still attribute the files
  "flux1-schnell-fp8.safetensors": w("Apache-2.0", "https://huggingface.co/black-forest-labs/FLUX.1-schnell"),
  // FLUX.2 klein 4B distilled - Apache-2.0 (the BFL model card states
  // apache-2.0; the Comfy-Org/Flux-2-Klein-4B repack is tagged the same). The
  // shipped graphs pin the official distilled bf16 file; the 9B sibling stays
  // banned via RED_FLAG_WEIGHTS (/klein.?9b/i).
  // The local -bf16 file is an offline dequantization of the fp8 download (fp8
  // tensors expanded with their per-tensor scales): torch on MPS cannot
  // materialise float8_e4m3fn at all, so the fp8 checkpoint cannot run here.
  "flux-2-klein-4b.safetensors": w("Apache-2.0", "https://huggingface.co/Comfy-Org/Flux-2-Klein-4B"),
  "flux-2-klein-4b-bf16.safetensors": w("Apache-2.0", "https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8"),
  "flux-2-klein-4b-fp8.safetensors": w("Apache-2.0", "https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8"),
  // FLUX.2-family VAE - ships inside the Apache-2.0 klein repack
  // (Comfy-Org/Flux-2-Klein-4B → split_files/vae/flux2-vae.safetensors)
  "flux2-vae.safetensors": w("Apache-2.0", "https://huggingface.co/Comfy-Org/Flux-2-Klein-4B"),
  "clip_l.safetensors": w("MIT", "https://huggingface.co/Comfy-Org/flux1-schnell"),
  "t5xxl_fp8_e4m3fn_scaled.safetensors": w("Apache-2.0", "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged"),
  // Qwen Image Edit 2509 (Apache-2.0)
  "qwen_image_edit_2509_fp8_e4m3fn.safetensors": w("Apache-2.0", "https://huggingface.co/Qwen/Qwen-Image-Edit-2509"),
  "qwen_2.5_vl_7b_fp8_scaled.safetensors": w("Apache-2.0", "https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct"),
  "qwen_image_vae.safetensors": w("Apache-2.0", "https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI"),
  // LTX-Video 0.9.5 - Lightricks Open RAIL-M (use restrictions → opt-in gate)
  "ltx-video-2b-v0.9.5.safetensors": w("Open RAIL-M", "https://huggingface.co/Lightricks/LTX-Video/blob/main/ltx-video-2b-v0.9.5.license.txt", "restricted"),
  // LTX-2.5 22B distilled - LTX-2.x community license, gated download → opt-in gate
  "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors": w("LTX-2.x Community", "https://huggingface.co/Lightricks/LTX-Video", "restricted"),
  "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors": w("LTX-2.x Community", "https://huggingface.co/Lightricks/LTX-Video", "restricted"),
  "ltx-2.5-audio-vae-bf16.safetensors": w("LTX-2.x Community", "https://huggingface.co/Lightricks/LTX-Video", "restricted"),
  "ltx-2.5-video-vae-bf16.safetensors": w("LTX-2.x Community", "https://huggingface.co/Lightricks/LTX-Video", "restricted"),
  "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors": w("LTX-2.x Community", "https://huggingface.co/Lightricks/LTX-Video", "restricted"),
  "ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors": w("LTX-2.x Community", "https://huggingface.co/Lightricks/LTX-Video", "restricted"),
  // SAM 3.1 multiplex (Meta SAM License - gated HF download; allows this
  // segmentation/tracking use, attribution kept; opt-in/restricted class)
  "sam3.1_multiplex_fp16.safetensors": w("Meta SAM License", "https://huggingface.co/facebook/sam3.1/blob/main/LICENSE", "restricted"),
  // Wan 2.1 / 2.2 family (Apache-2.0)
  "wan2.1_t2v_1.3B_fp16.safetensors": w("Apache-2.0", "https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B"),
  "wan2.1_i2v_480p_14B_fp16.safetensors": w("Apache-2.0", "https://huggingface.co/Wan-AI/Wan2.1-I2V-14B-480P"),
  "wan2.1_vace_1.3B_fp16.safetensors": w("Apache-2.0", "https://huggingface.co/Wan-AI/Wan2.1-VACE-1.3B"),
  "wan2.2_ti2v_5B_fp16.safetensors": w("Apache-2.0", "https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B"),
  "wan2.2_vae.safetensors": w("Apache-2.0", "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged"),
  "wan2.2_animate_14B_bf16.safetensors": w("Apache-2.0", "https://huggingface.co/Wan-AI/Wan2.2-Animate-14B"),
  // Wan Animate relight LoRA - Comfy-Org repack, upstream license Apache-2.0
  "wan2.2_animate_14B_relight_lora_bf16.safetensors": w("Apache-2.0", "https://huggingface.co/Comfy-Org/Wan-2.2"),
  // LightX2V 4-step cfg distill LoRA - official card is Apache-2.0
  // (lightx2v/Wan2.1-I2V-14B-480P-StepDistill-CfgDistill-Lightx2v). The graph
  // pins Kijai's bf16 file of that rank-64 LoRA.
  "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors": w("Apache-2.0", "https://huggingface.co/lightx2v/Wan2.1-I2V-14B-480P-StepDistill-CfgDistill-Lightx2v"),
  // Wan2.2 A14B MoE i2v + t2v pairs - cloud-quality tier (Comfy-Org repackaged)
  "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors": w("Apache-2.0", "https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B"),
  "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors": w("Apache-2.0", "https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B"),
  "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors": w("Apache-2.0", "https://huggingface.co/Wan-AI/Wan2.2-T2V-A14B"),
  "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors": w("Apache-2.0", "https://huggingface.co/Wan-AI/Wan2.2-T2V-A14B"),
  // cloud-tier Wan 2.1 variants (Comfy-Org repackaged, fp8) + Uni3C camera
  // controlnet (ewrfcas/Uni3C, Apache-2.0 - model_patches via ModelPatchLoader)
  "wan2.1_i2v_480p_14B_fp8_scaled.safetensors": w("Apache-2.0", "https://huggingface.co/Wan-AI/Wan2.1-I2V-14B-480P"),
  "wan2.1_flf2v_720p_14B_fp8_e4m3fn.safetensors": w("Apache-2.0", "https://huggingface.co/Wan-AI/Wan2.1-FLF2V-14B-720P"),
  "wan2.1_uni3c_controlnet.pth": w("Apache-2.0", "https://huggingface.co/ewrfcas/Uni3C"),
  // Qwen-Image 2512 (t2i) + Qwen-Image-Edit-2511 (+ dx8152 angles LoRA) - Apache-2.0
  "qwen_image_2512_fp8_e4m3fn.safetensors": w("Apache-2.0", "https://huggingface.co/Qwen/Qwen-Image-2512"),
  "qwen_image_edit_2511_fp8mixed.safetensors": w("Apache-2.0", "https://huggingface.co/Qwen/Qwen-Image-Edit-2511"),
  "Qwen-Edit-2509-Multiple-angles.safetensors": w("Apache-2.0", "https://huggingface.co/dx8152/Qwen-Edit-2509-Multiple-angles"),
  // Bernini-R (ByteDance - Wan2.2 MoE reference-guided video editing) - Apache-2.0
  "wan2.2_bernini_r_high_noise_fp8_scaled.safetensors": w("Apache-2.0", "https://huggingface.co/ByteDance/Bernini-R"),
  "wan2.2_bernini_r_low_noise_fp8_scaled.safetensors": w("Apache-2.0", "https://huggingface.co/ByteDance/Bernini-R"),
  // HiDream-O1-Image full checkpoint - MIT
  "hidream_o1_image_fp8_scaled.safetensors": w("MIT", "https://huggingface.co/HiDream-ai/HiDream-O1-Image"),
  "wan2.2_animate_14B_int8_convrot.safetensors": w("Apache-2.0", "https://huggingface.co/Wan-AI/Wan2.2-Animate-14B"),
  "wan2.2_s2v_14B_fp8_scaled.safetensors": w("Apache-2.0", "https://huggingface.co/Wan-AI/Wan2.2-S2V-14B"),
  "umt5_xxl_fp8_e4m3fn_scaled.safetensors": w("Apache-2.0", "https://huggingface.co/google/umt5-xxl"),
  "wan_2.1_vae.safetensors": w("Apache-2.0", "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged"),
  "clip_vision_h.safetensors": w("MIT", "https://github.com/openai/CLIP"),
  "wav2vec2_large_english_fp16.safetensors": w("Apache-2.0", "https://huggingface.co/facebook/wav2vec2-large-960h-lv60"),
  // ACE-Step 1.5 - Comfy-Org repackage Apache-2.0 (upstream Ace-Step1.5 MIT)
  "acestep_v1.5_turbo.safetensors": w("Apache-2.0", "https://huggingface.co/ACE-Step/Ace-Step1.5"),
  "qwen_0.6b_ace15.safetensors": w("Apache-2.0", "https://huggingface.co/ACE-Step/Ace-Step1.5"),
  "qwen_1.7b_ace15.safetensors": w("Apache-2.0", "https://huggingface.co/ACE-Step/Ace-Step1.5"),
  "ace_1.5_vae.safetensors": w("Apache-2.0", "https://huggingface.co/ACE-Step/Ace-Step1.5"),
  // Wan2.1-Fun camera-control DiT (Apache-2.0 - Comfy-Org repackage is
  // byte-identical to the alibaba-pai original, same sha256)
  "wan2.1_fun_camera_v1.1_1.3B_bf16.safetensors": w("Apache-2.0", "https://huggingface.co/alibaba-pai/Wan2.1-Fun-V1.1-1.3B-Control-Camera"),
  // Depth-Anything V2 Small (Apache-2.0)
  "depth_anything_v2_vits.pth": w("Apache-2.0", "https://huggingface.co/depth-anything/Depth-Anything-V2-Small"),
  // Depth-Anything-3 Mono Large (Apache-2.0 - verified on the model card)
  "depth_anything_3_mono_large.safetensors": w("Apache-2.0", "https://huggingface.co/depth-anything/DA3MONO-LARGE"),
  // Depth-Anything-3 Base (Apache-2.0 - HF API card data, multiview poses)
  "depth_anything_3_base.safetensors": w("Apache-2.0", "https://huggingface.co/depth-anything/DA3-BASE"),
  // DWPose ONNX detectors auto-fetched by controlnet_aux DWPreprocessor (Apache-2.0)
  "dw-ll_ucoco_384.onnx": w("Apache-2.0", "https://huggingface.co/yzd-v/DWPose"),
  "yolox_l.onnx": w("Apache-2.0", "https://huggingface.co/yzd-v/DWPose"),
  // Real-ESRGAN x4plus (BSD-3) - reached via the {{MODEL}} placeholder in upscale-4x
  "RealESRGAN_x4plus.pth": w("BSD-3-Clause", "https://github.com/xinntao/Real-ESRGAN"),
  // RIFE 4.26 frame interpolation (MIT - Comfy-Org repack "mit-and-apache-2.0",
  // upstream hzwer/Practical-RIFE MIT) - the finish pass's smoother
  "rife_v4.26.safetensors": w("MIT", "https://huggingface.co/Comfy-Org/frame_interpolation"),
  // DINOv3 clip bundled with the TRELLIS.2 pack - DINOv3 licence, opt-in
  // class; surfaces the "Built with DINOv3" notice. (s2b #64)
  "dino_v3_vit_l.safetensors": w("DINOv3", "https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md", "restricted"),
  // DINOv3-NAF clip the TRELLIS.2 conditioning path actually loads (Comfy-Org
  // Pixal3D repack) - same DINOv3 licence, same notice
  "dino_v3_L_naf_fp32.safetensors": w("DINOv3", "https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md", "restricted"),
  // TRELLIS.2 native weights (MIT - microsoft/TRELLIS.2-4B, Comfy-Org repack)
  "trellis_2_int8_convrot.safetensors": w("MIT", "https://huggingface.co/microsoft/TRELLIS.2-4B"),
  "trellis_2_shape_vae_bf16.safetensors": w("MIT", "https://huggingface.co/microsoft/TRELLIS.2-4B"),
  "trellis_2_texture_vae_bf16.safetensors": w("MIT", "https://huggingface.co/microsoft/TRELLIS.2-4B"),
  // MoGe-2 ViT-L normal/pointmap estimator (MIT - Ruicheng/moge-2-vitl,
  // Comfy-Org repack) - geometry-scan 3D path
  "moge_2_vitl_normal_fp16.safetensors": w("MIT", "https://huggingface.co/Ruicheng/moge-2-vitl"),
};

const c = (name: string, license: string, url: string, cls: ComponentClass = "open", notice?: string): LicenseComponent =>
  ({ name, license, url, class: cls, ...(notice ? { notice } : {}) });

const RANK: Record<LicenseClass, number> = LICENSE_CLASS_ORDER;

/** TRELLIS.2's DiT/VAEs are MIT, but the native pipeline can't run without
 *  its bundled DINOv3 clip - so the pack resolves restricted. DINOv3 ships
 *  with a "Built with DINOv3" attribution requirement. */
const TRELLIS2_COMPONENTS: LicenseComponent[] = [
  c("TRELLIS.2 weights (trellis_2_*)", "MIT", "https://huggingface.co/microsoft/TRELLIS.2-4B"),
  c("dino_v3_L_naf_fp32.safetensors", "DINOv3", "https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md", "restricted",
    'TRELLIS.2 conditioning clip - DINOv3 licence carries the "Built with DINOv3" notice'),
];
/* TripoSplat weights are MIT (verified on VAST-AI/TripoSplat), but the native
 * pipeline can't run without its bundled DINOv3 clip - so the pack resolves
 * restricted like TRELLIS.2. */
const TRIPOSPLAT_COMPONENTS: LicenseComponent[] = [
  c("TripoSplat weights (triposplat_*)", "MIT", "https://huggingface.co/VAST-AI/TripoSplat"),
  c("dino_v3_vit_h.safetensors", "DINOv3", "https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md", "restricted",
    'bundled TripoSplat clip - DINOv3 licence carries the "Built with DINOv3" notice'),
];

/** Node classes that fetch/load weights inside Python - no filename appears in
 *  graph inputs, so the generator credits them from this table. */
export const CLASS_COMPONENTS: Record<string, LicenseComponent[]> = {
  // the patched pack blends through OF_MouthMask (DWPose landmarks) - the
  // upstream face segmenter and its 79999_iter.pth weights are gone
  MuseTalkRun: [
    c("MuseTalk UNet (musetalk/pytorch_model.bin)", "MIT", "https://huggingface.co/TMElyralab/MuseTalk"),
    c("sd-vae-ft-mse", "MIT", "https://huggingface.co/stabilityai/sd-vae-ft-mse"),
    c("whisper tiny.pt", "MIT", "https://github.com/openai/whisper"),
    c("DWPose ONNX (yolox_l.onnx + dw-ll_ucoco_384.onnx)", "Apache-2.0", "https://huggingface.co/yzd-v/DWPose"),
  ],
  KokoroGenerator: [c("Kokoro-82M (kokoro_v1.onnx)", "Apache-2.0", "https://huggingface.co/hexgrad/Kokoro-82M")],
  KokoroSpeaker: [c("Kokoro-82M voices (voices_v1.bin)", "Apache-2.0", "https://huggingface.co/hexgrad/Kokoro-82M")],
  ChatterboxTTS: [c("Chatterbox pack (ve/t3_cfg/s3gen + conds.pt)", "MIT", "https://huggingface.co/ResembleAI/chatterbox")],
  // voice conversion - the same pack's s3gen + ve, no text model involved
  ChatterboxVC: [c("Chatterbox pack (s3gen + ve)", "MIT", "https://huggingface.co/ResembleAI/chatterbox")],
  // controlnet_aux node classes - the pack's dwpose preprocessor module ships
  // CMU-licensed OpenPose-derived code (non-commercial): known violation, WS4
  // is replacing it (MODELS.md "License notes"). Allowed to run meanwhile.
  DWPreprocessor: [
    c("DWPose ONNX weights (yolox_l.onnx + dw-ll_ucoco_384.onnx)", "Apache-2.0", "https://huggingface.co/yzd-v/DWPose"),
    c("comfyui_controlnet_aux dwpose preprocessor module", "non-commercial (OpenPose/CMU-derived code)", "https://github.com/Fannovel16/comfyui_controlnet_aux", "banned-known"),
  ],
  DepthAnythingV2Preprocessor: [
    c("comfyui_controlnet_aux pack (dwpose module ships OpenPose-derived code)", "non-commercial module in pack (see MODELS.md)", "https://github.com/Fannovel16/comfyui_controlnet_aux", "banned-known"),
  ],
  // standalone DWPose estimator node - loads the same Apache-2.0 ONNX weights
  OF_DWPose: [
    c("DWPose ONNX (yolox_l.onnx + dw-ll_ucoco_384.onnx)", "Apache-2.0", "https://huggingface.co/yzd-v/DWPose"),
  ],
  // mouth/lower-jaw blend masks - runs the same DWPose ONNX pair per frame
  OF_MouthMask: [
    c("MotionField node pack (comfy-nodes/motionfield_nodes)", "MIT", "LICENSE"),
    c("DWPose ONNX (yolox_l.onnx + dw-ll_ucoco_384.onnx)", "Apache-2.0", "https://huggingface.co/yzd-v/DWPose"),
  ],
  // trajectory node - pure math in the in-repo MIT pack, loads nothing
  OF_Trajectory: [
    c("MotionField node pack (comfy-nodes/motionfield_nodes)", "MIT", "LICENSE"),
  ],
  // camera rig + depth blur - numpy re-render/blur in the same MIT pack
  OF_CameraRig: [
    c("MotionField node pack (comfy-nodes/motionfield_nodes)", "MIT", "LICENSE"),
  ],
  OF_DepthBlur: [
    c("MotionField node pack (comfy-nodes/motionfield_nodes)", "MIT", "LICENSE"),
  ],
  // camera embed - Plücker ray maps from the pose stream, same MIT pack
  OF_CameraEmbed: [
    c("MotionField node pack (comfy-nodes/motionfield_nodes)", "MIT", "LICENSE"),
  ],
  // matte coverage strip - per-frame coverage readback in the same MIT pack
  OF_MatteCoverage: [
    c("MotionField node pack (comfy-nodes/motionfield_nodes)", "MIT", "LICENSE"),
  ],
  // object pick → tracked mask - same MIT pack (BiRefNet matte comes in
  // through the workflow's RemoveBackground class, not this node)
  OF_MaskTrack: [
    c("MotionField node pack (comfy-nodes/motionfield_nodes)", "MIT", "LICENSE"),
  ],
  // stroke mask for draw-to-video - pure tensor diff in the same MIT pack
  OF_DrawMask: [
    c("MotionField node pack (comfy-nodes/motionfield_nodes)", "MIT", "LICENSE"),
  ],
  // mask bbox crop + rect emit - pure tensor slicing in the same MIT pack
  OF_CropToMask: [
    c("MotionField node pack (comfy-nodes/motionfield_nodes)", "MIT", "LICENSE"),
  ],
  // whole-face region mask - runs the DWPose ONNX pair like OF_MouthMask
  OF_FaceMask: [
    c("MotionField node pack (comfy-nodes/motionfield_nodes)", "MIT", "LICENSE"),
    c("DWPose ONNX (yolox_l.onnx + dw-ll_ucoco_384.onnx)", "Apache-2.0", "https://huggingface.co/yzd-v/DWPose"),
  ],
  // provenance-tagged save - Pillow iTXt/XMP write in the same MIT pack
  OF_ProvTag: [
    c("MotionField node pack (comfy-nodes/motionfield_nodes)", "MIT", "LICENSE"),
  ],
  // normalised-box overlay paste - pure tensor math in the same MIT pack,
  // loads nothing (product-placement composite + harmonise mask)
  OF_BoxPlace: [
    c("MotionField node pack (comfy-nodes/motionfield_nodes)", "MIT", "LICENSE"),
  ],
  // relight - depth → normals and the shaded light guide, numpy in the same
  // MIT pack, loads nothing (DA3 depth arrives through its own classes)
  OF_RelightNormals: [
    c("MotionField node pack (comfy-nodes/motionfield_nodes)", "MIT", "LICENSE"),
  ],
  OF_Relight: [
    c("MotionField node pack (comfy-nodes/motionfield_nodes)", "MIT", "LICENSE"),
  ],
  // TRELLIS.2 native path - the pipeline can't run without its bundled
  // DINOv3 clip, so every stage class carries the restricted component
  // (source audit: `license-audit.ts --source-check` - no nvdiffrast).
  Trellis2Conditioning: TRELLIS2_COMPONENTS,
  Trellis2ShapeStage: TRELLIS2_COMPONENTS,
  Trellis2TextureStage: TRELLIS2_COMPONENTS,
  Trellis2UpsampleStage: TRELLIS2_COMPONENTS,
  EmptyTrellis2LatentStructure: TRELLIS2_COMPONENTS,
  VaeDecodeStructureTrellis2: TRELLIS2_COMPONENTS,
  VaeDecodeTextureTrellis: TRELLIS2_COMPONENTS,
  VaeDecodeShapeTrellis: TRELLIS2_COMPONENTS,
  // Pixal3D - the TRELLIS.2 multi-view conditioning entry points
  Pixal3DConditioning: TRELLIS2_COMPONENTS,
  Pixal3DMultiViewConditioning: TRELLIS2_COMPONENTS,
  // TripoSplat - MIT weights but the bundled DINOv3 clip keeps it restricted
  TripoSplatConditioning: TRIPOSPLAT_COMPONENTS,
  TripoSplatPreprocessImage: TRIPOSPLAT_COMPONENTS,
  TripoSplatSamplingPreview: TRIPOSPLAT_COMPONENTS,
  VAEDecodeTripoSplat: TRIPOSPLAT_COMPONENTS,
};

/** Server-side recipe pipelines (providers.recipe) carry no bundled graph, so
 *  their components are declared here. "explainer" is params-resolved instead
 *  (its motion stage picks a comfy endpoint at submit time). A recipe with no
 *  entry resolves restricted - the audit fails on it.
 *
 *  ReCut assemble runs its shots through the three VACE flow graphs - its
 *  license is the merge of their generated entries, plus the host ffmpeg. */
/** ffmpeg runs from the host's own install - MotionField never bundles it. */
const FFMPEG = c("ffmpeg", "user's system binary - not shipped", "https://ffmpeg.org/legal.html", "open",
  "ffmpeg is invoked from the host's own install; MotionField does not bundle it");

const RE_EDIT_ASSEMBLE_COMPONENTS = mergeComponents([
  // the character-swap flow's per-window work rides the person-swap person
  // pipeline (masked person pass + ref cut-out) - motion-transfer and
  // restyle stay on their own full-frame vace graphs
  WORKFLOW_LICENSES["person-swap-person.json"]?.components,
  WORKFLOW_LICENSES["person-swap-refcut.json"]?.components,
  WORKFLOW_LICENSES["vace-motion-transfer.json"]?.components,
  WORKFLOW_LICENSES["vace-restyle.json"]?.components,
  [FFMPEG],
]);

/** Optional weight packs (3D etc.) that no shipped workflow references yet -
 *  listed in Settings → Licenses so the restricted ones surface before opt-in.
 *  Pack class = worstClass(components). Kept in step with tier "3d" of
 *  scripts/runpod/models.cloud.json. */
export const PACK_LICENSES: { id: string; label: string; components: LicenseComponent[] }[] = [
  {
    id: "triposg", label: "TripoSG 1.5B (image → 3D mesh)",
    components: [
      c("TripoSG transformer + VAE", "MIT", "https://huggingface.co/VAST-AI/TripoSG"),
      c("bundled DINOv2 image encoder", "Apache-2.0", "https://github.com/facebookresearch/dinov2/blob/main/LICENSE"),
    ],
  },
  {
    id: "trellis1-image", label: "TRELLIS image-large (v1)",
    components: [c("TRELLIS-image-large checkpoints", "MIT", "https://huggingface.co/microsoft/TRELLIS-image-large")],
  },
  {
    id: "unirig", label: "UniRig (skeleton + skin)",
    components: [c("UniRig rignet + articulation-xl", "MIT", "https://huggingface.co/VAST-AI/UniRig")],
  },
  {
    id: "marigold-v2", label: "Marigold V2 (depth / normals / albedo)",
    components: [
      c("marigold_v2_* LoRAs + VAEs", "Apache-2.0", "https://huggingface.co/huawei-bayerlab/marigold-v2-0"),
      c("qwen_image_edit_2509 base (int8)", "Apache-2.0", "https://huggingface.co/Qwen/Qwen-Image-Edit-2509"),
    ],
  },
  {
    id: "trellis2", label: "TRELLIS.2 native",
    components: TRELLIS2_COMPONENTS,
  },
  {
    id: "triposplat", label: "TripoSplat (feed-forward gaussian splats)",
    components: TRIPOSPLAT_COMPONENTS,
  },
  {
    id: "cmu-mocap", label: "CMU mocap (motion-capture clips)",
    components: [
      c("CMU Graphics Lab mocap clips", "free to use, including inside sold products; the data itself may not be resold, even converted", "https://mocap.cs.cmu.edu/", "permissive-terms",
        'credit Carnegie Mellon University: "The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217." The data may ship inside sold products but may not be resold directly, even in converted form'),
    ],
  },
];

const DUB_HOST_COMPONENTS = [
  c("whisper.cpp (whisper-cli)", "MIT", "https://github.com/ggml-org/whisper.cpp"),
  c("whisper ggml-base.en", "MIT", "https://huggingface.co/ggerganov/whisper.cpp"),
  c("Translation - your own local LLM (default Qwen3.5 via Ollama)", "Apache-2.0", "https://huggingface.co/Qwen"),
  FFMPEG,
];

export const RECIPE_LICENSES: Record<string, LicenseInfo> = {
  "motion-render": {
    class: "open",
    components: [
      c("In-repo SceneSpec renderer (src/lib/render)", "MIT", "LICENSE"),
      c("three.js", "MIT", "https://github.com/mrdoob/three.js"),
      c("opentype.js", "MIT", "https://github.com/opentypejs/opentype.js"),
      c("Space Grotesk font", "OFL-1.1", "https://github.com/floriankarsten/space-grotesk"),
      c("Playwright Chromium (headless capture)", "Apache-2.0", "https://github.com/microsoft/playwright"),
      FFMPEG,
    ],
  },
  /** person-swap - masked VACE swap windows (person-swap-person.json), invert-matte
   *  environment windows (person-swap-environment.json), the BiRefNet coverage
   *  preflight (person-swap-matte.json), the optional MuseTalk lip restore
   *  (lipsync-video.json) and host-side ffmpeg assembly. */
  "person-swap": {
    class: worstClass(mergeComponents([
      WORKFLOW_LICENSES["person-swap-person.json"]?.components,
      WORKFLOW_LICENSES["person-swap-environment.json"]?.components,
      WORKFLOW_LICENSES["person-swap-matte.json"]?.components,
      WORKFLOW_LICENSES["person-swap-refcut.json"]?.components,
      WORKFLOW_LICENSES["lipsync-video.json"]?.components,
      [FFMPEG],
    ])),
    components: mergeComponents([
      WORKFLOW_LICENSES["person-swap-person.json"]?.components,
      WORKFLOW_LICENSES["person-swap-environment.json"]?.components,
      WORKFLOW_LICENSES["person-swap-matte.json"]?.components,
      WORKFLOW_LICENSES["person-swap-refcut.json"]?.components,
      WORKFLOW_LICENSES["lipsync-video.json"]?.components,
      [FFMPEG],
    ]),
  },
  /** dub - whisper.cpp ASR on the host, translation by the user's own local
   *  LLM, Kokoro + Chatterbox VC per line (dub-voice.json), MuseTalk lip-sync
   *  (lipsync-video.json) and host-side ffmpeg timing/mux. */
  "dub": {
    class: worstClass(mergeComponents([
      WORKFLOW_LICENSES["dub-voice.json"]?.components,
      WORKFLOW_LICENSES["lipsync-video.json"]?.components,
      DUB_HOST_COMPONENTS,
    ])),
    components: mergeComponents([
      WORKFLOW_LICENSES["dub-voice.json"]?.components,
      WORKFLOW_LICENSES["lipsync-video.json"]?.components,
      DUB_HOST_COMPONENTS,
    ]),
  },
  "re-edit-assemble": { class: worstClass(RE_EDIT_ASSEMBLE_COMPONENTS), components: RE_EDIT_ASSEMBLE_COMPONENTS },
  /** stage-render - Wan VACE windows (stage-render.json) driven by the
   *  headless three.js scene passes (depth/pose/previz), joined host-side
   *  with ffmpeg. */
  "stage-render": {
    class: worstClass(mergeComponents([
      WORKFLOW_LICENSES["stage-render.json"]?.components,
      [
        c("In-repo Stage scene renderer (src/lib/stage)", "MIT", "LICENSE"),
        c("three.js", "MIT", "https://github.com/mrdoob/three.js"),
        c("Playwright Chromium (headless capture)", "Apache-2.0", "https://github.com/microsoft/playwright"),
        FFMPEG,
      ],
    ])),
    components: mergeComponents([
      WORKFLOW_LICENSES["stage-render.json"]?.components,
      [
        c("In-repo Stage scene renderer (src/lib/stage)", "MIT", "LICENSE"),
        c("three.js", "MIT", "https://github.com/mrdoob/three.js"),
        c("Playwright Chromium (headless capture)", "Apache-2.0", "https://github.com/microsoft/playwright"),
        FFMPEG,
      ],
    ]),
  },
  // registered recipe stub (not implemented - no catalog endpoint reaches it);
  // declared so the audit can track it, and it stays restricted
  "game-build": { class: "restricted", components: [c("game-build recipe - not implemented", "unlisted", "", "restricted")] },
  /** audio-mix - post-mix is host ffmpeg only; video→sfx adds the MOSS SFX
   *  graph per planned cue (the cue planner is the user's own local LLM). */
  "audio-mix": {
    class: worstClass(mergeComponents([WORKFLOW_LICENSES["sfx-moss.json"]?.components, [FFMPEG]])),
    components: mergeComponents([WORKFLOW_LICENSES["sfx-moss.json"]?.components, [FFMPEG]]),
  },
  /** Palette grade - our LUT math (src/lib/grade) applied by the host ffmpeg; no weights. */
  "video-post": {
    class: "open",
    components: [c("In-repo colour grade (src/lib/grade)", "MIT", "LICENSE"), FFMPEG],
  },
  /** Cut to music - our beat tracker + edit planner (src/lib/beatcut.ts), joined by the host ffmpeg; no weights. */
  "beat-cut": {
    class: "open",
    components: [c("In-repo beat tracker and edit planner (src/lib/beatcut.ts)", "MIT", "LICENSE"), FFMPEG],
  },
};

/** Workflows whose weights sit behind a {{PLACEHOLDER}} instead of a literal
 *  filename - extra WEIGHT_LICENSES keys credited to that workflow file. */
export const WORKFLOW_EXTRA_WEIGHTS: Record<string, string[]> = {
  "upscale-4x.json": ["RealESRGAN_x4plus.pth"],
};

/** Endpoint class = worst of {open,restricted,banned}. "banned-known"
 *  components stay listed but never promote the endpoint (they run with a
 *  warning until their replacement lands). */
export function worstClass(components: readonly LicenseComponent[]): LicenseClass {
  let worst: LicenseClass = "open";
  for (const cp of components) {
    const cls = cp.class === "banned-known" ? "open" : cp.class;
    if (RANK[cls] > RANK[worst]) worst = cls;
  }
  return worst;
}

export function licenseForWeight(filename: string): LicenseComponent | null {
  if (!Object.hasOwn(WEIGHT_LICENSES, filename)) return null;
  const e = WEIGHT_LICENSES[filename];
  return e ? { name: filename, ...e } : null;
}

/** Map an SPDX-ish licence id (the `license` field in
 *  scripts/runpod/models.cloud.json) to its licence class. Fails closed:
 *  anything unrecognised - or non-commercial - is "refused" and may never
 *  reach the pod manifest. MIT/Apache-2.0/BSD/ISC/OFL/CC0 → open;
 *  use-policy licences (Open RAIL, Llama, Gemma, DINOv3, community licences
 *  such as LTX-2's) → restricted; CC-BY-style permissive-with-terms →
 *  permissive-terms; Hunyuan/Tencent licences (non-commercial) and
 *  NC/unknown/other/gated/empty → refused. setup.sh mirrors this allowlist
 *  in its manifest gate - keep the two in step. */
export function licenseClassForSpdx(id: string): { class: LicenseClass | "refused"; reason: string } {
  const s = id.trim().toLowerCase();
  // the nc rule is anchored ((^|[^a-z])nc([^a-z]|$)) - it still fails closed
  // on cc-by-nc-* and on underscore/dotted markers (cc-by-4.0_nc,
  // cc_by_nc-4.0), but a licence id that merely contains "nc" isn't refused
  if (s === "" || /(^|[^a-z])nc([^a-z]|$)|noncommercial|non-commercial|^other$|^unknown$|^unlisted$|^gated$/.test(s))
    return { class: "refused", reason: "non-commercial or unverifiable licence id" };
  if (/^(mit|apache-2\.0|bsd-2-clause|bsd-3-clause|bsd|isc|ofl-1\.1|cc0|cc0-1\.0|unlicense|zlib|mpl-2\.0)$/.test(s))
    return { class: "open", reason: "permissive licence" };
  // before the community rule - "tencent-hunyuan-community" is still banned
  if (/hunyuan|tencent/.test(s))
    return { class: "refused", reason: "Hunyuan/Tencent licences are non-commercial - banned" };
  if (/community/.test(s) || /^open-?rail/.test(s) || /^llama/.test(s) || /^gemma/.test(s) || /^dinov3/.test(s) || /^ltx/.test(s) || /^sam-license$/.test(s))
    return { class: "restricted", reason: "use-policy / community licence - opt-in required" };
  if (/^cc-by(-sa)?-\d/.test(s) || /permissive-terms/.test(s))
    return { class: "permissive-terms", reason: "permissive licence with attribution terms" };
  return { class: "refused", reason: "unrecognised licence id" };
}

/** Does an endpoint of this class need the restricted opt-in before it runs?
 *  Only "restricted" - open and permissive-terms run without opt-in (their
 *  notices surface in Settings → Licenses instead); banned never runs. */
export function needsOptIn(cls: LicenseClass): boolean {
  return cls === "restricted";
}

export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

const WEIGHT_EXT = /\.(safetensors|sft|pth|pt2|pkl|onnx|bin|ckpt|gguf|pt)$/i;

/* Weight-name patterns that must never run - non-commercial or otherwise
 *  barred weights. A matching value in any weight-looking input (extension
 *  match or a `*_name` key) adds a banned component even when the class is
 *  a core ComfyUI one. */
export const RED_FLAG_WEIGHTS: RegExp[] = [
  /\bda3\b[^/]*\b(large|giant|nested)\b/i, // DA3 metric-depth large/giant/nested (non-commercial; the mono-large variant is fine)
  /79999_iter/i,                          // face-parse BiSeNet - non-commercial
  /RMBG|briaai/i,                         // BRIA background-removal - non-commercial
  /inswapper|ins0wapper|insightface|inwapper/i,
  /codeformer/i,
  /nvdiffrast/i,
  /causvid/i,
  /gimm(?:[-_]|vfi|vfr|\b)/i,             // GIMM / GIMM-VFI frame interpolation (gimmvfi_*, GIMM_R_*) - non-commercial
  /kandinsky/i,                           // Kandinsky - non-commercial weights
  /body_pose_model|hand_pose_model/i,     // OpenPose-carryover pose weights - non-commercial
  /matanyone/i,
  /vibevoice/i,
  /hunyuan/i,
  /klein.?9b/i,
  /u2net/i,                             // rembg's default matting model + u2net variants - non-commercial
  /skin.?tokens/i,                      // SkinTokens - non-commercial
  /make.?it.?animatable/i,              // Make-It-Animatable - non-commercial
  /mixamo/i,                            // Mixamo assets - redistribution barred
];

/* Weight-name patterns that resolve RESTRICTED (opt-in, not banned) - the
 *  s2b 3D classifications. These are deliberately unanchored so separator
 *  variants (dino_v3, trellis_2, pixal-3d, TripoSplat) can't slip past. A
 *  WEIGHT_LICENSES table entry still wins over a pattern hit. */
export const RESTRICTED_WEIGHT_PATTERNS: RegExp[] = [
  /dino_?v3/i,                            // DINOv3 clip - "Built with DINOv3" notice required
  /trellis.?2/i,                          // TRELLIS.2 native weights (pack pulls the DINOv3 clip)
  /pixal.?3d/i,                           // Pixal3D - TRELLIS.2 conditioning path
  /triposplat|tripo.?splat/i,             // TripoSplat - licence unverified upstream
];

/* class_type patterns that must never run. Some are core ComfyUI classes -
 *  being in the node table can't make them runnable, so they are also left
 *  out of the generated KNOWN_NODE_CLASSES (gen-licenses) and flagged banned
 *  on sight here (controlnet_aux classes are additionally caught via the
 *  object_info python_module provenance in the audit). */
export const RED_FLAG_CLASSES: RegExp[] = [
  // SAM3* classes are allowed - SAM 3.1 ships under the Meta SAM License
  // (gated weights resolve restricted, opt-in) for mask/track upgrades.
  /^Trellis(?!2)/i, /^Kandinsky/i, /^CodeFormer/i,
  /^MatAnyone/i, /^VibeVoice/i, /^Hunyuan/i, /^CausVid/i, /^GIMM/i,
  // Tencent Hunyuan3D pack (Tencent Hunyuan Non-Commercial License) - the
  // classes are the NC model's entry points; banned outright, not gated.
  /Hunyuan3D/i, /^VAEDecodeHunyuan3D$/i, /^Tencent(3D|ImageToModel|ModelTo3DUV|SmartTopology|TextToModel)/i,
  // SkinTokens / Make-It-Animatable / Mixamo node classes - non-commercial
  /SkinTokens|MakeItAnimatable|Mixamo/i,
];

/** Node classes allowed in a graph: classes in shipped workflows ∪
 *  CLASS_COMPONENTS keys ∪ ComfyUI core classes (generated into
 *  licenses.generated.ts as KNOWN_NODE_CLASSES). Any other class_type in a
 *  caller-supplied graph is an "unlisted node" - banned, so the job is refused
 *  before it can reach ComfyUI. */
export const KNOWN_NODES: ReadonlySet<string> = new Set(KNOWN_NODE_CLASSES);

/** Resolve a Comfy graph's license from its node classes (CLASS_COMPONENTS)
 *  plus every weight-looking input value. A weight with no WEIGHT_LICENSES
 *  entry fails closed - a restricted "unlisted" component - unless the
 *  caller's onUnknownWeight throws (gen-licenses does: shipping graphs
 *  require verified entries) or substitutes its own component.
 *  Nodes whose class_type is outside KNOWN_NODES or matches RED_FLAG_CLASSES
 * - or that are malformed (no class_type / non-object inputs) - become
 *  banned components, so a doctored graph_json is refused outright. A
 *  weight-looking input value matching RED_FLAG_WEIGHTS is banned too, even
 *  on a known class. */
export function graphLicense(
  graph: ComfyGraph,
  onUnknownWeight?: (filename: string, nodeId: string, classType: string) => LicenseComponent | void,
  knownNodes: ReadonlySet<string> = KNOWN_NODES,
): LicenseInfo {
  const components = new Map<string, LicenseComponent>();
  const add = (cp: LicenseComponent) => { if (!components.has(cp.name)) components.set(cp.name, cp); };
  for (const [id, node] of Object.entries(graph)) {
    if (id === "_meta") continue;
    if (!node || typeof node !== "object" || typeof node.class_type !== "string" || !node.inputs || typeof node.inputs !== "object" || Array.isArray(node.inputs)) {
      add({ name: `malformed node ${id}`, license: "unlisted", url: "", class: "banned" });
      continue;
    }
    if (RED_FLAG_CLASSES.some((re) => re.test(node.class_type)))
      add({ name: `red-flag node ${node.class_type}`, license: "unlisted", url: "", class: "banned" });
    if (!knownNodes.has(node.class_type))
      add({ name: `unlisted node ${node.class_type}`, license: "unlisted", url: "", class: "banned" });
    if (Object.hasOwn(CLASS_COMPONENTS, node.class_type))
      for (const cp of CLASS_COMPONENTS[node.class_type] ?? []) add(cp);
    for (const [k, v] of Object.entries(node.inputs)) {
      if (typeof v !== "string") continue;
      if ((WEIGHT_EXT.test(v) || k.endsWith("_name")) && RED_FLAG_WEIGHTS.some((re) => re.test(v))) {
        add({ name: `red-flag weight ${v}`, license: "unlisted", url: "", class: "banned" });
        continue;
      }
      if (!WEIGHT_EXT.test(v)) continue;
      const cp = licenseForWeight(v) ?? onUnknownWeight?.(v, id, node.class_type) ??
        (RESTRICTED_WEIGHT_PATTERNS.some((re) => re.test(v))
          ? { name: v, license: "unlisted (matches a restricted 3D weight pattern)", url: "", class: "restricted" as const }
          : { name: v, license: "unlisted", url: "", class: "restricted" as const });
      add(cp);
    }
  }
  const list = [...components.values()];
  return { class: worstClass(list), components: list };
}

export function mergeComponents(lists: (readonly LicenseComponent[] | undefined)[]): LicenseComponent[] {
  const seen = new Map<string, LicenseComponent>();
  for (const l of lists) for (const cp of l ?? []) if (!seen.has(cp.name)) seen.set(cp.name, cp);
  return [...seen.values()];
}

/** The explainer recipe's motion stage - each key maps to the catalog endpoint
 *  the recipe submits ("still" runs ffmpeg only, no model). Kept in sync with
 *  the MOTION table in src/lib/generation/recipes/explainer.ts - the license
 *  audit cross-checks the two files. */
export const EXPLAINER_MOTION_ENDPOINTS: Record<string, string | null> = {
  "wan-vace": "motionfield/wan-vace/image-to-video",
  "wan22-ti2v": "motionfield/wan-2.2/image-to-video",
  "ltx": "motionfield/ltx-video/image-to-video",
  "still": null,
};

function endpointInfo(endpointId: string, licMap: Record<string, LicenseInfo>): LicenseInfo | null {
  const graph = Object.hasOwn(ENDPOINT_GRAPHS, endpointId) ? ENDPOINT_GRAPHS[endpointId] : undefined;
  return (graph ? licMap[graph] : undefined) ?? null;
}

/** The explainer recipe's license depends on params.motion_model, resolved
 *  through the motion endpoint ids above: "ltx" → restricted; anything else →
 *  worst of z-image-turbo + kokoro + the chosen motion endpoint's workflow.
 *  An unknown motion_model resolves restricted (fail closed). */
export function explainerLicense(
  params: Record<string, unknown>,
  licMap: Record<string, LicenseInfo>,
): LicenseInfo {
  const motion = String(params.motion_model ?? "wan-vace");
  const endpoint = Object.hasOwn(EXPLAINER_MOTION_ENDPOINTS, motion) ? EXPLAINER_MOTION_ENDPOINTS[motion] : undefined;
  const motionLic = endpoint ? endpointInfo(endpoint, licMap) : null;
  const unknownMotion = endpoint === undefined || (endpoint !== null && !motionLic);
  const components = mergeComponents([
    endpointInfo("motionfield/z-image-turbo/text-to-image", licMap)?.components,
    endpointInfo("motionfield/kokoro/text-to-speech", licMap)?.components,
    motionLic?.components,
    unknownMotion
      ? [{ name: `motion_model "${motion}": unknown endpoint`, license: "unlisted", url: "", class: "restricted" as const }]
      : undefined,
  ]);
  return { class: worstClass(components), components };
}

/** Effective license for an endpoint - pure resolution shared by the server
 *  gate and client pickers. Recipe endpoints resolve via RECIPE_LICENSES
 *  (explainer resolves its params through the motion endpoint ids); comfy
 *  endpoints use the attach-time info (or a fresh map lookup), merged with the
 *  params-picked workflowFor variant when it names another graph file. A
 *  caller-supplied graph override is scanned too - the result is the worst of
 *  the endpoint's own class and the override graph's. */
export function endpointLicenseFor(
  workflow: Pick<WorkflowDef, "endpointId" | "providers" | "license">,
  params: Record<string, unknown> = {},
  graph?: Record<string, unknown> | null,
  licMap: Record<string, LicenseInfo> = WORKFLOW_LICENSES,
): LicenseInfo {
  const recipe = workflow.providers.recipe?.name;
  let base: LicenseInfo;
  if (recipe === "explainer") {
    base = explainerLicense(params, licMap);
  } else if (recipe) {
    base = RECIPE_LICENSES[recipe] ?? {
      class: "restricted",
      components: [{
        name: `${workflow.endpointId}: recipe "${recipe}" has no RECIPE_LICENSES entry`,
        license: "unlisted", url: "", class: "restricted",
      }],
    };
  } else if (workflow.license) {
    base = workflow.license;
  } else {
    // fail closed: a graph that was never generated into the map runs restricted
    const wf = workflow.providers.comfy?.workflow;
    base = (wf ? licMap[wf] : undefined) ?? {
      class: "restricted",
      components: [{
        name: wf ? `${wf}: not in licenses.generated` : `${workflow.endpointId}: no license info`,
        license: "unlisted", url: "", class: "restricted",
      }],
    };
  }
  // a params-picked variant (workflowFor) runs its own graph file - merge its
  // license into the endpoint's whatever the base branch was. An ungenerated
  // pick fails closed: restricted, "not in licenses.generated".
  const pick = workflow.providers.comfy?.workflowFor?.(params);
  if (pick !== undefined && pick !== workflow.providers.comfy?.workflow) {
    const alt = licMap[pick] ?? {
      class: "restricted" as const,
      components: [{
        name: `${pick}: not in licenses.generated`,
        license: "unlisted", url: "", class: "restricted" as const,
      }],
    };
    const components = mergeComponents([base.components, alt.components]);
    base = { class: worstClass(components), components };
  }
  if (!graph) return base;
  const over = graphLicense(graph as ComfyGraph);
  const components = mergeComponents([base.components, over.components]);
  return { class: worstClass(components), components };
}

/** Attach each workflow's license via its bundled graph filename. Recipe
 *  endpoints (no graph file) get their RECIPE_LICENSES entry - the explainer
 *  resolves its params-default. */
export function attachLicenses(models: ModelDef[], licMap: Record<string, LicenseInfo>): ModelDef[] {
  return models.map((m) => ({
    ...m,
    workflows: m.workflows.map((wf) => {
      const graph = wf.providers.comfy?.workflow;
      const license = graph ? licMap[graph]
        : endpointLicenseFor(wf, {}, null, licMap);
      const out = license ? { ...wf, license } : wf;
      // explainer's class depends on params.motion_model - expose the
      // per-choice variants so pickers can badge "ltx" as restricted before
      // the params are even chosen
      if (wf.providers.recipe?.name === "explainer") {
        const byValue: Record<string, LicenseInfo> = {};
        for (const key of Object.keys(EXPLAINER_MOTION_ENDPOINTS)) {
          byValue[key] = explainerLicense({ motion_model: key }, licMap);
        }
        return { ...out, licenseVariants: { param: "motion_model", byValue } };
      }
      // a comfy workflowFor that switches on a declared select param -
      // the director's backend pick (ltx → ltx graphs → restricted) gets the
      // same per-choice badge
      const vp = wf.providers.comfy?.variantParam;
      if (vp && wf.providers.comfy?.workflowFor) {
        const byValue: Record<string, LicenseInfo> = {};
        for (const key of vp.values) {
          const pick = wf.providers.comfy.workflowFor({ [vp.name]: key }) ?? wf.providers.comfy.workflow;
          byValue[key] = licMap[pick] ?? { class: "restricted", components: [{ name: `${pick}: not in licenses.generated`, license: "unlisted", url: "", class: "restricted" }] };
        }
        return { ...out, licenseVariants: { param: vp.name, byValue } };
      }
      return out;
    }),
  }));
}
