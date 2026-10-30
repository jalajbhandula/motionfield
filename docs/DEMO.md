# Demo - the Oct 28 capture pipeline

The demo video is assembled from **real app flows on the Mac, on mock
generation** - every clip is headless Chromium driving the actual routes,
every card is a real SceneSpec render through `scripts/render/export.ts`,
and every badge in `timeline.json` resolves out of the catalog license data
(never typed by hand). Nothing in the pipeline can emit a fake frame.

## One command

```sh
# dev server first (mock provider - no GPU, no closed APIs, no .env needed):
# PUBLIC_BASE_URL must match the dev port - the motion/stage exporters
# render against it, and .env pins it to :3000.
PGLITE_DIR=/tmp/of-demo-pglite GENERATION_PROVIDER=mock LLM_PROVIDER= \
  BETTER_AUTH_URL=http://localhost:3110 PUBLIC_BASE_URL=http://localhost:3110 \
  PORT=3110 npm run dev

# then:
npm run demo:dry            # → /tmp/of-demo-dry/demo.mp4 + timeline.json + captions.srt
```

`demo:dry` runs `tsx scripts/demo/dry.ts`. Flags: `--base <url>`
(default `PLAYWRIGHT_BASE_URL` or `http://localhost:3110`), `--out <dir>`
(must be an `of-demo*` dir under a real temp root - `os.tmpdir()` or `/tmp`
resolved through symlinks - refused otherwise, nuked at the start of each
run so stale artifacts can't leak into the cut).

## What's in a run

1. **profile guard** - `scripts/demo/profile.json` pins the demo brain
   (`ollama` + `qwen3.5:9b`) and the MCP client; `profile-guard.ts` refuses
   closed/hosted providers, remote brain URLs and closed model names.
2. **provision** - a throwaway demo user: signup → pro plan (so the free
   tier's single live job doesn't serialise the takes) → API key (env only,
   never written) → restricted-license opt-in (so the VFX shot's LTX row is
   visible next to the Wan VACE default).
3. **capture** - `shots.ts` is the shot list; each entry declares `route`,
   step primitives (`click`/`fill`/`upload`/`waitFor`/`settle`/`check`/
   `select`/`goto` + `{testid|text|role|css}` selectors), `budget_s`,
   `required`, `source` (`mac`|`gpu`) and catalog `endpoints`. Each shot
   records its own 1920×1080 webm under `capture/clips/`.
4. **mcp-check** - `scripts/demo/mcp-check.ts` npm-links `motionfield-mcp`
   into the out dir and executes `profile.mcp.tool_sequence` for real:
   `run_create` (2-step plan, `ask_first`) → `run_approve` → `run_get` to
   done → `run_edit_step` on s2 → re-approve → `run_get` again. Asserts:
   every listed tool is advertised, the create idempotency contract holds on
   the v1 API (same key replays / different body → 422), s1 keeps its job
   while s2 re-runs, and the edit leaves a `run_step_revisions` row (the
   run's audit trail). Report: `mcp-check.json`.
5. **CLI line** - `motionfield generate motionfield/z-image-turbo/text-to-image
   -p prompt=… --wait --json` via the installed bin; redacted stdout in
   `cli-run.json`.
6. **music bed** - a real `motionfield/acestep/music` job on the mock
   provider returns a real WAV (no GPU needed for the dry run; the real bed
   comes from the GPU smoke below).
7. **cards** - `cards/title|outro|credits.json` are SceneSpec v1 docs with
   `{{TOKEN}}` slots; `cards.ts` fills them with parsed node class names
   (`comfy-nodes/motionfield_nodes`), deduped catalog badges, and the music
   credit, zod-validates, and renders each through the app's own
   `/render/motion` exporter.
8. **assemble** - `assemble.ts` normalizes every clip (speed-to-budget with
   an on-screen `sped up ×N` tag, never a truncated tail), overlays a
   lower-third title + `on this Mac` / `BYO GPU` source chip rendered as a
   transparent PNG in the app's Space Grotesk (this ffmpeg build has no
   `drawtext`, so text lands via the `overlay` filter), xfades
   segments, mixes the bed at −24 dB-ish, and writes `demo.mp4` +
   `timeline.json` + `captions.srt`. A missing required shot fails the
   assemble instead of producing a gappy cut.

## The Oct 28 live pass

The dry run exercises every required shot end to end. For the recorded
demo, the same `scripts/demo/*` pipeline runs against the real app:

- **Brain**: `ollama` + `qwen3.5:9b` (profile-guarded - a closed pick makes
  the run refuse before capture starts).
- **Music**: ACE-Step on the box/GPU - verified by the s14 GPU smoke:
  ```sh
  PORT=3120 PGLITE_DIR=/tmp/of-ws1-gpu/pglite GENERATION_PROVIDER=comfy \
    COMFY_BASE_URL=http://127.0.0.1:8188 npm run dev
  GPU_MAX_SECS=1800 ~/.motionfield/gpu-run ws1-s14 -- \
    npx tsx scripts/ws1-mcp-audio-smoke.mts --base http://localhost:3120
  ```
- **MCP terminal segment**: OpenCode + the `/mcp` snippet (the `mcp` shot
  shows the snippet card; the terminal itself is recorded live).
- **Remote ComfyUI** (BYO GPU) is labelled `cloud-recommended, untested`
  wherever a `gpu` source could appear - nothing in the cut claims a cloud
  run happened.

## Files

```
scripts/demo/
  dry.ts            assistant (npm run demo:dry)
  shots.ts          shot list + step DSL + catalog badge resolution
  capture.ts        Playwright driver → clips + capture/index.json
  mcp-check.ts      real MCP tool sequence + API idempotency checks
  cards.ts          SceneSpec card builder ({{TOKEN}} fills + badge lines)
  assemble.ts       normalize → overlays → xfade → music → timeline/captions
  profile-guard.ts  schema + closed-picks refusal
  profile.json      brain: ollama/qwen3.5:9b · client: opencode
  cards/*.json      title / outro / credits SceneSpec templates
docs/DEMO.md        this file
tests/e2e/ws1-demo.spec.ts        dry-run e2e (video exists, badges, srt, cards)
tests/unit/ws1-demo-security.test.ts  out-dir guard, profile refusal, redaction
```
