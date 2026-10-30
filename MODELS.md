# Models

MotionField's MIT license covers MotionField's own code only. Model weights, custom
nodes, and upstream services referenced by workflows in `/workflows` carry their
own licenses — audit them against your use case before shipping.

## Weights per workflow

| Workflow file | Model / weights file | Source (Hugging Face repo) | Weights license | Commercial use | Runs on Apple Silicon 32 GB? |
|---|---|---|---|---|---|
| `zimage-txt2img.json` `zimage-img2img.json` | `z_image_turbo_int8_convrot.safetensors` (5.8 GB) | [Comfy-Org/z_image_turbo](https://huggingface.co/Comfy-Org/z_image_turbo) (upstream [Tongyi-MAI/Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo)) | Apache-2.0 | Yes | **Yes** — ~11.5 GB with the text encoder below; bf16 (11.5 GB) or nvfp4 (CUDA-only) variants also exist upstream |
| 〃 | `qwen_3_4b_fp8_mixed.safetensors` (5.3 GB) | [Comfy-Org/z_image_turbo](https://huggingface.co/Comfy-Org/z_image_turbo) (upstream [Qwen/Qwen3-4B](https://huggingface.co/Qwen/Qwen3-4B)) | Apache-2.0 | Yes | Yes |
| 〃 | `ae.safetensors` (FLUX-family VAE) | [Comfy-Org/z_image_turbo](https://huggingface.co/Comfy-Org/z_image_turbo) — same file as the flux1-schnell repack | Apache-2.0 | Yes | Yes |
| `birefnet-remove-bg.json` | `birefnet.safetensors` (424 MB) | [Comfy-Org/BiRefNet](https://huggingface.co/Comfy-Org/BiRefNet) (upstream [ZhengPeng7/BiRefNet](https://huggingface.co/ZhengPeng7/BiRefNet)) | MIT | Yes | **Yes** — native ComfyUI nodes (`LoadBackgroundRemovalModel`/`RemoveBackground`), seconds per image |
| `klein-edit.json` `klein-inpaint.json` `klein-product-compose.json` `klein-product-scene.json` `klein-txt2img.json` | `flux-2-klein-4b.safetensors` (7.75 GB distilled bf16) | [Comfy-Org/Flux-2-Klein-4B](https://huggingface.co/Comfy-Org/Flux-2-Klein-4B) → `split_files/diffusion_models/` (upstream [black-forest-labs/FLUX.2-klein-4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B)) | Apache-2.0 | Yes | **Yes** — ~14 GB resident total (smoked in ws4-s7smoke; the s7fix smokes ran through `COMFY_MODEL_MAP` onto a local bf16 dequant of the fp8 download — same tensor layout — until the official file is downloaded). The klein 9B sibling is non-commercial and banned in the catalog |
| 〃 | `qwen_3_4b_fp8_mixed.safetensors` (5.3 GB) | [Comfy-Org/z_image_turbo](https://huggingface.co/Comfy-Org/z_image_turbo) — same Qwen3-4B encoder Z-Image uses (already on disk) | Apache-2.0 | Yes | Yes |
| 〃 | `flux2-vae.safetensors` | [Comfy-Org/Flux-2-Klein-4B](https://huggingface.co/Comfy-Org/Flux-2-Klein-4B) | Apache-2.0 | Yes | Yes |
| `klein-product-compose.json` (extra) | `birefnet.safetensors` (424 MB) | as above | MIT | Yes | Yes — same BiRefNet as the cutout workflow |
| ~~`schnell-*.json`~~ (removed ws4-s7) | `flux1-schnell-fp8.safetensors` (+ `clip_l`, `t5xxl`) | [Comfy-Org/flux1-schnell](https://huggingface.co/Comfy-Org/flux1-schnell) | Apache-2.0 | Yes | **Removed** — never finished a run on this box (~4 min/step under swap, >15 min at 480p). Workflows and endpoints deleted; the weight files stay licensed Apache-2.0 but can be deleted to make room |
| `qwenedit2511-edit.json` | `qwen_image_edit_2511_fp8mixed.safetensors` | [Comfy-Org/Qwen-Image-Edit_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI) (upstream [Qwen/Qwen-Image-Edit-2511](https://huggingface.co/Qwen/Qwen-Image-Edit-2511)) | Apache-2.0 | Yes | **No** — ~29 GB fp8 total; Comfy Cloud or CUDA GPU recommended |
| 〃 | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | [Comfy-Org/Qwen-Image-Edit_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI) (upstream Qwen2.5-VL-7B) | Apache-2.0 | Yes | No (bundled above) |
| 〃 | `qwen_image_vae.safetensors` | [Comfy-Org/Qwen-Image-Edit_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI) | Apache-2.0 | Yes | No (bundled above) |
| `ltx-txt2video.json` `ltx-img2video.json` `ltx-vfx-keyframe.json` `vfx-ltx-plate-classic.json` `vfx-ltx-image-classic.json` | `ltx-video-2b-v0.9.5.safetensors` | [Lightricks/LTX-Video](https://huggingface.co/Lightricks/LTX-Video) | Lightricks Open RAIL-M — [ltx-video-2b-v0.9.5.license.txt](https://huggingface.co/Lightricks/LTX-Video/blob/main/ltx-video-2b-v0.9.5.license.txt) | Yes, with use restrictions | **Yes** — measured ~90 s t2v / ~60 s i2v at 864×480, 17 frames, 6 steps ([SMOKE](docs/SMOKE.md)) |
| `vfx-ltx-plate.json` `vfx-ltx-image.json` | `ltxv-2b-0.9.8-distilled.safetensors` (6.34 GB — exact byte size pinned, 6,340,744,492) | [Lightricks/LTX-Video](https://huggingface.co/Lightricks/LTX-Video) | Lightricks Open RAIL-M (same LTX-Video license family) | Yes, with use restrictions | **Not downloaded** — the lab's `ltx098` engine stays hidden until that exact file exists under `models/checkpoints/`; the endpoint refuses it otherwise. No MotionField code ever installs it |
| 〃 | `t5xxl_fp8_e4m3fn_scaled.safetensors` | [Comfy-Org/Wan_2.1_ComfyUI_repackaged](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged) (upstream Google T5) | Apache-2.0 | Yes | Yes |
| `wan-txt2video.json` | `wan2.1_t2v_1.3B_fp16.safetensors` | [Comfy-Org/Wan_2.1_ComfyUI_repackaged](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged) (upstream Wan-AI/Wan2.1-T2V-1.3B) | Apache-2.0 | Yes | **Yes** — measured ~317 s at 864×480, 17 frames, 6 steps; real jobs (20+ steps, more frames) run tens of minutes — consider cloud for anything beyond smoke size |
| `wan-img2video.json` | `wan2.1_i2v_480p_14B_fp16.safetensors` | same repo (upstream Wan-AI/Wan2.1-I2V-14B-480P) | Apache-2.0 | Yes | **No** — ~28 GB fp16; use cloud or `COMFY_MODEL_MAP` to a lighter build |
| 〃 | `clip_vision_h.safetensors` | same repo (upstream LAION CLIP-ViT-H/14) | MIT | Yes | Yes |
| `wan-vace-img2video.json` `vace-motion-transfer.json` `vace-object-swap.json` `vace-character-swap.json` `vace-restyle.json` `vace-reframe.json` `persona-vace-image.json` `vfx-wan-alt-depth.json` `vfx-wan-alt-pose.json` `vfx-wan-alt-edges.json` `vfx-wan-alt-image.json` (+ the default `lipsync-talking-portrait`/`lipsync-talk` motion stage) | `wan2.1_vace_1.3B_fp16.safetensors` (Wan2.1-VACE-1.3B) | same repo | Apache-2.0 | Yes | **Yes** — measured 224–425 s per workflow at 480p, 17 frames, 6 steps; workable for short clips. Optional upgrade: `COMFY_MODEL_MAP` → `wan2.1_vace_14B_fp8scaled.safetensors` (Wan2.1-VACE-14B) on a GPU or Comfy Cloud |
| `wan22-ti2v-img2video.json` | `wan2.2_ti2v_5B_fp16.safetensors` (~11 GB) + `wan2.2_vae.safetensors` | [Comfy-Org/Wan_2.2_ComfyUI_Repackaged](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged) (upstream Wan-AI/Wan2.2-TI2V-5B) | Apache-2.0 | Yes | **No** — ~11 GB of weights, not downloaded; catalog marks the endpoint heavy/opt-in |
| 〃 (all Wan) | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | same repo (upstream Google uMT5-XXL) | Apache-2.0 | Yes | Yes |
| 〃 (all Wan) | `wan_2.1_vae.safetensors` | same repo | Apache-2.0 | Yes | Yes |
| `vace-restyle.json` | `depth_anything_v2_vits.pth` (Small only) | [depth-anything/Depth-Anything-V2-Small](https://huggingface.co/depth-anything/Depth-Anything-V2-Small) | Apache-2.0 | Yes | Yes |
| `vace-motion-transfer.json` `vace-character-swap.json` `wan-animate-character-swap.json` | DWPose detector weights (`dw-ll_ucoco_384.onnx` + `yolox_l.onnx`) | auto-fetched by comfyui_controlnet_aux (DWPose) | Apache-2.0 | Yes | Yes |
| `wan-animate-character-swap.json` | `wan2.2_animate_14B_bf16.safetensors` (~34.5 GB bf16 — the int8_convrot quant produced color corruption and was dropped) | [Comfy-Org/Wan_2.2_ComfyUI_Repackaged](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged) (upstream [Wan-AI/Wan2.2-Animate-14B](https://huggingface.co/Wan-AI/Wan2.2-Animate-14B)) | Apache-2.0 | Yes | **No** — not downloaded; catalog marks the endpoint cloud-recommended. Uses native `WanAnimateToVideo` (ComfyUI ≥0.41) |
| 〃 | `clip_vision_h.safetensors` (CLIP-ViT-H/14) | same repo (upstream LAION) | MIT | Yes | Yes |
| `qwen-character-edit.json` | same weights as `qwenedit2511-edit.json` (Qwen-Image-Edit-2511, multi-image via `TextEncodeQwenImageEditPlus`) | 〃 | Apache-2.0 | Yes | **No** — ~29 GB fp8; Comfy Cloud or CUDA GPU recommended |
| `vace-object-swap.json` | SAM2 mask-gen weights (upstream step only) | [facebook/sam2](https://huggingface.co/facebook/sam2-hiera-large) via ComfyUI-segment-anything-2 | Apache-2.0 | Yes | Yes |
| `lipsync-video.json` `lipsync-talking-portrait.json` `lipsync-talk.json` `lipsync-talking-portrait-ltx.json` `lipsync-talk-ltx.json` | MuseTalk UNet (`musetalk/pytorch_model.bin`, ~3.4 GB) + `sd-vae-ft-mse` + `whisper/tiny.pt` (76 MB) + DWPose ONNX face/pose models (`yolox_l.onnx` + `dw-ll_ucoco_384.onnx`, staged under `.../MuseTalk/dwpose/`). The `-ltx` variants additionally pull `ltx-video-2b-v0.9.5.safetensors` + t5xxl for the motion stage; the default portrait graphs use the Wan VACE weights above | [TMElyralab/MuseTalk](https://huggingface.co/TMElyralab/MuseTalk) bundle layout under `models/diffusers/TMElyralab/MuseTalk/`; VAE [stabilityai/sd-vae-ft-mse](https://huggingface.co/stabilityai/sd-vae-ft-mse); Whisper — OpenAI; DWPose via [yzd-v/DWPose](https://huggingface.co/yzd-v/DWPose) | MuseTalk code+weights MIT (commercial OK); VAE MIT; Whisper MIT; DWPose Apache-2.0; motion stage per the rows above | Yes | **Yes** — ~4 GB weights, runs on MPS/CPU |
| `lipsync-s2v.json` | `wan2.2_s2v_14B_fp8_scaled.safetensors` + `wav2vec2_large_english_fp16.safetensors` + `umt5_xxl` + `wan_2.1_vae` | [Comfy-Org/Wan_2.2_ComfyUI_Repackaged](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged) (upstream [Wan-AI/Wan2.2-S2V-14B](https://huggingface.co/Wan-AI/Wan2.2-S2V-14B); wav2vec2 upstream [facebook/wav2vec2-large-960h-lv60](https://huggingface.co/facebook/wav2vec2-large-960h-lv60)) | Apache-2.0 | Yes | **No** — ~16 GB fp8 + encoders; catalog marks it cloud/GPU-recommended. Uses native `WanSoundImageToVideo` + `AudioEncoderEncode` (ComfyUI ≥0.41) |
| `kokoro-tts.json` | `kokoro_v1.onnx` (310 MB, ONNX export of Kokoro-82M) + `voices_v1.bin` (27 MB, 54 voice tensors from `hexgrad/Kokoro-82M/voices/*.pt`) | ONNX build: [kokoro-onnx releases](https://github.com/taylorchu/kokoro-onnx/releases) (auto-fetched by the node pack); voice tensors + upstream weights: [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) | Apache-2.0 (weights); kokoro-onnx runtime MIT | Yes | **Yes** — CPU/ONNX, ~1× real-time on M1 Pro ([SMOKE](docs/SMOKE.md)) |
| `chatterbox-voice-clone.json` | `resembleai_default_voice` pack: `ve.safetensors` + `t3_cfg.safetensors` + `s3gen.safetensors` + `conds.pt` + `tokenizer.json` (~2.7 GB) | [ResembleAI/chatterbox](https://huggingface.co/ResembleAI/chatterbox) (auto-fetched by the node pack on first run) | MIT | Yes | **Yes** — MPS/CPU on M1 Pro ([SMOKE](docs/SMOKE.md)) |
| `upscale-4x.json` | `RealESRGAN_x4plus.pth` | [xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) (official release; HF mirrors exist) | BSD-3-Clause | Yes | **Yes** — measured ~15 s for a 512² → 2048² frame |

`COMFY_MODEL_MAP` (JSON env map) rewrites weight filenames at submit time, so a
workflow can declare canonical weights while a deployment runs lighter local
ones — e.g. `{"wan2.1_vace_14B_fp8scaled.safetensors":"wan2.1_vace_1.3B_fp16.safetensors"}`.

## Custom node packs per workflow

MotionField workflows use ComfyUI core nodes wherever possible. Extra packs:

| Pack | Repo + pinned commit | License | Needed by |
|---|---|---|---|
| ComfyUI core nodes | builtin (verified 0.41.0) | GPL-3.0 | every workflow |
| [ComfyUI-VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) | `4d907be` | GPL-3.0 | `ltx-txt2video`, `ltx-img2video`, `ltx-vfx-keyframe`, `wan-txt2video`, `wan-img2video`, `lipsync-*` (VHS_VideoCombine mux + clip handoff), all `vace-*` (VHS_LoadVideo / VHS_VideoCombine / VideoLengthAdjuster) |
| [comfyui_controlnet_aux](https://github.com/Fannovel16/comfyui_controlnet_aux) | `a587a4c` | Apache-2.0 | `vace-restyle` (DepthAnythingV2), `vace-motion-transfer` + `vace-character-swap` + `wan-animate-character-swap` (DWPreprocessor). Note: its `dwpose` preprocessor module ships CMU-licensed OpenPose-derived code (non-commercial) — MotionField's MuseTalk patch vendors the Apache-2.0 DWPose ONNX source instead |
| [ComfyUI-MuseTalk](https://github.com/chaojie/ComfyUI-MuseTalk) (chaojie) | `84f4b6d` + `scripts/patches/comfyui-musetalk-mps.patch` | MIT | `lipsync-video`, `lipsync-talking-portrait`, `lipsync-talk` — install via `scripts/setup-musetalk.sh`; its `requirements.txt` (mmlab `mmcv/mmdet/mmpose`) is upstream-only and skipped — landmarks/bboxes run on the vendored `musetalk/utils/dwpose_onnx/` (Apache-2.0, from IDEA-Research/DWPose); `lipsync-*-ltx` are opt-in LTX-Video variants |
| [ComfyUI-segment-anything-2](https://github.com/kijai/ComfyUI-segment-anything-2) | optional, not installed | Apache-2.0 | upstream mask generation for `vace-object-swap` (not in the graph itself — mask inputs are pre-baked) |
| [comfyui-kokoro](https://github.com/stavsap/comfyui-kokoro) (stavsap) | `cfb59b5` | Apache-2.0 | `kokoro-tts` (KokoroSpeaker + KokoroGenerator; wraps [kokoro-onnx](https://github.com/taylorchu/kokoro-onnx), MIT) |
| [ComfyUI-Chatterbox](https://github.com/wildminder/ComfyUI-Chatterbox) (wildminder) | `4597af8` | Apache-2.0 (vendored chatterbox is MIT) | `chatterbox-voice-clone` (ChatterboxTTS node, `audio_prompt` reference clip) |
| motionfield_nodes (in-repo, `comfy-nodes/motionfield_nodes`) | this repo | MIT | `OF_DWPose`/`OF_MouthMask`/`OF_MatteCoverage`/`OF_Trajectory`/`OF_CameraRig`/`OF_DepthBlur`/`OF_CameraEmbed` (persona, lipsync, camera-motion graphs), `OF_BoxPlace` (`klein-product-compose` — normalised-box overlay paste) |

Only ComfyUI-MuseTalk carries local edits — captured in
`scripts/patches/comfyui-musetalk-mps.patch` and re-applied by
`scripts/setup-musetalk.sh`. Every other pack runs unmodified at the pinned
commit above.

## License notes

- **Removed dependency:** the previous LatentSync lip-sync workflow pointed at
  `ComfyUI-LatentSyncWrapper`, which ships **no LICENSE file** — it must not be
  referenced as a dependency. All lip-sync entries now use the MIT-licensed
  `chaojie/ComfyUI-MuseTalk` pack or native ComfyUI nodes.
- **S3FD — removed:** upstream MuseTalk detects face bboxes with the sfd
  detector (`s3fd.pth`), whose weights were published for research use. Our
  patch drops it: face landmarks *and* the fallback bbox come from the
  vendored DWPose ONNX pipeline (`musetalk/utils/dwpose_onnx/`, Apache-2.0).
  `s3fd.pth` is no longer loaded (or needed).
- **Face-parse BiSeNet — removed:** upstream MuseTalk blends the lip-synced
  face back with a segmentation mask from `musetalk/utils/face_parsing/`
  (BiSeNet + ResNet18, `face-parse-bisent/79999_iter.pth`, trained on
  CelebAMask-HQ — non-commercial dataset terms). The patch now takes the
  mouth blend region from the MotionField `OF_MouthMask` node instead — a
  mouth-contour + lower-jaw hull built per frame from the same DWPose
  landmarks — and `setup-musetalk.sh` deletes the module, so the
  `face-parse-bisent` weight folder is no longer needed either. If a prior
  install staged it under `models/diffusers/TMElyralab/MuseTalk/`, that
  local folder can be deleted.

- **FLUX.1 [schnell] — removed (ws4-s7):** the local schnell stack never
  completed a job on this box (22.7 GB resident, ~4 min/step under memory
  pressure — a 4-step 480p smoke exceeded 15 minutes). The workflows,
  endpoints, tiles and links are gone; the weight rows above stay for
  attribution and the files can be deleted. Replacement: FLUX.2 klein 4B
  distilled (Apache-2.0, 7.75 GB bf16), which also absorbs the previous
  Qwen-Image-Edit responsibilities for instruction edit / masked remove /
  product placement. **klein 9B stays non-commercial** — it remains on the
  red-flag list and must never ship in a bundled workflow.

## License boundary

MotionField talks to ComfyUI over HTTP via the official Comfy SDK
(`@comfyorg/sdk`, Comfy API v2) — model weights and custom nodes run in the
ComfyUI process, never inside MotionField. MotionField's own code therefore stays
MIT regardless of the GPL-3.0 node packs or restricted-use weights it drives.
