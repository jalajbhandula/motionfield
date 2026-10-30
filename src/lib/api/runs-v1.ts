import crypto from "crypto";
import { promises as fs } from "fs";
import { sql } from "@/db";
import { findEndpoint } from "@/lib/catalog/video-models";
import { JOB_KIND_OUTPUT } from "@/lib/generation/types";
import {
  attKind, mediaBaseKind, mediaKindOf,
  type BriefAttachment, type RunView,
} from "@/lib/runs";
import type { SkillDef } from "@/lib/catalog/skills";
import { filePathFor } from "@/lib/storage";
import { canonicalJson } from "./idempotency";
import { mimeForJobOutput } from "./mime";
import type { AssetInfo, JobOutput } from "./job-shape";

/**
 * The public v1 run view - a documented projection over the engine's
 * RunView. Only the fields a remote caller needs: no user/session columns,
 * no raw step params, input hashes, model pickers or revision internals.
 * Step `params` stay server-side because they can embed resolved upload
 * paths and `$step:` wiring a public client already knows from its own plan.
 * Step outputs carry the same { url, type, bytes } contract JobV1 uses:
 * the asset row's mime first, else the kind/url inference - a bare provider
 * kind like "image" is never the wire `type`.
 */
export interface RunOutputV1 {
  url: string;
  type: string;
  bytes: number | null;
}

export interface RunStepV1 {
  id: string;
  title: string;
  endpoint: string;
  status: string;
  rev: number;
  job_id: string | null;
  outputs: RunOutputV1[];
  error: string | null;
  depends_on: string[];
}

export interface RunV1 {
  id: string;
  status: string;
  title: string | null;
  mode: string;
  ask_first: boolean;
  project_id: string | null;
  estimate: { credits: number; eta_seconds: number | null };
  planner: { via: string | null; fallback_reason: string | null };
  steps: RunStepV1[];
  created_at: string;
  updated_at: string;
  links: { self: string; approve: string; control: string };
}

export function runLinks(id: string) {
  return {
    self: `/api/v1/runs/${id}`,
    approve: `/api/v1/runs/${id}/approve`,
    control: `/api/v1/runs/${id}/control`,
  };
}

async function localFileBytes(url: string): Promise<number | null> {
  const p = filePathFor(url);
  if (!p) return null;
  try { return (await fs.stat(p)).size; } catch { return null; }
}

export async function runViewV1(run: RunView): Promise<RunV1> {
  // one assets query across every step that minted a job - the same
  // url→{mime,bytes} enrichment GET /api/v1/jobs/:id applies per output
  const jobIds = [...new Set(
    run.steps.map((s) => s.job_id).filter((x): x is string => !!x))];
  const byJob = new Map<string, Map<string, AssetInfo>>();
  if (jobIds.length) {
    const rows = await sql<{ job_id: string; url: string; bytes: number | null; mime: string | null }>(
      `SELECT job_id, url, bytes, mime FROM assets WHERE job_id = ANY($1)`, [jobIds]);
    for (const r of rows) {
      let m = byJob.get(r.job_id);
      if (!m) byJob.set(r.job_id, (m = new Map()));
      m.set(r.url, { bytes: r.bytes == null ? null : Number(r.bytes), mime: r.mime });
    }
  }
  const steps = await Promise.all(run.steps.map(async (s) => {
    const outs = (s.outputs as JobOutput[] | null) ?? [];
    const info = byJob.get(s.job_id ?? "") ?? new Map<string, AssetInfo>();
    // a missing/stale assets row still answers an honest byte count
    await Promise.all(outs.map(async (o) => {
      if (info.get(o.url)?.bytes == null) {
        const cur = info.get(o.url) ?? { bytes: null, mime: null };
        cur.bytes = await localFileBytes(o.url);
        info.set(o.url, cur);
      }
    }));
    return {
      id: s.step_id,
      title: s.title,
      endpoint: s.endpoint_id,
      status: s.status,
      rev: s.rev,
      job_id: s.job_id,
      outputs: outs.map((o) => ({
        url: o.url,
        type: info.get(o.url)?.mime ?? mimeForJobOutput(o.type, o.url),
        bytes: info.get(o.url)?.bytes ?? null,
      })),
      error: s.error,
      depends_on: s.depends_on,
    };
  }));
  return {
    id: run.id,
    status: run.status,
    title: run.title,
    mode: run.mode,
    ask_first: run.ask_first,
    project_id: run.project_id,
    estimate: { credits: run.estimate_credits, eta_seconds: run.eta_seconds },
    planner: { via: run.via, fallback_reason: run.planner_note },
    steps,
    created_at: run.created_at,
    updated_at: run.updated_at,
    links: runLinks(run.id),
  };
}

/* ---------------- request body ---------------- */

/** Read a request body capped at `cap` bytes - the same streaming rule
 *  POST /api/v1/jobs uses: a chunked request without Content-Length can't
 *  overshoot the limit. Shared by every run route that takes a body. */
export async function readBodyCapped(
  req: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  cap: number,
): Promise<{ text: string } | "too_large" | "unreadable"> {
  if (Number(req.headers.get("content-length") ?? 0) > cap) return "too_large";
  const stream = req.body;
  if (!stream) return { text: "" };
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? 0;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return "too_large";
      }
      if (value) chunks.push(Buffer.from(value));
    }
  } catch {
    return "unreadable";
  }
  return { text: Buffer.concat(chunks).toString("utf8") };
}

