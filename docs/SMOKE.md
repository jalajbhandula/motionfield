# Workflow smoke tests - local ComfyUI

End-to-end runs through the real provider path:
`comfyProvider.submit()` → `@comfyorg/sdk` → `comfy-api-proxy` (Comfy API v2)
→ local ComfyUI 0.41 → media outputs saved under `public/files/generated/`.

Hardware: Apple M1 Pro, 32 GB RAM, macOS. ComfyUI on `127.0.0.1:8188`,
proxy on `127.0.0.1:8189` (`COMFY_BASE_URL`). Smoke params deliberately tiny
(low res, ~1s video, few steps) - wall time is dominated by model weight
loading + sampler steps, so real jobs are slower than the numbers below.

Reproduce:

```sh
npx tsx scripts/comfy-smoke.ts <workflow.json> "prompt" \
  [--image|--video|--mask|--mask-video|--audio|--ref <path|/files/...>] \
  [--params '{"steps":6,"duration":1,"fps":16,"resolution":"480p"}'] [--timeout 900]
```

## Results (M1 Pro 32 GB)

Explainer recipe (`motionfield/explainer/video`, provider `recipe`):

| Case | Result | Wall time | Notes |
|---|---|---|---|
| `npx tsx scripts/recipe-smoke.ts "make an explainer about how rainbows form" --params '{"scenes":3,"voice":"af_heart","clip_duration":1,"fps":16,"steps":4}'` | ✅ pass | 1404 s | Provider-level run (no dev server): qwen3 wrote the 3-scene script, Z-Image keyframes, **Wan 2.1 VACE 1.3B** first-frame motion clips (default `motion_model`; `wan22-ti2v`/`ltx`/`still` are opt-ins), Kokoro narration, ffmpeg stitch → 16.04 s 864×480 h264+aac mp4. Exactly one new file landed under `public/files/generated` - every sub-job artifact is tracked and `fs.rm`'d after the stitch (also verified on a forced failure at the clip-submit step: intermediates were deleted). A topic without `LLM_BASE_URL`/`LLM_MODEL` fails fast with "Explainer needs an LLM"; a pasted script still runs (deterministic chunking). Cancel during the script phase reports `canceled` and submits no ComfyUI job; polls are idempotent. |
| `~/.motionfield/gpu-run ws2-explainer -- env COMFY_LIVE=1 EXPLAINER_LIVE=1 EXPLAINER_PHASE=<wan\|still\|off\|eval> npx vitest run tests/smoke/ws2-explainer-captions.test.ts` | ✅ pass (still path) · Wan timed out at the 25-min spec cap | wan 1500 s · still 1044 s · off 1002 s | 2026-10-24 (s11 head `5feca8f`): pasted 4-sentence script, look flat-2d, captions karaoke, 480p 16:9, scenes=4, clip_duration=2, steps=4. **Wan 2.1 VACE first** - reached `wan2.1_vace_1.3B_fp16` motion-clip stage but did not finish inside the 25-min budget on a contended 32 GB box (recorded `timeout`, error `canceled`). Still-motion rerun produced the evidence pair: `still-karaoke.mp4` 11.861 s, 864×480 h264+aac with a **real whisper** 4-cue `.srt`/`.vtt` (word-boundary 3.36 s/6.82 s/9.85 s mid-word carries - `timing:"real"`, 25/26 script words in cues); `still-off.mp4` is the same-seed uncaptioned reference. Burn proven by pixels - bottom-third byte-diff at cue midpoints t=1.71/5.09/8.34/11.5 → 0.0305-0.0521 (all >0.005) vs the reference; top half diffs collapse at two midpoints (0.0009-0.0016 - no caption band). Evidence in `/tmp/of-evidence/ws2-explainer-captions/` (evidence.json + both mp4s + sidecars). The run also surfaced and fixed two recipe bugs: a timed-out sub-job orphaned its ComfyUI prompt (now cancels first) and an external queue-purge kill now gets one honest resubmit under a fresh sub-job id with the deadline re-armed on first-run, not submit. |
| `npx tsx scripts/assistant-smoke.ts --only d` | ⚠ not re-run since the run-registry change | - (re-run pending) | Full HTTP path: planner picks `motionfield/explainer/video` for "make an explainer about how rainbows form" → one recipe job → h264+aac mp4; `/api/assets` shows only the final video for that job - no intermediates. The run map lives on `globalThis` (HMR-safe) and `poll` is idempotent - a completed run stays readable for a 10-minute sweep window; editing `src/` mid-run no longer fails the job. |
| `npx tsx scripts/brain-bench.ts --dry` | ✅ pass | <30 s | Built-in (stub) planner end to end - real uploads, real POST /api/agent/runs per brief, honest-ask briefs must 422 - plus a coverage check that every `want` regex names an offered tool; writes `/tmp/of-brain-bench.json`. |
| `npx tsx scripts/brain-bench.ts --stub <port>` | ✅ pass | <30 s | Wire-level bench: a loopback OpenAI-chat stub answers the planner route - scores the full llmPlan path (resolve → dispatch → parse → validate) with zero real model. `--stub` spins the stub up itself. |
| `~/.motionfield/gpu-run ws2-runs-brain -- env LLM_LIVE=1 npx vitest run tests/smoke/ws2-runs-brain.test.ts` | ✅ pass | 71 s | Re-run 2026-10-24 (s12fix6 head `704b791`): qwen3.5:9b think=off plans 3 briefs through shipped llmPlan - every returned plan now loops through shownMedia → materializeMedia → memory strip (s12fix6 F1); every Plan survives the real validatePlan on mock - t2v lighthouse, a t2i→i2v chained `$step` pipeline (auto-materialized image step), kokoro tts read-aloud. GPU only carries the LLM; PGLite is a fresh tmpdir. |
| `LLM_LIVE=1 npx tsx scripts/brain-bench.ts --planner ollama:qwen3.5:9b [--limit N]` | ⚠ 13/24 · avg 0.81 | 336 s (24 briefs) | Re-run 2026-10-23 (s12fix5 head `ad36a58`) under `gpu-run ws2-bench` vs a mock-provider dev server on :3120, think=off. 24 briefs: 13 planned, 8 asked (4 honest asks scored + the misses below), avg 0.81, p50 15.1 s / p95 24.8 s, 0 fallbacks, 24028 input / 1273 output tokens, via `ollama·qwen3.5:9b`×13 (web_search skipped unconfigured, 2 builtin-table briefs skipped for the model candidate). The MF2 guard now catches invented media - "upscale this image" (an honest-ask brief) → 422 `“Upscale image 4x” needs a image for "image_url" - attach one or name an @ref; I won't guess a file` where the last run parked a 201; the attached variant still plans 201 on `motionfield/upscale/image`. Scored misses with their exact refusal text - "animate this photo into a 4s clip" → `That endpoint isn't installed on this machine - "motionfield/stable-diffusion-3.5/text-to-image"`; "a 30s product ad for sneakers" → the MF2 ask on `product_image_url` (the model invented a product photo for an endpoint that needs one); "turn my podcast clip into a vertical reel" → `step "s1" needs a image for "image_url", but the attached file is a video`; "make a 3-shot reel: wide, close-up, drone pull-back" → `step "s1" depends on "s2" - dependencies must come earlier in the plan`. `--planner` takes a comma list; `--limit N` truncates; `--repeat N` reruns. |
| `PORT=3120 PGLITE_DIR=/tmp/of-ws2/pglite COMFYUI_DIR=/tmp/of-ws2/comfy npx next dev` → POST /api/models/hub/inspect + /downloads | ✅ pass | ~6 s | 2026-10-24 (s3c head `0ac10ac` + the seam fix landed in this same commit). Live Hugging Face, no seams: `google/bert_uncased_L-2_H-128_A-2` (Apache-2.0) → `model.safetensors` 17,739,144 B (16.92 MB ≤ 50 MB) into `checkpoints`; row `773484a7` ran to `done`; sha256 verified `7fb69ad9f6866d8983183c930e33828f326470bf6ad8bbb2ad4ed957a92e9414` == the HF LFS oid; file deleted after. The run also caught a real bug first try - with `MOTIONFIELD_HUB_TEST_FREE_GB` unset, `Number("")` made the seam report 0 GB and every download refused `needs 1 GB but only 0 GB free - MotionField keeps 10 GB free`; fixed to a strict `undefined` check, re-ran clean. |

2026-10-22 additions (ws4 preset-verify - catalog honesty gate):

Every catalog preset is a `PresetSpec` (src/lib/catalog/presets/schema.ts):
mechanism, inputs, tier, verifier. `scripts/preset-verify.ts` statically
checks every spec (endpoint+graph exist, inputs reach declared params,
open license for anything visible, mechanism payload resolves onto real
job params) and, with `--write`, runs real jobs per seed and writes
`tests/fixtures/preset-verify.json` - the gate every picker, page and
/api/jobs reads. A preset with no `verified` record at the current
mechanism hash is invisible and unsubmittable.

```sh
npx tsx scripts/preset-verify.ts --dry            # static audit, no GPU
npx tsx scripts/preset-verify.ts --list           # queue + coverage
npx tsx scripts/preset-verify.ts --queue          # writes /tmp/of-verify/queue-ws4.json (priority + est_minutes)
npx tsx scripts/preset-verify.ts --e2e-fixture    # regenerate the e2e verify fixture (computed hashes)
~/.motionfield/gpu-run ws4-preset-verify -- \
  npx tsx scripts/preset-verify.ts --id comic-panel,marble-gold --seeds 2 --write
```

Fixtures are real Z-Image-Turbo renders (8 steps, ≤640px - portrait/
product/street) committed under `tests/fixtures/verify/`; clip-2s.mp4 is
rebuilt from them (480×320, 17f @ 8fps, ~66 KB). Under `GENERATION_PROVIDER=mock`
a `--write` run records plumbing outcomes only - never `verified`, never the
judge. Checkers: `golden` fails closed until a baseline hash is implemented.

