# MotionField API (v1)

Programmatic access to MotionField generation endpoints. The v1 API is bearer-token
authenticated and returns JSON envelopes; binary results are streamed from a
dedicated result endpoint. A rendered version of this document - with a live
endpoint table - is served in-app at [`/docs/api`](/docs/api), and the
machine-readable contract is [`GET /api/v1/openapi.json`](#get-apiv1openapijson)
(OpenAPI 3.1, no auth required).

Base URL: the same origin as the app (e.g. `http://localhost:3000`).

## Authentication

All `/api/v1/*` endpoints require an API key in the `Authorization` header:

```
Authorization: Bearer of_<keyId>_<secret>
```

Keys are created from a signed-in browser session:

```bash
# create a key (the full token AND the webhook secret are returned exactly once - save both)
curl -X POST http://localhost:3000/api/keys \
  -H 'cookie: <your session cookie>' \
  -H 'content-type: application/json' \
  -d '{"label": "ci", "max_concurrency": 2}'

# → 201 { "id": "…", "key_id": "AbCdEfGhIjKl", "label": "ci",
#         "max_concurrency": 2, "key": "of_AbCdEfGhIjKl_…",
#         "webhook_secret": "ofwh_…" }

# list keys (never includes secrets)
curl http://localhost:3000/api/keys -H 'cookie: <your session cookie>'

# rotate the webhook signing secret (new ofwh_… returned once)
curl -X POST http://localhost:3000/api/keys/<id>/webhook-secret -H 'cookie: <your session cookie>'

# revoke
curl -X DELETE http://localhost:3000/api/keys/<id> -H 'cookie: <your session cookie>'
```

A revoked or malformed key yields `401` on every v1 call. `max_concurrency` is
1-64 (default 2). The `webhook_secret` signs webhook deliveries (see
[Webhooks](#webhooks)); it is stored encrypted and shown only at creation or
rotation. `POST /api/v1/jobs` with `webhook_url` on a key whose secret is
missing answers `400 webhook_secret_missing` - rotate the secret on that key
(`POST /api/keys/:id/webhook-secret`) to mint one.

## Endpoints

### `GET /api/v1/models`

Lists every callable endpoint.

```bash
curl http://localhost:3000/api/v1/models -H "Authorization: Bearer $KEY"
```

```json
{
  "models": [
    {
      "id": "motionfield/z-image-turbo/text-to-image",
      "kind": "image",
      "label": "Z-Image-Turbo · Generate",
      "tags": ["photoreal", "fast", "styles"],
      "inputs": {
        "type": "object",
        "properties": {
          "prompt": { "type": "string" },
          "seed": { "type": "integer", "minimum": 1, "maximum": 1000000 },
          "image_url": {
            "type": "string",
            "x-media": "image",
            "description": "media URL - upload via POST /api/v1/uploads"
          }
        },
        "required": ["prompt"],
        "additionalProperties": true
      },
      "license": {
        "class": "open",
        "components": [
          {
            "name": "ae.safetensors",
            "license": "Apache-2.0",
            "url": "https://huggingface.co/Comfy-Org/z_image_turbo"
          }
        ]
      },
      "estimate": { "credits": 0.32 },
      "tier": "local"
    }
  ]
}
```

`inputs` is a JSON Schema object generated from the endpoint's declared fields.
Every media param is marked `x-media` - `"image"`, `"video"`, `"audio"` or
`"media"` on the property itself (on `items` for array fields - `images` and
multi-media `*_urls` params are `type:"array"`) - so a client can tell which
fields take media URLs without guessing from the name: the catalog also uses
names like `image_reference_url`, which carry the same `x-media` marker.
`media` means any kind;
an `accepts` mime hint (e.g. `"image/*"`) narrows it when present. `tags`
carries the model's catalog tags for filtering/ranking.
`tier` is `local` for endpoints that run on a typical workstation and `cloud`
for endpoints that need a hosted GPU. `license.class` is `open`, `restricted`
or `banned`, and `license.components` lists the weights/files behind the
endpoint with their SPDX-style license and source URL. `estimate.credits` is
what a submission with default params would charge on your plan (`0` when the
model is unlimited on your plan); it is `null` when the endpoint can't run on
defaults alone, e.g. a required upload param.

Endpoints with `license.class === "restricted"` appear in this list only after
you opt in at [`/settings/licenses`](/settings/licenses) - submitting one
before that returns `403 restricted_license`. `banned` endpoints are never
listed.

### `POST /api/v1/jobs`

Submit a generation job. Returns `202` on creation (or `200` on an idempotent
replay - see below).

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: order-42-image-1' \
  -d '{
    "endpoint": "motionfield/z-image-turbo/text-to-image",
    "params": { "prompt": "a lighthouse at dawn", "aspect_ratio": "16:9" },
    "webhook_url": "https://example.com/hooks/of"
  }'
```

```json
{
  "id": "8f2c7d34-…",
  "status": "queued",
  "created_at": "2026-10-21T09:00:00.000Z",
  "links": {
    "self":   "/api/v1/jobs/8f2c7d34-…",
    "cancel": "/api/v1/jobs/8f2c7d34-…/cancel",
    "result": "/api/v1/jobs/8f2c7d34-…/result"
  }
}
```

`webhook_url` is optional: an absolute http(s) URL (≤2048 chars, no embedded
credentials) that receives one signed POST when the job reaches a terminal
state. See [Webhooks](#webhooks).

`Idempotency-Key` must be 1-255 printable ASCII characters. Request bodies are
capped at 1 MB (`413 payload_too_large` above that).

### `GET /api/v1/jobs/{id}`

Returns the job. Only jobs owned by the key's user are visible - anything else
is `404`.

```json
{
  "id": "8f2c7d34-…",
  "status": "in_progress",
  "progress": 42,
  "endpoint": "motionfield/z-image-turbo/img2img",
  "kind": "edit",
  "params": { "prompt": "…", "image_url": "/files/uploads/….png" },
  "outputs": [],
  "error": null,
  "source": "api",
  "created_at": "…",
  "updated_at": "…"
}
```

`endpoint` is the endpoint id the job was submitted to, `kind` its job kind,
and `params` the params as resolved at submit - preset markers expanded into
their apply values, strings coerced to the declared types (media fields hold
`/files/uploads/…` urls). `source` is the surface that submitted the job - `ui`,
`api`, `cli`, `mcp` or
`agent`. First-party clients send `X-MotionField-Source: cli|mcp` on writes;
absent or anything else lands as `api`. Job-created assets and uploads carry
the same provenance.

Once `status` is `completed`, `outputs` contains `{ url, type, bytes }` items -
`type` is the output's MIME type (`image/png`, `video/mp4`, `model/gltf-binary`,
…; `application/octet-stream` when it can't be determined).

### `POST /api/v1/jobs/{id}/cancel`

Cancels a `queued` or `in_progress` job and returns the job view. Already-final
jobs are returned unchanged. Charged credits are refunded automatically.

### `GET /api/v1/jobs/{id}/result?i=0`

Streams output file `i` (default `0`) with the correct `Content-Type`. Responds
`409 not_ready` while the job isn't `completed`, `404` when the output index
doesn't exist.

### `POST /api/v1/runs`

Creates a **run** - a durable multi-step generation plan the run engine
executes step by step (each step mints a job). Exactly one of three body
forms:

```bash
# a literal plan - same shape the app takes
curl -X POST http://localhost:3000/api/v1/runs \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"plan": {"title": "two shots", "steps": [
        {"id": "s1", "title": "first frame",
         "endpoint_id": "motionfield/z-image-turbo/text-to-image",
         "params": {"prompt": "a lighthouse at dawn"}, "depends_on": []},
        {"id": "s2", "title": "animate",
         "endpoint_id": "motionfield/wan-vace/image-to-video",
         "params": {"image_url": "$step:s1.outputs[0]", "prompt": "waves move"},
         "depends_on": ["s1"]}]}}'

