import { getDb, sql, tx, schema } from "@/db";
import { eq, and, inArray, isNotNull, lt, desc } from "drizzle-orm";
import { findEndpoint, findModel, findWorkflow } from "@/lib/catalog/video-models";
import { findPreset, EFFECT_PRESETS } from "@/lib/catalog/presets";
import { specById, specVisible, specCombinable, type PresetSpec } from "@/lib/catalog/presets/schema";
import type { PresetDef } from "@/lib/catalog/types";
import { planById } from "@/lib/catalog/plans";
import { chargeCredits, refundCredits, InsufficientCredits, grantCredits } from "@/lib/credits";
import { getProvider } from "@/lib/generation";
import { assertLicenseAllowed } from "@/lib/catalog/license-gate";
import type { ProviderOutput } from "@/lib/generation/types";
import type { WorkflowDef } from "@/lib/catalog/types";
import { hashJobRequest, hashMismatch, isValidIdempotencyKey } from "@/lib/api/idempotency";
import { enqueueTerminalWebhook, kickWebhookDelivery, type TerminalEventType } from "@/lib/api/webhooks";
import { mimeForJobOutput } from "@/lib/api/mime";
import { filePathFor } from "@/lib/storage";
import { resolveOwnedMedia } from "@/lib/media-owned";
import { probeVideo, probeImageSize } from "@/lib/re-edit-ffmpeg";
import { comingSoonReason } from "@/lib/catalog/coming-soon";
import { KEYFRAME_MOVES, makeEndKeyframe, type KeyframeMove } from "@/lib/camera-keyframe";
import { FINISH_MAX_SECONDS, finishProviderName, polishFinished, submitFinish, wantsFinish } from "@/lib/generation/finish";
import type { ProviderOutputItem } from "@/lib/generation/types";
import { promises as fsp } from "fs";
import crypto from "crypto";

export class JobError extends Error {
  status: number;
  code?: string;
  constructor(msg: string, status = 400, code?: string) { super(msg); this.status = status; this.code = code; }
}

/** Provenance tag on jobs/assets/uploads (migration 0102 CHECK constraint). */
export const JOB_SOURCES = ["ui", "api", "cli", "mcp", "agent"] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

function idempotencyMismatch(): JobError {
  return new JobError("Idempotency-Key was already used with a different request payload", 422, "idempotency_mismatch");
}

