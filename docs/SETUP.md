# Setup

## Sign-in providers

Email + password sign-in works out of the box (better-auth, `BETTER_AUTH_SECRET`
+ `BETTER_AUTH_URL` required). Social sign-in is opt-in per provider: a provider
is offered on `/login` and `/signup` only when both of its env vars are set, so
deployments show exactly the providers they have configured.

| Provider  | Env vars                                                       |
| --------- | -------------------------------------------------------------- |
| Google    | `BETTER_AUTH_GOOGLE_CLIENT_ID` / `BETTER_AUTH_GOOGLE_CLIENT_SECRET` |
| Apple     | `BETTER_AUTH_APPLE_CLIENT_ID` / `BETTER_AUTH_APPLE_CLIENT_SECRET`   |
| Microsoft | `BETTER_AUTH_MICROSOFT_CLIENT_ID` / `BETTER_AUTH_MICROSOFT_CLIENT_SECRET` |
| GitHub    | `BETTER_AUTH_GITHUB_CLIENT_ID` / `BETTER_AUTH_GITHUB_CLIENT_SECRET`   |

Callback URL to register with each provider:

```
<BETTER_AUTH_URL>/api/auth/callback/<provider>
```

For GitHub that's `<BETTER_AUTH_URL>/api/auth/callback/github` - e.g.
`http://localhost:3000/api/auth/callback/github` in a local dev setup. Create a
GitHub OAuth App (Settings → Developer settings → OAuth Apps) with that exact
"Authorization callback URL", then set the env vars and restart the server.

## Local ComfyUI (self-hosted, verified on macOS/Apple Silicon)

```bash
git clone https://github.com/comfyanonymous/ComfyUI && cd ComfyUI
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
# custom nodes used by our workflows:
git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite custom_nodes/ComfyUI-VideoHelperSuite
.venv/bin/pip install -r custom_nodes/ComfyUI-VideoHelperSuite/requirements.txt
git clone https://github.com/Fannovel16/comfyui_controlnet_aux custom_nodes/comfyui_controlnet_aux
.venv/bin/pip install -r custom_nodes/comfyui_controlnet_aux/requirements.txt   # DWPose + Depth-Anything preprocessors (weights auto-fetch)
git clone https://github.com/stavsap/comfyui-kokoro custom_nodes/comfyui-kokoro
.venv/bin/pip install -r custom_nodes/comfyui-kokoro/requirements.txt      # Kokoro TTS (onnxruntime + espeakng-loader wheels)
git clone https://github.com/wildminder/ComfyUI-Chatterbox custom_nodes/ComfyUI-Chatterbox
.venv/bin/pip install -r custom_nodes/ComfyUI-Chatterbox/requirements.txt  # Chatterbox voice clone (+ torchaudio soundfile)
.venv/bin/pip install torchaudio soundfile                               # Chatterbox audio I/O
/path/to/motionfield/scripts/setup-musetalk.sh "$PWD"                      # MIT - patched lip-sync pack
#   ^ from this repo: ./scripts/setup-musetalk.sh <comfyui-dir> clones
#     chaojie/ComfyUI-MuseTalk, pins 84f4b6d, applies
#     scripts/patches/comfyui-musetalk-mps.patch (Apple-Silicon + DWPose
#     landmarks/bbox - no mmlab, no research-licensed S3FD) and installs deps.
# Kokoro + Chatterbox weights auto-download on first generation (310 MB + ~2.7 GB).
# MuseTalk weights (~4 GB) go to models/diffusers/TMElyralab/MuseTalk/ - layout in MODELS.md.
# open-weights models (into models/):
#   checkpoints/ltx-video-2b-v0.9.5.safetensors - huggingface.co/Lightricks/LTX-Video
#   text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors - hf.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged
#   vae/wan_2.1_vae.safetensors - same repo
#   diffusion_models/wan2.1_vace_1.3B_fp16.safetensors - same repo (1.3B fits local; 14B → cloud)
#   diffusion_models/z_image_turbo_int8_convrot.safetensors - hf.co/Comfy-Org/z_image_turbo
#   text_encoders/qwen_3_4b_fp8_mixed.safetensors - same repo
#   background_removal/birefnet.safetensors - hf.co/Comfy-Org/BiRefNet
#   diffusion_models/flux-2-klein-4b.safetensors - hf.co/Comfy-Org/Flux-2-Klein-4B
#     (split_files/diffusion_models/, 7.75 GB distilled bf16; upstream black-forest-labs/FLUX.2-klein-4B)
#   vae/flux2-vae.safetensors - same repo
#   (qwen_3_4b encoder above is shared with klein)
.venv/bin/python main.py --port 8188

# in another terminal: the Comfy API v2 proxy the SDK talks to (serves :8189)
pip install comfy-api-proxy   # or: uv tool install comfy-api-proxy
comfy-api-proxy start --state-dir ~/.motionfield/comfy-proxy
```

