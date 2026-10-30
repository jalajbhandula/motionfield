/**
 * MotionField public API client - zero runtime dependencies.
 *
 * Requires Node ≥18.20 (fetch, AbortSignal.timeout) or any modern fetch
 * runtime for requests - including a WebCrypto `globalThis.crypto`.
 * verifyWebhook needs a synchronous HMAC (WebCrypto is async-only), so it
 * pulls node:crypto in lazily at first use - importing this module never
 * eagerly requires Node builtins.
 * See docs/API.md or the app's /docs/api page for the wire contract.
 */

/** Lazily-loaded node:crypto - see the module comment. */
type NodeCrypto = typeof import("node:crypto");
let _nodeCrypto: NodeCrypto | undefined;
function nodeCrypto(): NodeCrypto {
  if (_nodeCrypto) return _nodeCrypto;
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  if (!proc?.getBuiltinModule)
    throw new Error("verifyWebhook requires Node ≥20.16 (process.getBuiltinModule) - or any runtime exposing node:crypto");
  _nodeCrypto = proc.getBuiltinModule("node:crypto") as NodeCrypto;
  return _nodeCrypto;
}

/* ---------------- wire types ---------------- */

export type JobStatus = "queued" | "in_progress" | "completed" | "failed" | "nsfw" | "canceled";

/** Statuses after which a job never moves again. */
export const TERMINAL_STATUSES: readonly JobStatus[] = ["completed", "failed", "nsfw", "canceled"];

export interface JobOutput {
  url: string;
  /** Output MIME type - "image/png", "video/mp4", "model/gltf-binary", … */
  type: string;
  bytes: number | null;
}

export type JobSource = "ui" | "api" | "cli" | "mcp" | "agent";

export interface Job {
  id: string;
  status: JobStatus;
  progress: number;
  /** the endpoint id the job was submitted to + its job kind. */
  endpoint: string;
  kind: string;
  /** the params exactly as submitted (media fields hold /files/uploads/… urls). */
  params: Record<string, unknown>;
  outputs: JobOutput[];
  error: string | null;
  /** the surface that submitted the job */
  source: JobSource;
  created_at: string;
  updated_at: string;
}

export interface JobCreated {
  id: string;
  status: string;
  created_at: string;
  links: { self: string; cancel: string; result: string };
}

/** One signed webhook delivery - the body of the POST to webhook_url. */
export interface WebhookEvent {
  id: string;
  type: "job.completed" | "job.failed" | "job.nsfw" | "job.canceled";
  /** unix seconds */
  created: number;
  data: Job;
}

export interface Model {
  id: string;
  kind: string;
  label: string;
  /** the model's catalog tags - search/facet words. */
  tags: string[];
  /** JSON Schema for the endpoint's params object. Media params carry
   *  `x-media` (`image`|`video`|`audio`|`media`; on `items` for arrays) and
   *  their string values are urls from POST /api/v1/uploads. */
  inputs: Record<string, unknown>;
  license: {
    class: "open" | "restricted" | "banned";
    components: { name: string; license: string; url: string | null }[];
  };
  /** Default-params cost on your plan; null when the endpoint needs input. */
  estimate: { credits: number | null };
  tier: "local" | "cloud";
}

export interface Estimate {
  credits: number | null;
  usd: number;
  unlimited: boolean;
}

export interface MediaProbe {
  /** video-stream seconds (frames ÷ fps) - container duration can run long */
  duration: number;
  fps: number;
  width: number;
  height: number;
  rotation: number;
  has_audio: boolean;
  frames: number;
  /** the working size the clip renders at inside the Wan box */
  render_width: number;
  render_height: number;
  /** detected shot-window count for ReCut; null when detection failed */
  windows: number | null;
}

export interface UploadedFile {
  url: string;
}

export interface Me {
  user_id: string;
  email: string;
  plan: string | null;
  credits: number;
  key: { id: string; label: string };
}

export interface SystemInfo {
  queue: { queued: number; in_progress: number };
  gpu: { busy: boolean };
  tier: "local" | "cloud";
  disk: { free_gb: number | null };
}

export interface SkillSummary {
  slug: string;
  name: string;
  description: string;
}

export interface SkillDetail extends SkillSummary {
  /** generated SKILL.md - front matter, pipeline steps, intake questions, endpoints */
  skill_md: string;
}

export interface JobList {
  jobs: Job[];
  next_cursor: string | null;
}