/** Raw jobs row including WS1 columns - used by the idempotent replay pre-check. */
export async function findJobByIdemKey(userId: string, key: string) {
  const rows = await sql<{ id: string; status: string; created_at: unknown; request_hash: string | null }>(
    `SELECT id, status, created_at, request_hash FROM jobs WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [userId, key]);
  return rows[0] ?? null;
}

/** Merge preset apply-params + prompt fragments into raw params - the
 *  honesty gate (OF-0142/OF-0146):
 *   - every preset id resolves to a catalog PresetSpec; unknown, hidden or
 *     unverified presets are a 400 ("preset not available") - the catalog
 *     shows only what a verification record proves, and the same rule holds
 *     here so nothing fakes its way through a direct POST
 *   - combinations: trajectory / post / composite mechanisms may layer;
 *     every other mechanism owns the job outright and never combines
 *
 *  Presets arrive either as `${kind}_preset` keys or via workflow params
 *  that name them directly: `preset_id` (VACE restyle and the studio preset
 *  pickers - effect or motion ids) and `look_id` (image looks). */
export function resolveParams(params: Record<string, unknown>): Record<string, unknown> {
  const out = { ...params };
  // param name → preset kinds it may name (preset_id is shared by the effect
  // and motion pickers, so both catalogs are tried)
  const paramKeys: [string, PresetDef["kind"][]][] = [
    ["motion_preset", ["motion"]],
    ["effect_preset", ["effect"]],
    ["style_preset", ["style"]],
    ["preset_id", ["effect", "motion", "style"]],
    ["look_id", ["style"]],
  ];
  const picked: { preset: PresetDef; spec?: PresetSpec }[] = [];
  for (const [key, kinds] of paramKeys) {
    const v = out[key];
    if (v === undefined || v === null || v === "") continue;
    const preset = typeof v === "string" ? kinds.map((k) => findPreset(k, v)).find(Boolean) : undefined;
    if (!preset) throw new JobError("preset not available", 400);
    picked.push({ preset });
  }
  for (const key of ["motion_preset", "effect_preset", "style_preset"]) delete out[key];

  for (const p of picked) {
    const spec = specById(p.preset.id);
    p.spec = spec;
    // every catalog preset is spec'd - an unspec'd, hidden or unverified id
    // is not a real mechanism and never runs
    if (!spec || spec.hidden || !specVisible(spec))
      throw new JobError("preset not available", 400);
  }
  if (picked.length > 1 && picked.some((p) => !specCombinable(p.spec!)))
    throw new JobError("presets cannot be combined", 400);

  for (const { preset } of picked) {
    Object.assign(out, preset.apply);
    if (preset.promptFragment) {
      out.prompt = out.prompt ? `${out.prompt}, ${preset.promptFragment}` : preset.promptFragment;
    }
  }
  return out;
}

/** LLM/tool callers often send numbers as strings ("10s", "30", "true") - coerce
 *  to the declared field type before validation so the provider gets clean types.
 *  Mutates and returns `params`. Used by both createJob and the estimate path so
 *  an estimate always equals the eventual charge. */
export function coerceParams(workflow: WorkflowDef, params: Record<string, unknown>): Record<string, unknown> {
  for (const f of workflow.params) {
    const v = params[f.name];
    // a declared default IS the catalog's contract - an omitted param must
    // behave as if the user sent it (before: the provider's own fallbacks
    // ran 30 steps on a field declared as 8, and 'duration' enums lied)
    if (v === undefined && f.default !== undefined) { params[f.name] = f.default; continue; }
    if (v == null || typeof v === "boolean") continue;
    if (["number", "integer", "slider"].includes(f.type) && typeof v === "string") {
      const n = parseFloat(v);
      if (!Number.isNaN(n)) params[f.name] = n;
    } else if (f.type === "boolean" && typeof v === "string") {
      params[f.name] = v === "true";
    } else if (f.type === "select" && Array.isArray(f.enum) && f.enum.every((x) => typeof x === "number")) {
      const n = parseFloat(String(v));
      if (!Number.isNaN(n))
        params[f.name] = f.enum.includes(n) ? n : f.enum.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
    }
  }
  return params;
}

export async function createJobEx(userId: string, input: {
  endpointId: string;
  params: Record<string, unknown>;
  projectId?: string | null;
  title?: string;
  visibility?: "private" | "public";
  idempotencyKey?: string;
  /** sha256 of the canonical {endpoint,params} payload - computed here when omitted. */
  requestHash?: string | null;
  /** api_keys row id when the request came in via bearer auth (v1 API). */
  apiKeyId?: string | null;
  /** optional webhook target stored on the job (delivery is a later workstream). */
  webhookUrl?: string | null;
  /** caller surface tag - checked against the 0102 CHECK constraint; assets
   *  inherit it at finalize. UI callers omit it (default 'ui'). */
  source?: JobSource;
  presetId?: string | null;
  presetKind?: string | null;
  parentJobId?: string | null;
  graphJson?: Record<string, unknown> | null;
  graphForkedFrom?: string | null;
}): Promise<{ job: typeof schema.jobs.$inferSelect; replayed: boolean }> {
  const soon = comingSoonReason(input.endpointId);
  if (soon) throw new JobError(`coming soon - ${soon}`, 400, "bad_request");
  const found = findEndpoint(input.endpointId);
  if (!found) throw new JobError(`unknown endpoint ${input.endpointId}`, 404);
  const { model, workflow } = found;

  const db = await getDb();
  if (input.idempotencyKey != null && !isValidIdempotencyKey(input.idempotencyKey))
    throw new JobError("Idempotency-Key must be 1-255 printable ASCII characters", 400, "bad_request");
  const requestHash = input.idempotencyKey
    ? (input.requestHash ?? hashJobRequest(input.endpointId, input.params))
    : null;
  if (input.idempotencyKey) {
    const [prev] = await db.select().from(schema.jobs)
      .where(and(eq(schema.jobs.userId, userId), eq(schema.jobs.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (prev) {
      const prevHash = (await sql<{ request_hash: string | null }>(
        `SELECT request_hash FROM jobs WHERE id = $1`, [prev.id]))[0]?.request_hash ?? null;
      if (requestHash && hashMismatch(prevHash, requestHash)) throw idempotencyMismatch();
      // backfill the hash on rows created before request_hash existed
      if (requestHash && prevHash == null)
        await sql(`UPDATE jobs SET request_hash = $2 WHERE id = $1`, [prev.id, requestHash]);
      return { job: prev, replayed: true };
    }
  }

  const params = resolveParams(
    input.presetId && ["motion", "effect", "style"].includes(input.presetKind ?? "")
      ? { ...input.params, [`${input.presetKind}_preset`]: input.presetId }
      : input.params,
  );
  coerceParams(workflow, params);
  for (const f of workflow.params) {
    if (f.required && (params[f.name] === undefined || params[f.name] === "" || params[f.name] === null))
      throw new JobError(`missing required param: ${f.name}`);
  }

  const invalid = workflow.validate?.(params) ?? null;
  if (invalid) throw new JobError(invalid, 400, "bad_request");

  // declared duration gates - probe the owned /files/ media before any
  // charge or submission so a too-short/long upload never moves credits
  // (the swap workflows all declare a 4 s floor the label already states)
  for (const f of workflow.params) {
    if (f.minSeconds === undefined && f.maxSeconds === undefined) continue;
    const url = params[f.name];
    if (typeof url !== "string" || !url) continue;
    const file = await resolveOwnedMedia(userId, url);
    const probe = await probeVideo(file).catch(() => {
      throw new JobError(`${f.name} is not a readable video`, 400, "bad_request");
    });
    if (f.minSeconds !== undefined && probe.durationSec < f.minSeconds)
      throw new JobError(`${f.name} must be at least ${f.minSeconds} seconds (got ${probe.durationSec.toFixed(1)}s)`, 400, "bad_request");
    if (f.maxSeconds !== undefined && probe.durationSec > f.maxSeconds)
      throw new JobError(`${f.name} must be at most ${f.maxSeconds} seconds (got ${probe.durationSec.toFixed(1)}s)`, 400, "bad_request");
  }

  // v2v graphs that follow their source clip (see WorkflowDef.sourceGeometry)
  const sg = workflow.sourceGeometry;
  if (sg && params.width === undefined && params.height === undefined && params.frames === undefined) {
    const url = params[sg.param];
    if (typeof url === "string" && url) {
      const probe = await resolveOwnedMedia(userId, url).then(probeVideo).catch(() => null);
      const maxLong = sg.maxLong ?? (String(params.resolution ?? "") === "720p" ? 1280 : 832);
      if (probe) Object.assign(params, sourceGeometry(probe, maxLong, sg.maxFrames));
    }
  }

  // camera moves as an end keyframe cropped from the first frame
  const ck = workflow.cameraKeyframe;
  if (ck && !params.end_image_url && typeof params[ck.image] === "string" && params[ck.image]) {
    const move = String(params[ck.move] ?? "");
    if (move in KEYFRAME_MOVES) {
      const still = await resolveOwnedMedia(userId, String(params[ck.image]));
      params.end_image_url = await makeEndKeyframe(still, move as KeyframeMove);
      const phrase = KEYFRAME_MOVES[move as KeyframeMove].phrase;
      if (!String(params.prompt ?? "").includes(phrase)) params.prompt = `${String(params.prompt ?? "").trim()} ${phrase}.`.trim();
    }
  }

  // image-to-video graphs size from aspect_ratio (16:9 default) - workflows
  // that don't expose a ratio must follow the first frame, or a portrait
  // photo gets center-cropped into a landscape clip
  if (workflow.kind === "video" && typeof params.image_url === "string" && params.image_url
      && !workflow.params.some((f) => f.name === "aspect_ratio")
      && params.aspect_ratio === undefined && params.width === undefined) {
    const size = await resolveOwnedMedia(userId, params.image_url).then(probeImageSize).catch(() => null);
    if (size) params.aspect_ratio = nearestAspect(size.width / size.height);
  }

  await assertLicenseAllowed(workflow, userId, params, input.graphJson);

  const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, userId)).limit(1);
  if (!profile) throw new JobError("profile missing", 500);
  const plan = planById(profile.planId);
  if ((model.minPlanTier ?? 0) > plan.tier) {
    const names = ["paid", "Basic", "Pro", "Max", "Team"];
    throw new JobError(`${model.label} requires ${names[model.minPlanTier ?? 1]}+ plan`, 402);
  }

  // Reconcile this user's live jobs against the provider first - a job canceled
  // or finished externally must not keep counting toward the concurrency gate.
  const liveMine = await db.select({ id: schema.jobs.id }).from(schema.jobs)
    .where(and(eq(schema.jobs.userId, userId), inArray(schema.jobs.status, ["queued", "in_progress"]), isNotNull(schema.jobs.providerRequestId)))
    .limit(10);
  for (const j of liveMine) await tickJob(j.id).catch(() => {});

  const [{ n: active }] = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM jobs WHERE user_id = $1 AND status IN ('queued','in_progress')`, [userId]);
  const limit = ["image", "edit", "upscale", "character"].includes(model.kind)
    ? plan.parallelImage + profile.boostSlots : plan.parallelVideo + profile.boostSlots;
  if (active >= limit) throw new JobError(`concurrency limit reached (${limit} active jobs on your plan)`, 429, "concurrency_limit");

  const unlimited = (plan.unlimitedModels ?? []).includes(model.id);
  const cost = unlimited ? 0 : workflow.cost(params);

  const id = crypto.randomUUID();
  try {
    if (cost > 0) await chargeCredits(userId, cost, "job", id, `${model.label} · ${workflow.label}`);
  } catch (e) {
    if (e instanceof InsufficientCredits) throw new JobError(`insufficient credits - need ${cost}, have ${Math.round(e.have * 100) / 100}`, 402);
    throw e;
  }

  try {
    // Single INSERT including the WS1 columns: a racing same-key request must
    // see request_hash the moment this row becomes visible, otherwise it would
    // replay a job created from a different payload instead of getting a 422.
    await sql(
      `INSERT INTO jobs (id, user_id, project_id, endpoint_id, model_id, workflow, kind, status,
                         prompt, params, cost_credits, title, visibility, idempotency_key,
                         preset_id, preset_kind, parent_job_id, graph_json, graph_forked_from,
                         provider, api_key_id, request_hash, provider_meta, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,
               'mock',$19,$20,$21::jsonb,$22)`,
      [
        id, userId, input.projectId ?? null,
        input.endpointId, model.id, workflow.id, workflow.kind,
        String(params.prompt ?? params.text ?? "") || null,
        JSON.stringify(params), String(cost),
        input.title ?? null, input.visibility ?? (profile.autoPublish ? "public" : "private"),
        input.idempotencyKey ?? null,
        input.presetId ?? null, input.presetKind ?? null,
        input.parentJobId ?? null,
        input.graphJson ? JSON.stringify(input.graphJson) : null,
        input.graphForkedFrom ?? null,
        input.apiKeyId ?? null, requestHash,
        JSON.stringify(input.webhookUrl ? { webhook_url: input.webhookUrl } : {}),
        input.source ?? "ui",
      ]);
  } catch (e) {
    // Concurrent replay: another request with the same idempotency key won the
    // insert race - apply the same request-hash rule, refund this charge, replay.
    if (input.idempotencyKey && (e as { code?: string })?.code === "23505") {
      if (cost > 0) await refundCredits(userId, cost, "job", id, "idempotent replay - submit raced").catch(() => {});
      const [prev] = await db.select().from(schema.jobs)
        .where(and(eq(schema.jobs.userId, userId), eq(schema.jobs.idempotencyKey, input.idempotencyKey)))
        .limit(1);
      if (prev) {
        const prevHash = (await sql<{ request_hash: string | null }>(
          `SELECT request_hash FROM jobs WHERE id = $1`, [prev.id]))[0]?.request_hash ?? null;
        if (requestHash && hashMismatch(prevHash, requestHash)) throw idempotencyMismatch();
        return { job: prev, replayed: true };
      }
    }
    throw e;
  }

  try {
    // recipe-backed workflows bypass the env provider - they run server-side
    // pipelines that drive their own ComfyUI sub-jobs.
    const provider = workflow.providers.recipe?.name ? getProvider("recipe") : getProvider();
    const sub = await provider.submit({
      jobId: id, model, workflow, params, userId,
      graphOverride: input.graphJson ?? undefined,
      appBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
    });
    const resolvedGraph = (sub.meta?.graph ?? input.graphJson ?? null) as never;
    await db.update(schema.jobs)
      .set({
        provider: provider.name,
        providerRequestId: sub.providerJobId,
        providerMeta: { ...(input.webhookUrl ? { webhook_url: input.webhookUrl } : {}), ...(sub.meta ?? {}) } as never,
        graphJson: resolvedGraph,
      })
      .where(eq(schema.jobs.id, id));
  } catch (err) {
    // Guarded transition - a client cancel that landed while submit was in
    // flight already set a terminal status and refunded; don't clobber it.
    const claimed = await tx(async (q) => {
      const rows = await q(
        `UPDATE jobs SET status = 'failed', error = $2, completed_at = now(), updated_at = now()
         WHERE id = $1 AND status IN ('queued','in_progress') RETURNING id`,
        [id, String(err instanceof Error ? err.message : err)]);
      if (!rows.length) return false;
      await enqueueTerminalWebhook(id, "job.failed", { q });
      return true;
    });
    if (claimed) {
      if (cost > 0) await refundCredits(userId, cost, "job", id, "submit failed");
      // The job.failed delivery was enqueued inside the claim transaction -
      // kick the sweep so it doesn't sit pending until an unrelated request.
      kickWebhookDelivery();
    }
  }
  const job = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1).then((r: (typeof schema.jobs.$inferSelect)[]) => r[0]);
  return { job, replayed: false };
}