# a brief through the planner - "builtin" or "<provider>:<model>" to pick
curl -X POST http://localhost:3000/api/v1/runs \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"text": "a 5s clip of rain on a window", "planner": "builtin"}'

# a catalog skill - its pipeline becomes the plan
curl -X POST http://localhost:3000/api/v1/runs \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"skill": "narrated-explainer", "brief": "how rain forms",
       "answers": {"voice": "warm"}}'
```

Shared fields: `mode` (`"auto"` or `"offline"`), `ask_first` (park the run at
`awaiting_approval` until you approve), `project_id`, and `inputs` - up to 8
`{"url", "mime"?}` media items (only `/files/` urls are used; uploads come
from `POST /api/v1/uploads` and generated media from earlier jobs' outputs).
`inputs` applies to `text` and `skill` runs only - sending it with `{plan}`
is a 400. A skill fills its unset media params from `inputs` first, each
used once, before chaining earlier steps; a brief sends them to the planner
as attachments. Inside a plan, a step's media params take upload urls or
`"$step:<id>.outputs[n]"` refs into earlier steps - refs can only point at
steps in `depends_on` (transitively).

Skill steps that read a script (`readsScript` - narration/voice-over steps)
take their `prompt` verbatim: the writer-LLM rewrite the app runs for those
steps does not happen on this surface - put the narration text you want
spoken in `brief` (or `answers`).

A `text` brief may name your own refs as `@name` (the slug the refs API
writes - see [`/api/v1/refs`](#get-apiv1refs)). Each resolved ref's images
join the planner's attachable set, so `"a clip of @name"` lands the ref's
image in step 1's media param. An unknown or foreign `@name` is a `422` -
the planner asks instead of guessing.

Returns `201` (or `200` on idempotent replay - `Idempotency-Key` works like
`POST /jobs`) with the run view:

```json
{
  "id": "5be2…-…",
  "status": "awaiting_approval",
  "title": "two shots",
  "mode": "auto",
  "ask_first": true,
  "project_id": null,
  "estimate": { "credits": 2.4, "eta_seconds": 96 },
  "planner": { "via": "built-in planner", "fallback_reason": null },
  "steps": [
    { "id": "s1", "title": "first frame",
      "endpoint": "motionfield/z-image-turbo/text-to-image",
      "status": "pending", "rev": 0, "job_id": null,
      "outputs": [], "error": null, "depends_on": [] }
  ],
  "created_at": "…", "updated_at": "…",
  "links": { "self": "/api/v1/runs/5be2…",
             "approve": "/api/v1/runs/5be2…/approve",
             "control": "/api/v1/runs/5be2…/control" }
}
```

A step's `outputs` carry the same `{ url, type, bytes }` contract a job's
outputs do - `type` is the output's MIME type, `bytes` its size (null when
unknown). `estimate.credits` is the catalog cost summed over the plan;
`eta_seconds` is
the median of past runtimes - `null` when unknown. `planner.via` says what
produced the plan (`"built-in planner"`, `"provider·model"` or
`"skill·slug"`; `null` for a literal plan) and `planner.fallback_reason`
records when the requested planner failed over to the built-in one.

Statuses: `awaiting_approval` → `running` ⇄ `paused` → `done` / `failed` /
`stopped` (terminal). A run parks at `awaiting_approval` when `ask_first` is
set or its estimate exceeds the auto-approve cap; approve it to start work.
A step's `job_id` appears once the step submits - poll that job for progress.
`POST /api/v1/runs` errors: `400` malformed body or more/less than one of
plan/text/skill; `404` unknown skill or project; `422` when the plan fails
validation (plain message - unknown endpoint, bad `$step:` ref, missing
required param) or the planner needs more input. Bodies are capped at 1 MB.
Planning can take minutes, so the `Idempotency-Key` is reserved before any
work - a concurrent same-key request answers `409` with code
`idempotency_in_progress` and a `Retry-After` header until the create
finishes; SDKs retry that response for you.

### `GET /api/v1/runs/{id}`

The run view above - owner only (anything else is `404`). A live run **ticks
once on read**, like jobs - polling IS how runs advance without a worker.
On a real `DATABASE_URL`, `scripts/worker.ts` advances runs without reads -
see the [Database note](SETUP.md#database).

### `POST /api/v1/runs/{id}/approve`

Releases an `awaiting_approval` run to `running` and returns the run view.
Idempotent: approving a run already past the gate returns its view.

### `POST /api/v1/runs/{id}/control`

`{ "action": "pause" | "resume" | "stop" }` - idempotent per action. `pause`
parks the run (an in-flight step still finishes); `resume` continues; `stop`
ends it (`stopped`). A transition the current status forbids is `409`.

### `PATCH /api/v1/runs/{id}/steps/{stepId}`

Edits one step's spec before it submits: `{ "rev": 0, "title"?: "…",
"params"?: {…} }` - `rev` is the step's current revision from the run view
and `params` merges onto the stored spec (the whole step revalidates - a bad
edit is a `422`). A stale rev answers:

```json
{ "error": { "code": "stale_revision", "message": "…", "head_rev": 1 } }
```

`head_rev` carries the current revision so a client can refresh and retry -
refetch the run, resend at the new rev. An edit the live run refuses is the
engine's own `409`.

### `POST /api/v1/uploads`

Multipart upload for input media (field name `file`, up to 200 MB). The
returned `url` can be passed in params that expect a media URL.

```bash
curl -X POST http://localhost:3000/api/v1/uploads \
  -H "Authorization: Bearer $KEY" \
  -F file=@photo.png