export interface Asset {
  id: string;
  job_id: string | null;
  kind: string;
  url: string;
  mime: string | null;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  bytes: number | null;
  prompt: string | null;
  endpoint_id: string | null;
  source: JobSource;
  created_at: string;
}

export interface AssetList {
  assets: Asset[];
  next_cursor: string | null;
}

export interface Preset {
  id: string;
  kind: string;
  title: string;
  description: string;
  category: string | null;
  credits: number | null;
  input_required: string;
  model_hint: string | null;
  apply: Record<string, unknown>;
  prompt_fragment: string | null;
}

export interface PresetList {
  presets: Preset[];
}

export interface Ref {
  id: string;
  name: string;
  category: string;
  kind: string | null;
  description: string | null;
  images: string[];
  created_at: unknown;
}

export interface RefList {
  refs: Ref[];
}

export interface CreateRefInput {
  name: string;
  category?: "character" | "environment" | "prop";
  kind?: "person" | "outfit" | "prop" | "place";
  description?: string;
  /** 1-10 /files/ urls you own - uploads or generated assets. */
  images: string[];
  /** required true for person/character refs (docs/POLICY.md). */
  likeness_consent?: boolean;
}

/* ---------------- runs ---------------- */

export type RunStatus =
  "planning" | "awaiting_approval" | "running" | "paused" | "done" | "failed" | "stopped";

/** Statuses after which a run never moves again. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["done", "failed", "stopped"];

export type RunStepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "canceled";

export interface RunStep {
  /** the step's id inside the plan (s1, …) */
  id: string;
  title: string;
  /** the endpoint id this step submits */
  endpoint: string;
  status: RunStepStatus;
  /** spec revision - PATCH needs the current one */
  rev: number;
  /** the job this step minted (null until submitted) */
  job_id: string | null;
  outputs: JobOutput[];
  error: string | null;
  /** step ids that must finish before this one starts */
  depends_on: string[];
}

export interface Run {
  id: string;
  status: RunStatus;
  title: string | null;
  /** v1 accepts auto|offline; runs created in the app may come back "custom" */
  mode: "auto" | "offline" | "custom";
  ask_first: boolean;
  project_id: string | null;
  estimate: { credits: number; eta_seconds: number | null };
  planner: { via: string | null; fallback_reason: string | null };
  steps: RunStep[];
  created_at: string;
  updated_at: string;
  links: { self: string; approve: string; control: string };
}

export interface RunPlanStep {
  /** step id - later steps name it in depends_on and "$step:<id>.outputs[n]" refs */
  id: string;
  title: string;
  endpoint_id: string;
  params?: Record<string, unknown>;
  depends_on?: string[];
}

export interface RunPlan {
  title?: string;
  steps: RunPlanStep[];
}

/** POST /api/v1/runs body - exactly one of plan / text(+planner) / skill(+brief+answers). */
export interface CreateRunInput {
  /** literal plan - same shape the app takes */
  plan?: RunPlan;
  /** a plain-language brief the planner turns into a plan */
  text?: string;
  /** "builtin" or "<provider>:<model>" - text runs only */
  planner?: string;
  /** a slug from GET /api/v1/skills */
  skill?: string;
  /** the topic/brief a skill run expands on */
  brief?: string;
  /** intake answers keyed by the skill's intake[].key */
  answers?: Record<string, string>;
  /** media the run can consume - /files/ urls from POST /api/v1/uploads (or
   *  earlier job outputs). Skills fill their media slots from these first;
   *  the planner sees them as attachments. Anything else is dropped. */
  inputs?: { url: string; mime?: string }[];
  mode?: "auto" | "offline";
  /** park at awaiting_approval until POST …/approve */
  ask_first?: boolean;
  project_id?: string | null;
}

export interface StepEditInput {
  /** the step rev the caller last saw - a stale one is a 409 stale_revision */
  rev: number;
  title?: string;
  /** merged onto the stored params - the whole step revalidates */
  params?: Record<string, unknown>;
}

export type RunControlAction = "pause" | "resume" | "stop";

/* ---------------- Stage (the /api/stage 3D scene API - not v1) ---------------- */

/** One row of GET /api/stage. */
export interface StageSceneSummary {
  id: string;
  revision: number;
  title: string | null;
  created_at?: string;
  updated_at?: string;
}

