# MotionField MCP server (`motionfield-mcp`)

An MCP server that exposes the MotionField **v1 API** to MCP clients over stdio -
the same wire contract the CLI and SDKs use. It talks HTTP only; it never
touches the database, providers, or internals. Every job and upload it creates
is tagged `source: "mcp"` via the `X-MotionField-Source` header.
`motionfield-mcp-http` serves the same tools over the MCP **Streamable HTTP**
transport - see [Remote (Streamable HTTP)](#remote-streamable-http).

- Requires **Node ≥22.18** (the `.mts` sources run through type stripping - no
  build step) and a running MotionField (`pnpm dev`).
- Install both binaries: `./scripts/install-cli.sh` links `motionfield`,
  `motionfield-mcp` and `motionfield-mcp-http` into your npm prefix `bin`.
- `stdout` carries the MCP protocol only. All diagnostics go to `stderr`,
  redacted - `of_<id>_<secret>` key material never reaches a stream.

## Configuration

| Env | Default | Notes |
| --- | --- | --- |
| `MOTIONFIELD_API_KEY` | - (required) | `of_…` from Settings → API keys. Missing → stderr message, exit 2. |
| `MOTIONFIELD_URL` | `http://localhost:3000` | the MotionField base URL |
| `MOTIONFIELD_TOOLSETS` | `core,3d` | comma list; `all` enables every toolset |
| `MOTIONFIELD_MCP_OUT_DIR` | `./motionfield-out` | where `job_download` writes outputs |

At startup the server fetches `GET /api/v1/capabilities` and
`GET /api/v1/models` **once** and computes the advertised tool set as
*enabled toolsets ∩ reported capabilities ∩ server model catalog*. If a
fetch fails the server still starts - gated tools answer `not_available`
instead of crashing. A tool that exists but isn't advertised still answers
calls with a `not_available` tool error. Endpoint-pinned tools disappear
with their endpoint, so a restricted-license model only ever appears after
the caller opts in server-side.

Config format per client - every snippet below is rendered verbatim from
`src/app/mcp/snippets.ts`, the same module the `/mcp` page serves:

- **Claude Code** - `.mcp.json` in the project, or `claude mcp add`:
  https://code.claude.com/docs/en/mcp
- **Codex CLI** - `[mcp_servers.motionfield]` in `~/.codex/config.toml`:
  https://github.com/openai/codex/blob/main/docs/config.md
- **Cursor** - `~/.cursor/mcp.json` or `.cursor/mcp.json` in the project:
  https://cursor.com/docs/mcp
- **OpenCode** - `mcp` in `opencode.json(c)` (project or `~/.config/opencode/`):
  https://opencode.ai/docs/mcp-servers/

### Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "motionfield": {
      "command": "motionfield-mcp",
      "env": {
        "MOTIONFIELD_API_KEY": "of_…"
      }
    }
  }
}
```

or `claude mcp add motionfield --env MOTIONFIELD_API_KEY=of_… -- motionfield-mcp`

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.motionfield]
command = "motionfield-mcp"
env = { MOTIONFIELD_API_KEY = "of_…" }
```

or `codex mcp add motionfield --env MOTIONFIELD_API_KEY=of_… -- motionfield-mcp`

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "motionfield": {
      "command": "motionfield-mcp",
      "env": {
        "MOTIONFIELD_API_KEY": "of_…"
      }
    }
  }
}
```

### OpenCode (`opencode.json`)

```json
{
  "mcp": {
    "motionfield": {
      "type": "local",
      "command": [
        "motionfield-mcp"
      ],
      "enabled": true,
      "environment": {
        "MOTIONFIELD_API_KEY": "of_…"
      }
    }
  }
}
```

### Any other stdio client

Any MCP client that launches a stdio command works the same way - point it at
`motionfield-mcp` with the env vars in its own env/env-block format:

```json
{
  "command": "motionfield-mcp",
  "env": {
    "MOTIONFIELD_URL": "http://localhost:3000",
    "MOTIONFIELD_API_KEY": "of_…"
  }
}
```

### Worked example - OpenCode + a local open-weights model

`motionfield-mcp` is model-agnostic - any MCP-capable client drives it. This
`opencode.jsonc` pairs it with Ollama (`ollama serve` on this machine, model
pulled once with `ollama pull qwen2.5-coder:14b`) so the whole loop stays
local and open-weights:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "ollama/qwen2.5-coder:14b",
  "provider": {
    "ollama": { "models": { "qwen2.5-coder:14b": {} } }
  },
  "mcp": {
    "motionfield": {
      "type": "local",
      "command": ["motionfield-mcp"],
      "environment": {
        "MOTIONFIELD_URL": "http://localhost:3000",
        "MOTIONFIELD_API_KEY": "of_…"
      }
    }
  }
}
```

