"""OF_MossSFX + OF_SaveAudioWav — MotionField sound nodes.

OF_MossSFX runs MOSS-SoundEffect v2.0 (Apache-2.0) prompt→sfx on Apple
Silicon through the Apache-2.0 MLX port (moss-sfx-mlx). Weights live in
``<comfy models>/motionfield/moss-sfx-mlx/``; when absent the node downloads
them via ``huggingface_hub.snapshot_download`` — but ONLY from
``MOSS_REPO_ALLOWLIST``. Any other repo id raises before a byte is fetched.
When the deps or weights can't be made to work the node fails with a clear
"not available on this machine" message instead of emitting fake audio.

OF_SaveAudioWav writes a two-pass EBU R128 loudness-normalized WAV into
ComfyUI's output dir at 48 kHz s16 — the spec for every audio artifact
MotionField ships (music −14 LUFS, cues −16 LUFS, true peak ≤ −1 dBTP).
Pass 1 measures with loudnorm; pass 2 applies the linear gain manually
through an oversampled hard limiter, because loudnorm's own linear=true
silently falls back to dynamic mode when LRA > 11 or the true peak would
overshoot — the file then lands at the wrong loudness and nothing says
so. It passes the AUDIO through so a terminal SaveAudio can anchor the
workflow tail.

The module imports cleanly with stdlib only — torch/folder_paths are
optional so a host-side unit test can exec the allow-list check without a
ComfyUI install.
"""

import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile

try:
    import folder_paths
except ImportError:
    folder_paths = None

# ---------------------------------------------------------------------------
# MOSS repo allow-list — the ONLY Hugging Face repo OF_MossSFX may fetch:
# the Apache-2.0 MLX 4-bit port this machine actually runs. Any other repo
# id is refused before a byte is downloaded.
# ---------------------------------------------------------------------------
MOSS_REPO_ALLOWLIST = frozenset({
    "mlx-community/MOSS-SoundEffect-v2.0-4bit",
})

# CUDA hosts (no MLX) run the upstream torch pipeline (never auto-fetched -
# setup provisions it, so it stays off the allow-list) - same model, Apache-2.0
# - in its own Python 3.12 env, through moss_cuda_runner.py. Weights + the
# env's python live under <models>/motionfield/moss-sfx-torch/ (``weights/`` and
# a ``python`` symlink; OF_MOSS_PYTHON overrides the latter).
MOSS_TORCH_REPO = "OpenMOSS-Team/MOSS-SoundEffect-v2.0"

# dirs the snapshot needs (configs + tokenizers + mlx weights); the huge
# fp32 DiT/VAE pth files in the torch repo are deliberately excluded — on
# this machine MOSS runs the MLX conversion, not the torch reference.
MOSS_SNAPSHOT_PATTERNS = [
    "model_index.json",
    "mlx/**",
    "text_encoder/**",
    "tokenizer/**",
    "scheduler/**",
    "transformer/config.json",
    "vae/config.json",
    "LICENSE",
    "README.md",
]

MOSS_UNAVAILABLE = (
    "MOSS-SoundEffect is not available on this machine — needs the "
    "moss-sfx-mlx package + mlx in ComfyUI's python and the allow-listed "
    "weights under models/motionfield/moss-sfx-mlx/ (or let the node fetch "
    "them from an allow-listed HF repo)."
)


def moss_repo_allowed(repo_id) -> bool:
    """True only for exact allow-listed HF repo ids — no prefixes, no
    case folding, no wildcards. Pure-stdlib on purpose: a test execs this
    file directly to prove a hostile repo id is refused."""
    if not isinstance(repo_id, str):
        return False
    return repo_id in MOSS_REPO_ALLOWLIST


def _moss_weight_root() -> str:
    roots = []
    if folder_paths is not None:
        roots.append(folder_paths.models_dir)
    env = os.environ.get("COMFYUI_MODELS_DIR")
    if env:
        roots.extend(env.split(os.pathsep))
    roots.append(os.path.expanduser(os.path.join("~", "comfy", "ComfyUI", "models")))
    return os.path.join(roots[0], "motionfield", "moss-sfx-mlx")