# → 201 { "url": "/files/uploads/….png" }
```

The upload row records the same `X-MotionField-Source` provenance as jobs.

### `GET /api/v1/assets`

The caller's generated assets (job output files), newest first.

| Query    |                                                              |
| -------- | ------------------------------------------------------------ |
| `kind`   | `image`, `video`, `audio` or `file`                          |
| `source` | `ui`, `api`, `cli`, `mcp` or `agent`                         |
| `limit`  | page size, 1-100 (default 20)                                |
| `before` | opaque cursor from a previous page's `next_cursor`           |

```json
{ "assets": [ { "id": "…", "job_id": "…", "kind": "image", "url": "/files/…",
                "mime": "image/png", "width": 1024, "height": 1024,
                "duration_sec": null, "bytes": 123456, "prompt": "…",
                "endpoint_id": "motionfield/z-image-turbo/text-to-image",
                "source": "cli", "created_at": "…" } ],
  "next_cursor": "…" }
```

### `GET /api/v1/presets?kind=`

The preset catalog - named param recipes (styles, effects, shot presets) a
submission can reference via marker params (`<kind>_preset`, `preset_id`, or
the endpoint's own `*_id` fields).
Each entry carries `id`, `kind`, `title`, `description`, `category`,
`credits`, `input_required`, `model_hint`, `apply` (the params it merges) and
`prompt_fragment`. Presets whose `model_hint` points at restricted weights are
hidden until the caller opts in at `/settings/licenses` - same rule as
`/api/v1/models`.

```json
{ "presets": [ { "id": "noir-photo", "kind": "image", "title": "Noir",
                 "description": "…", "category": "style", "credits": 0,
                 "input_required": "none", "model_hint": null,
                 "apply": { "style_strength": 0.8 },
                 "prompt_fragment": "high-contrast black and white" } ] }
