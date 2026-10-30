# Running on a pod (RunPod)

MotionField is local-first; this is the escape hatch when your GPU isn't enough.
One pod, one volume, everything bound to `127.0.0.1` - you reach it over an SSH
tunnel, never the public proxy URL.

## Pod shape

For the requested full model stack, read [MODEL_DECISIONS.md](MODEL_DECISIONS.md)
first. LTX-2.5 is the core video stack as of the manifest below - tier A at
~219 GB incl. optional fits a 250 GB network volume beside ComfyUI/venv (~10 GB).
[RUNPOD_PLAN.md](RUNPOD_PLAN.md) describes only the earlier base rehearsal:
its A100/250 GB/$25 estimate is superseded by the manifest below and is not a
final provisioning instruction. No cloud resource has been created.

The full manifest is an optional inventory, not the default shopping list:
tier A alone is 219.1 GB (incl. optional) - LTX-2.5 is the new core video
stack (distilled int8 transformer + Gemma-4 encoder + video/audio VAEs +
latent upscalers + the IC-LoRA set: motion-track, union-control, ingredients,
layout-to-render, alpha-gen, sdr-to-hdr, pixel-upscaler, in-outpainting).
Wan 2.2 Animate stays for person swap; Wan VACE/Uni3C/fun-camera and the
Klein image stack stay because ~25 existing workflow graphs still load them -
they run until the recipes are ported to LTX-2.5 graphs. Wan 2.2 t2v/i2v
14B pairs moved to tier B as heavy alternates; the LTX-2 stack was dropped.
The LTX-2.5 repos are HF-gated - accept each licence once, then
`HF_TOKEN=...` both fills the manifest's pending sha256s
(`scripts/runpod/fill-hashes.py`, auto-run by setup.sh) and authorises the
downloads. Entries still pending after that are skipped at download (named,
never fetched - unverified bytes never land) and the install continues.
Community-licence entries ship `class:"restricted"` and need
`--with-restricted`.

## Setup

Prerequisites on the stock pod images: `git`, `python3` (+ `python3-venv` for
the venv - checked up front, exit 5 if missing) and `curl` are already there;
`rsync` and `uv` usually are not:

```bash
apt-get update && apt-get install -y rsync
pip install uv            # lands in ~/.local/bin - add it to PATH if needed
```

```bash
git clone <this repo> /workspace/motionfield
cd /workspace/motionfield
export HF_TOKEN=hf_...                            # read token, LTX licences accepted
scripts/runpod/setup.sh --tier A --with-optional --with-restricted --dry-run
scripts/runpod/setup.sh --tier A --with-optional --with-restricted
```

`--with-restricted` is required - the LTX-2.x community licence maps to the
restricted class by design (still prints "opt-in required in Settings →
Licenses"; the flag only lets the bits land on disk).

Tiers: **A** = core stack (LTX-2.5 distilled int8 + Gemma-4-12B encoder +
video/audio VAEs + latent upscalers + IC-LoRA set, Wan-Animate int8 for
person-swap, Qwen-Image-2512/Edit-2511 + Qwen2.5-VL + multi-angle LoRA,
Z-Image-Turbo, FlashVSR, shared encoders/VAEs/CLIP-vision, depth/detection/
cutout aux). **B** = the slower/heavier alternates (SCAIL-2 int8, FLF2V-14B
fp8, Wan2.2-TI2V-5B, LongCat-Video-Avatar-1.5 int8 + Whisper-large,
SeedVR2-3B). **C** = optional (HiDream-O1, Bernini-R - always
`optional:true`, only fetched with `--with-optional`). **3d** = TripoSG,
TRELLIS-image-large, UniRig, Marigold V2 and the TRELLIS.2 native path.

- `--with-optional`: the LTX-2.5 duration head, the Gemma-4-E2B prompt
  enhancer, and all of tier C.
- `--download-only`: fetch and sha256-verify weights, skip the software pins -
  but ComfyUI is still cloned/checked out first (the weights land inside
  `$COMFY_HOME/models`, and `git clone` refuses a non-empty dir). A pre-filled
  `$COMFY_HOME` without `.git` is adopted in place, so re-running
  `--download-only` on a pod that already has weights never clobbers them.
- `--dry-run`: print the per-file plan (tier, name, bytes, sha256, licence,
  class, target) and exit - nothing downloads.

Every entry is gate-checked in one pass before the first byte: the class must
equal the licence's class (or be *stricter* for a named pack - the trellis2
DiT/VAEs are MIT but ship `class:"restricted"` beside the bundled DINOv3
clip), the licence may not be NC/banned/unknown/other, the sha256 must be
64-hex, names/targets must be safe relative paths, and every URL must resolve
on huggingface.co - unless the entry carries an explicit `url` on a narrow
allowlist of official vendor hosts (GitHub release assets such as
RealESRGAN_x4plus.pth and the Kokoro ONNX, plus OpenAI's whisper CDN for
tiny.pt). The run exits 3 naming all offenders. Downloads resume
(`curl -C -`, token via `curl -K -` on stdin, never on argv) and each file is
sha256-verified against the manifest; a verified file gets a `.ok` marker so
re-runs skip the re-hash, a mismatch is moved to `.bad`. `HF_TOKEN` is read
from the environment if set (for gated sources) and is never printed.