/** GET /api/stage/:id - the live head. */
export interface StageSceneRead {
  id: string;
  title: string | null;
  scene: Record<string, unknown>;
  refs?: unknown[];
  refs_read?: { ref: unknown; status: string; note?: string }[];
  revision: number;
  created_at?: string;
  updated_at?: string;
}

/** POST /api/stage body - `empty:true` mints the default camera+ground
 *  scene with no LLM; `prompt` runs the scene writer (needs a configured
 *  LLM route on the server). */
export interface StageCreateInput {
  prompt?: string;
  empty?: boolean;
  refs?: string[];
  duration?: number;
  aspect?: string;
  fps?: number;
}

export interface StageCreateResult {
  id: string;
  revision: number;
  scene: Record<string, unknown>;
  refs?: unknown[];
  refs_read?: { ref: unknown; status: string; note?: string }[];
}

/** A typed Stage op - the schema lives server-side (`src/lib/stage/ops`);
 *  the SDK passes op objects through untouched. */
export type StageOp = Record<string, unknown>;

/** op vocabulary POST /api/stage/:id/ops understands (as {op:"…",…} objects):
 *  add {node} · update {id,path,value} · remove {id} ·
 *  set_camera_path {id,path|null} · apply_move {id,move,strength?,duration_s?,seed?}
 *  (move = a catalog trajectory id like "dolly-in"/"orbit-left-45" or a
 *  fuzzy name - "push in" resolves to dolly-in) · set_keys {id,keys[]} ·
 *  set_env {env} · set_meta {meta} · rename {id,name} · reparent {id,parent} */
export interface StageOpsResult {
  /** the new head revision */
  revision: number;
  /** the post-ops scene document */
  scene: Record<string, unknown>;
}

/** One row of GET /api/stage/:id/revisions - newest first. */
export interface StageRevisionSummary {
  revision: number;
  source: string;
  title: string | null;
  node_count: number;
  created_at: string;
}

/** GET /api/stage/:id/revisions/:rev - the full stored scene. */
export interface StageRevisionRead {
  revision: number;
  source: string;
  scene: Record<string, unknown>;
  created_at: string;
}

/* ---------------- errors ---------------- */

export interface ErrorInit {
  status: number;
  code: string;
  message: string;
  retryAfter?: number;
  license?: string;
  enableAt?: string;
  headRev?: number;
}

export class MotionFieldError extends Error {
  readonly status: number;
  readonly code: string;
  /** Retry-After seconds, when the server sent one (429/503). */
  readonly retryAfter?: number;
  /** 403 restricted_license only. */
  readonly license?: string;
  /** 403 restricted_license only - the UI path to opt in. */
  readonly enableAt?: string;
  /** 409 stale_revision only - the step's current rev, for refetch-and-retry. */
  readonly headRev?: number;

  constructor(init: ErrorInit) {
    super(init.message);
    this.name = "MotionFieldError";
    this.status = init.status;
    this.code = init.code;
    this.retryAfter = init.retryAfter;
    this.license = init.license;
    this.enableAt = init.enableAt;
    this.headRev = init.headRev;
  }

  static async fromResponse(res: Response): Promise<MotionFieldError> {
    let code = `http_${res.status}`;
    let message = res.statusText || `HTTP ${res.status}`;
    let license: string | undefined;
    let enableAt: string | undefined;
    let headRev: number | undefined;
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string; license?: string; enable_at?: string; head_rev?: number } | string;
        code?: string;
        head_revision?: number;
      } | null;
      const e = body?.error;
      if (e && typeof e === "object") {
        code = e.code ?? code;
        message = e.message ?? message;
        license = e.license;
        enableAt = e.enable_at;
        if (typeof e.head_rev === "number") headRev = e.head_rev;
      } else if (typeof e === "string" && e) {
        /* the stage routes answer flat {error: "…", code?, head_revision?} -
         * mapped onto the same codes clients branch on (stale_revision,
         * idempotency_mismatch, not_found). */
        message = e;
        if (typeof body!.head_revision === "number") headRev = body!.head_revision;
        const flat = typeof body!.code === "string"
          ? body!.code.toLowerCase().replace(/[^a-z0-9]+/g, "_")
          : undefined;
        code = flat
          ?? (res.status === 409 && headRev !== undefined ? "stale_revision"
            : res.status === 404 ? "not_found"
            : res.status === 401 ? "unauthorized"
            : res.status === 403 ? "forbidden"
            : code);
      }
    } catch { /* non-JSON error body - keep the defaults */ }
    return new MotionFieldError({
      status: res.status, code, message, license, enableAt, headRev,
      retryAfter: retryAfterSeconds(res.headers.get("retry-after")),
    });
  }
}