export async function createJob(userId: string, input: Parameters<typeof createJobEx>[1]) {
  return (await createJobEx(userId, input)).job;
}

/** Poll every live job once. Called by the worker loop and lazily by job-status GETs. */
export async function processJobs(): Promise<number> {
  const db = await getDb();
  const live = await db.select().from(schema.jobs)
    .where(and(
      inArray(schema.jobs.status, ["queued", "in_progress"]),
      isNotNull(schema.jobs.providerRequestId), // inserted but not yet submitted
    ))
    .orderBy(schema.jobs.createdAt)
    .limit(25);
  let remaining = 0;
  for (const job of live) {
    try { if (await tickJob(job.id)) remaining++; }
    catch (e) { console.error(`job ${job.id} tick error`, e); }
  }
  kickWebhookDelivery();
  return remaining;
}

/** providerMeta.finish - set when a completed video job's finish pass is
 *  in flight: `jobId` is the finish sub-job's provider id (matching
 *  providerRequestId marks the finish phase), `provider` who runs it,
 *  `meta` its submit meta, `raw` the pre-finish outputs kept as "raw". */
interface FinishMeta {
  jobId?: string;
  provider?: string;
  meta?: Record<string, unknown>;
  raw?: ProviderOutputItem[];
}

export async function tickJob(jobId: string): Promise<boolean> {
  const db = await getDb();
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job || !["queued", "in_progress"].includes(job.status)) return false;
  if (!job.providerRequestId) return false; // inserted, not yet submitted

  const meta = (job.providerMeta as Record<string, unknown>) ?? {};
  const fin = meta.finish as FinishMeta | undefined;
  const finishing = !!fin?.jobId && fin.jobId === job.providerRequestId;
  const provider = getProvider(finishing ? (fin?.provider ?? job.provider) : job.provider);
  const st = await provider.poll(job.providerRequestId, finishing ? (fin?.meta ?? {}) : meta);

  if (st.state === "queued" || st.state === "in_progress") {
    // Guard the status write: a cancelJob/finishJob claim may have landed while
    // the provider poll was in flight - never resurrect a terminal row.
    const updated = await db.update(schema.jobs)
      .set({ status: st.state, progress: st.state === "in_progress" ? (st.progress ?? job.progress) : job.progress,
        providerMeta: st.state === "in_progress" && st.stage ? { ...meta, stage: st.stage } : job.providerMeta,
        updatedAt: new Date() })
      .where(and(eq(schema.jobs.id, jobId), inArray(schema.jobs.status, ["queued", "in_progress"])))
      .returning({ id: schema.jobs.id });
    return updated.length > 0;
  }

  if (st.state === "completed") {
    if (finishing) {
      // finish sub-job landed - apply the host polish, keep the raw render
      const finished: ProviderOutputItem[] = [];
      for (const it of st.output.items) {
        const f = it.type === "video" ? filePathFor(it.url) : null;
        if (f) {
          try { finished.push(await polishFinished(f, job.id)); continue; } catch { /* keep unpolished */ }
        }
        finished.push({ ...it, role: "finished" });
      }
      const raw = (fin?.raw ?? []).map((i) => ({ ...i, role: "raw" }));
      await finishJob(job.id, { items: [...finished, ...raw] });
      return false;
    }
    if (!fin && wantsFinish((job.params as Record<string, unknown>) ?? {}, st.output.items)) {
      // best-effort: a failed startFinish falls through and delivers the raw render
      if (await startFinish(job, st.output.items)) return true;
    }
    await finishJob(job.id, st.output);
    return false;
  }

  // the polish is best-effort - a finish-phase failure still delivers the
  // raw render instead of losing the whole job
  if (finishing && fin?.raw?.length) {
    await finishJob(job.id, { items: fin.raw });
    return false;
  }

  // Terminal states (failed/nsfw/canceled): claim the final transition
  // atomically - only the tick that wins the UPDATE does refund + notify +
  // webhook enqueue, all inside one transaction so they can't split.
  const status = st.state === "nsfw" ? "nsfw" : st.state === "canceled" ? "canceled" : "failed";
  const providerError = "error" in st ? st.error ?? null : null;
  const claimed = await tx(async (q) => {
    const rows = await q(
      `UPDATE jobs SET status = $2, error = $3, completed_at = now(), updated_at = now()
       WHERE id = $1 AND status IN ('queued','in_progress') RETURNING id`,
      [jobId, status, providerError]);
    if (!rows.length) return false;
    await enqueueTerminalWebhook(jobId, `job.${status}` as TerminalEventType, { q });
    return true;
  });
  if (!claimed) return false;
  if (Number(job.costCredits) > 0)
    await refundCredits(job.userId, Number(job.costCredits), "job", job.id, `${status} - auto refund`);
  await notify(job.userId, "job_failed", `${modelLabel(job)} - ${status}`, providerError ?? undefined, `/history`);
  return false;
}