```

### `POST /api/v1/presets/resolve`

Previews what preset/style/effect ids will do to a params block - runs the
same resolve stage as job creation, returns the merged params, creates no job.

```bash
curl -X POST http://localhost:3000/api/v1/presets/resolve \
  -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"endpoint": "motionfield/z-image-turbo/text-to-image",
       "params": {"prompt": "dunes", "style_preset": "film-noir"}}'

# → { "endpoint": "motionfield/z-image-turbo/text-to-image",
#     "params": { "prompt": "dunes, black and white film noir, hard contrast, …",
#                  "…": "…the preset's apply values" } }
```

`404 unknown_endpoint` when the endpoint isn't in the catalog.

### `POST /api/v1/estimate`

Credit and USD cost preview without submitting a job.

```bash
curl -X POST http://localhost:3000/api/v1/estimate \
  -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"endpoint": "motionfield/z-image-turbo/text-to-image", "params": {"batch_size": 4}}'

# → { "credits": 0.32, "usd": 0.02, "unlimited": false }
```

The estimate runs the same parameter resolution and coercion as job creation -
the quoted `credits` is exactly what would be charged.

### `GET /api/v1/jobs?limit=50&status=&before=`

The caller's jobs, newest first - same per-job shape as `GET /jobs/{id}`.

| Query     |                                                              |
| --------- | ------------------------------------------------------------ |
| `limit`   | page size, 1-100 (default 50)                                 |
| `status`  | one of the job status values below                            |
| `ids`     | up to 12 comma-separated job UUIDs - returns the found set in request order, ignoring the other filters |
| `kind`    | job kind - `image`, `video`, `audio`, `edit`, `upscale`, `character`, `v2v`, `avatar`, `threed` |
| `source`  | `ui`, `api`, `cli`, `mcp` or `agent`                         |
| `before`  | opaque cursor from a previous page's `next_cursor`            |

```json
{ "jobs": [ /* job views */ ], "next_cursor": "dGVzdHw…" }
```

Follow `next_cursor` as `before` until it comes back `null`. Ordering is the
`(created_at, id)` tuple, so jobs sharing a timestamp paginate without
duplicates or gaps. The list is a snapshot - reads never advance a job.

### `GET /api/v1/me`

Who this key belongs to. The key itself is never returned - only its row id
and label.

```json
{ "user_id": "…", "email": "…", "plan": "pro", "credits": 312.5,
  "key": { "id": "…", "label": "ci" } }