| Run | Specs | Result | Notes |
|---|---|---|---|
| ws4 s3b session (2026-10-22) | comic-panel, marble-gold - vace-restyle, clip-2s.mp4 (8fps, 17f, <2MB), 480p, steps 4, seeds 1000/1001 | ✗ timed out on this box | jobs submitted + executed on real ComfyUI through createJob+tickJob (queue confirmed running); Wan VACE restyle at 8 steps needs ~20-25 min/prompt here (ComfyUI log shows completed prompts at 21-25 min) - 4-step runs still exceed the 2400 s cap under swap pressure. `preset-verify.json` records land as honest `failed`; both presets stay hidden until a verified record lands. Re-run on a freer box via the command above. |

2026-10-21 additions (lip-sync):

| Workflow | Model | Smoke params | Result | Wall time | Notes |
|---|---|---|---|---|---|
| `lipsync-video.json` | MuseTalk (MIT) | 2 s 480p zoompan of `tests/fixtures/verify/portrait.png` @ 25 fps + 2.9 s Kokoro line (`af_heart`) via `--video --audio` | ✅ pass | 90 s warm | Re-run 2026-10-23 under `gpu-run ws4-lipsync`: output 2.92 s 854×480 h264+aac @ **25 fps - read off `VHS_VideoInfoSource` (source rate; the fps param/select is gone)**, video/audio durations within one frame (73 f vs 2.901 s audio). That run's live pack carried the previous patch WITHOUT the mask-resample hunk - `grep "resampling masks" ~/comfy/ComfyUI/custom_nodes/ComfyUI-MuseTalk/nodes.py` → **absent** (re-checked 2026-10-23); the resample only lands once `scripts/patches/comfyui-musetalk-mps.patch` is reapplied (`setup-musetalk.sh --reset`), so rerun this smoke before relying on it. Mask loader now scales the SHORT side to 512 - `custom_height` landscape / `custom_width` portrait, chosen server-side via ffprobe (`providers.comfy.map`) - so `OF_MouthMask` never decodes 1080p portrait into ~22 GB. **portrait-b rerun 2026-10-23** (`comfy-smoke.ts lipsync-video.json --video portrait-clip.mp4 --audio kokoro-line.flac`): 540×960 portrait input → 93 s warm, output 540×960 @ 25 fps h264+aac, 2.92 s - the `Custom Width` mask path ran clean on live VHS (which now ignores `force_size`; `custom_width=512` does the short-side cap itself). Evidence under `/tmp/of-evidence/ws4-s5/` + older landscape run under `/tmp/of-evidence/ws4-s4/` - ffprobe JSON, 3 output frames, mask overlay on the input frame. chaojie pack (MIT), patched for M1 (`scripts/patches/comfyui-musetalk-mps.patch`, applied by `setup-musetalk.sh [--reset]`): MPS devices, `torch.load(map_location, weights_only=False)`, lazy weight load, `AUDIO` tensor input, DWPose landmarks **and** face bbox via the vendored Apache-2.0 `musetalk/utils/dwpose_onnx/` (weights staged under `models/diffusers/TMElyralab/MuseTalk/dwpose/`) - S3FD removed, upstream face segmenter removed; the blend region is `OF_MouthMask` (mouth contour + lower-jaw hull from the same landmarks), and once the patch is on, a mask/frame-count disagreement resamples the mask stream instead of drifting. |
| `lipsync-talk.json` | Kokoro-82M + Wan VACE 1.3B + MuseTalk | portrait PNG + typed line, voice af_heart, 4 steps @16fps | ✅ pass | 419 s | One-job text→speech→talking portrait - re-verified with the new default **Wan 2.1 VACE 1.3B** first-frame i2v motion stage (Apache-2.0): portrait → `WanVaceToVideo` control+reference → VHS → `MuseTalkRun` → 4.75 s h264+aac mp4 with audio muxed. `lipsync-talk-ltx.json` keeps the LTX-Video 0.9.5 (Open RAIL-M, use-restricted) motion stage as an explicit opt-in endpoint. |
| `lipsync-talking-portrait.json` | Wan VACE 1.3B + MuseTalk | portrait PNG + wav, 17 f @16 fps | - (same graph as lipsync-talk minus TTS - not re-run) | - | Two-stage graph: Wan VACE first-frame i2v clip (subtle motion) → VHS combine → `VHS_FILENAMES_STRING_MuseTalk` → `MuseTalkRun` → final combine muxed with the audio. The source clip cycles when the audio runs longer. Mid-clip suppressed from outputs via `_meta.drop_outputs`. `lipsync-talking-portrait-ltx.json` is the LTX opt-in variant. |
| `lipsync-*-ltx.json` | LTX-Video 0.9.5 + MuseTalk | - | ⚠️ not run | - | Open RAIL-M, use-restricted - opt-in only, never a default. Graphs preserved from the pre-swap LTX versions. |
| `wan-vace-img2video.json` | Wan2.1-VACE-1.3B fp16 (Apache-2.0) | 864×480, 17 f @16 fps, 4 steps, portrait first-frame | ✅ pass | 364 s | Native `WanVaceToVideo` first-frame i2v: keyframe → `control_video` + `reference_image`; `EmptyImage` black/white batch → `ImageToMask` all-mask → `control_masks` (`BatchImagesNode` dotted autogrow inputs). Output 21 f / 1.31 s 864×480 h264 mp4. This is the Explainer + talking-portrait default motion graph. |
| `wan22-ti2v-img2video.json` | Wan2.2-TI2V-5B fp16 (~11 GB, Apache-2.0) | - | ⚠️ not run | - | Native `Wan22ImageToVideoLatent` + `ModelSamplingSD3` (shift 5) + cfg-free i2v. Weights not downloaded - catalog marks it heavy/opt-in. |
| `lipsync-s2v.json` | Wan2.2-S2V-14B fp8 (~16 GB) | - | ⚠️ not run | - | Native `WanSoundImageToVideo` + `AudioEncoderEncode` (ComfyUI 0.41) - weights not on disk; catalog marks it cloud/GPU-recommended. Graph mirrors the official S2V template (ModelSamplingSD3 shift 8, uni_pc/simple, cfg 6, 77-frame chunk). |
| `latentsync.json` | LatentSync-1.5 | - | ⚠️ removed | - | Dropped - the `ComfyUI-LatentSyncWrapper` pack ships no LICENSE file; replaced by the MuseTalk workflows below. |

Earlier 2026-10-21 additions:

| Workflow | Model | Smoke params | Result | Wall time | Notes |
|---|---|---|---|---|---|
| `birefnet-remove-bg.json` | BiRefNet (MIT) | uploaded 640×480 PNG | ✅ pass | 15 s cold / 3 s warm | Native ComfyUI 0.41 nodes - no custom pack. Output is a single RGBA PNG; verified 88% transparent bg / 12% opaque subject on a synthetic test image. |
| `zimage-txt2img.json` | Z-Image-Turbo int8_convrot | 480×480, 8 steps | ✅ pass | 96 s cold | First pass: model load + 8 steps in ~96 s - dramatically lighter than schnell. `res_multistep`/`simple`, cfg 1, `ConditioningZeroOut` negative, `ModelSamplingAuraFlow` shift 3 (official int8 template shape). |
| `zimage-img2img.json` | Z-Image-Turbo int8_convrot | denoise 0.6, 8 steps, 640×480 PNG upload | ✅ pass | 95 s | `VAEEncode` source + partial denoise; output follows source dims. Also verified the SDK asset upload path again. |
| `kokoro-tts.json` | Kokoro-82M ONNX (Apache-2.0) | 74-char text, voice `af_heart`, speed 1 | ✅ pass | 5 s | comfyui-kokoro pack (Apache-2.0): `KokoroSpeaker` → `KokoroGenerator` → native `SaveAudio`. Model (310 MB) + 54 voices (27 MB) auto-fetched by the pack on first run. Output: 3.52 s FLAC @ 24 kHz, 106 KB - verified non-empty + sane duration via ffprobe. |
| `chatterbox-voice-clone.json` | Chatterbox `resembleai_default_voice` (MIT) | 36-char text, 2.9 s FLAC reference uploaded via `--audio` | ✅ pass | 23 s warm | Re-smoked 2026-10-23 (`gpu-run ws4-chatterbox`) on the current graph - `LoadAudio` → `ChatterboxTTS` (`audio_prompt`) → `SaveAudio`, no extra audio stages. `use_watermark: true` still rides every clone - the inaudible Perth mark needs `resemble-perth` in the ComfyUI venv (`scripts/setup-voice.sh`, MIT); not installed on this box yet, so the shipped copy says "watermarked when resemble-perth is installed". Two FLAC outputs @ 24 kHz. (Cold time still ~693 s once - the 2.7 GB pack download.) |
| `vace-character-swap.json` | Wan2.1-VACE-1.3B fp16 + OF_DWPose | 480×480, 17 f, 6 steps, person clip + portrait ref | ✅ pass | 232 s | Pose-driven swap: bundled `OF_DWPose` pose render → `control_video`, ref → `reference_image`. Output 17 f mp4 - the ref character walks the source's motion; `TrimVideoLatent` strips the prepended ref latent (no ref-frame flash). |
| `character-vace-image.json` | Wan2.1-VACE-1.3B fp16 | 480×480 (1:1), 12 steps, batch 2, square portrait ref | ✅ pass | 165 s | Single-frame VACE (`length: 1`) + ref conditioning → 2 distinct shots of the same character in a new scene (golden-hour café, linen shirt): silver pixie + face shape hold across both outputs. Prior run at 3:4 with the same ref stitched twice compressed the composite 2:1 and diluted identity - keep ref aspect ≈ output aspect; multi-ref stitch is best-effort. First run also exercised the optional `REF_IMAGE_2` loader + `ImageStitch` branch. |
| `wan-animate-character-swap.json` | Wan2.2-Animate 14B int8 (~15 GB) | - | ⚠️ not run | - | Native `WanAnimateToVideo` path (pose+face video, bg preservation, optional mask). Weights not on disk - catalog marks it cloud-recommended. |
| `qwen-character-edit.json` | Qwen-Image-Edit-2511 fp8 (~29 GB) | - | ⚠️ not run | - | Multi-ref character via `TextEncodeQwenImageEditPlus` (image1/2/3). Over the 32 GB budget - cloud/GPU. |

2026-10-20:

