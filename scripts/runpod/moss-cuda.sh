#!/bin/bash
# Opt-in: MOSS-SoundEffect v2.0 (Apache-2.0) for CUDA pods. OF_MossSFX runs it
# through comfy-nodes/motionfield_nodes/moss_cuda_runner.py in the isolated
# Python 3.12 env the upstream pipeline pins (it can't share ComfyUI's env).
# ~16 GB on disk (env ~5 GB + weights 11.2 GB) - put MOSS_HOME on a disk
# with room. Needs a ComfyUI restart afterwards to pick up the node.
#
#   MOSS_HOME=/root/moss MODELS_DIR=/workspace/ComfyUI/models bash scripts/runpod/moss-cuda.sh
set -euo pipefail
MOSS_HOME="${MOSS_HOME:-/root/moss}"
MODELS_DIR="${MODELS_DIR:-/workspace/ComfyUI/models}"
SRC_REF=934d6826b084c46a0d033402174d5f8ac4ed2519       # OpenMOSS/MOSS-TTS
HF_REV=e35df4d82fbe87fcd5d14e5d100e349c0c3c076d        # OpenMOSS-Team/MOSS-SoundEffect-v2.0
mkdir -p "$MOSS_HOME"
if [ ! -d "$MOSS_HOME/MOSS-TTS" ]; then
  git clone https://github.com/OpenMOSS/MOSS-TTS.git "$MOSS_HOME/MOSS-TTS"
fi
git -C "$MOSS_HOME/MOSS-TTS" fetch -q --depth 1 origin "$SRC_REF" && git -C "$MOSS_HOME/MOSS-TTS" checkout -q "$SRC_REF"
[ -x "$MOSS_HOME/env/bin/python" ] || UV_NO_CACHE=1 uv venv "$MOSS_HOME/env" -p 3.12
UV_NO_CACHE=1 uv pip install -p "$MOSS_HOME/env/bin/python" --index-strategy unsafe-best-match \
  --extra-index-url https://download.pytorch.org/whl/cu128 -e "$MOSS_HOME/MOSS-TTS/moss_soundeffect_v2[torch-cu128]"
"$MOSS_HOME/env/bin/python" - "$MOSS_HOME/weights" "$HF_REV" <<'PY'
import sys, huggingface_hub
huggingface_hub.snapshot_download("OpenMOSS-Team/MOSS-SoundEffect-v2.0", revision=sys.argv[2], local_dir=sys.argv[1])
PY
( cd "$MOSS_HOME/weights" && sha256sum -c - <<'SUMS'
169ad53ec313c3a34b06c0809216e4fc072cce444a5d4ff2b59690d064130ed5  text_encoder/model-00001-of-00002.safetensors
912becff8d60672aa8628ef08c05898d9adf17c2ad4ae3caf99b065622fdeff9  text_encoder/model-00002-of-00002.safetensors
aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4  tokenizer/tokenizer.json
bda86e4d6730ff47cea47851d219880191e9d21d4d264b21a6ffe7cb2db9dfb0  transformer/diffusion_pytorch_model.safetensors
07e6139ff33bd21ba8a7a7f40ed24aab13ac0d100cd686f8a9f3e03dc5251cb1  vae/vae_128d_48k.pth
SUMS
)
# the node looks under <models>/motionfield/moss-sfx-torch/{weights,python}
mkdir -p "$MODELS_DIR/motionfield/moss-sfx-torch"
ln -sfn "$MOSS_HOME/weights" "$MODELS_DIR/motionfield/moss-sfx-torch/weights"
# Invoke Python at its venv path: an external executable symlink loses pyvenv.cfg.
launcher="$MODELS_DIR/motionfield/moss-sfx-torch/python"
[ ! -L "$launcher" ] || unlink "$launcher"
printf '%s\n' '#!/bin/sh' "exec \"$MOSS_HOME/env/bin/python\" \"\$@\"" > "$launcher"
chmod +x "$launcher"
echo "MOSS-SoundEffect ready - restart ComfyUI to load OF_MossSFX's CUDA path."