```

### `GET /api/v1/system`

Queue depth of the caller's live jobs, whether the machine's GPU is currently
running a local-provider job (`comfy`/`recipe`, any user - it's a shared
resource), the deployment tier and free disk on the storage volume. Read
from the database - never probes ComfyUI or the GPU.

```json
{ "queue": { "queued": 2, "in_progress": 1 }, "gpu": { "busy": true },
  "tier": "local", "disk": { "free_gb": 412.7 } }
```

`tier` is `"cloud"` on hosted (`MOTIONFIELD_HOSTED=1`) deployments, where
`disk.free_gb` reports `null`.

### `GET /api/v1/skills` / `GET /api/v1/skills/{slug}`

The catalog's skill pipelines. The list returns
`{ skills: [{ slug, name, description }] }`; the detail adds a generated
`skill_md` - a SKILL.md document with front matter, what the pipeline does,
the intake questions it asks, and the job endpoints it calls.

```json
{ "slug": "narrated-explainer", "name": "Narrated Explainer",
  "description": "Topic or short script → one narrated video …",
  "skill_md": "---\nname: …" }
```

### `GET /api/v1/refs` / `POST /api/v1/refs` / `GET /api/v1/refs/{name}`

Refs are named, reusable `@references` - a subject, place or prop built from
your own images that briefs and plans can mention as `@name` (the run planner
resolves the name and fills media params with the ref's images; an unknown or
foreign name is never resolved - the planner asks instead of guessing).

```bash
# create - name slugifies to [a-z0-9-] ≤80; images are your own /files urls
curl -X POST localhost:3000/api/v1/refs -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"Hero Shot","category":"prop","kind":"prop",
       "images":["/files/uploads/….png"],"description":"the product still"}'
# → 201 { "ref": { "id":"…", "name":"hero-shot", "category":"prop", "kind":"prop",
#                  "description":"the product still", "images":["…"],
#                  "created_at":"…" } }

curl localhost:3000/api/v1/refs              -H "Authorization: Bearer $KEY"
curl localhost:3000/api/v1/refs?category=prop -H "Authorization: Bearer $KEY"
curl localhost:3000/api/v1/refs/hero-shot    -H "Authorization: Bearer $KEY"
```

Rules (identical on the session-scoped `/api/refs`):

- **Owner-scoped** - every read and write is filtered to the caller; another
  user's ref answers `404`, and their `/files/` url can't be borrowed into a
  ref (also `404`). External urls are `400`.
- **Likeness** - `kind:"person"` or `category:"character"` refs need
  `likeness_consent:true` (docs/POLICY.md).
- **Conflicts** - a duplicate `(user, name)` is `409`; bad category, empty
  slug or malformed body is `400`.
- **`{name}` lookups** - the path value slugifies the same way a create does,
  so `GET /api/v1/refs/Hero%20Shot` finds the `hero-shot` ref; anything that
  slugifies to nothing is a `404`.
- Rows written before the category rename keep reading: stored `location`
  comes back `environment`, `character` comes back `character`.

### `GET /api/v1/capabilities`

```json
{ "capabilities": ["jobs", "jobs.list", "jobs.source", "runs", "skills.read",
                   "system", "models", "estimate", "uploads", "assets", "presets",
                   "refs", "stage"] }