| Workflow | Model | Smoke params | Result | Wall time | Notes |
|---|---|---|---|---|---|
| `ltx-txt2video.json` | LTX-Video 2B 0.9.5 | 864×480, 17f @16fps, 6 steps | ✅ pass | 90 s | |
| `ltx-img2video.json` | LTX-Video 2B 0.9.5 | 864×480, 17f @16fps, 6 steps, uploaded PNG first-frame | ✅ pass | 60 s | Also verifies SDK asset upload (`/files/…` → `/upload/image`). Fixed two graph bugs: `LTXVImgToVideo.image` was wired to the CLIP loader (now LoadImage) and the node requires `strength` (set 1.0). |
| `ltx-vfx-keyframe.json` | LTX-Video 2B 0.9.5 | 864×480, 17f @16fps, 6 steps, start-frame PNG only | ✅ pass | 81 s | Optional end-keyframe path off: `END_IMAGE`/`END_FRAME` unresolved → end `LTXVAddGuide` + its `LoadImage` drop via `_meta.optional`, consumers rewired to the start guide via `_meta.passthrough`. |
| `ltx-vfx-keyframe.json` | LTX-Video 2B 0.9.5 | 864×480, 17f @16fps, 6 steps, start + end PNG keyframes | ✅ pass | 81 s | Two-keyframe path: both `LTXVAddGuide` nodes live (frame 0 + frame 16), `LTXVCropGuides` strips the 2 appended guide latents pre-decode. |
| `vace-restyle.json` | Wan2.1-VACE-1.3B fp16 + DA3 | 480×480, 17 f, 6 steps, 1 s clip upload, no REF_IMAGE | ✅ pass | 242 s | Depth control comes from the native DA3 chain (`LoadDA3Model` → `DA3Inference` → `DA3Render`). Optional `REF_IMAGE` loader+link dropped when unset. `TrimVideoLatent` (driven by `WanVaceToVideo` output 3) strips the prepended ref latent before `VAEDecode`. Re-verified via the ReCut smoke below. |
| `vace-reframe.json` | Wan2.1-VACE-1.3B fp16 | 480→864×480 outpaint (pad L/R 192px), 17f, 6 steps | ✅ pass | 425 s | `ImagePadForOutpaint` + VACE control mask. Needed `custom_width/height` on `VHS_LoadVideo` (required by current VHS). `TrimVideoLatent` strips the prepended ref latent. |
| `vace-object-swap.json` | Wan2.1-VACE-1.3B fp16 | 480×480, 17f, 6 steps, mask video + ref image upload | ✅ pass | 224 s | `ImageToMask` on the uploaded mask clip; both media uploads go through the SDK asset pipeline. `TrimVideoLatent` strips the prepended ref latent. |
| `vace-motion-transfer.json` | Wan2.1-VACE-1.3B fp16 + OF_DWPose | 480×480, 17 f, 6 steps, driving clip + subject ref upload | ✅ pass | 232 s | `OF_DWPose` renders the driving clip's pose into `control_video`. `TrimVideoLatent` strips the prepended ref latent - 17 f output, no ref-frame flash. |
| ReCut `motionfield/re-edit/v1.0` | recipe → Wan VACE per window | 2.63 s 2-shot 480×480@16 + tone, `flow=restyle`, 480p | ✅ pass | 761 s | `scripts/re-edit-smoke.ts` - server-side scene split (2 shots → 2 windows), ONE recipe job ran both windows through `vace-restyle.json` via `getProvider()` (~350 s each), then `assembleWindows` conformed each output to its exact frame count at the source fps and muxed the soundtrack. Output 42 f @16 fps, 2.625 s, 480×480, video+audio - source-identical container, frames restyled (≈8 dB PSNR vs source). Per-shot regen is one more job on the same chain (`POST /api/re-edit/[id]/shots/[i]`). |
| ReCut `motionfield/re-edit/v1.0` (ws4) | recipe → Wan VACE per window | 3.63 s 3-shot 320×180@24 + tone, `flow=restyle`, `steps=4`, `--regen 0` | ✅ pass | 2928 s + 1755 s regen | `npx tsx scripts/re-edit-smoke.ts <3-shot.mp4> --flow restyle --steps 4 --regen 0` - detect split the clip into 3 shots → 3 windows, one recipe job ran all through `vace-restyle.json` (DA3-rendered depth control), `assembleWindows` conformed each window to its exact frame count and remuxed the original audio. Output `/files/generated/re-edit/05199dd5-…mp4`: 320×180, 24 fps, 3.625 s, video+audio - container identical to source. `--regen 0` re-ran shot 0's window and re-assembled → `/files/generated/re-edit/7711394c-…mp4` (same container). `shot_status` tracked pending→running→completed per shot. The first regen attempt died to a ComfyUI outage mid-run; that retry ran through a one-off eval'd script - the supported path is `scripts/re-edit-smoke.ts --chain <id> --regen 0` (window timeout → chain failed → chain re-claimable → regen completes on the same chain), which is not yet GPU-proven itself. |
| PersonSwap `motionfield/person-swap/v1.0` person (ws4-s5fix + ws4-s5fix2 warm re-run) | recipe → matte preflight + masked Wan VACE window + MuseTalk | 2 s 360×640@24 + AAC tone, mode=person, 1 synthetic Z-Image ref (`portrait-b.png`, committed `tests/fixtures/verify/`), `steps=8`, 480p | ✅ pass | warm: 736 s total - window 617.5 s (≈5.1 min/s), preflight 37 s, ref cut-out 9 s, lip 69.4 s (≈0.6 min/s); cold first run 1048 s total (904 s window ≈7.5 min/s) | `PGLITE_DIR=/tmp/of-person-swap-smoke GENERATION_PROVIDER=comfy npx tsx scripts/person-swap-smoke.ts src.mp4 --mode person --ref portrait-b.png` - warm job `c2bbba03` (ws4-s5fix2; cold job `e9effa6c`). Fixed pipeline: the control video inside the grown/feathered person matte is an `OF_DWPose` render on black (no source pixels in the reactive region - `detect_face=false`); the identity is a BiRefNet cut-out on a white plate via `person-swap-refcut.json`. Output 360×640@24, 2.08 s, video+audio: the person is the ref's identity (black pixie cut, olive jacket - vs source auburn/denim), set preserved; `provider_meta.person-swap` shows `windows:1, gen_box:"256×480", steps:8, lip:"restored"`. Judge (qwen3.5:9b): "same person?" source↔output → **NO**; ref↔output → **YES**. Region PSNR vs source frame: inside person matte 9.5 dB (identity replaced), outside 16.2 dB. `cropdetect`: `crop=360:640:0:0` - no borders (window outputs are cropped back to the source content rect before assembly). Matte + strip evidence kept under `generated/.person-swap/<job>/`. Evidence in `/tmp/of-evidence/ws4-s5fix2/` (+ earlier `/tmp/of-evidence/ws4-s5fix/`). **Source provenance:** `src.mp4` (360×640) and the s5 `person-swap-src.mp4` (854×480) are the same asset - a 2 s @24 fps zoompan built with ffmpeg from a synthetic Z-Image portrait (`portrait.png`, a generated freckled woman in denim - not a real person) with an s4 Kokoro TTS tone line muxed; `portrait-b.png` is a second synthetic Z-Image portrait generated locally during s5fix. No real-person media fed any run. |
| PersonSwap `motionfield/person-swap/v1.0` environment (ws4-s5fix + ws4-s5fix2 cold re-run) | recipe → invert-matte Wan VACE window | same clip, mode=environment, `--no-lip`, 480p; s5fix2 run carried prompt `"neon-lit showroom, dark reflective floor"` | ✅ pass (prompt best-effort) | cold: 787 s total - window 784.4 s incl. one-time model load (≈6.5 min/s cold); warm 233 s total (≈1.9 min/s, s5fix) | Job `a2e12fb9` (cold; warm `5ed912c4`). The grown/feathered person matte is inverted; a mid-gray `EmptyImage` plate composited with the subject frames supplies the control video (source pixels survive only under the person matte). Output: identical person/wardrobe in a new warm neon-red lit interior - the room actually rebuilt. `meta.lip` reports `lip restore skipped: environment mode`. Region PSNR vs source: person region 26.6 dB (preserved >25), background 9.4 dB (rebuilt <15). `cropdetect`: `crop=360:640:0:0` - no borders. Judge asked twice (2 different frames) whether the output shows a "neon-lit showroom with a dark reflective floor" → **NO** both times (the frame is a tight portrait - no floor visible; the UI now labels the field "Direction - best-effort setting prompt"). Evidence in `/tmp/of-evidence/ws4-s5fix2/`. |
| `wan-txt2video.json` | Wan2.1-T2V-1.3B fp16 | 864×480, 17f @16fps, 6 steps | ✅ pass | 317 s | Output switched `SaveAnimatedWEBP` → `VHS_VideoCombine` (real h264 mp4, matches other video workflows). |
| `wan-txt2video.json` (ws4-s6 + ws4-s6fix gallery clip) | Wan2.1-T2V-1.3B fp16 | 9:16 256×480, 65f @16fps, seed 42, prompt "a young woman with short black hair and a red jacket walks toward the camera along a sunny park path…" - s6: **8 steps**; s6fix regen attempts: 25 steps | ⚠️ unverified | s6: 292 s · s6fix: 739 s + 739 s | `public/person-swap/gallery/park-walk-916.mp4` (4.06 s, 482 KB, synthetic person, Apache-2.0, embedded `steps:8, seed:42`). s6fix checked it properly: the 25-step regen (same prompt/seed/dims) produced a corrupt colour-smear clip on **two** deterministic attempts (214 KB, judge 0/2 - rejected, evidence `/tmp/of-evidence/ws4-s6fix/gallery-25b-REJECTED.mp4`); the on-disk 8-step file shows a person-shape but a **featureless face**, also 0/2 on "natural-looking person with a visible face?". `verified:false` now stands in `public/person-swap/gallery/manifest.json` with a recorded `verify` block - verified means a recorded check, not that the file exists. `/api/person-swap/gallery` serves **0** clips until the night batch delivers a clean ≥25-step regen (REQUEST). The POST route still resolves `gallery_id` server-side for any future verified entry. |
| PersonSwap `motionfield/person-swap/v1.0` **Quick** person, 2 windows + xfade (ws4-s6 S1) | recipe → matte preflight + ref cut-out + 2× masked Wan VACE windows + ffmpeg xfade + MuseTalk | 6 s 360×640@24 synthetic portrait zoompan + 440 Hz tone (`/tmp/of-evidence/ws4-s6/in/quick-6s-916.mp4`), `quick:true` → person mode, 1 ref (`portrait-b.png`), `steps=8`, 480p, lip on | ✅ pass | 2467 s total - window0 1066 s, window1 768 s, preflight ~395 s, ref cut ~45 s, assemble ~5 s, lip ~460 s | Job `6fad98f0` via `scripts/person-swap-smoke.ts --quick`. Output 360×640@24, 6.00 s, video+audio - **exact source dims and duration**. New in s6: non-final windows carry an 8-frame tail and `assemblePersonSwap` joins with `xfade`. s6fix re-measure of the join - a 6 s clip splits at 3.0 s so the fade lands on **frames 72-80** (not 120-128 as first reported): mean adjacent-frame diff there 3.9 vs clip median 1.28 = 3.0× (the reviewer's own pass measured ≈5.0 vs 1.51 = 3.3×) - above the ≤1.5× pop criterion either way, but spread evenly across the 8-frame fade with no single-frame pop (max pair 4.3). Window outputs are cropped to the exact pad rect `cutSegment` produced (av_rescale fit + truncated centred pad, yuv444p intermediate); edges re-measured on frames 83-143 (rows/cols 0-1 vs the 4-5 interior band): **top rows read ~10 luma darker (185.6 vs 195.3; reviewer ≈13 vs row 4) and the seam grows toward the tail - last frame 137 vs 189 (reviewer 112 vs 201)**; bottom (41.6 vs 41.7), left (178.0 vs 176.8) and right (137.9 vs 133.6) are clean - the top-edge seam is real - **fixed in ws1-s19 fix 7 (`22a23f8`)**: the window keep-crop now shaves 2 rows off the top of the content rect (`PERSON_SWAP_TOP_INSET`) and `person-swap-person.json` dilates the matte to `expand:12` for the hairline ghosts; GPU re-measure pending. Lip pass trims to source duration and re-muxes the ORIGINAL audio (`meta.lip:"restored"`). Judge (qwen3.5:9b, s6fix): "same person as the photo?" ref↔output → **0/2** - a strict false negative: both output frames visibly carry the ref's identity (black pixie + olive jacket; v2 also shows the hair-outline leakage addressed by the same fix). `provider_meta.person-swap`: `windows:2, gen_box:"256×480", steps:8, window_wall_s:[1066,768]`. Evidence (cov strips 0.65-0.70 person / 0.02 face, mattes, frames) under `generated/.person-swap/6fad98f0-…/` → `/tmp/of-evidence/ws4-s6/s1/`. |
| PersonSwap environment A/B on one clip (ws4-s6 S2+S3) | recipe → matte preflight + invert-matte Wan VACE window | same 2 s 360×640 portrait clip (`/tmp/of-evidence/ws4-s6/in/env-2s.mp4`), mode=environment, NO identity refs, `--no-lip`, 480p, `steps=8` | ✅ pass ×2 | A `"snowy pine forest, daylight"` job `169e1f8a`: 693 s - window 642.5 s · B `"neon city street at night"` job `b1cea646`: 697 s - window 542.3 s | Both jobs ran the **s6 env gate**: the preflight coverage strip (person ~0.65/frame) is now checked BEFORE the env window - env mode refuses a personless clip instead of burning a window. A output: identical auburn/denim performer against a stylized pine-treeline background; B output: same performer against red/green neon signage - the prompts landed directionally and the invert-matte preserved the person. Judge (qwen3.5:9b, s6fix, "output matches its own prompt?", 2 frames each): A `"snowy pine forest, daylight"` → **0/2** (frames show stylized pines but no snow - "snowy" didn't land); B `"neon city street at night"` → **0/2** (neon signage is there; the judge read it as not a street - borderline miss). Neither prompt passes 2/2, so the field stays labelled best-effort. `meta.lip` both `"lip restore skipped: environment mode"`; evidence `cov-env-w0.png` + `matte-env-w0.png` under `generated/.person-swap/<job>/` → `/tmp/of-evidence/ws4-s6/s2|s3/`. |
| PersonSwap environment refuse - no person (ws4-s6 S4) | recipe → matte preflight only | abstract 2 s 640×360 `gradients` colour field + tone (`/tmp/of-evidence/ws4-s6/in/noperson-2s.mp4`), mode=environment, `--no-lip` | ✅ refused before VACE | 42 s preflight → job failed at 10% | Job `b44caa5a`: the preflight strip read `[0.00, 0.07, 0.00, 0.00]` - a 7% hallucinated blob on 1 of 4 segments. The gate is **mean coverage ≥3%** (a max() gate passed this exact clip - the s6 change switched it): mean 1.75% → `environment mode keeps the performer - no person found on the coverage strip (mean matte coverage 1.8% < 3.0%)` before any VACE window. `cov-preflight.png` + `matte-preflight.png` stay as the evidence trail → `/tmp/of-evidence/ws4-s6/s4-refused/`; log `/tmp/of-evidence/ws4-s6/s4d-noperson.log`. An earlier attempt ran the clip through the OLD max gate (job `73df50b7`, cancelled) - its strip is kept at `/tmp/of-evidence/ws4-s6/s4-attempt1/`. |
| PersonSwap person **draft** on 480×832@16 clip (ws4-person-swap S1, two attempts) | recipe → matte preflight + ref cut-out + 1× masked Wan VACE window (window 0 only, `draft:true`, steps 4, no lip) | 5.56 s 480×832@16 synthetic portrait clip (89 f) + tone, mode=person, 1 ref (`person-a.png`), `--draft`, 480p | ❌ stalled ×2 - same point | attempt `a765507b`: killed by 10-min stall guard at 1513 s · attempt `8b7983be`: smoke timeout at ~1100 s | Both attempts ran the new draft path (window 0 only, `PERSON_SWAP_DRAFT_STEPS=4`, lip skipped) and stalled at **72% - after VACE sampling, inside the post-sample `RemoveBackground`(BiRefNet) pass on the 89-frame decoded output** under ~87% memory pressure. Failure was structural, not transient: the post-pass workload (89 f @480×832) was ≈5× the proven ws4-s5fix2 run (50 f @360×640 output). Root-caused to frame-count×pixels, not a hang: progress resumed once (49→72%) before grinding out. Preflight evidence (clean full-body matte, face coverage 0) kept → `/tmp/of-evidence/ws4-person-swap/draft1-*.png`. |
| PersonSwap person **draft** on lightened 384×672@8 clip (ws4-person-swap S2) | same draft path | 5.5 s 384×672@8 remux of the same synthetic portrait (44 f; window 0 = 40 f), mode=person, 1 ref, `--draft`, 480p | ⚠️ job timed out; **output salvaged + judge-passed** | job canceled at 980 s smoke cap (72% at 555 s; post-pass grinding under 5-lane contention); ComfyUI finished the prompt detached at ~13:47 | Job `1adc9df0`: the smoke-level timeout fired at 980 s but the ComfyUI prompt continued and wrote `of_1adc9df0_00008.mp4` - the window-0 gen-box output, **256×480@16, 44 f, 2.75 s**. Salvaged to `/tmp/of-evidence/ws4-person-swap/draft-salvage.mp4` (+ committed frame artifacts). **Judge (qwen3.5:9b): ref↔output "same person?" → YES** (facial features, short dark hairstyle, olive jacket identical); **src↔output → NO** (different people - source identity replaced). Frame strip: ref identity stable across all sampled frames, neutral studio background preserved, no visible seam within the window. Honest framing: the **job row failed** (timeout before crop/assemble/mux) - this is verified ComfyUI prompt output, not a completed person-swap job; it proves the draft pipeline's person pass produces a correct swap at draft steps on the current code. |
| PersonSwap person **draft** - completed job row (ws4-person-swap S3) | draft path incl. crop/assemble/mux tail | 5.46 s 384×672@6 synthetic portrait (33 f; window 0 = 16 f after even split), mode=person, 1 ref, `--draft`, 480p, **with n37 matte erode** | ✅ completed + judged | **job `b79ad2ca`: 1305 s total** - window pass 1188 s under 5-lane contention (preflight ~115 s, 4-step VACE ~450 s @112 s/step, post-pass ~600 s, tail ~90 s) | First **completed** draft job row on the new pipeline: `384×672@6, 2.67 s, 16 f, video+audio` cropped back to source dims, audio remuxed, `meta.draft:true, steps:4, windows:1, coverage person_mean 0.70, face 1%`. Judge (qwen3.5:9b): **ref↔output "same person?" → YES** (identical features, short dark hair, olive jacket); **"halo/outline around hair or shoulders?" → NO** (soft shadows, natural blending) - the n37 3 px matte erode verified on a real frame. Wall time exceeds the ~8-min fast-preview bar under contention - the window pass is the floor (~1100 s post-pass-bound); a sub-8-min draft would need a smaller gen box or fewer output frames than 16. Evidence: `/tmp/of-evidence/ws4-person-swap2/` + committed `tests/artifacts/person-swap-draft-job-*.png`. |
| PersonSwap approve→final attempts (ws4-person-swap S4) | final path: all windows + lip via `--draft-of` on draft `b79ad2ca` | attempt A `cd524811`: same 5.46 s clip → 2 windows; attempt B `09780b5d`: trimmed 2.5 s clip → 1 window (~40 f internal), steps 5 | A ❌ stalled at 722 s · **B ✅ completed 1223 s** | A: window pass stalled at 34 % under contention - a 2-window final ≈ 2400 s can never fit a 25-min slot. B: window pass 1021 s + tail; in-slot | Attempt A proved the sizing limit: window cost is span×16 fps internal frames, so a real 2-window final needs two full passes + lip ≈ 2400 s+. **Attempt B completed the full approve→final job row**: `draft_of` keyed back to `b79ad2ca` (same-seed derivation verified - final matte-w0.png visually identical to the draft's, not byte-equal since mattes are recomputed from each clip's frames), output `384×672@6, 2.5 s, 15 f, video+audio`, windows:1, coverage person_mean 0.697, face 1%. Judge (qwen3.5:9b): ref↔output YES, src↔output NO - but **halo→YES** (soft grey ghost outline) and a persistent eye-band artifact across all 15 frames: generation-side degradation at steps 5 (draft steps-4 was clean; mattes identical, composite geometry unchanged - defect is inside the person region). Lip restore attempted, **failed** `MuseTalkRun: Expected size 672 but got size 640` - root-caused to `lipsyncMaskPlaceholders` emitting 512-wide masks vs native video frames; fixed to native dims (unverified, no GPU re-run). 1 window → no inter-window join exists; ≤1.5× join criterion stays unmeasured. Evidence: `/tmp/of-evidence/ws4-person-swap2/final/` + `tests/artifacts/person-swap-final-job-*`. |
| `schnell-txt2img.json` | FLUX.1-schnell fp8 | - | 🗑 removed | - | Removed in ws4-s7: never completed a run on this box (22.7 GB resident, ~215-285 s/step at 480p under swap - reached step 3/4 at ~14 min before cancel). Replaced by the klein stack below; the endpoint ids no longer resolve. Weights sit on disk until the owner deletes `flux1-schnell-fp8.safetensors` (11 GB) to make room for klein. |
| `schnell-img2img.json` | FLUX.1-schnell fp8 | - | 🗑 removed | - | Deleted with the rest of the schnell stack - superseded by `klein-edit.json`. |
| `schnell-inpaint.json` | FLUX.1-schnell fp8 | - | 🗑 removed | - | Deleted - superseded by `klein-inpaint.json` (masked edit + object removal). |

2026-10-24 additions (ws4 s7 - FLUX.2 klein 4B, the Mac edit default):

Native ComfyUI 0.41 FLUX.2 klein 4B distilled stack (Apache-2.0):
`UNETLoader` + `CLIPLoader` (`flux2` type → Qwen3-4B fp8 encoder) + `flux2-vae`
+ `ReferenceMultiLatent` (the edit target rides `images.image0`; up to 3 optional
extra refs on `image1..3`) + `Flux2Scheduler`/`KSamplerSelect`(euler)/
`CFGGuider`(cfg 1)/`SamplerCustomAdvanced` - the official klein template shape.

**Graphs pin `flux-2-klein-4b.safetensors`** (7.75 GB distilled bf16 -
`Comfy-Org/Flux-2-Klein-4B` → `split_files/diffusion_models/`, upstream
`black-forest-labs/FLUX.2-klein-4B`, Apache-2.0). The official file is not
downloaded yet, so the smokes below ran through
`COMFY_MODEL_MAP='{"flux-2-klein-4b.safetensors":"flux-2-klein-4b-bf16.safetensors"}'`
→ the local `flux-2-klein-4b-bf16.safetensors`, an offline dequantization of the
official `black-forest-labs/FLUX.2-klein-4b-fp8` download (same distilled
checkpoint, same tensor layout - the fp8 file itself cannot run here: torch
2.14.1 MPS cannot materialise `float8_e4m3fn`).

Smoked 2026-10-24 (ws4-s7fix) through the real provider path + `nodes-sync`
pack (OF_BoxPlace live, incl. its new `product_mask` output). Inpaint and
compose now return the source's own size - the model input is lanczos-scaled
to ~1 MP, the decode lanczos-scaled back and composited onto the original
upload. Judge reads are honest:

| Workflow | Model | Smoke params | Result | Wall time | Notes |
|---|---|---|---|---|---|
| `klein-edit.json` | FLUX.2-klein-4B bf16 + Qwen3-4B fp8 + flux2-vae | 352×480 portrait-b + "make the jacket bright red", 4 steps | ✅ pass | 183 s | B1 instruction edit. Judge: jacket is clearly red ✓, same person/face/haircut/composition ✓ (mild skin smoothing only). |
| `klein-inpaint.json` | same | 640×480 street + brushed mask, mode=remove, 4 steps | ✅ pass | 191 s | B2 native-res: output **640×480 = the source's own size**; grown+feathered mask composites the rescaled decode onto the ORIGINAL upload - **outside-mask PSNR vs the original = inf dB** (mask grown 61px for the measure). Judge: suitcase gone ✓. (s7 also showed: klein can keep a large salient object - a cyclist at 8.8% of frame was not removed at 4 steps.) |
| `klein-product-compose.json` | same + BiRefNet | street + product PNG + bbox (0.555,0.740,0.125,0.204), 4 steps | ✅ pass | 301 s | B17 native-res scene path: `OF_BoxPlace` pastes the BiRefNet cutout on the ORIGINAL scene (contain-fit, centred); the decode is rescaled to scene size and composited inside the grown box, then the placed composite is pasted back inside the new `product_mask` (placed alpha, eroded ~2px + blur) - **product pixels kept verbatim: PSNR vs placed composite inside the eroded matte = 42.5 dB (≥0.9) / 51.6 dB (≥0.99)**; the <0.9 ring is the intended klein edge-blend/shadow. Judge: same black headphones ✓, sits plausibly on the pavement ✓. |
| `klein-product-scene.json` | same | product PNG + scene prompt, 480×480, **steps omitted** | ✅ pass | 224 s | B17 no-plate path: product photo rides `images.image0`; **no steps supplied → executed `steps: 4`** (ComfyUI history) - the catalog map's `p.steps ?? 4` landed instead of the generic 30. klein generated the scene around the upload - same headphone design. (s7's identical-graph 4-step baseline: 122 s on a quieter box.) |
| `klein-txt2img.json` | FLUX.2-klein-4B bf16 | 480×480, 4 steps, seed 7 | ✅ pass | 38 s | Extra local t2i beside Z-Image-Turbo (which stays the default - klein is weaker at pure t2i). Espresso-cup prompt produced a clean lit product shot. |
| `klein-faceswap.json` (ws4-s7b) | FLUX.2-klein-4B bf16 + BiRefNet + DWPose | 352×480 portrait source + portrait-b identity ref, consent ✓, seed 42 - two runs at steps 4 / 6 (jobs `dea77dc4`, `3b1f606d`) | ⚠️ pipeline pass / quality fail | 303 s + 430 s | Consented photo face swap via `COMFY_MODEL_MAP` → bf16 dequant. Chain works end-to-end: `OF_FaceMask` (DWPose 68-pt hull + forehead strip, clipped to the BiRefNet person matte) produced a clean face-region mask (evidence `faceswap-mask.png`); the region decode lanczos-returns to source size and `ImageCompositeMasked` keeps all non-face pixels; `OF_ProvTag` writes the output PNG with a tEXt `prov` receipt (`{"feature":"photo-face-swap","seed":42,"model":"flux2-klein-4b"}`) + `XML:com.adobe.xmp` packet - both verified in the saved file. **Judge: identity transplant 0/2** - at 4 and 6 steps klein-4B fills the masked region with a reinterpretation (a double-exposure scene inside the head silhouette carrying the ref's styling), not a pixel-level face transplant. Mask/region/consent/prov are correct; the local 4B edit stack does not transfer identity at this size. The app stays verification-gated; the honest fix is a dedicated identity adapter (not on this box). Two earlier submits exposed and fixed real plumbing bugs: `OF_ProvTag` wasn't in `comfy.ts` `OUTPUT_CLASSES` so `prune()` cut its whole chain (jobs "succeeded" with only the mask), and the node's own counter collided with the sibling `SaveImage` filename - tagged files now write `<prefix>-prov_NNNNN_.png`. Evidence `/tmp/of-evidence/ws4-s7/`. |
| `vace-object-swap.json` - frame-0 pick + track (ws4-s5b) | Wan2.1-VACE-1.3B fp16 + BiRefNet | 2 s 640×480@25 café zoompan + 440 Hz tone (`/tmp/of-evidence/ws4-object/obj-src.mp4`), box over the cyclist (x 108-283, y 225-432) → `pick.png`; ref `product.png`, prompt "black over-ear headphones on the street", seed 42, steps 6 | ⚠️ track pass / swap partial | 712 s | Job `354e4887`. `OF_MaskTrack` clipped each frame's BiRefNet matte to the blob overlapping the frame-0 pick - the tracked matte frame is a clean cyclist+bike silhouette (evidence `matte-frame.png`), and the 17×1 per-frame coverage strip rode alongside (`coverage-strip.png`). Output 864×480, 1.06 s, video+audio (aac passthrough ✓): the café scene survives and the tracked region regenerated - but at 6 steps VACE produced a morphed figure rather than the ref object, so content swap is partial (same local-fidelity ceiling as the faceswap). Track mechanics + refusal contract (`min_coverage` 0.01) verified; swap quality is honest-best-effort at this model size. |
| `wan-img2video.json` | Wan2.1-I2V-14B fp16 (~28 GB) | - | ⚠️ not run | - | Over the 32 GB budget - marked `heavy` in the catalog (Comfy Cloud / GPU). |
| `qwenedit2511-edit.json` | Qwen-Image-Edit-2511 fp8 (~29 GB) | - | ⚠️ not run | - | Over the 32 GB budget - marked `heavy` in the catalog. |

Evidence: `/tmp/of-evidence/ws4-s7fix/` - inputs, outputs, `judge-inpaint.py`
+ `judge-compose.py` (replays the graph's own BiRefNet → place_overlay →
erode/blur math so the comparison region is the real product matte), and
`RESULTS.md` with every number. Earlier all-five-lanes run:
`/tmp/of-evidence/ws4-s7/`. `comfy-smoke.ts` accepts any workflow file - e.g.
`npx tsx scripts/comfy-smoke.ts klein-inpaint.json --image in.png --mask m.png "…"`.
Requires `flux-2-klein-4b.safetensors` + `flux2-vae.safetensors` on disk and
the `motionfield_nodes` pack re-synced (`OF_BoxPlace`).

2026-10-24 additions (ws3 s10 - the VFX Lab `/visual-effects`; s11 honesty pass
on 2026-10-24):

Eight workflows back the lab: plate + image passes on LTX-Video
(`vfx-ltx-plate*` / `vfx-ltx-image*` - distilled-0.9.8 graph pair gated on
the exact checkpoint file, classic-0.9.5 pair as the always-available
engine) plus a Wan VACE 1.3B structure-control alternative
(`vfx-wan-alt-{depth,pose,edges,image}` - the Apache-2.0 path). All eight
lint clean against the live `/object_info` (`scripts/runpod/validate.ts
--lint`). Driver: `scripts/vfx-verify.ts` - stages the owned fixture
upload, stamps the probe-derived dims/frames/fps/duration itself, runs the
real job through `createJob` + the comfy provider, sha256-hashes the
output, and writes the preset's verification record to
`tests/fixtures/vfx-verify.json` - `--write` is the only path that flips a
preset to "verified" on the page.

s11 - a completed run is not automatically `verified`: before stamping,
`effectDiff` (`src/lib/catalog/video/vfx-diff.ts`) samples ~6 mid-span
output frames (past the pinned HOLD head, before the pinned tail; ~9
frames skipped on still plates) and diffs each against the plate at the
same timestamps on a 64×36 luma plane. Mean |Δ| under `EFFECT_DIFF_MIN`
(12/255) stamps `weak` - which `vfxPresetVerified` never accepts, and
neither does it accept a pre-metric stamp. The record carries
`effect_diff` (mean/min/sampled frames/per-frame); the side-sheet shows
the sampled span over the plate at the same times. Manual probes:
`--lock`, `--steps`, `--image`, `--structure`, `--sheet` (rebuilds the
evidence strip from a recorded artifact, no GPU).

| Workflow | Model | Smoke params | Result | Wall time | Notes |
|---|---|---|---|---|---|
| `vfx-ltx-plate-classic.json` | LTX-Video 2B 0.9.5 + t5xxl fp8 | 480×320 plate (2 s source), 49 f, 8 steps, preset `vfx-frostbite` lock strong / hold 9 | ✅ pass Δ15.3 | 85 s warm | s11 re-verified - street section unmistakably frozen (icicles, snow, frosted trees). |
| `vfx-ltx-plate-classic.json` | LTX-Video 2B 0.9.5 + t5xxl fp8 | same plate, `vfx-molten` lock strong / hold 9, 8 steps | ✅ pass Δ16.26 | 55 s | Building runs molten-orange on the street section. |
| `vfx-ltx-plate-classic.json` | LTX-Video 2B 0.9.5 + t5xxl fp8 | same plate, `vfx-ashfall` lock strong / hold 9, 8 steps | ✅ pass Δ15.4 | 58 s | Grey ash blanket on the street section. |
| `vfx-ltx-plate-classic.json` | LTX-Video 2B 0.9.5 + t5xxl fp8 | same plate, `vfx-frostbite` lock full, 4 steps | ✅ Δ77.43 | 70 s | s11 proof - denoise 1.0 re-noises hard off the plate: SplitSigmasDenoise → SamplerCustom `add_noise` wiring sound; s10 weakness was lock+prompt, not the graph. |
| `vfx-ltx-plate-classic.json` | LTX-Video 2B 0.9.5 + t5xxl fp8 | s10 rows (frostbite/molten/ashfall, medium·strong·medium locks, 4 steps) | ⚠️ weak | 525/378/33 s | s10 "pass" was cosmetic - Δ5.4-5.5 vs plate (re-render, no effect). Kept for the record; the s11 gate stamps these `weak`. |
| `vfx-ltx-image-classic.json` | LTX-Video 2B 0.9.5 + t5xxl fp8 | 640×480 still → 65 f @24, 4 steps, `vfx-frostbite` | ⚠️ weak | 158 s | Still → clip path works mechanically, but the s10 output Δ7.4 vs the still = cosmetic. Record superseded by the plate run. |
| `vfx-ltx-plate.json` | `ltxv-2b-0.9.8-distilled.safetensors` | - | ⚠️ not run | - | Checkpoint not on this Mac - the `ltx098` engine stays hidden (`ltx098Installed()` = name+size pin) and submits 400 until the exact file lands. |
| `vfx-ltx-image.json` | `ltxv-2b-0.9.8-distilled.safetensors` | - | ⚠️ not run | - | Same checkpoint gate as the plate pair. |
| `vfx-wan-alt-depth.json` | Wan VACE 1.3B fp16 + DA3 mono | 480×320 plate, depth control, 33 f preview @16 fps | ✅ pass Δ93.55 | 266 s | `depth` structure - DA3 → WanVaceToVideo control; `vfx-overgrowth` re-verified s11 (`ba90d01e…`, deterministic-seed twin of s10's `0ea03a3f…`) - greenery visibly claiming the plate, some grid shimmer in dark regions. |
| `vfx-wan-alt-pose.json` | Wan VACE 1.3B + OF_DWPose | 480×320 plate, pose control, 33 f preview @16 fps | ⚠️ weak-by-eye | 347 s | `pose` structure - the output's green/magenta is DWPose skeleton + grid bleed, not foliage: completes but not the named effect. `vfx-overgrowth` now pins `alt_structure: depth`. |
| `vfx-wan-alt-edges.json` | Wan VACE 1.3B | plate, edge control | ⚠️ not run | - | `edges` structure - Canny control video; lint clean, not GPU-run tonight. |
| `vfx-wan-alt-image.json` | Wan VACE 1.3B | still, first-frame reference | ⚠️ not run | - | `image` structure - reference-image i2v; lint clean, not GPU-run tonight. |

## Provider path verified

- **Media upload**: user files under `public/files/` are read by the provider
  and uploaded through the SDK asset pipeline (`POST /api/v2/assets` → ComfyUI
  `/upload/image`), then bound into loader nodes as `core/ASSET` refs resolved
  by the proxy. Verified with image (`ltx-img2video`, `upscale-4x`), video
  (`vace-*`), mask video (`vace-object-swap`), ref image inputs, and audio
  (`chatterbox-voice-clone` - uploaded wav → `LoadAudio.audio`).
- **Audio outputs**: `SaveAudio` results come back through `job.outputs` as
  `audio/*` items (flac), are saved under `public/files/generated/`, stored as
  `kind: "audio"` assets, and play inline (`<audio>`) in Studio, job detail,
  and history.
- **Progress**: `poll()` reports real percent from the job's SSE `progress`
  frames (per-node step/steps preferred, node-weighted fallback). Verified
  through the app's own job path: `POST /api/jobs` → `GET /api/jobs/{id}`
  advanced `progress` 0 → 75 → 88 → 99 → completed.

## Assistant (Ollama)

End-to-end through the real chat path: `POST /api/agent/sessions` →
`POST .../messages` (the planner turn runs inline) → poll
`GET .../messages?after=N` for live jobs, progress, and results.

Current setup - not re-run:

```sh
LLM_PROVIDER=ollama LLM_MODEL=qwen3.5:9b npm run dev   # native Ollama API
npx tsx scripts/assistant-smoke.ts [--only a|b|c] [--timeout 900]
```

(`LLM_BASE_URL=http://localhost:11434/v1 LLM_API_KEY=ollama` also works.)

Results below recorded with **qwen3:8b via `/v1`** (OpenAI-compatible chat):

| Brief | Planner | Endpoints | Result | Wall time | Output |
|---|---|---|---|---|---|
| A · "make a short cinematic video of a lighthouse at dusk" | qwen3 tool calls (22-24 s) | `motionfield/ltx-video/text-to-video` (480p, 3s, 25fps, 6 steps) | ✅ pass | 270 s | `/files/generated/4731121d-…mp4` |
| B · "make a short video …, then restyle it with a cartoon shader" | qwen3 timed out (120 s ×2 under memory pressure) → deterministic fallback | `motionfield/ltx-video/text-to-video` → `motionfield/wan-vace/restyle` (`video_url: $prev`) | ⚠️ chain verified, timed out of smoke window | >1500 s* | `27cbf151-…mp4` (3.04 s, valid) |
| C · "animate this image into a short cinematic video" (attached `/files/generated/5cf20964-…png`) | qwen3 tool calls (39 s) | `motionfield/ltx-video/image-to-video` (480p, 3s, 25fps) | ✅ pass | 872 s | `/files/generated/63f92a18-…mp4` |

\* Run under severe memory pressure (a 23 GB FLUX weight-set left ~100 MB free;
the same LTX job ran in 90 s when the box was fresh). B's chain was exercised
end to end: restyle deferred → drained on t2v completion → `video_url` filled
from the finished job → completed with a valid 3.04 s mp4. It simply exceeded
the 1500 s script budget before the final status settled.

> **WS2 brain pass (2026-10-22, unrun)**: default endpoints changed. The
> deterministic planner, Canvas node map, Assistant fallback plan, and
> skill steps now default to open-license endpoints - `motionfield/wan-2.1/*`
> and `motionfield/wan-vace/image-to-video` - and LTX is an explicit opt-in.
> Rows A-C below were recorded before the change (endpoints named `ltx-*`).
> Agent LLM routing is per-user (`llmConfigured(userId)`), sessions carry
> `mode: "auto" | "offline"` (offline refuses remote LLM routes), and session
> interrupt releases a local Ollama planner model (`keep_alive: 0`).
>
> **Step 3 surface (unrun):** Settings → Models & LLMs edits the same routes
> (`llm_provider_settings` + `llm_task_routes` over `LLM_*` env fallbacks),
> the Offline toggle persists per user (`llm_user_prefs`; `MOTIONFIELD_OFFLINE=1`
> locks it on), and subscription CLIs (claude/codex) are opt-in text-only
> providers - never planner, refused offline + hosted. Live CLI check:
> `LLM_CLI_LIVE=1 npx vitest run tests/smoke/ws2-cli-live.test.ts` (needs a
> logged-in `claude` or `codex` on PATH - personal machines only).
>
> **Step 7 surface (s12 - agent tools v2):** `GET /api/agent/tools` exposes
> the mode-filtered tool list - one catalog tool per live endpoint (schema
> derived from the workflow's declared params, enum values narrowed to
> `specVisible()`-verified presets) plus the `agent/*` builtins
> (web_fetch/web_search/notes/ask_user/todo/catalog_search/refs_list,
> memory_save/memory_forget, and a registered-but-`not_available`
> schedule_create). Builtin steps run job-less inside a run: 0 credits, a
> `/files/runs/` text|json leaf, ETA unknown. Request-path ticks execute at
> most one builtin per tick (the worker sweep chains through them).
> `web_fetch` is a guarded HTTP(S) GET - every redirect hop re-checks the
> target, link-local/metadata ranges always refuse, private ranges refuse
> when hosted, Offline requires loopback, caps are 3 hops / 10 s / 2 MB /
> text content-types, and fetched text lands in runs wrapped as untrusted
> data. `web_search` exists only while the caller's `searxng_url` pref is set
> (Settings → Models & LLMs; Offline demands loopback, hosted demands an
> SSRF-clean https base). `@ref` names in briefs and literal plan params
> resolve to the caller's own refs - unknown names ask/422, never guess.
> Planner: `scripts/brain-bench.ts [--dry] [--stub] [--limit N] [--builtinOnly]
> [--planner <provider>:<model>[,…]] [--repeat N]` scores ~20 briefs against
> `POST /api/agent/runs` and writes `/tmp/of-brain-bench.json`. `--dry` runs
> the built-in planner (zero LLM); `--stub` runs the full llmPlan path
> against a loopback OpenAI-wire stub; media briefs attach real uploaded
> fixtures, media-less ones must 422. The planner call bounds reply tokens
> explicitly (num_predict - old Ollama defaults to 128 and truncates
> mid-JSON), gates thinking behind `MOTIONFIELD_PLANNER_THINK=1`, repairs
> transposed trailing brackets in near-miss JSON, and auto-materializes a
> `text-to-*` generator step when a planned consumer's required media input
> has no source - two budget-gated correction rounds carry refusals back.
>
> **Step 8 surface (s8 - memory + projects):** named memories persist per
> user under `memories` (`memory_save`/`memory_forget` builtin steps, or the
> `/api/agent/memories` CRUD - duplicate names 409 on the API, the tool
> upserts); `memory_links` binds a memory to owned jobs/assets/refs/
> projects/uploads (cascade delete). A run bound to a project
> (`project_id` on the session or the run POST - ownership 404s everywhere)
> retrieves up to 5 memories into the planner turn, project-bound first,
> wrapped as remembered-DATA - never instructions - plus the project's
> `project_settings.instructions` line. `/api/agent/memories/graph` renders
> the user's memory map (`?project_id=` scopes it); `/projects/[id]` shows
> instructions, project memories + forget, folders, favs, jobs and linked
> uploads - owner-only; a public/foreign viewer gets the project, public
> assets and owner profile only. `/ai-assistant` carries a Memory panel.
>
> **Step 6 surface (s6):** sessions/runs carry `mode: auto | offline | custom`.
> `offline` = loopback-only LLM routes (a remote planner pick is refused
> before any network call and narrated as planner_error), heavy endpoints
> drop out of the picker, and a remote `http(s)` media ref on a step 422s
> before any job exists (loopback URLs and `/files/` refs pass). `custom`
> = every run parks at `awaiting_approval` and each step carries a same-kind
> model picker + effort select (`draft|standard|high` derive the endpoint's
> own resolution/steps/duration knobs); the pick lands through the step-edit
> API and persists as `model_choice`/`effort` provenance. The smoke's turns
> accept `--mode` per turn and the tree print shows mode · via · model
> picks.

Verified behaviors:
- **Run engine (s5/s6)**: run statuses are `planning | awaiting_approval |
  running | paused | done | failed | stopped` - terminal is `{done, failed,
  stopped}` (`stopped` replaces the old "canceled" run status;
  `scripts/assistant-smoke.ts` tracks the same set). `ask_first: true`
  parks new runs at `awaiting_approval` - the smoke auto-approves them -
  and a step edit on a parked/finished run resets it plus its transitive
  descendants (older specs land in `run_step_revisions`) and re-gates on
  the pending-delta estimate. A paused run STAYS paused across an edit
  (the gate never auto-resumes); an edit on a stopped run reopens it and
  resets its non-done ancestors too, so a killed dependency re-runs.
  Edits carry `endpoint_id` (same output kind; required media inputs
  auto-wire to `$step` deps) and `effort` (draft/standard/high); jobs
  submit under a rev-scoped idempotency key (`run-step:<id>:r<rev>`), so a
  re-run is a fresh job, not a replay.
- **LLM planning**: qwen3 emits OpenAI tool calls; `<think>` blocks stripped;
  params arrive as strings ("10s") and are coerced to field types in `createJob`.
- **Endpoint validation**: tool schema lists only live catalog endpoints with
  `workflows/` files; unknown ids get a tool-level error, not a crash.
- **Chaining**: `$prev`/missing media params defer a step behind the running
  job and it drains automatically on completion (`queuedSteps` + `lastOutputs`).
- **LLM failure**: ollama timeout/unreachable → explicit status message
  ("can't reach the LLM at … - is the provider running and the model
  pulled?") → deterministic fallback planner that orders intents by text
  position and still chains a second intent.
- **Interrupt**: `POST .../interrupt` on a live job → provider cancel →
  session `interrupted`, pending jobs cleared.
- **Concurrency**: stale externally-canceled jobs reconcile via `createJob`'s
  live-job tick so the free-plan 1-job gate can't deadlock.

## ws1-s19 behavior-check fixes (2026-10-24, `ws1-surface`)

Code landed for all eight behavior-check rows; fixes 7 and 8 are now both
verified at the measurement level:

- **PersonSwap top-edge seam + hairline ghosts (fix 7, `22a23f8`)** -
  `person-swap-person.json` matte grow `expand 6 → 18`; every window's content
  rect loses 2 rows off the top (`PERSON_SWAP_TOP_INSET`) and is stretched back
  in `person-swap.ts`/`re-edit-ffmpeg.ts`. Per-window `image_urls` re-injection
  was verified to already exist. **Verified 2026-10-25 (job `4fb74e6b`,
  real ComfyUI, `--quick --mode person --lip`)**: window 0's saved matte
  grew to 90.5% coverage vs the 79.3% preflight matte - the wider dilation
  is in the executed graph (`expand` reached the provider as 18 on the
  deployed person workflow). The re-edit `window-0.mp4` (53f @ 256×455)
  averaged across all frames shows **no edge seam**: top rows 0-5 read
  94.8-96.4 luma against a 102 interior band - no dark seam line (the
  pre-fix signature measured ~10-50 luma dips). Top hairline-zone vertical
  gradient energy vs the source clip's same band: **4.09 → 1.99** - half
  the edge shimmer. Window sampling ran clean at 40 s/it ×8 with no
  mid-prompt wedge. The same run surfaced and fixed three infra bugs that
  had been masquerading as recipe stalls: proxy dedup returning stale
  `comfy_ref`s for re-uploaded cuts (fast-path now re-uploads when the
  upstream file is gone), `ImageBlur sigma 16 > max 10` in the merged
  ghost-hair graph (now 10), and VHS's `LazyAudioMap` exploding inside
  ComfyUI's `ram_release` cache walk on streamless mp4s - patched locally
  + `scripts/patches/vhs-streamless-audio.patch`.
- **Stage render exposure (fix 8, `0d3cdb6`)** - the headless
  `/render/stage` renderer now applies `LinearToneMapping` +
  `toneMappingExposure = 1.6` on lit passes (previz/anchor); depth and
  pose passes stay at 1.0 so control maps keep their true ramps.
  **Verified 2026-10-25 (render-level A/B)**: the same seeded scene was
  rendered through `/render/stage` at exposure 1.0 vs 1.6 - mean luma
  48.6 → 60.7 (1.25× in sRGB ≈ a linear 1.6 gain through the sRGB encode;
  the lit faces read visibly brighter, depth/pose paths are untouched at
  1.0). Full VACE-window carry-through is queued in the GPU sweep.

### GPU sweep - final merged-trunk pass (2026-10-25)

All commands run via `npx tsx --env-file=.env scripts/*-smoke.ts` against
local ComfyUI (:8188, via proxy :8189); every "pass" is a real executed
prompt with a real output file, not a submit-only check.

| Workflow | Result | Wall | Evidence |
|---|---|---|---|
| `zimage-txt2img.json` (T2I) | ✅ pass | 551 s | 449 KB PNG `public/files/generated/99170f7c-…png` |
| `klein-txt2img.json` | ✅ pass | 73 s | 453 KB PNG `…/5ffffbd7-…png` - `COMFY_MODEL_MAP` remaps `flux-2-klein-4b.safetensors` → the on-disk `-bf16` dequant |
| `sfx-moss.json` | ✅ pass | 238 s | 469 KB WAV `…/b5cb5a1e-…wav` |
| `music-acestep.json` | ✅ pass (earlier session) | - | real WAV |
| director-smoke (VACE + cam moves) | ✅ pass | 362 s prompt | h264 480×272 2.06 s MP4 `/tmp/of-evidence/media/of_smoke-9e_00001.mp4` + `director-poses-dacf39d9.json` (dolly-in→pan-left keyframes) |
| `vace-object-swap.json` | ✅ pass | 616 s | mp4 `…/40bb3a3a-…mp4` + tracked-matte/coverage PNGs; see note |
| `reshoot-video.json` (`pan-left`, steps=2 - gpu-slot cap) | ✅ pass | 1301 s | h264 832×480 2.04 s AAC `tests/artifacts/reshoot-s9-pan-left.mp4` + strip + first/last & subject-crop pairs; `motion_check` −28.5 px = 152 % of commanded yaw; detail in BENCHMARKS → S9-pan-final |

**Swap required two fixes before the pass.** First run failed validation
- `OF_MaskTrack` was absent from the live node pack: the ComfyUI
`custom_nodes/motionfield_nodes` symlink targets `~/.motionfield/nodes-live`,
a stale copy missing five files (`nodes_mask.py`, `nodes_audio.py`,
`nodes_camera.py`, `nodes_provenance.py`, `core/face.py`,
`core/camera_rig.py`). Re-synced all 23 pack files from
`comfy-nodes/motionfield_nodes/`; node tests (`tests/run.py`, incl. the
three `OF_MaskTrack` cases) pass under the ComfyUI venv. Second run
reached execution and the node did exactly its designed job: the grass
fixture's BiRefNet matte overlapped the centre pick at 0.0% mean
coverage, so `OF_MaskTrack` raised `track lost … under the 1% floor`
instead of regenerating blind - a live re-verification of the refusal
contract. Third run used a proper fixture (`test-face.mp4` + drawn pick
over the person + painted ref): the track held through all frames and
VACE regenerated the region - completed 616 s with the matte-frame and
coverage-strip evidence saved alongside the output.

### s12 - Director rig fix pass (`t3/inspect-keyframe-rig-controls`, 2026-10-25)

The 480×272×33 f Director output that motivated this work (duplicated
lighthouse mid-pan + floating black blobs) was root-caused by a
control-only pass, then re-verified on the fixed rig:

| Command | Result | Wall | Evidence |
|---|---|---|---|
| `cam_smoke.py --save-control` on `director-wan.json` (dolly-in+pan-left, 832×480×49 f, `OF_DirectorRig`) | ✅ pass | ~90 s | `/tmp/of-evidence/dir-rig/` - rgb/holes/control strips; mean hole share peaks 30.7 % mid-move, ends 0.1 % (v1 rig: 36.2 % peak, porous speckle); control frames show coherent grey disocclusion bands, no speckle seeds |
| `cam_smoke.py --save-control` on same keyframe pre-fix (`OF_CameraRig`, 480×272) | ⚠ diagnosed | - | earlier strips: porous scatter + subject-shaped ~60-80 % disocclusion → VACE re-paints subject in the hole (the duplicate) and leaves speck-holes (the blobs) |
| `director-smoke.ts … dolly-in+pan-left, 832×480, 5 steps, 33 f` (full VACE render, mild-DoF + tight band) | ⚠ landed, quality-fail | 902 s | `of_smoke-b9_00001.mp4` 832×480 2.06 s - one lighthouse throughout (no duplicate tower, blur-band mush gone, real dolly-in visible) BUT a transient dark sky-pill floats upper-left ~f13-16 + edge specks → post-mortem: pill is a filled island the mask already marks reactive, i.e. **VACE hallucinated it inside the flat-0.5 reactive sea**; fix = diffuse rim colours through the reactive region + colour-ghost drop (`16795e5`) |

Node-side fix detail lives in `docs/BENCHMARKS.md` §s12. Custom-node
registration verified live: `OF_DirectorRig` present in `/object_info`
after `nodes-sync` + `comfy-restart`; all five director workflows
(`director-wan`, `director-wan-txt`, `director-wan-fun`,
`director-wan-fun-txt`, `cam-i2v-fun`) lint clean against live object
info.

| `director-smoke.ts … dolly-in+pan-left, 832×480, 5 steps, 33 f` (v4: diffused-prior control) | ✅ **pass** | 1076 s | `of_smoke-fb_00001.mp4` 832×480 2.06 s - judge `dir-judge-v4.json`: `duplicates:false, blobs:false, motion:"dolly+pan"`; `motion_check`: dolly grid-patch 2.5×@tower corr 0.747 / pan bg_dx −4.69 px - both pass; strip `/tmp/of-evidence/dir-v4-strip.png`. Honest nits: tower desaturates mid-clip, transient f4 edge ghost, foreground soft |
| `director-smoke.ts … arc-left-45, 832×480, 5 steps, 33 f` | ⚠ motion pass, visual degraded | 1054 s | `of_smoke-03_00001.mp4` - `motion_check arc-left-45`: centre lock 0.875 px, rel_bg −31.2 px vs rig 28.7 px (**109 %**). Strip showed rim-march smear columns in deep edge seas → fixed by masked smoothing of the diffused prior (`fb29bd5`) |
| `director-smoke.ts … pan-left, 832×480, 5 steps, 33 f` (smoothed prior) | ✅ **pass** | 1017 s | `of_smoke-43_00001.mp4` - `motion_check pan-left`: bg_dx **−24.1 px** pass; strip `/tmp/of-evidence/dir-pan-strip.png`: one striped lighthouse, no pills/blobs/dupes, DoF soft foreground |
## platform lane - ComfyUI Apps + MCP + launch (2026-10-25, `t3/implement-platform-task`)

Generated five UI-format **App-mode** workflows from the API graphs
(`scripts/comfy-apps/build.ts`, validated against live `/object_info`
= 1119 classes - every class/widget enumerated; VHS keyed serialization
and `control_after_generate` handled). Real `/prompt` executions of the
generated apps on this Mac (ComfyUI :8188):

| App (generated) | Source graph | Run | Wall | Judge |
|---|---|---|---|---|
| `motionfield-image.app.json` (10 n/10 l/5 inputs) | `zimage-txt2img.json` | ✅ `0e4e2826-4dd3-4cc7-ab2d-dd8e3cf303ce` → `Image_00001_.png` | **128.4 s** | strip `/tmp/of-image-thumb.png` → qwen3.5:9b "lighthouse at dusk image?" **yes** |
| `motionfield-vfx-lab.app.json` (18 n/29 l/6 inputs) | `vfx-ltx-plate-classic.json` | ✅ `a10f6bcc-ca99-49f3-8469-d72f6cbfc7fc` → `VFX_00001-audio.mp4` | **220.6 s** | strip `/tmp/of-vfx-strip.png` → "effect applied to the plate?" **yes** |

Evidence: `tests/artifacts/image-zimage.jpg` (37 KB) ·
`tests/artifacts/vfx-lab-plate.mp4` (169 KB) → README `docs/media/` slots.
`--fetch` downloads verified. `motionfield-director` / `motionfield-reshoot` /
`motionfield-person-swap` apps validate; GPU runs left to their owning lanes.

**MCP live wrappers** - `reshoot`, `vfx_lab`, `re_edit` moved off
`pending` onto endpoints: each calls `POST /api/v1/probe` (bearer-authed,
ownership-checked) first, so frames/fps/dims/`windows` are server-stamped.
SDK gained `client.probe()`. e2e: `platform-mcp.spec.ts` 5/5 (real job
created end-to-end for all three + consent/404/no-token guards),
`platform-launch.spec.ts` 4/4 (`start.sh` wiring, all 23 live nav hrefs
<400, studio pages zero console errors, 401/traversal/path-leak guards).

**One-command start** - `npm run start:local` = migrate + seed (PGlite,
no docker) → build-if-stale → `next start` → prints URL + ComfyUI
guidance. Syntax/migrate/seed verified end-to-end; screenshots script
regenerated all 22 page shots under mock.

## stage lane - /scene-3d blockout → Wan VACE (2026-10-25, `t3/implement-stage-task`)

Jointed OpenPose-BODY_18 mannequin (26 named poses + drag-to-pose +
project-owned offscreen thumbnails), 11 subject-bound camera presets +
bird's-eye layout cam, `apply_move` op baking catalog trajectories into
camera keys (fuzzy names: "push in"→dolly-in), writer drafts accepting
camera moves/keys, ops `dry_run`, structured Scene/Shot/Only VACE prompt,
and a real problems view (below-ground/floating/outside-frustum/
subject-underframed/subject-off-center/duration-over-cap/no-render-camera;
shots lists every camera; physics reports metres-to-floor, the decorative
gravity constant is gone).

Run `stage-smoke` (seed 7): walker `-1.6→1.6` m at z=0, crate at
`[0.9,0.45,-1.6]` off the stride (bbox sweep asserts), render cam
`[0,1.5,5.5]` lookAt→chest + dolly-in. Measured on the seeded scene:
subject fills **56 % → 88 %** of frame height across the 3 s clip
(centre stays inside middle 60 % at 51-49 %/66-75 %), `depthRange`
2.88-20.56 m (2nd-98th pct of content corners' view depth).
Control pass = linear-view-depth shader (near white/far black, γ0.85)
replacing the near-black nonlinear `MeshDepthMaterial` - figure region
mean **73.1** vs far background **0.0** on the mid frame.

Evidence: `tests/artifacts/stage-vace-417bda8b/stage-{previz,control}-strip.png`
(previz: walker crosses, passes IN FRONT of the crate, camera visibly
dollies; control: readable gradient, subject white vs far black) +
`control-mid.png`. VACE window `1/1` submitted at 13:44 under a fresh
FIFO ticket; sampling/decode still mid-flight at this entry - final mp4
+ qwen3.5:9b judgement recorded on completion. Attempts today:
rc 1×2 during a dev-server-down window, one 881 s slot killed by an
external ComfyUI restart, one instant guard crash (own bbox check
counted the ground plane - fixed, sweep skips `shape:"plane"`).

## video finish pass (ux lane r1) - mechanics verified, GPU order-measurement queued

`workflows/video-finish.json` - core LoadVideo → GetVideoComponents →
RealESRGAN_x4plus (4×) → ImageScaleBy 0.5 (net 2×) → FrameInterpolate
rife_v4.26 (2× fps) → CreateVideo + SaveVideo h264, then host ffmpeg
unsharp+grain. runpod --lint vs live object_info: CLEAN (needed
`format.codec`). Job-level post-step: finish:true (catalog default on
finals; draft:true skips) submits the graph as a follow-up provider job,
keeps the raw render as role:"raw"; finish failure still delivers raw.
e2e (mock, port 3209): finish:true → finished+raw outputs, finish:false →
1 output - PASS x2. PENDING: both-orders timing on 3 s 832×480
(/tmp/of-finish-measure/measure.py queued as lane-ux) + qwen judge +
strips - recorded next round; graph order may flip on the numbers.


## 2026-10-27 completion checkpoint: separate audio backend

Real direct-SDK Kokoro speech smoke produced
`public/files/generated/01b75576-b701-4446-b208-792e4af6f1d6.flac`: 70,960 bytes,
2.218667 seconds (file and ffprobe rechecked). Main backend was unreachable
(port 9), audio backend was the local Comfy proxy. This proves real local
audio routing and output retrieval; it was not a complete authenticated app
flow or Fish Drama3 test. No paid GPU was used.

Earlier completion validation: 1178 unit tests passed, eight skipped; four
TypeScript projects and production build passed; ten Canvas/platform/API browser
checks passed. Integration follow-up results are recorded in MODEL_DECISIONS.md
when complete. See that document for remaining models, MCP tools and cloud
approval boundary. Entire-app completion is not asserted.
