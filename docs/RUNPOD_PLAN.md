# MotionField: bounded RunPod setup

Prepared 2026-10-26. No pod or volume has been created by this work.

**Status: base-stack rehearsal plan, not the final model-selection decision.**
The user reaffirmed Qwen 3.8 27B Q4, Fish Drama 3 and LTX 2.5 on 2026-10-26.
Those targets must be reconciled and integrated before provisioning; the
250 GB / $25 calculation below covers only the currently implemented base.
See MODEL_DECISIONS.md. Do not rent a pod from this document as if the three
upgrades were already included.

## Current first-session recommendation

Latest user priority is an economical real demo. Start with the staged plan in
[MODEL_DECISIONS.md](MODEL_DECISIONS.md#economical-demo-priority-latest-user-steering):
`setup-studio.sh --demo --dry-run`, existing workflows, 48 GB GPU, approximately
$2.21 for two GPU/storage hours, or $2.42 with 100 GB network storage retained
for one day (plus 10 GB container disk), and a $5 initial reservation. The demo profile selects 24.80 GB from the manifest and copies
9.16 GB through `scripts/runpod/demo-files.txt` (33.97 GB total); it defers
remote audio/lip-sync installs. Use that list instead of the wider studio
list in the transfer example below. No provisioning is authorized. The A100/250 GB plan below is the
older wider base-stack rehearsal, not the economical default.

First-batch commands to run only after explicit provisioning approval:

```sh
MAX_RUNTIME_SECS=7200 EMPTY_LIMIT_SECS=600 UNREACHABLE_LIMIT_SECS=600 \
  bash scripts/runpod/watchdog.sh > /workspace/motionfield-watchdog.log 2>&1 &
bash scripts/runpod/setup-studio.sh --demo --dry-run
bash scripts/runpod/setup-studio.sh --demo
# Copy demo-files.txt from the Mac using the rsync pattern below, then start.sh.
```

The two-hour limit includes setup; a live setup lock pauses the idle checks,
not the absolute runtime cap. Back up accepted outputs before shutdown, confirm
the pod stopped and inspect actual charges. Storage continues charging until
removed; the proposed one-day retention is not automatic cleanup.

## Wider base-stack setup

- Keep the app, database, uploaded media, Ollama and audio generation on the Mac.
- Run image/video generation on one A100 80 GB pod at **no more than $1.79/hour**.
  The current published Secure Cloud price is $1.79/hour; actual checkout and
  regional availability must be checked before deployment.
- Use a **250 GB standard network volume**, mounted at /workspace. Keep the repo,
  ComfyUI, its venv, models and generated pod outputs there.
- Use a small 20 GB container disk for the OS; do not buy a second pod volume.
- Use the official RunPod PyTorch template with CUDA-compatible PyTorch and
  Python 3.11/3.12. Install git, rsync, curl, ffmpeg, espeak-ng, python3-venv,
  libgl1, libglib2.0-0 and uv if the template does not supply them.
- Use SSH with an existing registered key and tunnel port 8189. Expose no public
  ComfyUI HTTP port. No Comfy Cloud subscription or paid model APIs are needed.

## Models and exact storage

The checked dry run of `bash scripts/runpod/setup-studio.sh --dry-run` selects
19 manifest files, **152,460,335,915 bytes (152.46 GB)**. Selection reads actual
node inputs, not the manifest's speculative used_by tags.

| Capability | Planned models |
|---|---|
| Text/image video | Wan 2.2 A14B I2V and T2V, high/low-noise pairs |
| Character replacement alternative | Wan 2.2 Animate 14B |
| New camera move alternative | Wan 2.1 I2V + Uni3C |
| Image editing and angle variants | Qwen Image Edit 2511 + shared encoder/VAE + angle LoRA |
| Existing Director, scene rendering and swaps | Wan VACE 1.3B + DA3 + Z-Image and shared encoders |
| Existing image edits, VFX and lip sync | Copy the current working Klein bf16, LTX 0.9.5, MuseTalk, BiRefNet, DWPose and finishing files |

The 16 existing files in `scripts/runpod/studio-files.txt` total
**27,660,851,369 bytes**. The two existing Kokoro files add **353,746,785 bytes**.
Combined model footprint: **180,474,934,069 bytes (180.47 GB)**. Allow about
20 GB for software/caches and 20 GB for inputs/outputs; 250 GB leaves about
29.5 GB spare. These are planning allowances, not a remote disk measurement.

Do not download the unconnected LTX-2 19B/Gemma/LoRA/upscaler stack, FlashVSR,
LongCat, tier C, or the 3D model tier for this first verification run. They
remain in the optional full manifest; their presence is not evidence of an
implemented app. LTX 0.9.5 keeps its existing license gate. The selected new
manifest files are Apache-2.0 or MIT; no gated HF model is required.

The Mac's audio models remain useful: Kokoro, Chatterbox, ACE-Step and the
Apple-only MOSS-SoundEffect MLX stack. The installed Ollama model is
qwen3.5:9b. The intended target is qwen3.8:27b-q4_K_M (18 GB), not yet installed. The saved environment names that exact target; the installed 9B model is a fallback.

## Spending limit

Reserve a maximum **$25** from the existing $60 credit; keep at least $35
unspent during this first setup/verification session. Disable auto-pay/recharge
in the account. No new payment is authorized by this document.

| Item | Conservative allowance |
|---|---:|
| Setup/download/install: up to 2 hours at $1.79 | $3.58 |
| Real-output verification: up to 2 hours at $1.79 | $3.58 |
| 250 GB network volume for a full 30 days | $17.50 |
| 20 GB container disk during 4 hours | about $0.012 |
| Total reserved | **$24.67** |

Storage bills hourly even with the pod stopped. It is about **$0.583/day**;
four days would cost about $2.33, rather than the full $17.50 reservation.
Keeping it after 30 days incurs additional charges. Back up results locally
and explicitly decide whether to retain the volume after the contest.
GPU setup/download time is billable. 152 GB takes roughly 25 minutes at a
sustained 100 MB/s or 2.1 hours at 20 MB/s before software installation.
Two setup hours are a budget limit, not a speed guarantee.

Start the watchdog before setup, using a four-hour absolute runtime cap:

```sh
MAX_RUNTIME_SECS=14400 EMPTY_LIMIT_SECS=600 \
  bash scripts/runpod/watchdog.sh > /workspace/motionfield-watchdog.log 2>&1 &
```

The current CLI command is `runpodctl pod stop POD_ID`. The watchdog refuses
to run without the CLI and a pod id. It stops after ten idle minutes or at the
four-hour limit, including a stuck job. It does not stop storage billing.
Monitor it from the Mac; do not rely solely on a background process that could
die. Do not start another session without checking accumulated account charges.

## Prepare and connect

Use the current checkout, including the unfinished work; a GitHub clone alone
will not contain these uncommitted fixes. Copy the repository without .env,
.data, node_modules, .git, .next*, public/files, screenshots or test results.
No user database, secrets or generated user media is needed on the pod.

On the pod, in that copied checkout:

```sh
bash scripts/runpod/setup-studio.sh --dry-run
bash scripts/runpod/setup-studio.sh
```

The installer pins ComfyUI, VHS, MotionField nodes, Kokoro and patched MuseTalk.
It has not been executed on CUDA yet. Before the first prompt, copy the
existing graphics files from the Mac, preserving their relative paths:

```sh
# Substitute the pod's actual IP and SSH port; never paste a password/API key.
rsync -av --files-from=scripts/runpod/studio-files.txt \
  -e 'ssh -p SSH_PORT' ~/comfy/ComfyUI/models/ \
  root@POD_IP:/workspace/ComfyUI/models/
rsync -av -e 'ssh -p SSH_PORT' \
  ~/comfy/ComfyUI/custom_nodes/comfyui-kokoro/kokoro_v1.onnx \
  ~/comfy/ComfyUI/custom_nodes/comfyui-kokoro/voices_v1.bin \
  root@POD_IP:/workspace/ComfyUI/custom_nodes/comfyui-kokoro/
```

These transfers total about 28 GB; no Mac models should be deleted after copying.
Existing Klein graphs use the deployment's current COMFY_MODEL_MAP alias for
flux-2-klein-4b-bf16.safetensors. Keep that mapping in the Mac app.

Start `bash scripts/runpod/start.sh` on the pod. Then tunnel from the Mac:

```sh
ssh -N -L 18189:127.0.0.1:8189 root@POD_IP -p SSH_PORT
```

Set the Mac app's environment, then restart only when no user jobs are running:

```dotenv
GENERATION_PROVIDER=comfy
COMFY_BASE_URL=http://127.0.0.1:18189
COMFY_AUDIO_BASE_URL=http://127.0.0.1:8189
LLM_PROVIDER=ollama
LLM_MODEL=qwen3.8:27b-q4_K_M
```

If a proxy requires a token, use COMFY_API_KEY for the pod and
COMFY_AUDIO_API_KEY for local audio. Do not put either in logs or the repo.
Audio jobs persist which backend they used so polling/cancellation goes back
to the correct server, including recipe sub-jobs.

## Verification before calling it finished

1. Fetch /object_info; lint every selected graph with scripts/runpod/validate.ts.
2. Run one short T2I and I2V, then a real authenticated upload-to-output app flow.
3. Re-run person-swap draft/final: inspect identity, halo, eye band, seam and lip
   restoration. A completed job alone is not a quality pass.
4. Verify Director orbit after the smoothing fix, re-shoot and one VFX preset.
5. Verify audio still returns a real WAV from the Mac with the pod configured.
6. Verify scene-to-video, finishing, and capture a genuine output demo.
7. Stop the pod, confirm its stopped state and actual account charges.

Photo face swap still lacks a proven identity-transfer solution. An empty
Quick gallery must not be advertised as verified. Exact equivalence with
proprietary models is not claimed. Full-app completion must not be claimed
until the remaining implementations and real-output checks are done.

## Sources checked

- https://www.runpod.io/pricing (A100 80 GB and storage prices)
- https://docs.runpod.io/pods/pricing (container/network billing and retention)
- https://docs.runpod.io/storage/network-volumes (mounting/persistence)
- https://docs.runpod.io/pods/manage-pods (current stop command)
- https://huggingface.co/Qwen/Qwen-Image-Edit-2511 (Apache-2.0)
- https://huggingface.co/Lightricks/LTX-Video (existing model license)
