# MotionField

**An open-source creative studio built on ComfyUI.** Image, video, audio, 3D,
games and product ads in one app, on open weights, on your own machine.
Run it on a Mac, on a rented RunPod GPU, or with no GPU at all in mock mode.

Built for Comfy's Open Source challenge. The application code is MIT.
Weights and third-party nodes keep their own licenses, shown in the app before a job runs.

[![MotionField demo](docs/media/hero.gif)](docs/media/motionfield.mp4)

[See every studio](#what-you-can-do) · [Models and tools used](#models-and-tools-used) · [Full video demo](docs/media/motionfield.mp4)

| | |
| --- | --- |
| **57** studio endpoints you can run | **74** ComfyUI workflows committed as JSON |
| **21** custom ComfyUI nodes we wrote | **5** ComfyUI Apps you can open in ComfyUI itself |
| **39** MCP tools, plus a CLI, TypeScript and Python SDKs | Chrome and Blender plugins |

## What is new here

- **Try it in three minutes with no GPU.** Mock mode runs every page, the job
  queue and file serving with synthetic results, so anyone can click through the
  whole studio on a laptop. Point it at ComfyUI when you want real renders.
- **Runs on a Mac.** Image, short video, voice, music and sound effects were
  measured on a 32 GB Apple Silicon Mac. Heavier models run on a RunPod GPU over
  one SSH tunnel; set `COMFY_AUDIO_BASE_URL` to keep voice on the Mac while video
  renders on the pod.
- **Our own ComfyUI node pack.** [`comfy-nodes/motionfield_nodes`](comfy-nodes/motionfield_nodes)
  adds 21 nodes: named camera moves turned into per-frame poses (`OF_Trajectory`),
  depth-based camera rigs (`OF_CameraRig`, `OF_DA3Poses`), mattes and mouth masks
  for person swap, relighting, plate audio and provenance tags. 97 Python tests cover them.
- **A full audio side.** Text to speech, voice cloning with consent, music,
  sound effects from a video, and dubbing into another language with the mouth
  re-synced.
- **Game Builder.** One sentence becomes a game spec that the browser plays in a
  sandbox. No GPU.
- **Camera control.** Aim a shot from a still, through depth estimation and Wan.
- **VFX on LTX-2.5.** Frost, embers, vines and other effects grow over real
  footage, with the source audio kept.
- **Honest labels.** Every result in the catalog was rendered by the workflow it
  names. The license is shown before a job runs.
- **Agents can drive it.** The MCP server, CLI and SDKs share the web app's
  catalog, so an MCP client can upload, render and download.

## Run it on this machine

Docker starts the database. It does not download model weights, and neither does `pnpm dev`.

```bash
docker compose up -d db
pnpm install --frozen-lockfile
cp .env.example .env
pnpm db:migrate && pnpm db:seed
GENERATION_PROVIDER=mock pnpm dev
```

Open the printed URL and create an account. The pages, Game Builder, and the saved examples work with no GPU. The header says **GPU not used**.

A real render uses ComfyUI you already have. Leave `GENERATION_PROVIDER=comfy`.

| Where the GPU is | What you start | `COMFY_BASE_URL` |
| --- | --- | --- |
| This Mac | ComfyUI on port 8188, then `comfy-api-proxy` on 8189 | `http://127.0.0.1:8189` |
| RunPod | ComfyUI on the pod, then `ssh -N -L 18189:127.0.0.1:8189 root@<pod> -p <port>` | `http://127.0.0.1:18189` |

Restart the app after changing `.env`. One process sends image, video, and 3D to that one URL. To keep voice on the Mac while video uses the pod, set `COMFY_AUDIO_BASE_URL=http://127.0.0.1:8189`. The pod must be able to reach `PUBLIC_BASE_URL` to fetch uploads. Weights go in ComfyUI's own `models/` folder. The list is [MODELS.md](MODELS.md).

## Five flows to look at

These are the ones to open first. Each one has a saved result in the repo, and Game Builder plays in the browser with no GPU.

1. **Image** — text to image and instruction edits. Open `/ai/image`.
2. **Video and VFX** — LTX-2.5 is the model in the effect shot. Open `/ai/video`.
3. **Product Ads** — a product photo in a new set. Open `/product-ads`.
4. **Dub and lip sync** — a new language track with the mouth re-synced. Open `/dub-translate`.
5. **Game Builder** — one sentence becomes a game the browser draws. Open `/games`. No GPU.

The homepage also orbits a perfume bottle built with TRELLIS.2 ([photo](public/examples/feature/trellis2-image-to-3d.jpg), [model](public/examples/feature/trellis2-image-to-3d.glb)). That is a real result. It is not one of the five flows above.

The header says whether the GPU is connected. Mock mode still runs every page with synthetic output.

## What you can do

**Pictures**

- **Image**: text to image, edits by instruction, background removal, color grade.
- **Video**: a prompt or a still becomes a clip, with camera moves and end frames.
- **Effects**: one-click effects on footage you already have.
- **Camera move**: re-aim the shot after the render.

**People**

- **Person swap**: replace a consented person and keep the shot.
- **Object swap**: swap a prop the same way.
- **Lip sync**: a face and a voice track become a talking shot.
- **Dub**: re-voice a clip in another language and re-sync the mouth.
- **Voice studio**, **music & SFX**: voices, soundtracks, effects.

**Things**

- **Product ads**: drop a product photo into a new set.
- **3D models**: one photo in, a textured GLB out, orbitable in the browser.
- **3D scenes**: block and stage a shot in 3D, then render it.
- **Game builder**: a sentence becomes a playable browser game.

**Pipelines**

- **Canvas**: prompt, image, video and audio nodes wired into chains on one board.
- **AI Assistant**: describe the result; it picks the studio.
- **MCP, SDK, CLI**: drive every job from an agent or a script.

The full studio list lives under **Studio tools** in the app. A page being
visible does not mean every weight is installed on your machine — the catalog
says so on those rows instead of pretending.

<table>
  <tr>
    <td><img src="docs/screenshots/image.png" alt="Image studio"/><br/><sub>Image studio — model and license shown up front</sub></td>
    <td><img src="docs/screenshots/video.png" alt="Video studio"/><br/><sub>Video studio — camera presets, real render</sub></td>
    <td><img src="docs/screenshots/assistant.png" alt="AI Assistant"/><br/><sub>AI Assistant — describe it, it picks the studio</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/games.png" alt="Game Builder"/><br/><sub>Game Builder — playable in the page</sub></td>
    <td><img src="docs/screenshots/ads.png" alt="Product Ads"/><br/><sub>Product Ads — compare the source and generated scene</sub></td>
    <td><img src="docs/screenshots/scene3d.png" alt="3D scene"/><br/><sub>3D scene — grey-box blocking plus camera still</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/dub.png" alt="Dub and translate"/><br/><sub>Dub & Translate — before and after, re-synced lips</sub></td>
    <td><img src="docs/screenshots/audio.png" alt="Audio studio"/><br/><sub>Audio studio — music, voices and sound effects</sub></td>
    <td><img src="docs/screenshots/canvas.png" alt="Canvas"/><br/><sub>Canvas — nodes wired into a pipeline</sub></td>
  </tr>
</table>

Canvas connects generation jobs into a reusable board with saved layouts,
undo, and import/export. Game Builder creates a checked game specification;
the browser plays it with the local runtime in
[`public/games/runtime.js`](public/games/runtime.js). A configured language
model can write the spec; templates provide a fallback.

## Hardware by feature

MotionField code is MIT; the weights are not, and each keeps its own license.
The catalog shows the license before a job runs. The full per-file audit —
every weights file, source repo, license and measured footprint — is in
[MODELS.md](MODELS.md) and [docs/LICENSES.md](docs/LICENSES.md).

| Feature | Main models or tools | License of the listed models | Hardware notes |
|---|---|---|---|
| Image, img2img | Z-Image-Turbo + Qwen3-4B encoder | Apache-2.0 | Yes |
| Edit, product shots, compose | FLUX.2 Klein 4B | Apache-2.0 | Yes |
| Edit by instruction | Qwen-Image-Edit-2511 | Apache-2.0 | Cloud or CUDA recommended (~29 GB) |
| Text/image to video, VFX | LTX-2.5 and legacy LTX-Video 2B | LTX-2.x Community / Open RAIL-M | LTX-Video 2B was measured on a 32 GB Mac; LTX-2.5 is a larger GPU workflow |
| Video, swaps, motion | Wan 2.1, Wan 2.2, Wan VACE | Apache-2.0 | Short VACE 1.3B tests ran on a 32 GB Mac; larger variants need more GPU memory |
| Character swap | Wan 2.2 Animate 14B + DWPose | Apache-2.0, plus component licenses | CUDA/cloud recommended for Animate |
| Lip sync | MuseTalk, Whisper, sd-vae-ft-mse | MIT; DWPose Apache-2.0 | MuseTalk weights are about 4 GB; the chosen video stage adds its own requirements |
| Dub & translate | Kokoro, Chatterbox, MuseTalk | Apache-2.0 / MIT; other components have their own licenses | Depends on the selected translation and video stages |
| Music | ACE-Step 1.5 | Apache-2.0 for the Comfy-Org package | Tested on Apple Silicon; roughly 16 GB peak RAM in the documented run |
| Sound effects | MOSS SoundEffect v2 | Apache-2.0 | Apple Silicon MLX or a separately provisioned CUDA environment |
| Cutout, depth, masks | BiRefNet, Depth Anything V2, SAM2 | MIT / Apache-2.0 | Requirements vary by model and workflow |
| Upscale, frame interpolation | Real-ESRGAN, RIFE | BSD-3-Clause / MIT | Real-ESRGAN was measured on a 32 GB Mac |
| Textured 3D models | TRELLIS.2 + DINOv3 | TRELLIS.2 MIT; DINOv3 has its own restricted license | CUDA GPU required for the documented TRELLIS.2 workflow |
| AI Assistant and game planning | Configured language model, or built-in planner/templates | Depends on the configured model | No language model is required for the built-in fallback |

These are the main components, not an exhaustive dependency list. Model and
node licenses can differ within a workflow. Restricted tiers are marked in
`scripts/runpod/models.cloud.json`; setup requires `--with-restricted` for them.

## Requirements

| | |
| --- | --- |
| Runtime | Node.js 22.18+, pnpm 12.15.0 (`packageManager` in `package.json`) |
| Database | Docker, then Postgres on port 5432. `sh start.sh` starts it |
| Rendering | Mock provider works with no GPU; model-backed renders need ComfyUI and `comfy-api-proxy` on :8189. Some workflows require ComfyUI 0.41 or newer |
| GPU | Your own, or a rented pod over SSH — see [docs/CLOUD.md](docs/CLOUD.md) |

## Install

1. Install and configure:

   ```bash
   pnpm install --frozen-lockfile
   cp .env.example .env        # set a real BETTER_AUTH_SECRET inside
   docker compose up -d db
   ```

   In `.env`, set:

   ```dotenv
   DATABASE_URL=postgres://motionfield:motionfield@127.0.0.1:5432/motionfield
   ```

   ```bash
   pnpm db:migrate && pnpm db:seed
   ```

2. Run with synthetic results — no GPU needed:

   ```bash
   GENERATION_PROVIDER=mock pnpm dev
   ```

3. Open `http://localhost:3000` and create an account.

`pnpm health` checks the whole setup in one pass — runtime, auth, database,
workflows, ComfyUI, media tools — and prints PASS, WARN or FAIL with the fix
for each line. Run it when something is wrong; a FAIL tells you what to fix.

`sh start.sh` (or `start.command` on macOS) does the whole sequence: install,
migrate, seed, build when stale, start. `--provider mock` keeps it synthetic.

The database is Postgres in Docker (`docker-compose.yml`). `sh start.sh` runs
`docker compose up` when `DATABASE_URL` is empty.

## Point it at a GPU

1. Install ComfyUI, the custom nodes and the weights you want. Follow
   [docs/SETUP.md](docs/SETUP.md) and [MODELS.md](MODELS.md).
2. ComfyUI listens on `8188`; the app talks to the API proxy on `8189`.
3. In `.env`:

   ```dotenv
   GENERATION_PROVIDER=comfy
   COMFY_BASE_URL=http://127.0.0.1:8189
   PUBLIC_BASE_URL=http://localhost:3000
   ```

4. `pnpm dev`, pick a model whose weights are installed, and run it. A remote
   ComfyUI must be able to reach `PUBLIC_BASE_URL` to fetch your media.

A rented GPU is the same through an SSH tunnel — steps, licenses and disk
budgets in [docs/CLOUD.md](docs/CLOUD.md), measured timings in
[docs/BENCHMARKS.md](docs/BENCHMARKS.md):

```bash
ssh -N -L 18189:127.0.0.1:8189 root@<pod-host> -p <ssh-port>
GENERATION_PROVIDER=comfy COMFY_BASE_URL=http://127.0.0.1:18189 pnpm dev
```

Set `COMFY_API_KEY` when the proxy asks for one.

## How it is built

```
Browser (Next.js)  ──>  MotionField server (API routes and job queue)
                            ├──> local media tools and recipes
                            ├──> optional configured language model
                            └──> comfy-api-proxy ──> ComfyUI (your GPU)
```

- Each model-backed tool is a ComfyUI graph committed as JSON in
  [`workflows/`](workflows). The server submits that graph. Recipes can chain
  a graph with local processing. The web app, CLI, and MCP server share one
  catalog, and `scripts/comfy-apps/build.ts` builds ComfyUI forms from
  supported graphs.
- The mock provider returns canned outputs so the whole app — queue, consent,
  polling, file serving — runs in CI and on machines with no GPU.
- Output media is served from `/files/` after an ownership check.

## Settings that matter

The full list is [.env.example](.env.example).

| Variable | Purpose |
|---|---|
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | Auth secret and the URL you open |
| `DATABASE_URL` | Docker Postgres. `docker compose up -d db` then this URL |
| `GENERATION_PROVIDER` | `mock` or `comfy` |
| `COMFY_BASE_URL`, `COMFY_API_KEY` | API proxy, and a key if it requires one |
| `PUBLIC_BASE_URL` | Address ComfyUI uses to fetch inputs |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL` | Assistant and game writer. Unset: fixed planner and game templates |
| `MOTIONFIELD_TRUSTED_ORIGINS` | Extra origins, such as a LAN address |
| `STRIPE_SECRET_KEY`, `RESEND_API_KEY` | Optional billing and email |

## Develop

```bash
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
GENERATION_PROVIDER=mock pnpm test:e2e
```

Browser tests use mock generation. They verify behavior, not picture quality.

| Path | What lives there |
|---|---|
| `src/app/` | Pages and API routes |
| `src/lib/` | Catalog, providers, game spec and runtime wiring |
| `workflows/` | ComfyUI graphs the app executes |
| `comfy-nodes/` | Custom nodes and ComfyUI App files |
| `public/games/runtime.js` | The canvas runtime that plays a GameSpec |
| `models/`, `docs/LICENSES.md` | Weight inventory and licenses |

Agents can drive the same jobs through [docs/MCP.md](docs/MCP.md),
[docs/API.md](docs/API.md), the [TypeScript SDK](packages/sdk-ts/README.md),
the [Python SDK](packages/sdk-py/README.md) and the [CLI](docs/CLI.md).

## When it breaks

- **`missing placeholders`** — a graph gained a `{{X}}` the catalog does not
  fill. Check `src/lib/generation/comfy.ts` and that endpoint's
  `providers.comfy.map`.
- **`Unknown node type`** — ComfyUI is missing a node. Re-run setup and
  `scripts/runpod/validate.ts --lint`.
- **Images 404** — media is served from `/files/` after an ownership check.
  See [docs/SMOKE.md](docs/SMOKE.md).
- **Assistant or game writer is quiet** — set `LLM_*` and have that model
  running, or expect the template path.
- **Mock frames instead of a real render** — check `GENERATION_PROVIDER`,
  `COMFY_BASE_URL`, and the installed weights.
- **Database is unreachable** — start it with `docker compose up -d db`.

## Limits

Some video and audio weights are restricted.
`scripts/runpod/models.cloud.json` marks them, and setup will not install
those tiers unless you pass `--with-restricted`. Likeness tools require
consent: [docs/POLICY.md](docs/POLICY.md).

Local unit and browser tests do not prove picture quality. Many camera presets still
show a path diagram instead of a generated video preview.

## Models and tools used

Taken from [`models/manifest.json`](models/manifest.json) (95 weights files)
and the committed graphs in [`workflows/`](workflows). Licenses are in
[docs/LICENSES.md](docs/LICENSES.md) and [MODELS.md](MODELS.md).

**Video**
- [Wan 2.1](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B) T2V 1.3B, I2V 14B, FLF2V 14B, [VACE 1.3B](https://huggingface.co/Wan-AI/Wan2.1-VACE-1.3B) and the Fun Control-Camera 1.3B (Alibaba Wan-AI, PAI). Apache-2.0.
- [Wan 2.2](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B) TI2V 5B, I2V/T2V A14B, [Animate 14B](https://huggingface.co/Wan-AI/Wan2.2-Animate-14B) and S2V 14B, with the umt5-xxl text encoder and the lightx2v step-distill LoRA. Apache-2.0.
- [LTX-2.5](https://huggingface.co/Lightricks/LTX-Video) (Lightricks) for text and image to video, camera motion, VFX plates and talking portraits; LTX-Video 2B 0.9.5 as the Mac path. LTX-2.x Community / Open RAIL-M.
- [Uni3C](https://huggingface.co/ewrfcas/Uni3C) camera control. Apache-2.0.

**Images**
- [Z-Image Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) with the Qwen3-4B encoder (Tongyi-MAI). Apache-2.0.
- [FLUX.2 klein 4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8) (Black Forest Labs) for edits, inpaint and product placement. Apache-2.0.
- [Qwen-Image-Edit 2511](https://huggingface.co/Qwen/Qwen-Image-Edit-2511) and 2509 with Qwen2.5-VL 7B, and the Multiple-angles LoRA (dx8152). Apache-2.0.

**People, pose, depth and 3D**
- [DWPose](https://huggingface.co/yzd-v/DWPose), [Depth Anything V2 Small](https://huggingface.co/depth-anything/Depth-Anything-V2-Small) and [Depth Anything 3](https://huggingface.co/depth-anything/DA3-BASE). Apache-2.0.
- [MoGe-2](https://huggingface.co/Ruicheng/moge-2-vitl) (Microsoft) for geometry scans. MIT.
- [TRELLIS.2 4B](https://huggingface.co/microsoft/TRELLIS.2-4B) (Microsoft) with DINOv3 (Meta, its own license) for textured 3D. MIT.
- [BiRefNet](https://huggingface.co/ZhengPeng7/BiRefNet) cutouts (MIT) and SAM 3.1 tracking (Meta SAM License).

**Audio and lip sync**
- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) speech (Apache-2.0) and [Chatterbox](https://huggingface.co/ResembleAI/chatterbox) voice cloning (MIT).
- [ACE-Step 1.5](https://huggingface.co/ACE-Step/Ace-Step1.5) music. Apache-2.0.
- [MOSS SoundEffect](https://github.com/OpenMOSS/MOSS-TTS) sound effects, on MLX or CUDA. Apache-2.0.
- [MuseTalk](https://huggingface.co/TMElyralab/MuseTalk) lip sync with sd-vae-ft-mse and [Whisper](https://github.com/openai/whisper) / whisper.cpp for transcripts. MIT.
- wav2vec2-large-960h (Meta) for Wan S2V. Apache-2.0.

**Finishing**
- [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) upscaling (BSD-3-Clause) and RIFE frame interpolation (MIT).

**Tools**
- [ComfyUI](https://github.com/Comfy-Org/ComfyUI) and [comfy-api-proxy](https://github.com/Comfy-Org/comfy-api-proxy) (Comfy Org).
- Custom node packs: our [`motionfield_nodes`](comfy-nodes/motionfield_nodes), ComfyUI-LTXVideo, ComfyUI-VideoHelperSuite, comfyui_controlnet_aux, ComfyUI-MuseTalk, comfyui-kokoro and ComfyUI-Chatterbox.
- An optional local language model (for example through Ollama) for the AI Assistant and Game Builder; built-in planners and templates work without one.
- ffmpeg and ffprobe for muxing, grading, captions and checks.
- App: Next.js, React, Postgres (Docker), Better Auth, three.js, the MCP SDK and Playwright for tests.

No partner nodes or closed-source APIs are needed for any studio.

## Credits

Built on [ComfyUI](https://github.com/comfyanonymous/ComfyUI) and open
weights, including Wan, Qwen, FLUX.2, LTX, Kokoro, Chatterbox, BiRefNet, Depth
Anything, Real-ESRGAN and RIFE. Per-weight attribution is in
[docs/LICENSES.md](docs/LICENSES.md).

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
Report security issues in private.