def _moss_local_dir(repo_id: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", repo_id)
    return os.path.join(_moss_weight_root(), safe)


def _moss_ready(model_dir: str) -> bool:
    need = (
        "model_index.json",
        os.path.join("mlx", "dit.safetensors"),
        os.path.join("mlx", "vae.safetensors"),
        os.path.join("text_encoder", "config.json"),
        os.path.join("tokenizer", "tokenizer.json"),
    )
    return all(os.path.isfile(os.path.join(model_dir, f)) for f in need)


def _moss_ensure_weights(repo_id: str) -> str:
    """Local snapshot dir for the allow-listed repo; downloads only the
    files MOSS_SNAPSHOT_PATTERNS names. A non-allow-listed id never reaches
    this function."""
    model_dir = _moss_local_dir(repo_id)
    if _moss_ready(model_dir):
        return model_dir
    try:
        from huggingface_hub import snapshot_download
    except ImportError as e:
        raise RuntimeError(MOSS_UNAVAILABLE + f" (huggingface_hub: {e})") from e
    os.makedirs(model_dir, exist_ok=True)
    snapshot_download(
        repo_id=repo_id,
        local_dir=model_dir,
        allow_patterns=MOSS_SNAPSHOT_PATTERNS,
    )
    if not _moss_ready(model_dir):
        raise RuntimeError(
            f"MOSS-SoundEffect weights did not materialize in {model_dir} — "
            "the repo layout changed; refusing to guess."
        )
    return model_dir


_moss_pipes = {}


def _moss_pipe(repo_id: str, model_dir: str):
    pipe = _moss_pipes.get(model_dir)
    if pipe is not None:
        return pipe
    try:
        from moss_sfx_mlx.pipeline_mlx import MossSoundEffectPipeline
        import mlx.core as mx  # noqa: F401
    except ImportError as e:
        raise RuntimeError(MOSS_UNAVAILABLE + f" (import: {e})") from e
    pipe = MossSoundEffectPipeline.from_pretrained(model_dir=model_dir)
    _moss_pipes[model_dir] = pipe
    return pipe



def _mlx_available() -> bool:
    # Linux may have the MLX package installed without an Apple Metal runtime.
    if sys.platform != "darwin":
        return False
    try:
        import importlib.util
        return importlib.util.find_spec("mlx") is not None
    except Exception:
        return False


def _moss_torch_root() -> str:
    return os.path.join(os.path.dirname(_moss_weight_root()), "moss-sfx-torch")


def _moss_cuda(prompt, seconds, seed, steps, cfg):
    """Run the torch pipeline in its isolated env; return a ComfyUI AUDIO."""
    import numpy as np
    import torch
    root = _moss_torch_root()
    py = os.environ.get("OF_MOSS_PYTHON") or os.path.join(root, "python")
    weights = os.path.join(root, "weights")
    if not (os.path.exists(py) and os.path.isfile(os.path.join(weights, "model_index.json"))):
        raise RuntimeError(
            "MOSS-SoundEffect is not available on this machine - on CUDA it needs the "
            f"{MOSS_TORCH_REPO} weights under {weights} and the upstream "
            "moss_soundeffect_v2 env's python at " + py + " (see scripts/runpod/setup.sh)."
        )
    runner = os.path.join(os.path.dirname(os.path.abspath(__file__)), "moss_cuda_runner.py")
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "sfx.wav")
        p = subprocess.run(
            [py, runner, weights, out, str(float(seconds)), str(int(steps)), str(float(cfg)), str(int(seed))],
            input=str(prompt).strip(), capture_output=True, text=True,
        )
        if p.returncode != 0 or not os.path.isfile(out):
            raise RuntimeError(f"MOSS-SoundEffect (CUDA) failed: {(p.stderr or p.stdout).strip()[-600:]}")
        # decode to 48 kHz f32 via ffmpeg - no soundfile dependency here
        q = subprocess.run([_ffmpeg(), "-v", "error", "-i", out, "-f", "f32le", "-ac", "1", "-ar", "48000", "-"],
                           capture_output=True)
        if q.returncode != 0:
            raise RuntimeError(f"MOSS-SoundEffect decode failed: {q.stderr.decode(errors='replace')[-300:]}")
    arr = np.frombuffer(q.stdout, dtype=np.float32).copy()
    return {"waveform": torch.from_numpy(arr[None, None, :]), "sample_rate": 48000}