Software pins installed (non-dry-run): ComfyUI **0.41.0**
(`ce1e922d8623bb507180e32a0c01a7d0e29edef7`), ComfyUI-VideoHelperSuite
`4d907bee61e92c2e65af3bd6383a4e4d356126d1`, ComfyUI-LTXVideo
`220e1d45aa0469f518e982102fca4dca92a61862` (IC-LoRA + draw-track nodes -
only when LTX weights are planned), comfyui-kokoro (stavsap, Apache-2.0)
`cfb59b5605b351e196182c836f0b48c1a784e52f` and ComfyUI-MuseTalk (chaojie,
MIT) `84f4b6dcbb0d87e87687f324092056646582457d` - each only when its weights
are planned; the MotionField MuseTalk patch is applied on the pod too (it is
portable: cuda→mps→cpu device pick, and the vendored ONNX DWPose pipeline
replaces mmpose/S3FD/face-parsing, whose weights we do not ship). Audio -
Kokoro TTS and MuseTalk lip-sync - runs on the pod; `voices_v1.bin` is
generated there by the pack itself (np.savez of the hexgrad voice .pt
files - no canonical URL, unpinnable bytes). This repo's `motionfield_nodes`
(rsynced into `custom_nodes/`), ComfyUI_FlashVSR (smthemex, Apache-2.0)
`153cf03343a116c85aee40d291125921cc33935a`, ComfyUI-LongCat-Avatar
(rookiestar28, MIT) `08b4daedfaed69abaf467097f8665615b2137331`, and
`comfy-api-proxy==0.1.6` via `uv tool install`. The FlashVSR/LongCat pins are
in-repo choices - bump the `*_REF` vars in setup.sh only after re-checking
licence and head commit. The repo URLs are env-overridable
(`COMFYUI_REPO`, `VHS_REPO`, `FLASHVSR_REPO`, `LONGCAT_REPO`, `KOKORO_REPO`,
`MUSETALK_REPO`) for mirrors or tests. Setup checks the tools it needs first (`git`, `python3`, `curl` -
plus `rsync`/`uv` for a full install) and exits 5 naming a missing one, and
it clones/checks out ComfyUI *before* downloading weights - a pre-filled
`$COMFY_HOME` without `.git` is adopted in place (`git init` + `fetch` +
`checkout -f`), so `models/` content survives. After the pins, setup creates
`$COMFY_HOME/.venv` (`--system-site-packages`) and pip-installs ComfyUI's
`requirements.txt` plus every custom node's `requirements.txt`.

## Running

```bash
scripts/runpod/start.sh        # ComfyUI :8188 + proxy :8189, both 127.0.0.1
scripts/runpod/watchdog.sh &   # stops the pod after 20 min of empty queue
```

If an LLM (e.g. Ollama for the explainer and dub writers) shares the GPU,
start ComfyUI with `COMFY_RESERVE_VRAM=22 scripts/runpod/start.sh` so its
model cache leaves the LLM room; otherwise the LLM spills to CPU and its
steps time out.

Then on your machine:

```bash
ssh -N -L 18189:127.0.0.1:8189 root@<pod-ip> -p <ssh-port>
COMFY_BASE_URL=http://127.0.0.1:18189 GPU_LOCK=/tmp/of-gpu-pod.lock
```

The app talks to the proxy (8189); ComfyUI's own port stays on loopback. The
public RunPod HTTP port mapping is not used and can be left empty.

### API key

Generate a token and export the same value on the pod and in the app env:

```bash
openssl rand -hex 32                     # run once, e.g. on your Mac
export COMFY_API_KEY=<that-value>        # on the pod, before start.sh
```

With `COMFY_API_KEY` set, `start.sh` launches the proxy with
`--token "$COMFY_API_KEY"` - the API-key gate then applies to every request.
The same value goes in the app environment as `COMFY_API_KEY` (the Comfy SDK
reads it from there). Unset, the proxy takes any caller that can reach the
tunnel. Note the token is visible in `ps` on the pod - fine on a
single-tenant pod - and `start.sh` never prints it.

### Per-workflow validation

`scripts/runpod/validate.ts` submits one bundled graph through the SDK and
writes an evidence JSON (job id, status, metrics, per-output sha256):

```bash
COMFY_BASE_URL=http://127.0.0.1:18189 \
npx tsx scripts/runpod/validate.ts --workflow wan22a14b-i2v.json \
  --ref INPUT_IMAGE=/tmp/frame.png \
  --params '{"prompt":"…","steps":8,"duration":3,"resolution":"480p"}' \
  --out tests/artifacts/pod-<name>.json
```