/** Submit the finish pass as a follow-up provider job and point
 *  providerRequestId at it - the raw outputs are stashed in
 *  provider_meta.finish.raw and re-attached when the finish lands.
 *  The phase claim (finish marker) lands BEFORE the submit so a racing
 *  tick can't double-submit; a submit failure leaves the marker set and
 *  the next tick falls through to delivering the raw render. */
async function startFinish(job: typeof schema.jobs.$inferSelect, items: ProviderOutputItem[]): Promise<boolean> {
  const src = items.find((i) => i.type === "video");
  if (!src) return false;
  const provName = finishProviderName(job.provider);
  const db = await getDb();
  const claimed = await sql<{ id: string }>(
    `UPDATE jobs SET provider_meta = jsonb_set(provider_meta, '{finish}', $2::jsonb), updated_at = now()
     WHERE id = $1 AND status IN ('queued','in_progress') AND provider_meta -> 'finish' IS NULL RETURNING id`,
    [job.id, JSON.stringify({ provider: provName, raw: items })]);
  if (!claimed.length) return false;
  try {
    // the raw render isn't an assets row yet - resolve it directly
    const file = src.url.startsWith("/files/") ? filePathFor(src.url) : null;
    if (!file) return false;
    const probe = await probeVideo(file);
    if (probe.durationSec > FINISH_MAX_SECONDS) return false;
    const model = findModel(job.modelId)
      ?? { id: job.modelId, label: job.modelId, vendor: "", kind: "video" as const, description: "", workflows: [] };
    const sub = await submitFinish(
      { jobId: job.id, model, userId: job.userId, appBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}` },
      src.url, provName);
    const rows = await sql<{ id: string }>(
      `UPDATE jobs SET provider_request_id = $2,
           provider_meta = jsonb_set(provider_meta, '{finish}', provider_meta -> 'finish' || $3::jsonb),
           updated_at = now()
         WHERE id = $1 AND status IN ('queued','in_progress') RETURNING id`,
      [job.id, sub.providerJobId, JSON.stringify({ jobId: sub.providerJobId, meta: sub.meta ?? {} })]);
    if (!rows.length) {
      // canceled mid-submit - release the provider-side job
      await getProvider(provName).cancel(sub.providerJobId, sub.meta ?? {}).catch(() => {});
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function modelLabel(job: { modelId: string; workflow: string }) {
  return findModel(job.modelId)?.label ?? job.modelId;
}

/** Raw snake_case jobs row as returned inside tx()/sql() raw queries. */
interface JobDbRow {
  id: string;
  user_id: string;
  model_id: string;
  workflow: string;
  endpoint_id: string;
  project_id: string | null;
  status: string;
  progress: number;
  prompt: string | null;
  title: string | null;
  visibility: string;
  cost_credits: string;
  outputs: unknown;
  error: string | null;
  provider_meta: Record<string, unknown> | null;
  api_key_id: string | null;
  source: string;
  created_at: unknown;
  updated_at: unknown;
}

async function finishJob(jobId: string, output: ProviderOutput) {
  // Exactly-once finalization: the status claim + asset inserts run in one
  // transaction, so two concurrent ticks can't both produce assets.
  const result = await tx(async (q) => {
    const claimed = await q(
      `UPDATE jobs SET status = 'completed', progress = 100, completed_at = now(), updated_at = now()
       WHERE id = $1 AND status IN ('queued','in_progress') RETURNING id`,
      [jobId]);
    if (!claimed.length) return null;
    const [job] = (await q(`SELECT * FROM jobs WHERE id = $1`, [jobId])) as JobDbRow[];
    const outputs = [];
    for (const item of output.items) {
      const assetId = crypto.randomUUID();
      const mime = mimeForJobOutput(item.type, item.url);
      // Persist the byte size so readers never have to stat the file at rest.
      const fp = filePathFor(item.url);
      const bytes = fp ? await fsp.stat(fp).then((s) => s.size).catch(() => null) : null;
      await q(
        `INSERT INTO assets (id, user_id, job_id, project_id, kind, url, width, height, duration_sec, mime, prompt, endpoint_id, visibility, bytes, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [assetId, job.user_id, job.id, job.project_id, item.type, item.url,
         item.width ?? null, item.height ?? null,
         item.duration != null ? String(item.duration) : null, mime,
         job.prompt, job.endpoint_id, job.visibility, bytes,
         job.source ?? "ui"]);
      outputs.push({ assetId, type: item.type, url: item.url, width: item.width, height: item.height, duration: item.duration, role: item.role });
    }
    await q(`UPDATE jobs SET outputs = $2::jsonb WHERE id = $1`, [jobId, JSON.stringify(outputs)]);
    if (job.project_id) await q(`UPDATE projects SET updated_at = now() WHERE id = $1`, [job.project_id]);
    await enqueueTerminalWebhook(jobId, "job.completed", { q });
    return job;
  });
  if (!result) return;
  await notify(result.user_id, "job_done", `${modelLabel({ modelId: result.model_id, workflow: result.workflow })} finished`, result.title ?? result.prompt ?? undefined, `/jobs/${result.id}`);
}