class OF_MossSFX:
    """Prompt → 48 kHz mono sound effect through MOSS-SoundEffect v2.0."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"multiline": True}),
                "seconds": ("FLOAT", {"default": 10.0, "min": 0.5, "max": 30.0, "step": 0.1}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2147483647}),
                "repo_id": ("STRING", {"default": "mlx-community/MOSS-SoundEffect-v2.0-4bit"}),
            },
            "optional": {
                "num_inference_steps": ("INT", {"default": 60, "min": 10, "max": 300}),
                "cfg_scale": ("FLOAT", {"default": 4.0, "min": 1.0, "max": 12.0, "step": 0.1}),
            },
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "synthesize"
    CATEGORY = "MotionField/audio"

    def synthesize(self, prompt, seconds, seed, repo_id,
                   num_inference_steps=60, cfg_scale=4.0):
        if not moss_repo_allowed(repo_id):
            raise ValueError(
                f"OF_MossSFX: repo_id {repo_id!r} is not on the allow-list — "
                f"only {sorted(MOSS_REPO_ALLOWLIST)} may be fetched"
            )
        import numpy as np
        import torch

        if not _mlx_available():
            return (_moss_cuda(prompt, seconds, seed, num_inference_steps, cfg_scale),)
        model_dir = _moss_ensure_weights(repo_id)
        pipe = _moss_pipe(repo_id, model_dir)

        wav = pipe(
            str(prompt).strip(),
            seconds=float(seconds),
            num_inference_steps=int(num_inference_steps),
            cfg_scale=float(cfg_scale),
            seed=int(seed),
            num_channels=1,
            progress_bar_cmd=lambda it, *a, **k: it,
        )
        # pipe returns an mx.array [batch, channels, samples] (48 kHz mono)
        arr = np.asarray(wav, dtype=np.float32)
        arr = np.squeeze(arr)
        if arr.ndim == 1:
            arr = arr[None, None, :]      # → [1, 1, N]
        elif arr.ndim == 2:
            arr = arr[None, :, :]         # → [1, C, N]
        waveform = torch.from_numpy(np.ascontiguousarray(arr))
        return ({"waveform": waveform, "sample_rate": int(getattr(pipe, "sample_rate", 48000))},)


# ---------------------------------------------------------------------------
# OF_SaveAudioWav — normalized WAV writer
# ---------------------------------------------------------------------------

def _ffmpeg() -> str:
    exe = os.environ.get("FFMPEG_BIN") or shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("OF_SaveAudioWav needs ffmpeg on PATH (or FFMPEG_BIN)")
    return exe


def _loudnorm_measure(raw_path: str, target_i: float, tp: float, lra: float = 11.0) -> dict:
    p = subprocess.run(
        [_ffmpeg(), "-hide_banner", "-nostats", "-i", raw_path,
         "-af", f"loudnorm=I={target_i}:TP={tp}:LRA={lra}:print_format=json",
         "-f", "null", "-"],
        capture_output=True, text=True,
    )
    m = re.search(r"\{\s*\"input_i\".*?\}", p.stderr, re.S)
    if p.returncode != 0 or not m:
        raise RuntimeError(f"loudnorm measure failed: {p.stderr.strip()[-400:]}")
    j = json.loads(m.group(0))
    # loudnorm emits strings ("-27.09", "-inf") — normalize to floats
    def _f(k):
        try:
            return float(j.get(k))
        except (TypeError, ValueError):
            return float("nan")
    return {k: _f(k) for k in ("input_i", "input_tp", "input_lra", "input_thresh")}


def _loudnorm_apply(raw_path: str, out_path: str, target_i: float, tp: float,
                    measured: dict, lra: float = 11.0) -> None:
    # manual linear gain (target − input_i), then the same oversampled bus
    # limiter the TS path runs: 192 kHz so alimiter catches inter-sample
    # peaks, hard 0.79 ceiling, level=0 — it caps, never re-loudens.
    gain_db = target_i - measured["input_i"]
    af = (
        f"volume={gain_db:.2f}dB,"
        "aresample=192000,alimiter=limit=0.79:level=0,aresample=48000"
    )
    p = subprocess.run(
        [_ffmpeg(), "-y", "-hide_banner", "-i", raw_path,
         "-af", af, "-ar", "48000", "-c:a", "pcm_s16le", out_path],
        capture_output=True, text=True,
    )
    if p.returncode != 0:
        raise RuntimeError(f"loudnorm apply failed: {p.stderr.strip()[-400:]}")


def _write_raw_wav(waveform, sample_rate: int, path: str) -> None:
    """waveform: torch tensor [B, C, N] float32 → 48 kHz-friendly f32 wav."""
    import numpy as np
    import torch
    ch_first = waveform[0].detach().cpu().float()  # [C, N]
    ch_first = torch.clamp(ch_first, -1.0, 1.0)
    pcm = ch_first.t().contiguous().numpy()        # [N, C]
    # minimal f32 wav writer — no soundfile dependency
    n, c = pcm.shape
    data = pcm.astype(np.float32).tobytes()
    import struct
    byte_rate = sample_rate * c * 4
    block = c * 4
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE")
        f.write(b"fmt " + struct.pack("<IHHIIHH", 16, 3, c, sample_rate, byte_rate, block, 32))
        f.write(b"data" + struct.pack("<I", len(data)) + data)


class OF_SaveAudioWav:
    """AUDIO → loudness-normalized WAV in ComfyUI's output dir; AUDIO passes
    through so a terminal node can anchor the graph. Emits a ui audio entry
    so hosts (comfy-pool) collect the wav as the job's output."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO",),
                "filename_prefix": ("STRING", {"default": "audio/ComfyUI"}),
                "lufs_target": ("FLOAT", {"default": -14.0, "min": -40.0, "max": -5.0, "step": 0.1}),
                "true_peak": ("FLOAT", {"default": -1.0, "min": -6.0, "max": -0.1, "step": 0.1}),
            },
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "save"
    CATEGORY = "MotionField/audio"
    OUTPUT_NODE = True

    def save(self, audio, filename_prefix="audio/ComfyUI",
             lufs_target=-14.0, true_peak=-1.0):
        if folder_paths is None:
            raise RuntimeError("OF_SaveAudioWav must run inside ComfyUI")
        output_dir = folder_paths.get_output_directory()
        full_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, output_dir)
        os.makedirs(full_folder, exist_ok=True)

        results = []
        waveform = audio["waveform"]
        sample_rate = int(audio["sample_rate"])
        for batch in range(waveform.shape[0]):
            out_name = f"{filename}_{counter:05}_.wav"
            out_path = os.path.join(full_folder, out_name)
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
                raw = tf.name
            try:
                _write_raw_wav(waveform[batch:batch + 1], sample_rate, raw)
                measured = _loudnorm_measure(raw, float(lufs_target), float(true_peak))
                # a silent input measures −inf — the honest normalized
                # output for silence is the source copied through
                if not math.isfinite(measured["input_i"]):
                    shutil.copyfile(raw, out_path)
                else:
                    _loudnorm_apply(raw, out_path, float(lufs_target), float(true_peak), measured)
            finally:
                try:
                    os.unlink(raw)
                except OSError:
                    pass
            results.append({"filename": out_name, "subfolder": subfolder, "type": "output"})
            counter += 1

        return {"ui": {"audio": results}, "result": (audio,)}