```

Static registry the CLI, SDKs and MCP clients use to gate optional command
groups - a group is only usable when its capability string appears here.
`threed` appears/disappears with the model catalog, not by hand.

While `stage` is reported, the 3D-scene surface lives under `/api/stage`
(**not** `/api/v1`): `GET/POST /api/stage`, `GET /api/stage/{id}`,
`GET /api/stage/{id}/inspect`, `POST /api/stage/{id}/ops`,
`GET /api/stage/{id}/revisions[/{rev}]`,
`POST /api/stage/{id}/revisions/{rev}/restore`. Same `of_…` bearer auth -
errors come back flat (`{error, code?, head_revision?}`) rather than in the
v1 envelope: a stale `base_revision` is `409 {error:"stale base_revision",
head_revision}`, an `Idempotency-Key` reuse with a different body is
`422 {code:"IDEMPOTENCY_MISMATCH"}`. The CLI's `motionfield stage` group
([CLI.md](./CLI.md)) and the SDKs' `stage*` methods drive it.

### `GET /api/v1/openapi.json`

The OpenAPI 3.1 document for everything on this page, generated from the same
catalog the server enforces. Public - no `Authorization` header needed.

## Webhooks

Set `webhook_url` when creating a job and MotionField sends exactly one POST when
the job reaches a terminal state - `job.completed`, `job.failed`, `job.nsfw` or
`job.canceled`. The body is frozen when the event is enqueued, so retries
resend byte-identical payloads:

```json
{
  "id": "0f8a…-…",            // delivery id - also sent as X-MotionField-Event-Id
  "type": "job.completed",
  "created": 1730000000,       // unix seconds
  "data": { /* the exact GET /api/v1/jobs/{id} object */ }
}
```

Headers on every delivery:

```
User-Agent: MotionField-Webhooks/1
Content-Type: application/json
X-MotionField-Event-Id: <delivery uuid>
X-MotionField-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "${t}.${body}")>
```

Verify the signature with the `ofwh_…` secret shown at key creation/rotation -
in Node:

```ts
import crypto from "node:crypto";

function verify(secret: string, header: string, body: string): boolean {
  const [t, v1] = header.replace("t=", "").split(",v1=");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${body}`)
    .digest("hex");
  const fresh = Math.abs(Math.floor(Date.now() / 1000) - Number(t)) <= 300;
  return fresh && /^[0-9a-f]{64}$/.test(v1) &&
    crypto.timingSafeEqual(Buffer.from(v1, "hex"), Buffer.from(expected, "hex"));
}
```

Rules: verify against the **raw** request body, reject timestamps older than
five minutes, and treat the event id as idempotent (a redelivery is the same
`id`, `type` and `body`).

Retries: a failed attempt is retried at +30s, +2m, +10m, +30m and +60m - six
attempts at most, never past two hours from the first - then the delivery is
marked exhausted. Any 2xx acknowledges; 408/429/5xx and network errors retry;
any other status fails immediately. Redirects are never followed.

Target restrictions: link-local, `0.0.0.0/8`, unspecified and multicast
addresses are always refused (including IPv4-mapped forms); on deployments with
`MOTIONFIELD_HOSTED=1`, loopback, RFC1918 and `fc00::/7` addresses are refused
too. CGNAT/shared address space `100.64.0.0/10` counts as private under the
same rule - refused on hosted deployments, and always refused by the MCP
server's `upload{url}` fetch guard (which runs on your own machine, where that
range can only ever be your carrier's or your LAN's equipment). A refused
delivery ends with `last_error = "destination not allowed"`.

## Job status values

| Status        | Meaning                                        |
| ------------- | ---------------------------------------------- |
| `queued`      | accepted, waiting for a worker                 |
| `in_progress` | actively generating; `progress` is 0-100       |
| `completed`   | finished - `outputs` is populated              |
| `failed`      | provider error - `error` has details, refunded |
| `nsfw`        | blocked by the safety filter, refunded         |
| `canceled`    | canceled by the user, refunded                 |

## Idempotency

Send an `Idempotency-Key` header with job or run creation. The server stores
the key together with `request_hash` - a sha256 of the canonical (sorted-key)
JSON of the request:

- Same key + same payload → `200` with the original job/run; nothing is
  re-charged or re-submitted.
- Same key + different payload → `422` with code `idempotency_mismatch`.
- Keys are scoped per user. Retrying with a new key always creates a new
  job/run.
- Run creation reserves the key before planning starts: a second request on
  the same key while the first still runs answers `409
  idempotency_in_progress` + `Retry-After` - retry and the finished run
  replays (one run total, no double spend).

## Concurrency

Each API key has `max_concurrency` (default `2`, set at creation). When the
key's `queued` + `in_progress` jobs reach the cap, `POST /api/v1/jobs` answers:

```
429 { "error": { "code": "concurrency_limit", "message": "…" } }
Retry-After: 5
```

Live jobs are reconciled against the provider before counting, so completed
work frees slots immediately. Your plan-level concurrency limit applies on top
of the per-key limit.

## SDKs

Two zero-dependency SDKs ship in this repo under `packages/` - both MIT
licensed, both usable straight from source (no build step or install needed):