export async function cancelJob(userId: string, jobId: string) {
  const db = await getDb();
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job || job.userId !== userId) throw new JobError("not found", 404);
  if (!["queued", "in_progress"].includes(job.status)) return job;
  if (job.providerRequestId) {
    const meta = (job.providerMeta as Record<string, unknown>) ?? {};
    const fin = meta.finish as FinishMeta | undefined;
    const finishing = !!fin?.jobId && fin.jobId === job.providerRequestId;
    await getProvider(finishing ? (fin?.provider ?? job.provider) : job.provider)
      .cancel(job.providerRequestId, finishing ? (fin?.meta ?? {}) : meta).catch(() => {});
  }
  // Claim the transition - a concurrent tick finalizing this job must not be
  // overwritten, and only the claim winner refunds + enqueues the webhook.
  const claimed = await tx(async (q) => {
    const rows = await q(
      `UPDATE jobs SET status = 'canceled', completed_at = now(), updated_at = now()
       WHERE id = $1 AND status IN ('queued','in_progress') RETURNING id`, [jobId]);
    if (!rows.length) return false;
    await enqueueTerminalWebhook(jobId, "job.canceled", { q });
    return true;
  });
  if (!claimed) {
    const [fresh] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
    return fresh ?? { ...job, status: "canceled" };
  }
  if (Number(job.costCredits) > 0)
    await refundCredits(userId, Number(job.costCredits), "job", jobId, "canceled - auto refund");
  return { ...job, status: "canceled" };
}

