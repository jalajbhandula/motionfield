import { ALL_MODELS } from "@/lib/catalog/video-models";
import { endpointLicense } from "@/lib/catalog/license-gate";
import { paramsJsonSchema } from "./v1";
import type { ModelDef, WorkflowDef } from "@/lib/catalog/types";

/**
 * OpenAPI 3.1 document for the v1 API, built from the catalog so the
 * documented param schema can never drift from what the server enforces.
 */

/** Every endpoint exposed over v1: exactly those whose license class is open. */
export function openEndpoints(): { model: ModelDef; workflow: WorkflowDef }[] {
  const out: { model: ModelDef; workflow: WorkflowDef }[] = [];
  for (const m of ALL_MODELS)
    for (const w of m.workflows)
      if (endpointLicense(w).class === "open") out.push({ model: m, workflow: w });
  return out;
}

const ERROR_SCHEMA = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        license: { type: "string", description: "403 restricted_license only - the license that must be opted into" },
        enable_at: { type: "string", description: "403 restricted_license only - where to opt in" },
      },
    },
  },
};

const OUTPUT_ITEM_SCHEMA = {
  type: "object",
  required: ["url", "type", "bytes"],
  properties: {
    url: { type: "string" },
    type: { type: "string", description: "output MIME type (image/png, video/mp4, model/gltf-binary, …)" },
    bytes: { type: ["integer", "null"] },
  },
};

