# MotionField verification report

Status: **Phase A (pod-off) complete. No end-to-end GPU render has been verified yet.**
A feature is only marked working after a real render is inspected — that is Phase B
(`../of-reports/gpu-batch.md`). Live status table: `../of-reports/test-all-status.md`.

## What changed in Phase A (code verified, not GPU-verified)

- **Wan Animate person swap** — rewritten to the official ComfyUI Wan 2.2 Animate
  template: `wan2.2_animate_14B_bf16.safetensors` (sha256-verified manifest entry)
  replaces the suspected-bad int8/convrot checkpoint, plus the official relight
  LoRA, `ModelSamplingSD3 shift=8`, KSampler 6 steps / cfg 1 / euler / simple,
  split DWPose body+face preprocessors, masked plate composite, audio passthrough.
- **Qwen image edit** — the catalog endpoint was wired to an orphaned 2509 graph
  whose weights were never shipped (edit instructions silently ignored). Now runs
  `qwenedit2511-edit.json` with the official 2511 recipe: TextEncodeQwenImageEditPlus,
  FluxKontextMultiReferenceLatentMethod, ModelSamplingAuraFlow shift 3.1, CFGNorm,
  cfg 4 / 40 steps, steps exposed as a param (4–80).
- **Qwen character edit** — moved off the missing 2509 fp8 checkpoint to
  `qwen_image_edit_2511_fp8mixed.safetensors` with the same 2511 conditioning.
- **Klein edit family** — verified structurally equivalent to the official FLUX.2
  Klein distilled template (ReferenceMultiLatent ≡ ReferenceLatent chain,
  Flux2Scheduler, CFGGuider cfg=1, 4 steps). All graphs reference
  `flux-2-klein-4b.safetensors`, not the 512-byte stub on the pod.
- **Graph blockers fixed** — `reshoot-uni3c` RemoveBackground fed from an audio
  output (now a real `LoadBackgroundRemovalModel`); `vfx-wan-alt-image` autogrow
  inputs flattened; lipsync `{{PREFIX}}_clip` placeholders removed.
- **Manifest** — added sha256-verified official entries for Wan 2.1 T2V 1.3B,
  Wan 2.2 S2V fp8, wav2vec2, all four ACE-Step 1.5 weights, and the Wan Animate
  relight LoRA (Comfy-Org). Removed the corrupted int8 Wan checkpoint.
- **Offline linter** — `scripts/lint-workflows.py`: all 69 workflows, 0 errors.
- **sync-to-pod.sh** — rsync over `~/.ssh/runpod_motionfield`, POD_HOST/POD_PORT env,
  excludes `.env`, `.data`, `node_modules`, `.next*`, `public/files`, `.git`.
- **Clean-room sweep** — zero forbidden terms outside allowed exceptions.
- **Gates** — typecheck PASS, 1178 unit tests PASS, `next build` PASS (119 routes).

## Known Phase-B blockers (decisions needed)

- **LTX-2.5 weights are gated** on Hugging Face (LTX-2.x community license);
  manifest sha256s are `pending`. Either run `fill-hashes.py`/`setup.sh` with an
  `HF_TOKEN` that has accepted the licenses, or mark the LTX-2.5 features
  hidden/skipped for the demo.
- **3D workflows do not exist** — the trellis/triposg/marigold/sam3.1 manifest
  groups have no corresponding workflow JSONs. The 3D feature is not shippable
  as-is; SAM 3.1 is additionally gated.
- **Audio stack** — ACE-Step weights are now in the manifest but were never seen
  on the pod; Chatterbox/Whisper are pack-managed and need an install check in
  GPU-session Order 0. MOSS-SFX is Mac/MLX-only by design.
- The pod's 512-byte `flux-2-klein-4b-bf16.safetensors` stub is unused by any
  workflow; it can be ignored or deleted on the pod.

## Original audit findings (pre-Phase-A, kept for history)

- The demo setup previously reported installation of its software and weights; a
  completed install is not evidence of a successful render.
- The full model dry run selected ~203 GiB — a plan, not a download.
- The earlier pod's ComfyUI answered on port 8188 via the `localhost:18188`
  tunnel; port 8189 was a separate `comfy-api-proxy` whose necessity is
  unverified. A `/tmp/mitm.py` process was also running — its purpose is unknown;
  do not depend on either blindly.
- A Z-Image prompt completed in the pod log (122.52s) but the output was never
  inspected — not evidence of quality.