**TypeScript** - `packages/sdk-ts` (`src/index.ts`; Node ≥18.20 or any fetch
runtime):

```ts
import { MotionField, verifyWebhook } from "./packages/sdk-ts/src/index.ts";

const of = new MotionField({ baseUrl: "http://localhost:3000", apiKey: "of_…" });
const models = await of.models();
const job = await of.submit(
  "motionfield/z-image-turbo/text-to-image",
  { prompt: "neon" },                    // Idempotency-Key defaults to a fresh UUID
);
const done = await of.wait(job.id);      // polls GET until a terminal status
const { bytes, contentType } = await of.download(done.id); // e.g. image/png

// runs: createRun / getRun / approveRun / controlRun / editStep / waitRun -
// the same wire contract as the routes above (Idempotency-Key on createRun,
// waitRun polls until done|failed|stopped, editStep throws stale_revision
// with error.headRev on a stale rev)
const run = await of.createRun({ plan: { steps: [
  { id: "s1", title: "frame", endpoint_id: "motionfield/z-image-turbo/text-to-image",
    params: { prompt: "dunes at dusk" } }] } });
const finished = await of.waitRun(run.id);
```

**Python** - `packages/sdk-py` (stdlib only; `Client` + `AsyncClient`):

```python
import sys; sys.path.insert(0, "packages/sdk-py")
from motionfield import Client, verify_webhook

client = Client("http://localhost:3000", "of_…")
done = client.wait(client.submit(
    "motionfield/z-image-turbo/text-to-image",
    {"prompt": "neon"})["id"])
png = client.download(done["id"])

# runs: create_run / get_run / approve_run / control_run / edit_step / wait_run
run = client.create_run(plan={"steps": [
    {"id": "s1", "title": "frame",
     "endpoint_id": "motionfield/z-image-turbo/text-to-image",
     "params": {"prompt": "dunes at dusk"}}]})
finished = client.wait_run(run["id"])
```

Both clients send `Idempotency-Key` on submit and retry transient
`429`/`5xx` on idempotent calls (honoring `Retry-After`); both map the error
envelope to `MotionFieldError` with `code`, `retryAfter`/`retry_after`,
`license` and `enableAt`/`enable_at` fields (`wait` expiry is
`code="wait_timeout"`); both export a webhook-signature verifier
(`verifyWebhook` / `verify_webhook`) that checks the
`x-motionfield-signature` header against the raw body with your `ofwh_…`
secret - inside your receiver:

```ts
// TypeScript
if (!verifyWebhook(secret, req.headers["x-motionfield-signature"], rawBody))
  return res.status(401).end();
```

```python
# Python
if not verify_webhook(secret, request.headers.get("x-motionfield-signature"),
                      request.body):
    return ("bad signature", 401)
```

## Errors

Errors share one envelope:

```json
{ "error": { "code": "not_found", "message": "job not found" } }
```

| HTTP | `code`                    | When                                              |
| ---- | ------------------------- | ------------------------------------------------- |
| 400  | `bad_request`             | malformed JSON, missing fields, bad Idempotency-Key |
| 400  | `webhook_secret_missing`  | `webhook_url` set but the key has no signing secret |
| 401  | `unauthorized`            | missing/invalid/revoked API key                   |
| 402  | `payment_required`        | insufficient credits or plan too low              |
| 403  | `restricted_license`      | endpoint's license needs an opt-in - body carries `license` + `enable_at` |
| 404  | `not_found`               | unknown endpoint, job, run or step (or not yours) |
| 409  | `not_ready`               | result requested before completion                |
| 409  | `stale_revision`          | step PATCH sent an old `rev` - `error.head_rev` has the current one |
| 409  | `idempotency_in_progress` | a same-key run create is still in flight - `Retry-After` says when   |
| 409  | `conflict`                | run control transition the current status forbids |
| 422  | `unprocessable_entity`    | plan/step failed validation or the planner refused |
| 413  | `payload_too_large`       | body over 1 MB / upload over 200 MB               |
| 415  | `unsupported_media_type`  | upload type not accepted                          |
| 422  | `idempotency_mismatch`    | key reused with a different payload               |
| 429  | `concurrency_limit`       | per-key or plan concurrency cap (`Retry-After`)   |
| 500  | `internal_error`          | unexpected server error                           |

The run's own 404 rule: a run or step another user owns answers `404`, never
`403` - the response reveals nothing about whether it exists.