const JOB_SCHEMA = {
  type: "object",
  required: ["id", "status", "progress", "endpoint", "kind", "params", "outputs", "error", "source", "created_at", "updated_at"],
  properties: {
    id: { type: "string", format: "uuid" },
    status: { type: "string", enum: ["queued", "in_progress", "completed", "failed", "nsfw", "canceled"] },
    progress: { type: "integer", minimum: 0, maximum: 100 },
    endpoint: { type: "string", description: "the endpoint id the job was submitted to" },
    kind: { type: "string", description: "job kind - image, video, audio, edit, upscale, character, v2v, avatar, threed" },
    params: { type: "object", description: "the params as resolved at submit - preset markers expanded into their apply values and coerced to the declared types (media fields carry /files/uploads/… urls)" },
    source: { type: "string", enum: ["ui", "api", "cli", "mcp", "agent"], description: "the surface that submitted the job" },
    outputs: { type: "array", items: OUTPUT_ITEM_SCHEMA },
    error: { type: ["string", "null"] },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
};

const JOB_CREATED_SCHEMA = {
  type: "object",
  required: ["id", "status", "created_at", "links"],
  properties: {
    id: { type: "string", format: "uuid" },
    status: { type: "string" },
    created_at: { type: "string", format: "date-time" },
    links: {
      type: "object",
      required: ["self", "cancel", "result"],
      properties: {
        self: { type: "string" },
        cancel: { type: "string" },
        result: { type: "string" },
      },
    },
  },
};

const ME_SCHEMA = {
  type: "object",
  required: ["user_id", "email", "plan", "credits", "key"],
  properties: {
    user_id: { type: "string" },
    email: { type: "string" },
    plan: { type: ["string", "null"] },
    credits: { type: "number" },
    key: {
      type: "object",
      required: ["id", "label"],
      properties: {
        id: { type: "string", format: "uuid", description: "api_keys row id - the id used with /api/keys endpoints" },
        label: { type: "string" },
      },
    },
  },
};

const SYSTEM_SCHEMA = {
  type: "object",
  required: ["queue", "gpu", "tier", "disk"],
  properties: {
    queue: {
      type: "object",
      required: ["queued", "in_progress"],
      properties: {
        queued: { type: "integer" },
        in_progress: { type: "integer" },
      },
    },
    gpu: {
      type: "object",
      required: ["busy"],
      properties: { busy: { type: "boolean", description: "an in_progress job is running on a local provider" } },
    },
    tier: { type: "string", enum: ["local", "cloud"] },
    disk: {
      type: "object",
      required: ["free_gb"],
      properties: {
        free_gb: { type: ["number", "null"], description: "GB free on the storage volume; null on hosted deployments" },
      },
    },
  },
};

const SKILL_SUMMARY_SCHEMA = {
  type: "object",
  required: ["slug", "name", "description"],
  properties: {
    slug: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
  },
};

const SKILL_DETAIL_SCHEMA = {
  type: "object",
  required: ["slug", "name", "description", "skill_md"],
  properties: {
    slug: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    skill_md: { type: "string", description: "generated SKILL.md - front matter, pipeline steps, intake questions, endpoints" },
  },
};

const JOB_LIST_SCHEMA = {
  type: "object",
  required: ["jobs", "next_cursor"],
  properties: {
    jobs: { type: "array", items: { $ref: "#/components/schemas/Job" } },
    next_cursor: { type: ["string", "null"], description: "pass back as `before` for the next page; null at the end" },
  },
};

const CAPABILITIES_SCHEMA = {
  type: "object",
  required: ["capabilities"],
  properties: {
    capabilities: { type: "array", items: { type: "string" } },
  },
};

const SOURCE_PROP = {
  type: "string",
  enum: ["ui", "api", "cli", "mcp", "agent"],
};

const ASSET_SCHEMA = {
  type: "object",
  required: ["id", "kind", "url", "source", "created_at"],
  properties: {
    id: { type: "string", format: "uuid" },
    job_id: { type: ["string", "null"], format: "uuid" },
    kind: { type: "string", enum: ["image", "video", "audio", "file"] },
    url: { type: "string" },
    mime: { type: ["string", "null"] },
    width: { type: ["integer", "null"] },
    height: { type: ["integer", "null"] },
    duration_sec: { type: ["number", "null"] },
    bytes: { type: ["integer", "null"] },
    prompt: { type: ["string", "null"] },
    endpoint_id: { type: ["string", "null"] },
    source: SOURCE_PROP,
    created_at: { type: "string", format: "date-time" },
  },
};

const ASSET_LIST_SCHEMA = {
  type: "object",
  required: ["assets", "next_cursor"],
  properties: {
    assets: { type: "array", items: { $ref: "#/components/schemas/Asset" } },
    next_cursor: { type: ["string", "null"], description: "pass back as `before` for the next page; null at the end" },
  },
};

const PRESET_SCHEMA = {
  type: "object",
  required: ["id", "kind", "title", "apply"],
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: ["motion", "effect", "style", "palette", "mixed-media"] },
    title: { type: "string" },
    description: { type: "string" },
    category: { type: ["string", "null"] },
    credits: { type: ["number", "null"] },
    input_required: { type: "string", enum: ["none", "image", "video", "any"] },
    model_hint: { type: ["string", "null"], description: "model the preset was tuned on - restricted-weight hints keep the preset hidden until the caller opts in" },
    apply: { type: "object", description: "params the preset merges into the job" },
    prompt_fragment: { type: ["string", "null"], description: "text appended to the prompt" },
  },
};

const PRESET_LIST_SCHEMA = {
  type: "object",
  required: ["presets"],
  properties: { presets: { type: "array", items: { $ref: "#/components/schemas/Preset" } } },
};

const REF_SCHEMA = {
  type: "object",
  required: ["id", "name", "category", "kind", "description", "images", "created_at"],
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string", description: "the @ref slug - [a-z0-9-], ≤80" },
    category: { type: "string", enum: ["character", "environment", "prop"], description: "stored 'location'/'persona' values read as 'environment'/'character'" },
    kind: { type: ["string", "null"], enum: ["person", "outfit", "prop", "place", null] },
    description: { type: ["string", "null"] },
    images: { type: "array", items: { type: "string" }, description: "caller-owned /files urls (1-10)" },
    created_at: {},
  },
};

const REF_LIST_SCHEMA = {
  type: "object",
  required: ["refs"],
  properties: { refs: { type: "array", items: { $ref: "#/components/schemas/Ref" } } },
};