/* ---------------- run inputs ---------------- */

/** Caller-supplied inputs for a skill pipeline or a planner brief - media the
 *  run can feed into unfilled media params. Only /files/ urls ever reach a
 *  plan (the same filter the app route applies to attachments); uploads come
 *  from POST /api/v1/uploads and generated media from earlier jobs. Anything
 *  else is dropped before planning, so a genuinely missing media input is a
 *  validation 422 instead of an invented file. */
export function runInputs(v: { url: string; mime?: string }[] | undefined): BriefAttachment[] {
  return (v ?? []).filter((i) => typeof i?.url === "string" && i.url.startsWith("/files/"));
}

/* ---------------- skill → plan ---------------- */

/** The run engine's plan shape for a step. */
export interface PlanStepInput {
  id: string;
  title: string;
  endpoint_id: string;
  params: Record<string, unknown>;
  depends_on: string[];
}

/**
 * Map a catalog skill onto a literal plan - the same rules the Assistant
 * applies: steps keep their declared params verbatim, ordered `s1..sN`, each
 * depending on the previous one, and a media input the skill left unset is
 * filled from the first unused caller-supplied input of the matching kind
 * (each input used once, like the app's attachments), else chained to the
 * closest earlier step whose output kind can fill it. Media the run itself
 * can't produce (a photo the user would attach) stays unset and validatePlan
 * answers 422 - a skill that needs an upload says so instead of inventing a
 * file.
 */
export function skillPlan(
  skill: SkillDef,
  brief: string,
  answers?: Record<string, string>,
  inputs?: BriefAttachment[],
) {
  const steps: PlanStepInput[] = skill.steps(brief, answers).map((s, i) => ({
    id: `s${i + 1}`,
    title: s.label,
    endpoint_id: s.endpoint,
    params: { ...s.params },
    depends_on: i > 0 ? [`s${i}`] : [],
  }));
  const usedInputs = new Set<string>();
  for (const [i, st] of steps.entries()) {
    const found = findEndpoint(st.endpoint_id);
    if (!found) continue;
    for (const f of found.workflow.params) {
      if (st.params[f.name] != null) continue;
      const kind = mediaKindOf(f);
      if (!kind) continue;
      const base = mediaBaseKind(kind);
      const input = inputs?.find((a) => attKind(a) === base && !usedInputs.has(a.url));
      let up: string | null = null;
      for (let k = i - 1; k >= 0; k--) {
        const upKind = findEndpoint(steps[k].endpoint_id)?.workflow.kind;
        if (upKind && JOB_KIND_OUTPUT[upKind] === base) { up = steps[k].id; break; }
      }
      const url = input?.url ?? (up ? `$step:${up}.outputs[0]` : null);
      if (url) {
        if (input) usedInputs.add(input.url);
        st.params[f.name] = kind === "images" ? [url] : url;
      }
    }
  }
  return { title: `Skill: ${skill.name}`, steps };
}

/* ---------------- idempotency ledger (migration 0103) ---------------- */

/** sha256 of the canonical create body - key order can't mint a mismatch. */
export function hashRunRequest(body: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}

/** Look up a stored (user, Idempotency-Key) pair - the run id + request hash
 *  the first POST recorded, or null when the key is fresh. run_id stays NULL
 *  while the create that reserved the key is still in flight. */
export async function findRunIdem(userId: string, key: string) {
  const [row] = await sql<{ run_id: string | null; request_hash: string | null }>(
    `SELECT run_id, request_hash FROM v1_run_idem WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, key]);
  return row ?? null;
}

/** Reserve (user, key) BEFORE any planning/create work - the row exists while
 *  the request runs, so a concurrent same-key request sees the in-flight
 *  reservation and answers 409 idempotency_in_progress instead of minting a
 *  second run. Returns true when this request holds the reservation. */
export async function reserveRunIdem(userId: string, key: string, requestHash: string): Promise<boolean> {
  const ins = () => sql<{ idempotency_key: string }>(
    `INSERT INTO v1_run_idem (user_id, idempotency_key, request_hash, run_id)
     VALUES ($1,$2,$3,NULL)
     ON CONFLICT (user_id, idempotency_key) DO NOTHING
     RETURNING idempotency_key`,
    [userId, key, requestHash]);
  if ((await ins()).length) return true;
  // a create that died mid-planning leaves a forever-NULL reservation that
  // would 409 the key for good - reclaim a reservation far older than the
  // planner's own budget once, then let the insert race decide as usual
  await sql(
    `DELETE FROM v1_run_idem
      WHERE user_id = $1 AND idempotency_key = $2 AND run_id IS NULL
        AND created_at < now() - interval '10 minutes'`,
    [userId, key]);
  return (await ins()).length > 0;
}

/** Fill the reservation with the created run - after this, same-key +
 *  same-payload retries replay the run instead of racing. */
export async function finishRunIdem(userId: string, key: string, runId: string) {
  await sql(
    `UPDATE v1_run_idem SET run_id = $3 WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, key, runId]);
}

/** A create-path failure drops an unresolved reservation (and ONLY an
 *  unresolved one) so a corrected retry reserves the key fresh. */
export async function releaseRunIdem(userId: string, key: string) {
  await sql(
    `DELETE FROM v1_run_idem
      WHERE user_id = $1 AND idempotency_key = $2 AND run_id IS NULL`,
    [userId, key]);
}