class OF_PlateAudio:
    """VFX Lab plate audio.

    VHS_LoadVideo yields a lazy audio map that throws when the source clip
    has no audio stream — the whole run dies mid-execute even though the
    audio output only feeds VHS_VideoCombine's *optional* input. This node
    does the same ffmpeg extract eagerly and returns ``(None,)`` on failure,
    so a silent plate produces a silent output instead of a failed job.
    """

    CATEGORY = "motionfield/vfx"
    FUNCTION = "load"
    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "video": ("STRING", {"vhs_path_extensions": ["mp4", "mov", "webm", "mkv"]}),
            "start_time": ("FLOAT", {"default": 0, "min": 0, "widgetType": "VHSTIMESTAMP"}),
            "duration": ("FLOAT", {"default": 0, "min": 0, "widgetType": "VHSTIMESTAMP"}),
        }}

    def load(self, video, start_time=0, duration=0):
        if folder_paths is None:
            raise RuntimeError("OF_PlateAudio must run inside ComfyUI")
        # VHS lives under the hyphenated pack dir — ComfyUI registers it under
        # a mangled module name, so find its utils module by the tail of the
        # dotted key instead of guessing the pack's sys.modules prefix.
        vhs = next((m for k, m in sys.modules.items()
                    if k.endswith("videohelpersuite.utils") and m is not None), None)
        if vhs is None:
            try:
                import importlib
                vhs = importlib.import_module("videohelpersuite.utils")
            except ImportError as exc:
                raise RuntimeError("OF_PlateAudio needs ComfyUI-VideoHelperSuite loaded") from exc
        try:
            audio = vhs.get_audio(folder_paths.get_annotated_filepath(video), start_time, duration)
        except Exception:
            return (None,)
        # the streamless-audio patch returns a zero-length waveform instead
        # of raising. VideoCombine treats that as a mux and can still fail;
        # None tells it to write the picture with no audio track.
        wave = audio.get("waveform") if isinstance(audio, dict) else None
        # A missing shape is not silence — only a zero-length waveform is.
        # The streamless-audio patch returns shape (1, channels, 0).
        shape = getattr(wave, "shape", None) if wave is not None else None
        if shape is not None and int(shape[-1]) == 0:
            return (None,)
        return (audio,)


NODE_CLASS_MAPPINGS = {
    "OF_MossSFX": OF_MossSFX,
    "OF_SaveAudioWav": OF_SaveAudioWav,
    "OF_PlateAudio": OF_PlateAudio,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "OF_MossSFX": "OF MOSS SoundEffect (prompt → sfx, MLX or CUDA)",
    "OF_SaveAudioWav": "OF Save Audio WAV (loudness-normalized)",
    "OF_PlateAudio": "OF Plate Audio (silent-safe)",
}