Then set `GENERATION_PROVIDER=comfy` + `COMFY_BASE_URL=http://127.0.0.1:8189`
in `.env`, and check the round trip with
`pnpm exec tsx --env-file=.env scripts/comfy-smoke.ts ltx-txt2video.json "a paper boat on a pond"`.

The provider (`src/lib/generation/comfy.ts`) runs every workflow through the
official **Comfy SDK** (`@comfyorg/sdk`, Comfy API v2), so self-hosted, API
deployments and Comfy Cloud all take the same API-format workflow JSONs -
only `COMFY_BASE_URL` and the key change:

| Surface | URL | Auth |
|---|---|---|
| Comfy Cloud (managed) | `https://cloud.comfy.org` | `COMFY_API_KEY` (Bearer) |
| Comfy API deployment | `https://<deployment>.run.comfy.app` | `COMFY_API_KEY` |
| Self-hosted ComfyUI (default) | `http://127.0.0.1:8189` (`comfy-api-proxy`) | none |

## Database

Local setup is Postgres in Docker:

```bash
docker compose up -d db
```

`DATABASE_URL=postgres://motionfield:motionfield@127.0.0.1:5432/motionfield`

`sh start.sh` starts that container when `DATABASE_URL` is empty. There is no second database.

`scripts/worker.ts` runs against `DATABASE_URL`. The worker e2e needs one too:
`DATABASE_URL=postgres://… pnpm exec playwright test tests/e2e/ws1-runs-worker.spec.ts`.

## Trusted proxies (rate limiting)

`MOTIONFIELD_TRUSTED_PROXIES` is a comma-separated list of IP/CIDR entries -
the proxies in front of the app whose addresses may be trusted when reading
`x-forwarded-for`. The auth rate limiter walks the forwarded chain
right-to-left, skipping trusted hops, so per-IP buckets follow the real
client.

**Unset by default**: forwarded IP headers are ignored entirely, so a direct
client cannot spoof `x-forwarded-for` to borrow someone else's rate-limit
bucket. Set it when you put a real proxy (nginx, a cloud LB) in front -
otherwise every request lands in the proxy's bucket.

## Tests

`pnpm test` runs the unit suite (Vitest). The end-to-end suite is Playwright -
`pnpm test:e2e` starts the dev server on its own port with the mock generation
provider, so no real GPU work happens. First time only,
install the browser binary:

```
pnpm exec playwright install chromium
```

## MCP server

`motionfield-mcp` is the stdio MCP server (`packages/mcp`, installed by
`./scripts/install-cli.sh`). Configuration is env-only -
`MOTIONFIELD_URL` (default `http://localhost:3000`), `MOTIONFIELD_API_KEY`
(required), `MOTIONFIELD_TOOLSETS` (default `core,3d`; `all` enables
everything), `MOTIONFIELD_MCP_OUT_DIR` (default `./motionfield-out`). See
[docs/MCP.md](./MCP.md) for client configs (Claude Code, Codex, Cursor,
OpenCode) and the security posture.