/** Retry-After supports both delta-seconds and HTTP-date forms. */
function retryAfterSeconds(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, (t - Date.now()) / 1000) : undefined;
}

/* ---------------- client ---------------- */

export interface ClientOptions {
  /** e.g. "http://localhost:3000" - trailing slashes are trimmed. */
  baseUrl: string;
  /** `of_…` token from Settings → API keys. */
  apiKey: string;
  /** provenance tag for writes - sent as X-MotionField-Source; jobs/uploads
   *  land tagged "api" when unset. Our own clients pass "cli" or "mcp". */
  source?: "cli" | "mcp" | "api";
  /** per-attempt timeout, ms - default 30_000 */
  timeoutMs?: number;
  /** injectable fetch - defaults to globalThis.fetch */
  fetch?: typeof fetch;
}

export interface SubmitOptions {
  /** delivery target; must be an endpoint enabled on the key's webhook secret */
  webhookUrl?: string;
  /** defaults to a fresh random UUID - replay returns the original job */
  idempotencyKey?: string;
}

export interface WaitOptions {
  /** poll interval, ms - default 1000 */
  intervalMs?: number;
  /** total wait budget, ms - default 600_000 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 300;
const MAX_DELAY_MS = 30_000;
/** A text brief can plan for minutes server-side (the server's planner
 *  budget - default 300 s, MOTIONFIELD_PLANNER_BUDGET_MS) - POST /runs needs
 *  an attempt window that outlives it, and a same-key create still in
 *  flight is retried inside this total budget. */
const CREATE_ATTEMPT_FLOOR_MS = 330_000;
const IN_PROGRESS_BUDGET_MS = 340_000;

export class MotionField {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly source?: "cli" | "mcp" | "api";
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.source = opts.source;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error("no fetch implementation available - pass ClientOptions.fetch");
    this.fetchFn = f.bind(globalThis) as typeof fetch;
  }