const RUN_STEP_SCHEMA = {
  type: "object",
  required: ["id", "title", "endpoint", "status", "rev", "job_id", "outputs", "error", "depends_on"],
  properties: {
    id: { type: "string", description: "the step's id inside the plan (s1, …)" },
    title: { type: "string" },
    endpoint: { type: "string", description: "the endpoint id this step submits" },
    status: { type: "string", enum: ["pending", "running", "done", "failed", "skipped", "canceled"] },
    rev: { type: "integer", minimum: 0, description: "spec revision - PATCH …/steps/{stepId} must send the current one" },
    job_id: { type: ["string", "null"], format: "uuid", description: "the job this step minted (null until submitted)" },
    outputs: { type: "array", items: OUTPUT_ITEM_SCHEMA, description: "the step job's outputs - same {url,type,bytes} contract as a job's" },
    error: { type: ["string", "null"] },
    depends_on: { type: "array", items: { type: "string" }, description: "step ids that must finish before this one starts" },
  },
};

const RUN_SCHEMA = {
  type: "object",
  required: ["id", "status", "title", "mode", "ask_first", "project_id", "estimate", "planner", "steps", "created_at", "updated_at", "links"],
  properties: {
    id: { type: "string", format: "uuid" },
    status: { type: "string", enum: ["planning", "awaiting_approval", "running", "paused", "done", "failed", "stopped"] },
    title: { type: ["string", "null"] },
    mode: { type: "string", enum: ["auto", "offline", "custom"], description: "v1 accepts auto|offline - custom comes back on runs created in the app" },
    ask_first: { type: "boolean" },
    project_id: { type: ["string", "null"], format: "uuid" },
    estimate: {
      type: "object",
      required: ["credits", "eta_seconds"],
      properties: {
        credits: { type: "number", description: "catalog cost summed over the plan's steps" },
        eta_seconds: { type: ["integer", "null"], description: "median of past step runtimes - null = honest unknown" },
      },
    },
    planner: {
      type: "object",
      required: ["via", "fallback_reason"],
      properties: {
        via: { type: ["string", "null"], description: "what produced the plan - \"built-in planner\", \"provider·model\" or \"skill·slug\"; null for a literal plan" },
        fallback_reason: { type: ["string", "null"], description: "set when the requested planner failed over to the built-in one" },
      },
    },
    steps: { type: "array", items: { $ref: "#/components/schemas/RunStep" } },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
    links: {
      type: "object",
      required: ["self", "approve", "control"],
      properties: {
        self: { type: "string" },
        approve: { type: "string" },
        control: { type: "string" },
      },
    },
  },
};

const PLAN_STEP_INPUT_SCHEMA = {
  type: "object",
  required: ["id", "title", "endpoint_id"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 40, description: "step id - later steps name it in depends_on and $step: refs" },
    title: { type: "string", minLength: 1, maxLength: 160 },
    endpoint_id: { type: "string", description: "one of the endpoint ids /api/v1/models lists" },
    params: { type: "object", description: "the endpoint's params - media fields take /files/uploads/… urls or \"$step:<id>.outputs[n]\" refs into earlier steps" },
    depends_on: { type: "array", items: { type: "string" }, maxItems: 24, description: "earlier step ids that must finish first" },
  },
};

const RUN_CREATE_BODY = {
  type: "object",
  description: "Exactly one of three forms: { plan } (literal plan), { text, planner? } (a brief through the planner - \"builtin\" or \"provider:model\"), or { skill, brief, answers? } (a catalog skill's steps as the plan). inputs supply media the skill/planner fills in; mode is auto|offline; ask_first parks the run at awaiting_approval.",
  properties: {
    plan: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 200 },
        steps: { type: "array", minItems: 1, maxItems: 12, items: PLAN_STEP_INPUT_SCHEMA },
      },
    },
    text: { type: "string", maxLength: 8000, description: "a plain-language brief the planner turns into a plan" },
    planner: { type: "string", maxLength: 200, description: "\"builtin\" or \"<provider>:<model>\" - text runs only" },
    skill: { type: "string", description: "a slug from GET /api/v1/skills" },
    brief: { type: "string", maxLength: 8000, description: "the topic/brief a skill run expands on" },
    answers: { type: "object", additionalProperties: { type: "string" }, description: "intake answers keyed by the skill's intake[].key" },
    inputs: {
      type: "array", maxItems: 8,
      items: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", description: "a /files/ url - from POST /api/v1/uploads or an earlier output; anything else is dropped" },
          mime: { type: "string" },
        },
      },
      description: "media the run can consume - skills fill their media slots from these first, the planner sees them as attachments",
    },
    mode: { type: "string", enum: ["auto", "offline"] },
    ask_first: { type: "boolean", description: "park at awaiting_approval until POST …/approve" },
    project_id: { type: ["string", "null"], format: "uuid" },
  },
};

