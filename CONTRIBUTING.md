# Contributing to MotionField

Open an issue describing the problem, expected behavior and a minimal reproduction before proposing a large change. Keep fixes focused and preserve existing work in your checkout.

## Run locally

Follow [README.md](README.md) for dependencies and setup. Use a separate database and build directory for validation so you do not change your development data.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm audit:licenses --check
python3 scripts/lint-workflows.py
```

Run browser tests with mock generation and an isolated database. The test configuration blocks access to real ComfyUI endpoints; its Whisper fixture tests application plumbing, not speech-recognition quality.

```sh
PGLITE_DIR=/tmp/motionfield-e2e MOTIONFIELD_DIST_DIR=.next-e2e PORT=3100 \
  GENERATION_PROVIDER=mock pnpm test:e2e
```

## Workflows and model changes

Include a regression check for a confirmed defect. Preserve input geometry, audio, ownership checks and cancellation behavior. Keep optional inputs genuinely optional.

Credit every model and custom node. Regenerate license artifacts with `scripts/gen-licenses.ts`, `scripts/gen-manifest.ts` and `scripts/license-audit.ts --write`, then run the freshness check. Keep restricted models behind their existing opt-in.

A mock job, working page or valid video container is not proof of generation quality. For a real executor change, record inputs, parameters, job ID, output, runtime and a visual/audio verdict. Keep unverified executors gated until their real output passes review.

Do not commit credentials, local databases, private uploads or generated user content. Use generated examples you have the right to redistribute.