  private async send(
    path: string, init: RequestInit, retry: boolean,
    signal?: AbortSignal, attemptTimeoutMs?: number,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          ...init,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            ...(this.source ? { "x-motionfield-source": this.source } : {}),
            ...(init.headers as Record<string, string> | undefined),
          },
          signal: combineSignals(AbortSignal.timeout(attemptTimeoutMs ?? this.timeoutMs), signal),
        });
      } catch (e) {
        if (signal?.aborted) throw new MotionFieldError({ status: 0, code: "aborted", message: "request aborted" });
        if (retry && attempt < MAX_ATTEMPTS) { await sleep(BASE_DELAY_MS * 2 ** (attempt - 1)); continue; }
        if (e instanceof MotionFieldError) throw e;
        throw new MotionFieldError({ status: 0, code: "network_error", message: e instanceof Error ? e.message : String(e) });
      }
      if (res.ok) return res;
      const err = await MotionFieldError.fromResponse(res);
      const retryable = res.status === 429 || res.status >= 500;
      if (retry && retryable && attempt < MAX_ATTEMPTS) {
        const hinted = err.retryAfter != null ? Math.min(err.retryAfter * 1000, MAX_DELAY_MS) : null;
        await sleep(hinted ?? Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS));
        continue;
      }
      throw err;
    }
  }

  private async json<T>(method: string, path: string, opts?: {
    body?: unknown;
    headers?: Record<string, string>;
    retry?: boolean;
    signal?: AbortSignal;
    /** per-attempt timeout override - create runs plan server-side */
    attemptTimeoutMs?: number;
  }): Promise<T> {
    const res = await this.send(path, {
      method,
      headers: { "content-type": "application/json", ...(opts?.headers ?? {}) },
      body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
    }, opts?.retry ?? false, opts?.signal, opts?.attemptTimeoutMs);
    return res.json() as Promise<T>;
  }

  /** GET /api/v1/me - who this key belongs to; the key itself is never returned. */
  async me(): Promise<Me> {
    return this.json<Me>("GET", "/api/v1/me", { retry: true });
  }

  /** GET /api/v1/system - caller queue depth, GPU busy, tier, free disk. */
  async system(): Promise<SystemInfo> {
    return this.json<SystemInfo>("GET", "/api/v1/system", { retry: true });
  }

  /** GET /api/v1/capabilities - the static registry clients gate optional
   *  command groups on. */
  async capabilities(): Promise<string[]> {
    const r = await this.json<{ capabilities: string[] }>("GET", "/api/v1/capabilities", { retry: true });
    return r.capabilities;
  }

  /** GET /api/v1/jobs - the caller's jobs, newest first. Follow next_cursor as
   *  `before` until null. `ids` (≤12) returns the found set in request order. */
  async listJobs(opts: {
    limit?: number; status?: JobStatus; before?: string;
    ids?: string[]; kind?: string; source?: JobSource;
  } = {}): Promise<JobList> {
    const sp = new URLSearchParams();
    if (opts.limit != null) sp.set("limit", String(opts.limit));
    if (opts.status) sp.set("status", opts.status);
    if (opts.ids?.length) sp.set("ids", opts.ids.join(","));
    if (opts.kind) sp.set("kind", opts.kind);
    if (opts.source) sp.set("source", opts.source);
    if (opts.before) sp.set("before", opts.before);
    const qs = sp.toString();
    return this.json<JobList>("GET", `/api/v1/jobs${qs ? `?${qs}` : ""}`, { retry: true });
  }

  /** GET /api/v1/assets - the caller's generated assets, newest first. */
  async listAssets(opts: {
    kind?: string; source?: JobSource; limit?: number; before?: string;
  } = {}): Promise<AssetList> {
    const sp = new URLSearchParams();
    if (opts.kind) sp.set("kind", opts.kind);
    if (opts.source) sp.set("source", opts.source);
    if (opts.limit != null) sp.set("limit", String(opts.limit));
    if (opts.before) sp.set("before", opts.before);
    const qs = sp.toString();
    return this.json<AssetList>("GET", `/api/v1/assets${qs ? `?${qs}` : ""}`, { retry: true });
  }

  /** GET /api/v1/presets - the preset catalog (restricted-weight presets stay
   *  hidden until the caller opts in). */
  async listPresets(opts: { kind?: string } = {}): Promise<Preset[]> {
    const sp = new URLSearchParams();
    if (opts.kind) sp.set("kind", opts.kind);
    const qs = sp.toString();
    return (await this.json<PresetList>("GET", `/api/v1/presets${qs ? `?${qs}` : ""}`, { retry: true })).presets;
  }

  /** POST /api/v1/presets/resolve - what preset/style/effect ids will do to
   *  a params block, without creating a job. */
  async resolvePreset(endpoint: string, params: Record<string, unknown> = {}): Promise<{ endpoint: string; params: Record<string, unknown> }> {
    return this.json("POST", "/api/v1/presets/resolve", { body: { endpoint, params }, retry: true });
  }

  /** GET /api/v1/refs - the caller's refs, newest first. */
  async listRefs(opts: { category?: string } = {}): Promise<Ref[]> {
    const qs = new URLSearchParams();
    if (opts.category) qs.set("category", opts.category);
    const q = qs.toString();
    return (await this.json<RefList>("GET", `/api/v1/refs${q ? `?${q}` : ""}`, { retry: true })).refs;
  }

  /** GET /api/v1/refs/{name} - one ref by slug name; 404 when it isn't yours. */
  async getRef(name: string): Promise<Ref> {
    return (await this.json<{ ref: Ref }>("GET", `/api/v1/refs/${encodeURIComponent(name)}`, { retry: true })).ref;
  }

  /** POST /api/v1/refs - create a ref; the name slugifies to the @ref form. */
  async createRef(input: CreateRefInput): Promise<Ref> {
    return (await this.json<{ ref: Ref }>("POST", "/api/v1/refs", { body: input })).ref;
  }

  /** GET /api/v1/skills - the catalog's skill pipelines. */
  async skills(): Promise<SkillSummary[]> {
    const r = await this.json<{ skills: SkillSummary[] }>("GET", "/api/v1/skills", { retry: true });
    return r.skills;
  }

  /** GET /api/v1/skills/:slug - one skill plus its generated SKILL.md. */
  async skill(slug: string): Promise<SkillDetail> {
    return this.json<SkillDetail>("GET", `/api/v1/skills/${encodeURIComponent(slug)}`, { retry: true });
  }

  /** GET /api/v1/models - the catalog your key can see (restricted endpoints
   *  appear only after opting in at /settings/licenses). */
  async models(): Promise<Model[]> {
    return (await this.json<{ models: Model[] }>("GET", "/api/v1/models", { retry: true })).models;
  }

  /** POST /api/v1/estimate - cost of a submission before you spend it. */
  async estimate(endpoint: string, params: Record<string, unknown> = {}): Promise<Estimate> {
    return this.json<Estimate>("POST", "/api/v1/estimate", { body: { endpoint, params }, retry: true });
  }

  /** POST /api/v1/probe - ownership-checked ffprobe facts + render dims +
   *  shot-window count for a /files/ clip you own. Endpoints that require
   *  probe truth (re-shoot, VFX plate, ReCut) need these numbers. */
  async probe(video_url: string): Promise<{ probe: MediaProbe }> {
    return this.json<{ probe: MediaProbe }>("POST", "/api/v1/probe", { body: { video_url }, retry: true });
  }

  /** POST /api/v1/jobs - submits with an Idempotency-Key (random UUID by
   *  default) and retries transient failures. */
  async submit(
    endpoint: string,
    params: Record<string, unknown> = {},
    opts: SubmitOptions = {},
  ): Promise<JobCreated> {
    return this.json<JobCreated>("POST", "/api/v1/jobs", {
      body: {
        endpoint,
        params,
        ...(opts.webhookUrl ? { webhook_url: opts.webhookUrl } : {}),
      },
      headers: { "Idempotency-Key": opts.idempotencyKey ?? globalThis.crypto.randomUUID() },
      retry: true,
    });
  }

  /** GET /api/v1/jobs/:id */
  async get(id: string, opts: { signal?: AbortSignal } = {}): Promise<Job> {
    return this.json<Job>("GET", `/api/v1/jobs/${encodeURIComponent(id)}`, { retry: true, signal: opts.signal });
  }

  /** POST /api/v1/jobs/:id/cancel */
  async cancel(id: string): Promise<Job> {
    return this.json<Job>("POST", `/api/v1/jobs/${encodeURIComponent(id)}/cancel`, { retry: true });
  }

  /** Poll GET until the job reaches a terminal status; throws on timeout or abort. */
  async wait(id: string, opts: WaitOptions = {}): Promise<Job> {
    const interval = Math.max(50, opts.intervalMs ?? 1000);
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    for (;;) {
      if (opts.signal?.aborted) throw new MotionFieldError({ status: 0, code: "aborted", message: "wait aborted" });
      const job = await this.get(id, { signal: opts.signal });
      if (TERMINAL_STATUSES.includes(job.status)) return job;
      const left = deadline - Date.now();
      if (left <= 0) throw new MotionFieldError({ status: 0, code: "wait_timeout", message: `job ${id} still ${job.status} after wait budget` });
      await interruptibleSleep(Math.min(interval, left), opts.signal);
    }
  }

  /** POST /api/v1/uploads - multipart file upload, returns { url } for params. */
  async upload(file: Uint8Array | Blob, opts: { filename?: string; contentType?: string } = {}): Promise<UploadedFile> {
    const fd = new FormData();
    const blob = file instanceof Blob ? file : new Blob([file as unknown as BlobPart], { type: opts.contentType });
    fd.set("file", blob, opts.filename ?? (typeof File !== "undefined" && file instanceof File ? file.name : "upload.bin"));
    const res = await this.send("/api/v1/uploads", { method: "POST", body: fd }, false);
    return res.json() as Promise<UploadedFile>;
  }

  /** GET /api/v1/jobs/:id/result?i=N - the output bytes with the response's
   *  Content-Type (follows provider redirects; Authorization is not forwarded). */
  async download(id: string, opts: { index?: number } = {}): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const res = await this.send(`/api/v1/jobs/${encodeURIComponent(id)}/result?i=${opts.index ?? 0}`, { method: "GET" }, false);
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") };
  }

  /* ---------------- runs ---------------- */

  /** POST /api/v1/runs - exactly one of plan / text(+planner) / skill(+brief).
   *  Always sends an Idempotency-Key (random UUID by default). A text brief
   *  plans server-side (up to the server's planner budget - default 300 s,
   *  MOTIONFIELD_PLANNER_BUDGET_MS), so that form's attempt window is at
   *  least 330 s; a same-key create still in flight answers 409
   *  idempotency_in_progress and is retried after the server's Retry-After
   *  until the winner's run replays. */
  async createRun(input: CreateRunInput, opts: { idempotencyKey?: string } = {}): Promise<Run> {
    const key = opts.idempotencyKey ?? globalThis.crypto.randomUUID();
    const attemptTimeoutMs = input.text !== undefined
      ? Math.max(this.timeoutMs, CREATE_ATTEMPT_FLOOR_MS) : undefined;
    const deadline = Date.now() + IN_PROGRESS_BUDGET_MS;
    for (;;) {
      try {
        return await this.json<Run>("POST", "/api/v1/runs", {
          body: input,
          headers: { "Idempotency-Key": key },
          retry: true,
          attemptTimeoutMs,
        });
      } catch (e) {
        if (!(e instanceof MotionFieldError) || e.code !== "idempotency_in_progress") throw e;
        const left = deadline - Date.now();
        if (left <= 0) throw e;
        await sleep(Math.min((e.retryAfter ?? 2) * 1000, left));
      }
    }
  }

  /** GET /api/v1/runs/:id - live runs tick once on read, like jobs. */
  async getRun(id: string, opts: { signal?: AbortSignal } = {}): Promise<Run> {
    return this.json<Run>("GET", `/api/v1/runs/${encodeURIComponent(id)}`, { retry: true, signal: opts.signal });
  }

  /** POST /api/v1/runs/:id/approve - idempotent like the control verbs. */
  async approveRun(id: string): Promise<Run> {
    return this.json<Run>("POST", `/api/v1/runs/${encodeURIComponent(id)}/approve`, { retry: true });
  }

  /** POST /api/v1/runs/:id/control { action: pause | resume | stop }. */
  async controlRun(id: string, action: RunControlAction): Promise<Run> {
    return this.json<Run>("POST", `/api/v1/runs/${encodeURIComponent(id)}/control`, { body: { action }, retry: true });
  }

  /** PATCH /api/v1/runs/:id/steps/:stepId - a stale rev throws 409
   *  stale_revision with `headRev` set to the step's current rev. */
  async editStep(id: string, stepId: string, edit: StepEditInput): Promise<Run> {
    return this.json<Run>("PATCH", `/api/v1/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(stepId)}`, { body: edit });
  }

  /** Poll GET until the run reaches a terminal status (done|failed|stopped);
   *  throws on timeout or abort. */
  async waitRun(id: string, opts: WaitOptions = {}): Promise<Run> {
    const interval = Math.max(50, opts.intervalMs ?? 1000);
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    for (;;) {
      if (opts.signal?.aborted) throw new MotionFieldError({ status: 0, code: "aborted", message: "wait aborted" });
      const run = await this.getRun(id, { signal: opts.signal });
      if (TERMINAL_RUN_STATUSES.includes(run.status)) return run;
      const left = deadline - Date.now();
      if (left <= 0) throw new MotionFieldError({ status: 0, code: "wait_timeout", message: `run ${id} still ${run.status} after wait budget` });
      await interruptibleSleep(Math.min(interval, left), opts.signal);
    }
  }

  /* ---------------- Stage (the /api/stage 3D scene API - not v1) ---------------- */

  /** GET /api/stage - your scenes, newest first. */
  async stageList(): Promise<StageSceneSummary[]> {
    return (await this.json<{ scenes: StageSceneSummary[] }>("GET", "/api/stage", { retry: true })).scenes;
  }

  /** POST /api/stage - `{empty:true}` mints the default camera+ground scene;
   *  `prompt` runs the LLM scene writer (503s when none is configured). */
  async stageCreate(input: StageCreateInput): Promise<StageCreateResult> {
    return this.json<StageCreateResult>("POST", "/api/stage", { body: input });
  }

  /** GET /api/stage/:id - the live head; a foreign id answers not_found. */
  async stageGet(id: string): Promise<StageSceneRead> {
    return this.json<StageSceneRead>("GET", `/api/stage/${encodeURIComponent(id)}`, { retry: true });
  }

  /** GET /api/stage/:id/inspect?view=meta|tree|shots|physics|problems[&rev=N]. */
  async stageInspect(id: string, view: string, rev?: number): Promise<Record<string, unknown>> {
    const q = new URLSearchParams({ view });
    if (rev !== undefined) q.set("rev", String(rev));
    return this.json<Record<string, unknown>>("GET", `/api/stage/${encodeURIComponent(id)}/inspect?${q}`, { retry: true });
  }

  /** POST /api/stage/:id/ops - typed scene mutations under optimistic
   *  concurrency. `idempotencyKey` ([A-Za-z0-9_-]{1,128}) dedupes byte-
   *  identical retries for 24 h; a stale `baseRevision` throws 409
   *  stale_revision with `headRev` set to the live revision. */
  async stageApplyOps(id: string, opts: {
    baseRevision: number;
    ops: StageOp[];
    selection?: string;
    idempotencyKey?: string;
    /** validate + return the resulting scene WITHOUT committing a revision */
    dryRun?: boolean;
  }): Promise<StageOpsResult> {
    return this.json<StageOpsResult>("POST", `/api/stage/${encodeURIComponent(id)}/ops`, {
      body: { base_revision: opts.baseRevision, ops: opts.ops, ...(opts.selection ? { selection: opts.selection } : {}), ...(opts.dryRun ? { dry_run: true } : {}) },
      headers: opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : undefined,
    });
  }

  /** GET /api/stage/:id/revisions - newest-first history (≤100). */
  async stageRevisions(id: string): Promise<StageRevisionSummary[]> {
    return (await this.json<{ revisions: StageRevisionSummary[] }>("GET", `/api/stage/${encodeURIComponent(id)}/revisions`, { retry: true })).revisions;
  }

  /** GET /api/stage/:id/revisions/:rev - the full stored scene, read-only. */
  async stageRevision(id: string, rev: number): Promise<StageRevisionRead> {
    return this.json<StageRevisionRead>("GET", `/api/stage/${encodeURIComponent(id)}/revisions/${encodeURIComponent(String(rev))}`, { retry: true });
  }

  /** POST /api/stage/:id/revisions/:rev/restore - copies the stored scene
   *  onto a NEW head; history is append-only. A stale baseRevision throws
   *  409 stale_revision with `headRev`. */
  async stageRestore(id: string, rev: number, baseRevision: number): Promise<{ revision: number; scene: Record<string, unknown> }> {
    return this.json<{ revision: number; scene: Record<string, unknown> }>(
      "POST", `/api/stage/${encodeURIComponent(id)}/revisions/${encodeURIComponent(String(rev))}/restore`,
      { body: { base_revision: baseRevision } });
  }
}