`--ref` is repeatable and names the graph's media placeholder (`INPUT_IMAGE`,
`END_IMAGE`, `REF_IMAGE`, `REF_IMAGE_2`, `REF_IMAGE_3`, `INPUT_VIDEO`, `AUDIO`);
a bare path maps to `INPUT_IMAGE`. Inputs upload through the SDK asset path -
media bytes never touch `public/files`, and outputs download under
`--media-dir` (default `/tmp/of-evidence/media`). The license classes of
every graph's weights are in `docs/LICENSES.md`; a timeout is recorded as
inconclusive, never a pass. Before any submit the pod continuation runs
`validate.ts --lint <object_info.json>` on every graph - an offline check
against a saved `/object_info` dump (unknown class_type, missing required
input, dangling link); it never touches `COMFY_BASE_URL`.

## Pod notes

- Uni3C camera control runs via the native `WanUni3CControlnetApply` node,
  fed by our rig renders - no wrapper packs.
- The Wan-Fun camera DiTs take `OF_CameraEmbed` (Plücker ray maps from the
  MotionField node pack's pose stream).
- ATI / Wan-Move stay P2 - not on the pod manifest.
- LongCat's audio-separator runs whatever `.onnx` sits in `models/longcat` -
  none is on the manifest; licence-check any separator model before adding one.
- Wan 2.2 A14B (cloud quality tier): each high/low-noise fp8 pair is ~28.6 GB
  (Comfy-Org/Wan_2.2_ComfyUI_Repackaged, split_files/diffusion_models; sha256 in
  models/manifest.json). When the volume quota is tight, a RAM-backed copy works:
  download the pair into `/dev/shm/a14b` and symlink each file into
  `models/diffusion_models` - ComfyUI picks them up without a restart. tmpfs is
  wiped when the pod stops, so re-fetch after a restart. Measured on an H100:
  720p 3 s (73 frames) at 20 steps ~49 s/step.
- Verify budget: each workflow's cap is 1.5× its measured warm render. A
  timeout is recorded as **inconclusive**, never as a pass.

## Watching the burn

`watchdog.sh` polls `127.0.0.1:8188/queue` once a minute; when the queue has
been empty for `EMPTY_LIMIT_SECS` (default 20 min) it re-polls once and runs
`runpodctl pod stop $RUNPOD_POD_ID` if it's still empty. A ComfyUI that stays
unreachable for `UNREACHABLE_LIMIT_SECS` (default 30 min) counts as idle too -
a crashed pod stops billing - except while `/tmp/of-setup.lock` is held by a
**live pid** (setup.sh writes its pid in and holds it for the whole run; a
stale lock whose pid is gone is ignored, so a SIGKILLed setup never freezes
the watchdog). `watchdog.sh --dry-run` prints the current decision and exits -
use it to sanity-check before leaving a pod unattended.

## Cost guidance

Use the current [bounded plan](RUNPOD_PLAN.md): A100 80 GB at a maximum
$1.79/hour, 250 GB standard network storage at $17.50/month, and a $25
first-session reserve. Storage keeps billing after the pod stops.
Container disk is $0.10/GB/month while running, and is erased on stop;
it is not free. A separate pod volume is unnecessary.

These prices were checked against the [official pricing page](https://www.runpod.io/pricing)
and [storage billing docs](https://docs.runpod.io/pods/pricing) on 2026-10-26.
The actual regional checkout rate wins; do not deploy above the cap.
Setup/download time is billable. Run the watchdog with
`MAX_RUNTIME_SECS=14400` and verify it really stopped the pod. No rendering
speed or remote quality result is promised before an executed smoke.

### Not in the manifest (and why)

- **LTX-2.5 (22B + Gemma-4 12B)** - newer than the pinned LTX-2 19B, but the
  `Lightricks/LTX-2.5` repo is **gated**: anonymous fetches get 401 and the
  LFS sha256 is masked, and every manifest entry must carry a verified
  64-hex checksum before download. Once you accept the terms on HF and set
  `HF_TOKEN`, the hashes can be fetched and the entry added honestly.
- **Fish Audio Drama 3** - discussed but not integrated. The current
  [LICENSE](https://huggingface.co/fishaudio/drama-3/blob/main/LICENSE)
  is the Fish Audio Community License (despite the older research-license
  metadata tag). It permits research/non-commercial use and conditional
  commercial use; production self-service hosted audio has separate terms.
  The 41.5 GB model needs its own tested runtime, adapter, provenance/consent
  handling and budget. Do not label it categorically non-commercial or
  pretend the existing Kokoro/Chatterbox workflow runs it.
- **Wan 2.5/2.6/2.7/3.0** - hosted Partner-Node APIs only, no open weights.
  Nothing to download; Wan 2.2 A14B remains the newest self-runnable Wan.
- **Local LLM** - the assistant brain/translator/judge runs on the Mac via
  Ollama (`LLM_PROVIDER`/`LLM_MODEL`), never on the pod.

### Optional: MOSS SoundEffect on CUDA

The sound-effect endpoints run MOSS-SoundEffect v2.0 (Apache-2.0). On Apple Silicon the node uses the MLX port; on a CUDA pod run `MOSS_HOME=/root/moss bash scripts/runpod/moss-cuda.sh` (~16 GB: isolated Python 3.12 env + sha256-pinned weights), then restart ComfyUI. OF_MossSFX finds it under `models/motionfield/moss-sfx-torch/`.