Start `opencode` in that project and ask for *"use the direct-shot prompt to
make a 5-second dolly-in on a neon sign"*. The local model picks up the
`direct-shot` prompt, calls `models_list` → `estimate` → `generate` itself
against your running app, and reports the file `job_download` wrote.

## Tools (20 `core` + 2 `3d` + 17 `studio`)

| Tool | Capability | What it does |
| --- | --- | --- |
| `models_list` | `models` | endpoint catalog - `kind` filter; `goal` re-ranks by token overlap with id/label/tags (deterministic, no LLM) |
| `model_schema` | `models` | one endpoint's full record - inputs schema, license, estimate |
| `presets` | `presets` | `list` / `get` / `resolve` named param recipes - resolve previews the merged params without a job |
| `skills` | `skills.read` | `list` / `get` skill pipelines + generated SKILL.md; `run` starts a run with `{slug, brief, params?/answers?, inputs?}` (needs `runs`); `import` gates on `skills.import` → `not_available` today |
| `estimate` | `estimate` | credit + USD preview |
| `upload` | `uploads` | `{path}` local media file **or** `{url}` remote fetch → `{url}` for params |
| `generate` | `jobs` | submit one job (optional `wait_s` ≤ 50) |
| `generate_batch` | `jobs` | `requests` - up to 12 endpoint+params items, per-item errors in place |
| `job_status` | `jobs.list` | live view of one job |
| `job_wait` | `jobs.list` | wait on up to 12 ids (≤50 s) |
| `job_cancel` | `jobs` | cancel queued/in-progress |
| `job_download` | `jobs` | save outputs into `MOTIONFIELD_MCP_OUT_DIR` |
| `jobs_list` | `jobs.list` | filter by ids, kind, source, status, cursor |
| `assets_list` | `assets` | generated assets, kind/source/cursor filters |
| `system_status` | `system` | `{system, account}` - queue depth, machine-wide `gpu.busy`, tier, disk + caller's `{plan, credits}`; never the key |
| `run_create` | `runs` | create a durable run - `{plan}` literal plan, `{skill, brief, params?/answers?}` for a skill pipeline, or `{brief, planner?}` for a planner-built plan; `inputs` supply media (text and skill runs only), `mode` (auto\|offline) + `ask_first` optional |
| `run_get` | `runs` | one run's live view - status, steps (status/rev/outputs/error), estimate, planner |
| `run_approve` | `runs` | release an `awaiting_approval` run - idempotent like the control verbs |
| `run_edit_step` | `runs` | `{id, step_id, rev, title?, params?}` - `rev` is the step's current revision from `run_get`; a stale rev is `stale_revision` carrying `head_rev` |
| `run_control` | `runs` | `pause` / `resume` / `stop` (`cancel` accepted as an alias for `stop`) |

`jobs_list{source}` and `assets_list{source}` additionally need `jobs.source`.
The five `run_*` tools are listed only while the API reports `runs` - on a
server without it they stay hidden and calls answer `not_available`, the same
as any other unadvertised tool.
Registered-for-later toolsets: `sites`, `blender` -
`MOTIONFIELD_TOOLSETS=all` enables them as tools land.

### 3d toolset (`3d` - on by default)