/** Idempotent daily free credits for free-plan users. */
export async function applyDailyCredits(userId: string) {
  const db = await getDb();
  const [p] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, userId)).limit(1);
  if (!p || p.planId !== "free") return;
  const [{ n }] = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM credit_ledger WHERE user_id = $1 AND kind = 'daily' AND created_at > now() - interval '20 hours'`, [userId]);
  if (n > 0) return;
  const { DAILY_FREE_CREDITS } = await import("@/lib/catalog/plans");
  await grantCredits(userId, DAILY_FREE_CREDITS, "daily", null, null, "Daily free credits");
}

export async function reapStuckJobs() {
  const db = await getDb();
  const stuck = await db.select().from(schema.jobs).where(
    and(inArray(schema.jobs.status, ["queued", "in_progress"]),
      lt(schema.jobs.createdAt, new Date(Date.now() - 24 * 3600 * 1000))));
  for (const j of stuck) {
    const claimed = await tx(async (q) => {
      const rows = await q(
        `UPDATE jobs SET status = 'failed', error = 'job timed out', completed_at = now(), updated_at = now()
         WHERE id = $1 AND status IN ('queued','in_progress') RETURNING id`, [j.id]);
      if (!rows.length) return false;
      await enqueueTerminalWebhook(j.id, "job.failed", { q });
      return true;
    });
    if (claimed && Number(j.costCredits) > 0)
      await refundCredits(j.userId, Number(j.costCredits), "job", j.id, "timeout refund");
  }
  return stuck.length;
}

export async function notify(userId: string, type: string, title: string, body?: string, href?: string) {
  const db = await getDb();
  await db.insert(schema.notifications).values({ userId, type, title, body: body ?? null, href: href ?? null }).catch(() => {});
}

export async function listUserJobs(userId: string, limit = 50) {
  const db = await getDb();
  return db.select().from(schema.jobs)
    .where(eq(schema.jobs.userId, userId))
    .orderBy(desc(schema.jobs.createdAt))
    .limit(limit);
}

export { findWorkflow, findEndpoint, findModel, EFFECT_PRESETS };

const I2V_ASPECTS: [string, number][] = [["16:9", 16 / 9], ["9:16", 9 / 16], ["1:1", 1], ["4:3", 4 / 3], ["3:4", 3 / 4]];
/** Closest supported ratio (log-distance, so 9:16 and 16:9 are symmetric). Exported for tests. */
export function nearestAspect(r: number): string {
  return I2V_ASPECTS.reduce((best, cur) => Math.abs(Math.log(cur[1] / r)) < Math.abs(Math.log(best[1] / r)) ? cur : best)[0];
}

/** Output geometry that follows a source clip: same aspect, long side capped
 *  (multiples of 16), and no more 16 fps frames than the clip has (capped).
 *  Exported for tests. */
export function sourceGeometry(
  probe: { width: number; height: number; durationSec: number },
  maxLong = 832, maxFrames = 81,
): { width: number; height: number; frames: number } {
  const scale = Math.min(1, maxLong / Math.max(probe.width, probe.height));
  const r16 = (x: number) => Math.max(16, Math.round((x * scale) / 16) * 16);
  const frames = Math.min(maxFrames, Math.max(5, Math.floor(probe.durationSec * 16)));
  return { width: r16(probe.width), height: r16(probe.height), frames };
}
