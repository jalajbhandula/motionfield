"""MOSS-SoundEffect v2.0 torch/CUDA runner for OF_MossSFX.

Runs inside the isolated Python 3.12 env the upstream pipeline requires
(github.com/OpenMOSS/MOSS-TTS moss_soundeffect_v2, Apache-2.0) - ComfyUI's
own env can't host its pinned torch/transformers. Called as a subprocess:

  python moss_cuda_runner.py <model_dir> <out.wav> <seconds> <steps> <cfg> <seed>  (prompt on stdin)
"""
import os
import sys

os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")  # skip the multi-minute compile


def main() -> None:
    model_dir, out, seconds, steps, cfg, seed = sys.argv[1:7]
    prompt = sys.stdin.read().strip()
    import torch
    from moss_soundeffect_v2 import MossSoundEffectPipeline

    torch.manual_seed(int(seed))
    pipe = MossSoundEffectPipeline.from_pretrained(model_dir, torch_dtype=torch.bfloat16, device="cuda")
    audio = pipe(prompt=prompt, seconds=float(seconds), num_inference_steps=int(steps), cfg_scale=float(cfg))
    pipe.save_audio(audio, out)


if __name__ == "__main__":
    main()