| Tool | Gate | What it does |
| --- | --- | --- |
| `stage` | capability `stage` | the `/api/stage` 3D-scene surface - `list`/`create` (`empty:true` mints the default scene, `prompt` runs the writer), `get`, `inspect` (`t` = meta\|tree\|shots\|physics\|problems, optional `rev`), `apply` (`base_revision` + `ops[]` + optional `selection`/`idempotency_key`), `revisions`, `revision`, `restore`. A stale base is `stale_revision` carrying `head_rev`; an idempotency-key reuse with a different body is `idempotency_mismatch`; a foreign id is `not_found`. |
| `anim_clips` | capability `anim_clips` | animation-clip search - the wrapper isn't built; answers `not_available` naming the capability and its owner step (WS5b S1) |

`stage` is a **capability**, not a catalog endpoint - it lists when the API
reports `stage`, which it does while the `/api/stage` routes exist. Renders
and GLB exports happen on the Stage page (the browser renders them); the
`stage` tool has no render/export action.

## Studio toolset (`studio` - off by default; `MOTIONFIELD_TOOLSETS=studio` or `all`)

The 17 studio tools. A tool lists when its capability is reported **or** one
of its endpoints is in the startup model catalog. Tools whose wrapper isn't
built yet are **never** listed - whatever the server reports - and calls
answer `not_available` naming the capability, its owner step, and that the
MCP wrapper isn't built yet. Job tools return the job (optional `wait_s`
≤ 50 like `generate`); media args are `/files/` urls you own (from `upload`
or a job output) - a foreign url is the API's `not_found`.