/* ---------------- webhook signature verification ---------------- */

export interface VerifyOptions {
  /** max |now - t| in seconds - default 300 */
  toleranceSec?: number;
  /** override the clock (tests) */
  nowSec?: number;
}

/**
 * Verify an `x-motionfield-signature` header (`t=<unix>,v1=<hex hmac>`) against
 * the raw request body with the key's `ofwh_…` secret. Fails closed on every
 * anomaly - malformed headers, stale timestamps, wrong body, wrong secret.
 *
 * `header` mirrors what Node's http server hands you: a single string, a
 * one-element array, or absent. Any other array can't be trusted → false.
 * node:crypto is loaded lazily on first call (see the module comment).
 */
export function verifyWebhook(
  secret: string,
  header: string | readonly string[] | null | undefined,
  rawBody: string | Uint8Array,
  opts: VerifyOptions = {},
): boolean {
  let h: string | null | undefined;
  if (typeof header === "string" || header == null) {
    h = header;
  } else {
    if (header.length !== 1) return false;
    h = header[0];
  }
  if (!secret || !h) return false;
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of h.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v1") v1 = v;
  }
  if (t == null || !Number.isFinite(t) || !v1 || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSec ?? 300)) return false;

  const { createHmac, timingSafeEqual } = nodeCrypto();
  const bodyBytes = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  const expected = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${t}.`, "utf8"), bodyBytes]))
    .digest();
  const presented = Buffer.from(v1, "hex");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/* ---------------- internals ---------------- */

/** Race the per-attempt timeout against an optional caller signal - whichever
 *  fires first aborts the fetch. */
function combineSignals(timeout: AbortSignal, user?: AbortSignal): AbortSignal {
  if (!user) return timeout;
  if (user.aborted) return user;
  const c = new AbortController();
  const abort = (s: AbortSignal) => { if (!c.signal.aborted) c.abort(s.reason); };
  user.addEventListener("abort", () => abort(user), { once: true });
  timeout.addEventListener("abort", () => abort(timeout), { once: true });
  return c.signal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new MotionFieldError({ status: 0, code: "aborted", message: "wait aborted" }));
    const onAbort = () => {
      clearTimeout(t);
      reject(new MotionFieldError({ status: 0, code: "aborted", message: "wait aborted" }));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