const SOURCE_HEADER = {
  name: "X-MotionField-Source",
  in: "header",
  required: false,
  description: "provenance tag for this write - `cli` or `mcp` from our own clients; anything else counts as `api`",
  schema: { type: "string", enum: ["cli", "mcp", "api"] },
};

const IDEM_HEADER = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  description: "1-255 printable ASCII characters. Same key + same payload replays the original job/run; same key + different payload is a 422. On POST /api/v1/runs a key is reserved before planning - a concurrent same-key request answers 409 idempotency_in_progress + Retry-After until the create finishes.",
  schema: { type: "string", minLength: 1, maxLength: 255 },
};

const WEBHOOK_URL_PROP = {
  type: "string",
  format: "uri",
  maxLength: 2048,
  description: "http(s) endpoint that receives one signed POST when the job reaches a terminal state",
};

function jobBodySchema(workflow: WorkflowDef) {
  return {
    type: "object",
    required: ["endpoint"],
    properties: {
      endpoint: { const: workflow.endpointId },
      params: paramsJsonSchema(workflow.params),
      webhook_url: WEBHOOK_URL_PROP,
    },
  };
}

const EVENT_TYPES = ["job.completed", "job.failed", "job.nsfw", "job.canceled"] as const;

function webhookOperation(type: (typeof EVENT_TYPES)[number]) {
  return {
    post: {
      summary: type,
      description:
        "One POST per job terminal event. Verify `X-MotionField-Signature` against the " +
        "`ofwh_…` secret shown when the key is created or rotated.",
      parameters: [
        {
          name: "X-MotionField-Signature",
          in: "header",
          required: true,
          description: "`t=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>`",
          schema: { type: "string" },
        },
        {
          name: "X-MotionField-Event-Id",
          in: "header",
          required: true,
          description: "delivery id - retries resend the same body and event id",
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["id", "type", "created", "data"],
              properties: {
                id: { type: "string", format: "uuid" },
                type: { const: type },
                created: { type: "integer", description: "unix seconds" },
                data: { $ref: "#/components/schemas/Job" },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Acknowledged - any 2xx counts as delivered" },
      },
    },
  };
}

const jsonBody = (schema: unknown) => ({ required: true, content: { "application/json": { schema } } });
const errResp = (desc: string) => ({ description: desc, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });

export function buildOpenApi() {
  const endpoints = openEndpoints();
  return {
    openapi: "3.1.0",
    info: {
      title: "MotionField API",
      version: "1.0.0",
      description: "Programmatic access to MotionField generation endpoints. Bearer-token authenticated; binary results are streamed from a dedicated result endpoint.",
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/v1/models": {
        get: {
          summary: "List callable endpoints with their input JSON Schemas",
          responses: {
            "200": {
              description: "endpoint catalog",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      models: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["id", "kind", "label", "tags", "inputs", "license", "estimate", "tier"],
                          properties: {
                            id: { type: "string" },
                            kind: { type: "string" },
                            label: { type: "string" },
                            tags: { type: "array", items: { type: "string" }, description: "the model's catalog tags - clients may rank or filter on them" },
                            inputs: {
                              type: "object",
                              description: "JSON Schema for the endpoint's params. Media params carry `x-media` - `image`|`video`|`audio`|`media` on the property (on `items` for array fields; `media` means any kind, narrowed by `accepts` when present) - and their string values are urls from POST /api/v1/uploads.",
                            },
                            license: {
                              type: "object",
                              required: ["class", "components"],
                              properties: {
                                class: { type: "string", enum: ["open", "restricted", "banned"] },
                                components: {
                                  type: "array",
                                  items: {
                                    type: "object",
                                    required: ["name", "license", "url"],
                                    properties: {
                                      name: { type: "string" },
                                      license: { type: "string" },
                                      url: { type: "string" },
                                    },
                                  },
                                },
                              },
                            },
                            estimate: {
                              type: "object",
                              required: ["credits"],
                              properties: { credits: { type: ["number", "null"] } },
                            },
                            tier: { type: "string", enum: ["local", "cloud"] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "401": errResp("missing or invalid API key"),
          },
        },
      },
      "/api/v1/jobs": {
        get: {
          summary: "List your jobs, newest first, cursor-paginated",
          description: "Snapshot read - does not advance jobs. Follow `next_cursor` as `before` until null. `ids` returns the named jobs in request order (no pagination).",
          parameters: [
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["queued", "in_progress", "completed", "failed", "nsfw", "canceled"] } },
            { name: "ids", in: "query", required: false, description: "up to 12 comma-separated job UUIDs - returns the found set in request order", schema: { type: "string" } },
            { name: "kind", in: "query", required: false, description: "job kind (image | video | audio | edit | upscale | character | v2v | avatar | threed)", schema: { type: "string" } },
            { name: "source", in: "query", required: false, schema: SOURCE_PROP },
            { name: "before", in: "query", required: false, description: "cursor from a previous page's next_cursor", schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "job page", content: { "application/json": { schema: { $ref: "#/components/schemas/JobList" } } } },
            "400": errResp("bad limit/status/ids/kind/source/before"),
            "401": errResp("missing or invalid API key"),
          },
        },
        post: {
          summary: "Submit a generation job",
          description: "`params` is validated against the endpoint's declared fields. One variant per endpoint.",
          parameters: [IDEM_HEADER, SOURCE_HEADER],
          requestBody: jsonBody({ oneOf: endpoints.map((e) => jobBodySchema(e.workflow)) }),
          responses: {
            "202": { description: "job created", content: { "application/json": { schema: { $ref: "#/components/schemas/JobCreated" } } } },
            "200": { description: "idempotent replay - same Idempotency-Key + payload", content: { "application/json": { schema: { $ref: "#/components/schemas/JobCreated" } } } },
            "400": errResp("malformed body or missing fields"),
            "401": errResp("missing or invalid API key"),
            "402": errResp("insufficient credits or plan too low"),
            "403": errResp("restricted_license - the endpoint's license requires an opt-in at /settings/licenses first"),
            "404": errResp("unknown endpoint"),
            "413": errResp("body over 1MB"),
            "422": errResp("Idempotency-Key reused with a different payload"),
            "429": errResp("per-key concurrency cap (Retry-After: 5)"),
          },
        },
      },
      "/api/v1/jobs/{id}": {
        get: {
          summary: "Job state (owner only)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": { description: "job view", content: { "application/json": { schema: { $ref: "#/components/schemas/Job" } } } },
            "401": errResp("missing or invalid API key"),
            "404": errResp("not found (or not yours)"),
          },
        },
      },
      "/api/v1/jobs/{id}/cancel": {
        post: {
          summary: "Cancel a queued or in_progress job (auto-refund)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": { description: "job view", content: { "application/json": { schema: { $ref: "#/components/schemas/Job" } } } },
            "401": errResp("missing or invalid API key"),
            "404": errResp("not found (or not yours)"),
          },
        },
      },
      "/api/v1/jobs/{id}/result": {
        get: {
          summary: "Stream an output file",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
            { name: "i", in: "query", required: false, schema: { type: "integer", default: 0 } },
          ],
          responses: {
            "200": { description: "output bytes with media Content-Type", content: { "application/octet-stream": {} } },
            "401": errResp("missing or invalid API key"),
            "404": errResp("no output at that index"),
            "409": errResp("job not completed yet"),
          },
        },
      },
      "/api/v1/runs": {
        post: {
          summary: "Create a multi-step run",
          description:
            "Thin wrapper over the run engine: exactly one of { plan }, { text, planner? } or { skill, brief, answers? }. " +
            "The run starts ticking immediately unless the estimate or ask_first parks it at awaiting_approval. " +
            "Run ids mint jobs per step - poll GET /api/v1/runs/{id} (reads tick once, like jobs).",
          parameters: [IDEM_HEADER, SOURCE_HEADER],
          requestBody: jsonBody(RUN_CREATE_BODY),
          responses: {
            "201": { description: "run created", content: { "application/json": { schema: { $ref: "#/components/schemas/Run" } } } },
            "200": { description: "idempotent replay - same Idempotency-Key + payload", content: { "application/json": { schema: { $ref: "#/components/schemas/Run" } } } },
            "400": errResp("malformed body, or not exactly one of plan/text/skill"),
            "401": errResp("missing or invalid API key"),
            "402": errResp("insufficient credits"),
            "403": errResp("restricted_license - a step's endpoint requires an opt-in at /settings/licenses first"),
            "404": errResp("unknown skill or project"),
            "409": errResp("idempotency_in_progress - a same-key create is still in flight; retry after Retry-After seconds"),
            "413": errResp("body over 1MB"),
            "422": errResp("plan failed validation (unknown endpoint, bad $step: ref, missing required param), the planner needed more input, or Idempotency-Key reused with a different payload"),
          },
        },
      },
      "/api/v1/runs/{id}": {
        get: {
          summary: "Run state (owner only) - live runs tick once on read",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": { description: "run view", content: { "application/json": { schema: { $ref: "#/components/schemas/Run" } } } },
            "401": errResp("missing or invalid API key"),
            "404": errResp("not found (or not yours)"),
          },
        },
      },
      "/api/v1/runs/{id}/approve": {
        post: {
          summary: "Release an awaiting_approval run (idempotent)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": { description: "run view", content: { "application/json": { schema: { $ref: "#/components/schemas/Run" } } } },
            "401": errResp("missing or invalid API key"),
            "404": errResp("not found (or not yours)"),
          },
        },
      },
      "/api/v1/runs/{id}/control": {
        post: {
          summary: "Pause, resume or stop a run (idempotent per action)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: jsonBody({
            type: "object",
            required: ["action"],
            properties: { action: { type: "string", enum: ["pause", "resume", "stop"] } },
          }),
          responses: {
            "200": { description: "run view", content: { "application/json": { schema: { $ref: "#/components/schemas/Run" } } } },
            "400": errResp("bad action"),
            "401": errResp("missing or invalid API key"),
            "404": errResp("not found (or not yours)"),
            "409": errResp("invalid transition for the run's current status"),
          },
        },
      },
      "/api/v1/runs/{id}/steps/{stepId}": {
        patch: {
          summary: "Edit one step's spec - rev is optimistic concurrency",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
            { name: "stepId", in: "path", required: true, description: "the step's id in the plan (s1, …)", schema: { type: "string" } },
          ],
          requestBody: jsonBody({
            type: "object",
            required: ["rev"],
            properties: {
              rev: { type: "integer", minimum: 0, description: "the step rev the caller last saw - a stale one answers 409 stale_revision + head_rev" },
              title: { type: "string", maxLength: 160 },
              params: { type: "object", description: "merged onto the stored params - the whole step revalidates" },
            },
          }),
          responses: {
            "200": { description: "run view", content: { "application/json": { schema: { $ref: "#/components/schemas/Run" } } } },
            "400": errResp("missing rev"),
            "401": errResp("missing or invalid API key"),
            "404": errResp("run or step not found (or not yours)"),
            "409": errResp("stale_revision (error carries head_rev) or an edit the live run refuses"),
            "422": errResp("the edited step fails validation"),
          },
        },
      },
      "/api/v1/uploads": {
        post: {
          summary: "Upload input media (multipart field `file`, ≤200MB)",
          parameters: [SOURCE_HEADER],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["file"],
                  properties: { file: { type: "string", format: "binary" } },
                },
              },
            },
          },
          responses: {
            "201": { description: "stored - pass `url` to media params", content: { "application/json": { schema: { type: "object", properties: { url: { type: "string" } } } } } },
            "401": errResp("missing or invalid API key"),
            "413": errResp("file over 200MB"),
            "415": errResp("file type not accepted"),
          },
        },
      },
      "/api/v1/estimate": {
        post: {
          summary: "Credit + USD cost preview for an endpoint",
          requestBody: jsonBody({
            type: "object",
            required: ["endpoint"],
            properties: {
              endpoint: { type: "string", enum: endpoints.map((e) => e.workflow.endpointId) },
              params: { type: "object" },
            },
          }),
          responses: {
            "200": {
              description: "cost estimate",
              content: { "application/json": { schema: { type: "object", properties: { credits: { type: "number" }, usd: { type: "number" }, unlimited: { type: "boolean" } } } } },
            },
            "400": errResp("malformed body"),
            "401": errResp("missing or invalid API key"),
            "404": errResp("unknown endpoint"),
          },
        },
      },
      "/api/v1/assets": {
        get: {
          summary: "List your generated assets, newest first, cursor-paginated",
          parameters: [
            { name: "kind", in: "query", required: false, schema: { type: "string", enum: ["image", "video", "audio", "file"] } },
            { name: "source", in: "query", required: false, schema: SOURCE_PROP },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
            { name: "before", in: "query", required: false, description: "cursor from a previous page's next_cursor", schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "asset page", content: { "application/json": { schema: { $ref: "#/components/schemas/AssetList" } } } },
            "400": errResp("bad kind/source/limit/before"),
            "401": errResp("missing or invalid API key"),
          },
        },
      },
      "/api/v1/presets": {
        get: {
          summary: "Preset catalog - named param recipes for style/effect/shot variants",
          description: "Presets whose `model_hint` points at restricted weights are hidden until the caller opts in at /settings/licenses.",
          parameters: [
            { name: "kind", in: "query", required: false, schema: { type: "string", enum: ["motion", "effect", "style", "palette", "mixed-media"] } },
          ],
          responses: {
            "200": { description: "preset list", content: { "application/json": { schema: { $ref: "#/components/schemas/PresetList" } } } },
            "400": errResp("bad kind"),
            "401": errResp("missing or invalid API key"),
          },
        },
      },
      "/api/v1/presets/resolve": {
        post: {
          summary: "Resolve preset/style/effect ids in a params block",
          description: "Runs the same resolveParams stage as job submission - returns the merged params (preset apply values + prompt fragments, marker fields stripped) without creating a job.",
          requestBody: jsonBody({
            type: "object",
            required: ["endpoint"],
            properties: {
              endpoint: { type: "string", description: "endpoint the params will be submitted to" },
              params: { type: "object", description: "raw params - may contain preset markers (*_preset / *_id fields)" },
            },
          }),
          responses: {
            "200": { description: "resolved params", content: { "application/json": { schema: { type: "object", required: ["endpoint", "params"], properties: { endpoint: { type: "string" }, params: { type: "object" } } } } } },
            "400": errResp("malformed body"),
            "401": errResp("missing or invalid API key"),
            "404": errResp("unknown endpoint"),
          },
        },
      },
      "/api/v1/refs": {
        get: {
          summary: "List your refs, newest first - ?category= narrows",
          parameters: [
            { name: "category", in: "query", required: false, schema: { type: "string", enum: ["character", "environment", "prop"] } },
          ],
          responses: {
            "200": { description: "ref list", content: { "application/json": { schema: { $ref: "#/components/schemas/RefList" } } } },
            "400": errResp("unknown category"),
            "401": errResp("missing or invalid API key"),
          },
        },
        post: {
          summary: "Create a ref - a named @reference built from your own images",
          description:
            "The name slugifies to the @ref form ([a-z0-9-], ≤80). Every image url must be one of " +
            "your own /files urls - another user's answers 404, an external url 400. Person or " +
            "character refs need likeness_consent:true. A duplicate name is a 409.",
          parameters: [SOURCE_HEADER],
          requestBody: jsonBody({
            type: "object",
            required: ["name", "images"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 80 },
              category: { type: "string", enum: ["character", "environment", "prop"], default: "character" },
              kind: { type: "string", enum: ["person", "outfit", "prop", "place"] },
              description: { type: "string", maxLength: 500 },
              images: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", description: "a /files/ url you own" } },
              likeness_consent: { type: "boolean", description: "required true for person/character refs" },
            },
          }),
          responses: {
            "201": { description: "created", content: { "application/json": { schema: { type: "object", properties: { ref: { $ref: "#/components/schemas/Ref" } } } } } },
            "400": errResp("malformed body, empty slug, missing likeness consent, or an external image url"),
            "401": errResp("missing or invalid API key"),
            "404": errResp("an image url that isn't yours (or doesn't exist)"),
            "409": errResp("a ref with that name already exists"),
            "413": errResp("body over 64KB"),
          },
        },
      },
      "/api/v1/refs/{name}": {
        get: {
          summary: "One of your refs by slug name",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "the ref", content: { "application/json": { schema: { type: "object", properties: { ref: { $ref: "#/components/schemas/Ref" } } } } } },
            "401": errResp("missing or invalid API key"),
            "404": errResp("no ref with that name (or not yours)"),
          },
        },
      },
      "/api/v1/me": {
        get: {
          summary: "Caller identity - user, plan, credits and the key's label",
          responses: {
            "200": { description: "identity", content: { "application/json": { schema: { $ref: "#/components/schemas/Me" } } } },
            "401": errResp("missing or invalid API key"),
            "404": errResp("user not found"),
          },
        },
      },
      "/api/v1/system": {
        get: {
          summary: "Queue depth, GPU busy, deployment tier and free disk",
          responses: {
            "200": { description: "system state", content: { "application/json": { schema: { $ref: "#/components/schemas/SystemInfo" } } } },
            "401": errResp("missing or invalid API key"),
          },
        },
      },
      "/api/v1/skills": {
        get: {
          summary: "List skill pipelines",
          responses: {
            "200": {
              description: "skill list",
              content: {
                "application/json": {
                  schema: { type: "object", required: ["skills"], properties: { skills: { type: "array", items: { $ref: "#/components/schemas/SkillSummary" } } } },
                },
              },
            },
            "401": errResp("missing or invalid API key"),
          },
        },
      },
      "/api/v1/skills/{slug}": {
        get: {
          summary: "One skill plus its generated SKILL.md",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "skill detail", content: { "application/json": { schema: { $ref: "#/components/schemas/SkillDetail" } } } },
            "401": errResp("missing or invalid API key"),
            "404": errResp("unknown skill"),
          },
        },
      },
      "/api/v1/capabilities": {
        get: {
          summary: "Static capability registry - clients gate optional command groups on it",
          responses: {
            "200": { description: "capability list", content: { "application/json": { schema: { $ref: "#/components/schemas/Capabilities" } } } },
            "401": errResp("missing or invalid API key"),
          },
        },
      },
      "/api/v1/openapi.json": {
        get: {
          summary: "This document",
          security: [],
          responses: { "200": { description: "OpenAPI 3.1 document" } },
        },
      },
    },
    webhooks: Object.fromEntries(EVENT_TYPES.map((t) => [t, webhookOperation(t)])),
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "API key `of_<keyId>_<secret>` - created under Settings → API keys or POST /api/keys" },
      },
      schemas: {
        Error: ERROR_SCHEMA,
        Job: JOB_SCHEMA,
        JobCreated: JOB_CREATED_SCHEMA,
        JobList: JOB_LIST_SCHEMA,
        Me: ME_SCHEMA,
        SystemInfo: SYSTEM_SCHEMA,
        SkillSummary: SKILL_SUMMARY_SCHEMA,
        SkillDetail: SKILL_DETAIL_SCHEMA,
        Capabilities: CAPABILITIES_SCHEMA,
        Asset: ASSET_SCHEMA,
        AssetList: ASSET_LIST_SCHEMA,
        Preset: PRESET_SCHEMA,
        PresetList: PRESET_LIST_SCHEMA,
        Ref: REF_SCHEMA,
        RefList: REF_LIST_SCHEMA,
        Run: RUN_SCHEMA,
        RunStep: RUN_STEP_SCHEMA,
      },
    },
  };
}