| Tool | Gate | What it does |
| --- | --- | --- |
| `refs` {list, get, create} | capability `refs` | named `@refs` over `/api/v1/refs` - your own images, mentioned as `@name` in briefs and plans; person/character needs `likeness_consent:true` |
| `person_swap` | endpoint `wan-vace/character-swap` (or `wan-animate/character-swap` when that is the one listed) | `video_url` + `image_url` + `likeness_consent:true` → performer swap |
| `director_shot` | endpoint `director/generate` | `prompt` + start `image_url`, `moves` (≤3 catalog ids), `lights` (≤2 `az:el:color:hardness`), `lens`/`sensor`/`aperture`/`body`, `emotion{name,intensity}`, `backend` (wan-vace default - runs locally; ltx is a restricted opt-in), `takes` 1-4 (a job each); every mapped field is checked against the endpoint's live schema |
| `motion_graphics` | endpoint `motion-render/mp4` | `spec_id` (a render_specs row you own) + optional `values` overrides → the deterministic three.js exporter's MP4 |
| `voices` {list, create} | endpoint `chatterbox/voice-clone` | `create{audio_url, prompt, consent:true}` → cloned speech; `consent` omitted → `consent_required`; `audio_url` omitted → `invalid_params` with the `/audio` recorder page; `list` → `not_available` until capability `voices` |
| `characters` {list, create} | capability `characters` | not in this build yet - the MCP wrapper isn't built |
| `reshoot` | endpoint `motionfield/reshoot/video` | `video_url` + optional `moves` (≤3 catalog ids, `'+'`-joined), `prompt`/`negative_prompt`, `backend` (local default; cloud is Uni3C 14B), `strength`/`distance`/`steps`/`seed`. The tool calls `POST /api/v1/probe` first and submits the probe-stamped `frames`/`fps`/`duration`/`width`/`height` the endpoint requires - timing stays frame-exact, output is silent |
| `vfx_lab` | endpoint `motionfield/ltx-video/vfx-lab-plate` | `video_url` plate (≤10 s) + `prompt`, `engine` (ltx095 default; ltx098 only when the distilled checkpoint is installed), `plate_lock`, `hold`, optional `end_image_url` + `target_strength`, `resolution`, `steps`. Probes via `/api/v1/probe` and stamps the required `frames` (8n+1)/`fps`/`duration`/dims |
| `re_edit` | endpoint `motionfield/re-edit/v1.0` | `video_url` + `flow` (`character-swap`\|`motion-transfer`\|`restyle`), `image_urls` (required unless restyle - consent required when they're a person's likeness), `instructions`, `preset_id` (restyle only), `resolution`, `steps`. The tool reads the detected shot count from `/api/v1/probe` and submits it as `windows` - ONE recipe job, original timing/fps/audio preserved |
| `audio` {music, sfx, video_sfx} | endpoint `motionfield/acestep/music`, `motionfield/moss/sfx`, `motionfield/moss/video-sfx` | `kind` picks the endpoint: music = `prompt` + optional `duration` (10-120 s), sfx = `prompt` + optional `duration` (1-20 s), video_sfx = `video_url` (a /files/ clip you own) + optional `prompt` cue guidance. `wait_s` ≤ 50 like `generate`; a field the endpoint doesn't declare is `invalid_params`, and the endpoint's own range check answers too |
| `dub` | endpoint `motionfield/dub/v1` | `video_url` (an English talking clip you own, ≤120 s) + `language` (`es`\|`fr`\|`it`\|`pt`\|`hi`\|`ja`\|`zh`) + `likeness_consent:true`; optional `voice` (`auto` picks the base voice from the speaker's pitch), `lipsync` (default true), `original_volume` (0-0.5). ONE recipe job: whisper → local-LLM translation → Kokoro + Chatterbox voice conversion → MuseTalk lip-sync; the output keeps the source length and an `.srt` sits next to it |
| `ad_lab` {kit_from_url, products, avatars, create, presets} | capability `ads` | not in this build yet - the MCP wrapper isn't built |
| `video_analyze` | capability `video_analyze` | not in this build yet - the MCP wrapper isn't built |
| `clipper` | capability `clipper` | local `/files/uploads/` clips only - not in this build yet |
| `shorts` {create, preset_create} | capability `shorts` | not in this build yet - the MCP wrapper isn't built |
| `podcast_edit` | capability `podcast` | not in this build yet - the MCP wrapper isn't built |
| `virality_score` | capability `virality` | not in this build yet - the MCP wrapper isn't built; results carry label "heuristic" |

Endpoint-pinned tools disappear with their endpoint - a restricted-license
model only ever appears in the catalog after the caller opts in server-side,
and is never a default. Consent rule: `person_swap` (`likeness_consent`) and
`voices{create}` (`consent`) refuse with `consent_required` unless the caller
passes `true`. For `voices{create}` the consent check is enforced by the MCP
tool itself - the API declares no consent field on that endpoint yet.

### Tool errors

Every failure returns `{code, message}` as a tool error (`isError: true`) -
`invalid_params`, `not_found`, `restricted_license`/`banned_license` (with
`license` + `enable_at`), `conflict`, `not_available`, `guard` (local/remote
guard refusal), `network_error`, `internal_error`. Nothing throws across the
protocol.

## Prompts (13 listed on a server reporting `runs`, `core`)

`re-edit-edit` · `swap-performer` · `direct-shot` · `reshoot-angle` ·
`vfx-plate` · `stage-scene` · `explainer` · `ugc-ad` ·
`ad-pack` · `launch-motion` · `podcast-cut` · `make-game` · `skill-run`

`make-3d-character` is registered too but stays hidden until the API reports
the `threed` capability (i.e. until the catalog ships a callable
`kind:"threed"` endpoint). `skill-run` declares `skills.read` + `runs` and
calls the `skills` + `run_*` tools, so it lists only on a server that reports
both - the same rule every prompt follows.

Each prompt declares the tools its instructions call plus the capabilities it
`requires`. It appears in `prompts/list` only when **every named tool is
advertised AND every required capability is reported** - so a recipe whose
surface isn't live on this deployment stays hidden rather than fail at use.

## Security posture

- **Key secrecy**: the key lives in `MOTIONFIELD_API_KEY`, rides only the
  `Authorization` header, and every outbound string (stderr, tool results,
  errors) passes the shared `redact()`.
- **`upload{path}`**: realpath → regular file → extension in the API's upload
  allowlist (media only, no `.html`/`.json`) → ≤200 MB.
- **`upload{url}`**: http/https only; DNS resolves up front through the shared
  net-guard (loopback, RFC1918, CGNAT, ULA, link-local/metadata, multicast
  refused on this host, not just hosted deployments); the connection is
  **pinned** to the approved address set so a DNS flip can't redirect the
  fetch; redirects ≤ 3 hops, each re-checked; body capped at the upload limit;
  remote content-type must already be an upload type.
- **`job_download`**: job id must be a UUID; the write path resolves inside
  `MOTIONFIELD_MCP_OUT_DIR` (symlinks resolved before comparing).
- **Billing**: a generated `source` header tags jobs/uploads `mcp`; `estimate`
  shows credits before submit; `wait` is capped at 50 s so an agent can't park
  forever.

## Remote (Streamable HTTP) - `motionfield-mcp-http`

`motionfield-mcp-http` serves the same tools over the MCP **Streamable HTTP**
transport - `POST /mcp` on `MOTIONFIELD_MCP_HTTP_HOST:MOTIONFIELD_MCP_HTTP_PORT`
(default `127.0.0.1:8790`). **Stateless**: no sessions, one JSON-RPC message
per HTTP request, a fresh transport per request.

```bash
MOTIONFIELD_URL=http://localhost:3000 motionfield-mcp-http
# listens on http://127.0.0.1:8790/mcp
```

Auth is per-request, never server-side: every request must carry its own
`Authorization: Bearer of_…`, verified against `GET /api/v1/me` and cached
≤ 60 s keyed by the key's sha256 - **there is no OAuth and no server key**;
a missing or refused key gets `401` before any MCP handling. Host and
Origin headers must match `MOTIONFIELD_MCP_ALLOWED_HOSTS` (default
`localhost:<port>` and `127.0.0.1:<port>` - the DNS-rebinding guard) or the
answer is `403`; request bodies are capped at 4 MB and must land inside the
60 s request timeout. A caller's capabilities + model catalog are fetched
with *their* key and cached on the same ≤ 60 s clock, so two keys on one
listener stay fully isolated.

HTTP-mode tool differences - local paths are stdio-only:

- `upload{path}` → a `guard` tool error ("local paths are stdio-only");
  `upload{url}` works the same as stdio.
- `job_download` writes nothing to disk - it returns
  `{url, mime, bytes}` where `url` is the job's
  `/api/v1/jobs/{id}/result?i=N` on this server for the caller to fetch with
  their own key.
- Every other tool that would touch the local filesystem is refused the same
  way.

The listener binds loopback by default and that is the supported deployment:
putting it on a LAN/WAN requires a TLS-terminating reverse proxy in front
plus a tight `MOTIONFIELD_MCP_ALLOWED_HOSTS` - an `of_` key over cleartext
`http://` to a remote host is a footgun.

Remote client configs - every snippet is rendered verbatim from
`src/app/mcp/snippets.ts`, the same module the `/mcp` page serves. Each one
references the key through the client's own env expansion, so the secret
stays out of the file. Formats checked against the clients' docs on
2026-10-24:

- Claude Code: https://code.claude.com/docs/en/mcp
- Cursor: https://cursor.com/docs/mcp
- Codex CLI: https://developers.openai.com/codex/mcp (config reference)
- OpenCode: https://opencode.ai/docs/mcp-servers/

### Claude Code (`.mcp.json` or `~/.claude.json`)

```json
{
  "mcpServers": {
    "motionfield": {
      "type": "http",
      "url": "http://127.0.0.1:8790/mcp",
      "headers": {
        "Authorization": "Bearer ${MOTIONFIELD_API_KEY}"
      }
    }
  }
}
```

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "motionfield": {
      "url": "http://127.0.0.1:8790/mcp",
      "headers": {
        "Authorization": "Bearer ${env:MOTIONFIELD_API_KEY}"
      }
    }
  }
}
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.motionfield]
url = "http://127.0.0.1:8790/mcp"
bearer_token_env_var = "MOTIONFIELD_API_KEY"
```

### OpenCode (`opencode.json`)

```json
{
  "mcp": {
    "motionfield": {
      "type": "remote",
      "url": "http://127.0.0.1:8790/mcp",
      "headers": {
        "Authorization": "Bearer {env:MOTIONFIELD_API_KEY}"
      }
    }
  }
}
```

### Any Streamable-HTTP client

```text
POST http://127.0.0.1:8790/mcp
Authorization: Bearer <your of_… key>
```
