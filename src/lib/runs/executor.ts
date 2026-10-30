import crypto from "node:crypto";
import { z } from "zod";
import { sql, tx } from "@/db";
import { cancelJob, createJob, tickJob, JobError } from "@/lib/jobs";
import { hashJobRequest } from "@/lib/api/idempotency";
import { findEndpoint } from "@/lib/catalog/video-models";
import { STEP_REF, validatePlan, type Plan } from "./plan";
import { currentOptIn } from "./endpoints";
import { AUTO_APPROVE_CAP_CREDITS, estimateSteps, medianSecondsTx } from "./estimate";
import { mediaBaseKind, mediaKindOf } from "./media";
import { EFFORTS, EFFORT_PARAMS, effortParams, modePolicy, nearestDepOfKind, RUN_MODES, type Effort } from "./modes";
import type { ParamField } from "@/lib/catalog/types";
import { JOB_KIND_OUTPUT } from "@/lib/generation/types";
import { toolForEndpoint } from "@/lib/agent/tools/registry";
import { execBuiltin } from "@/lib/agent/tools/exec";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "@/lib/agent/tools/web";
import type { AgentTool } from "@/lib/agent/tools/registry";
import { saveBytes } from "@/lib/storage";
import { userOffline } from "@/lib/llm/settings";

/**
 * The run executor - driven by lazily-fired ticks (session polls, run polls).
 * One transition per tick: a running step is reconciled against its job, or
 * the next runnable pending step is claimed + submitted through createJob
 * (idempotency key = the step row id - repeated ticks can never double-submit).
 *
 * Ordering: steps submit in plan order once their depends_on steps are done;
 * at most ONE step is in flight per user at any moment. A paused run submits
 * nothing new - an in-flight job still reconciles so it doesn't get lost.
 */

export const TERMINAL_RUN = new Set(["done", "failed", "stopped"]);
/** Statuses that still drive ticks (paused reconciles its in-flight step). */
const LIVE_RUN = new Set(["running", "paused"]);

export interface RunRow {
  id: string;
  user_id: string;
  session_id: string | null;
  project_id: string | null;
  mode: string;
  status: string;
  plan: unknown;
  estimate_credits: string;
  eta_seconds: number | null;
  ask_first: boolean;
  /** planner route that produced the plan ("built-in planner" | "ollama·qwen3…") */
  via?: string | null;
  /** planner fallback/error note recorded at submit */
  planner_note?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface StepRow {
  id: string;
  run_id: string;
  idx: number;
  step_id: string;
  title: string;
  endpoint_id: string;
  params: Record<string, unknown>;
  depends_on: string[];
  input_hash: string | null;
  job_id: string | null;
  status: string;
  outputs: unknown;
  error: string | null;
  rev: number;
  /** Custom mode: endpoint the user explicitly picked (null = planner's choice) */
  model_choice?: string | null;
  /** Custom mode: effort applied ('draft'|'standard'|'high') - provenance */
  effort?: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

/** tx() hands back untyped rows - parse at the boundary, never cast. */
type TxQ = (query: string, params?: unknown[]) => Promise<unknown[]>;

const maybeDate = z.custom<Date | null>((v) => v == null || v instanceof Date).default(null);
const STEP_ROW = z.looseObject({
  id: z.string(), run_id: z.string(), idx: z.number(), step_id: z.string(),
  title: z.string(), endpoint_id: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  depends_on: z.array(z.string()).default([]),
  input_hash: z.string().nullable().default(null),
  job_id: z.string().nullable().default(null),
  status: z.string(), outputs: z.unknown().default([]),
  error: z.string().nullable().default(null), rev: z.number().default(0),
  model_choice: z.string().nullable().default(null),
  effort: z.string().nullable().default(null),
  started_at: maybeDate, finished_at: maybeDate,
});
const STEP_ROWS = z.array(STEP_ROW);
const RUN_STATE = z.looseObject({ status: z.string(), ask_first: z.boolean().default(false), mode: z.string().default("auto") });

async function qRows<T>(q: TxQ, schema: z.ZodType<T[]>, query: string, params: unknown[] = []): Promise<T[]> {
  return schema.parseAsync(await q(query, params));
}

/* ---- session feed - the run narrates itself like the old planner did ---- */

async function emit(run: RunRow, role: string, kind: string, content: Record<string, unknown>) {
  if (!run.session_id) return;
  await sql(
    `INSERT INTO agent_messages (session_id, role, kind, content) VALUES ($1,$2,$3,$4::jsonb)`,
    [run.session_id, role, kind, JSON.stringify(content)],
  );
}
const emitStatus = (run: RunRow, text: string) => emit(run, "system", "status", { text });
const emitTool = (run: RunRow, kind: "tool_call" | "tool_result", content: Record<string, unknown>) =>
  emit(run, kind === "tool_call" ? "assistant" : "tool", kind, { tool: "run_step", ...content });

/* ---- durable run events - the feed behind GET /runs/:id/events (SSE) ---- */

/** Append an event row; never throws - events are observability, and a dead
 *  events table must not break execution. */
export async function emitEvent(
  run: Pick<RunRow, "id" | "user_id">,
  kind: string,
  stepId: string | null = null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await sql(
    `INSERT INTO run_events (run_id, user_id, kind, step_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [run.id, run.user_id, kind, stepId, JSON.stringify(payload)],
  ).catch(() => {});
}

/**
 * One tick of the run engine. `nudge` lets a claim-refusal wake the run
 * holding the in-flight slot (one level deep only). `chain` lets a finished
 * builtin tool step continue the run in the same call - TRUE only on the
 * worker sweep: on request paths (POST /runs, run GET, SSE, session polls) a
 * tick stops at the builtin leaf so one poll never eats several inline
 * execs back-to-back.
 */
export async function tickRun(runId: string, nudge = true, chain = false): Promise<void> {
  const [run] = await sql<RunRow>(`SELECT * FROM agent_runs WHERE id = $1`, [runId]);
  if (!run || !LIVE_RUN.has(run.status)) return;
  const steps = await sql<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 ORDER BY idx`, [runId]);
  const byStepId = new Map(steps.map((s) => [s.step_id, s]));

  // (a) a running step - reconcile against its job, one transition per tick.
  //     This still runs while the run is paused: an in-flight job finishes
  //     naturally instead of being orphaned mid-flight.
  const cur = steps.find((s) => s.status === "running");
  if (cur) {
    if (!cur.job_id) { // claimed but job never recorded - finish the submit
      // …except a builtin tool step, which never GETS a job_id: one started
      // <60 s ago is still executing inline (the SSE stream, the run poll and
      // the session poll all tick - re-running would duplicate outbound
      // fetches, todo writes and events). Only an older one - orphaned by a
      // crash - may re-run.
      if (toolForEndpoint(cur.endpoint_id)) {
        const started = cur.started_at instanceof Date
          ? cur.started_at.getTime()
          : cur.started_at == null ? 0 : Date.parse(String(cur.started_at));
        if (started && Date.now() - started < 60_000) return;
      }
      await launchStep(run, cur, byStepId, chain);
      return;
    }
    const live = await tickJob(cur.job_id).catch(() => true);
    if (live) return;
    const [job] = await sql<{ status: string; outputs: unknown; error: string | null }>(
      `SELECT status, outputs, error FROM jobs WHERE id = $1`, [cur.job_id]);
    if (!job || job.status === "queued" || job.status === "in_progress") return;
    if (job.status === "completed") {
      await stepDone(run, cur, job.outputs);
      // keep going - the finished step may unblock the next one or finalize
      // the run. Stopping here starves a run only ever driven by another
      // run's claim-refusal nudge: once that run takes the slot its ticks
      // reconcile its own step and nobody touches this run again.
      await tickRun(runId, nudge, chain);
      return;
    }
    await failStep(run, cur, job.error ?? `job ${job.status}`);
    return;
  }

  // paused - parked: nothing new submits; a pause that landed after the last
  // step finished still finalizes (terminal always beats parked).
  if (run.status === "paused") {
    if (!steps.some((s) => s.status === "pending" || s.status === "running")) {
      await finalizeRun(run, steps.some((s) => s.status === "failed"));
    }
    return;
  }

  // (b) nothing in flight - submit the next pending step whose deps are done
  const nxt = steps.find((s) =>
    s.status === "pending" && s.depends_on.every((d) => byStepId.get(d)?.status === "done"));
  if (!nxt) {
    // pending steps whose deps can never complete (upstream failed, was
    // canceled or skipped) are dead - cascade-skip them, then reconcile.
    // failStep/controlRun already cover the live paths; this is the net
    // for crashes and partial writes.
    const dead = new Set<string>();
    for (const s of steps) {
      if (s.status === "pending" &&
          s.depends_on.some((d) => ["failed", "canceled", "skipped"].includes(byStepId.get(d)?.status ?? ""))) {
        dead.add(s.id);
      }
    }
    for (const id of dead) {
      const skipped = await sql(
        `UPDATE run_steps SET status = 'skipped', finished_at = now() WHERE id = $1 AND status = 'pending' RETURNING step_id`,
        [id]);
      for (const r of skipped) await emitEvent(run, "step_skipped", r.step_id);
    }
    // nothing left to run - terminal reconciliation (a crash between a
    // step-level update and the run-level one lands here on the next tick)
    const alive = steps.filter((s) => !dead.has(s.id));
    if (!alive.some((s) => s.status === "pending" || s.status === "running")) {
      await finalizeRun(run, alive.some((s) => s.status === "failed"));
    }
    return;
  }
  await claimStep(run, nxt, byStepId, nudge, chain);
}

/** Claim the terminal status (done/failed) - only wins on a live run row, so
 *  a racing stop/pause never gets resurrected by a late finalize. */
async function finalizeRun(run: RunRow, failed: boolean) {
  const upd = await sql(
    `UPDATE agent_runs SET status = $2, updated_at = now()
      WHERE id = $1 AND status IN ('running','paused') RETURNING id`,
    [run.id, failed ? "failed" : "done"]);
  if (!upd.length) return;
  await emitEvent(run, failed ? "run_failed" : "run_done");
  await emitStatus(run, failed ? "Run failed." : "Run complete - all steps done.");
}

/** Claim pending → running inside a transaction holding the per-user advisory
 *  lock: the NOT EXISTS slot check and the claim can't interleave with a
 *  sibling tick's, so no two steps of the same user can both enter "running".
 *  The lock is xact-scoped - it releases at commit, before the (slow) job
 *  submit that follows the claim. */
async function claimStep(run: RunRow, step: StepRow, byStepId: Map<string, StepRow>, nudge = true, chain = false) {
  const claimed = await tx(async (q) => {
    await q(`SELECT pg_advisory_xact_lock(hashtext($1))`, [run.user_id]);
    // the claim returns the committed row so the launch below submits the
    // spec under the lock - an edit that landed mid-tick can't slip stale
    // params into the job (its guard refuses non-pending steps anyway)
    return qRows(q, STEP_ROWS,
      `UPDATE run_steps SET status = 'running', started_at = now()
        WHERE id = $1 AND status = 'pending'
          AND (SELECT status FROM agent_runs WHERE id = $2) = 'running'
          AND NOT EXISTS (
            SELECT 1 FROM run_steps rs JOIN agent_runs ar ON ar.id = rs.run_id
             WHERE ar.user_id = $3 AND rs.status = 'running'
          )
        RETURNING *`, [step.id, run.id, run.user_id]);
  });
  const row = claimed[0];
  if (!row) {
    // the claim lost - either this run left 'running', or a sibling run
    // holds the one-in-flight slot. Ticks only fire when someone polls, so
    // a step whose job finished inside a run nobody polls would starve
    // every other run of this user forever - nudge that run's tick once
    // (one level: the nudged tick can't nudge further). The real fix is the
    // worker's tickRuns() sweep (WS1).
    if (nudge) {
      const [holder] = await sql<{ run_id: string }>(
        `SELECT rs.run_id FROM run_steps rs JOIN agent_runs ar ON ar.id = rs.run_id
          WHERE ar.user_id = $1 AND rs.status = 'running' AND ar.id <> $2
          ORDER BY rs.started_at NULLS LAST LIMIT 1`,
        [run.user_id, run.id]);
      if (holder) await tickRun(holder.run_id, false).catch(() => {});
    }
    return;
  }
  byStepId.set(row.step_id, row); // keep byStepId views current for this tick
  await launchStep(run, row, byStepId, chain);
}

/** Step-error text shown while the concurrency gate has the step parked. */
export const WAITING_TEXT = "waiting for a free slot";

/** Resolve $step refs, hash the input, submit through createJob (idempotency
 *  key = the step row id - a retried launch replays the same job), record the
 *  job id. Any failure ends the step + run - EXCEPT a full queue (createJob's
 *  concurrency_limit 429): the step just goes back to pending with a visible
 *  note and retries on the next tick; the run never fails over it. A stop
 *  that landed mid-submit cancels the orphan job. */
async function launchStep(run: RunRow, step: StepRow, byStepId: Map<string, StepRow>, chain = false) {
  try {
    const resolved = resolveStepParams(step, byStepId);
    const hash = inputHash(step, resolved, byStepId);
    // builtin agent/* tool - a job-less step: the executor's file write IS
    // the leaf (text/json), 0 cr, no provider call. Runs inline on the claim
    // so one tick does claim→exec→done.
    const tool = toolForEndpoint(step.endpoint_id);
    if (tool) {
      await launchToolStep(run, step, tool, resolved, hash, chain);
      return;
    }
    const job = await createJob(run.user_id, {
      endpointId: step.endpoint_id,
      params: resolved,
      projectId: run.project_id ?? undefined,
      title: step.title,
      // rev is part of the key: an editStep re-run must submit a fresh job,
      // not replay the one the old spec produced
      idempotencyKey: `run-step:${step.id}:r${step.rev}`,
      requestHash: hashJobRequest(step.endpoint_id, resolved),
    });
    const upd = await sql(
      `UPDATE run_steps SET job_id = $2, input_hash = $3, error = NULL
        WHERE id = $1 AND status = 'running' RETURNING id`,
      [step.id, job.id, hash]);
    if (!upd.length) {
      // a stop landed between claim and submit - kill the orphan job
      await cancelJob(run.user_id, job.id).catch(() => {});
      return;
    }
    await emitEvent(run, "step_running", step.step_id, { job_id: job.id, input_hash: hash });
    await emitTool(run, "tool_call", {
      step_id: step.step_id, job_id: job.id, endpoint: step.endpoint_id,
      text: `Running ${step.title} - job ${job.id.slice(0, 8)}`,
    });
  } catch (e) {
    if (e instanceof JobError && e.code === "concurrency_limit") {
      // back to pending with the wait note - once per contiguous wait (the
      // claim keeps the error, so step.error still reads it next tick)
      const wasWaiting = step.error === WAITING_TEXT;
      await sql(
        `UPDATE run_steps SET status = 'pending', started_at = NULL, error = $2
          WHERE id = $1 AND status = 'running'`,
        [step.id, WAITING_TEXT]);
      step.status = "pending";
      step.error = WAITING_TEXT;
      if (!wasWaiting) {
        await emitEvent(run, "step_waiting", step.step_id, { reason: "concurrency_limit" });
        await emitStatus(run, `Waiting for a free slot - "${step.title}" submits when capacity opens.`);
      }
      return;
    }
    await failStep(run, step, e instanceof Error ? e.message : String(e));
  }
}

/** A builtin tool step: execBuiltin produces the leaf body; it lands as a
 *  run file under /files/runs/<run>/<step-row-id>.<ext> (the row id is a
 *  uuid - no path input) and the step's outputs carry the leaf with its
 *  `via` and a bounded text preview. */
async function launchToolStep(
  run: RunRow, step: StepRow, tool: AgentTool,
  resolved: Record<string, unknown>, hash: string, chain: boolean,
) {
  // announce the step BEFORE exec - a slow builtin (a 10 s web fetch)
  // otherwise looks frozen on the feed while it runs
  await emitEvent(run, "step_running", step.step_id, { input_hash: hash, tool: tool.name });
  await emitTool(run, "tool_call", {
    step_id: step.step_id, endpoint: step.endpoint_id,
    text: `Running ${step.title} - ${tool.name}`,
  });
  // Offline re-checks at exec time: a run created online and approved after
  // the user turns Settings → Offline on must not fetch remote targets - the
  // stored mode alone would allow it. A prefs read failure fails CLOSED:
  // unverifiable means offline, never "probably online".
  const mode = z.enum(RUN_MODES).catch("auto").parse(run.mode);
  const offline = mode === "offline" || await userOffline(run.user_id).catch(() => true);
  const result = await execBuiltin(
    { userId: run.user_id, runId: run.id, sessionId: run.session_id, mode: offline ? "offline" : mode, offline },
    tool, resolved);
  const upd = await sql(
    `UPDATE run_steps SET input_hash = $2, error = NULL
      WHERE id = $1 AND status = 'running' RETURNING id`,
    [step.id, hash]);
  if (!upd.length) return; // a stop landed mid-exec - the file is never written
  const ext = tool.output === "json" ? "json" : "txt";
  const url = await saveBytes(`runs/${run.id}/${step.id}.${ext}`, Buffer.from(result.body, "utf8"));
  // the stored leaf keeps the untrusted-DATA framing - a later planner turn
  // fed from the file sees it. The step's inline preview strips just the
  // markers: they're framing, not content, and read as noise on the card.
  const preview = result.body
    .replace(UNTRUSTED_OPEN, "")
    .replace(UNTRUSTED_CLOSE, "")
    .trim();
  const outputs = [{
    url, type: tool.output, via: tool.name,
    text: preview.length > 400 ? `${preview.slice(0, 400)}…` : preview,
  }];
  await stepDone(run, step, outputs);
  // request-path ticks stop at the builtin leaf - claim→exec→done is this
  // tick's transition; the next poll or worker pass picks up whatever it
  // unblocked. Only the sweep (tickRuns → chain) continues in-call, so a
  // plan of builtins still finishes in one pass off the request path.
  if (chain) await tickRun(run.id, false, true);
}

/** Step outputs as stored on the row - parsed, never trusted. */
const STEP_OUTPUTS = z.array(z.looseObject({ url: z.string().optional() }));

/** Resolve "$step:<id>.outputs[<n>]" values against finished upstream steps. */
function resolveStepParams(step: StepRow, byStepId: Map<string, StepRow>): Record<string, unknown> {
  const resolve = (v: unknown): unknown => {
    if (typeof v === "string") {
      const m = STEP_REF.exec(v);
      if (!m) return v;
      const outs = STEP_OUTPUTS.safeParse(byStepId.get(m[1])?.outputs ?? []).data ?? [];
      const url = outs[Number(m[2])]?.url;
      if (typeof url !== "string" || !url) throw new Error(`step ${m[1]} has no output #${m[2]} to feed step "${step.step_id}"`);
      return url;
    }
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, resolve(x)]));
    }
    return v;
  };
  return resolve(step.params) as Record<string, unknown>;
}

/** sha256 over the submit payload + upstream input hashes - the recorded
 *  fingerprint of exactly what this step ran on. Deliberately excludes run id
 *  and step id: a step whose inputs are unchanged keeps its hash across edits
 *  of sibling/upstream-untouched steps, so the tree can prove what re-ran. */
export function inputHash(
  step: Pick<StepRow, "endpoint_id" | "depends_on">,
  resolved: Record<string, unknown>,
  byStepId: Map<string, Pick<StepRow, "input_hash">>,
): string {
  const deps = Object.fromEntries(step.depends_on.map((d) => [d, byStepId.get(d)?.input_hash ?? null]));
  return crypto.createHash("sha256")
    .update(JSON.stringify({ endpoint: step.endpoint_id, params: resolved, deps }))
    .digest("hex");
}

async function stepDone(run: RunRow, step: StepRow, outputs: unknown) {
  const upd = await sql(
    `UPDATE run_steps SET status = 'done', outputs = $2::jsonb, finished_at = now()
      WHERE id = $1 AND status = 'running' RETURNING id`,
    [step.id, JSON.stringify(outputs ?? [])]);
  if (!upd.length) return;
  // the composer checklist mirrors step titles - the finished step's item
  // ticks itself in ONE jsonb write: elements rewrite in place inside the
  // same UPDATE, so an interleaved user tick on another item survives, and
  // the EXISTS gate means a no-match write never happens at all (no
  // read-then-write window for a lost update).
  if (run.session_id) {
    await sql(
      `UPDATE agent_sessions
          SET context = jsonb_set(context, '{todo,items}', (
                SELECT jsonb_agg(CASE WHEN el->>'text' = $2
                                       AND coalesce(el->>'done', 'false') <> 'true'
                                 THEN el || '{"done":true}'::jsonb ELSE el END
                                 ORDER BY ord)
                  FROM jsonb_array_elements(context->'todo'->'items')
                       WITH ORDINALITY AS x(el, ord)
              ), false),
              updated_at = now()
        WHERE id = $1
          AND jsonb_typeof(context->'todo'->'items') = 'array'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(context->'todo'->'items') el
                       WHERE el->>'text' = $2
                         AND coalesce(el->>'done', 'false') <> 'true')`,
      [run.session_id, step.title],
    ).catch(() => {});
  }
  // feed the session's lastOutputs - a follow-up turn ("now animate it")
  // resolves its media input from the last produced url per kind
  if (run.session_id) {
    const last: Record<string, string> = {};
    for (const o of STEP_OUTPUTS.safeParse(outputs ?? []).data ?? []) {
      if (typeof o.url === "string" && typeof o.type === "string"
          && ["image", "video", "audio"].includes(o.type)) last[o.type] = o.url;
    }
    if (Object.keys(last).length) {
      await sql(
        `UPDATE agent_sessions
            SET context = jsonb_set(context, '{lastOutputs}',
                          coalesce(context->'lastOutputs', '{}'::jsonb) || $2::jsonb, true),
                updated_at = now()
          WHERE id = $1`,
        [run.session_id, JSON.stringify(last)]).catch(() => {});
    }
  }
  await emitEvent(run, "step_done", step.step_id, { job_id: step.job_id, outputs: outputs ?? [] });
  await emitTool(run, "tool_result", {
    step_id: step.step_id, job_id: step.job_id,
    text: `Done - ${step.title}`, outputs: outputs ?? [],
  });
}

/** A step failure skips everything still waiting and fails the run -
 *  completed steps keep their results. The run transition is claimed
 *  atomically: a racing stop that already moved the run to 'stopped' wins,
 *  and a tick that reads the job as canceled afterward must not resurrect
 *  the run as 'failed'. When the claim loses, nothing else happens - the
 *  stop path already marked the steps. */
async function failStep(run: RunRow, step: StepRow, msg: string) {
  const claimed = await sql(
    `UPDATE agent_runs SET status = 'failed', updated_at = now()
      WHERE id = $1 AND status IN ('running','paused') RETURNING id`,
    [run.id]);
  if (!claimed.length) return;
  await sql(
    `UPDATE run_steps SET status = 'failed', error = $2, finished_at = now()
      WHERE id = $1 AND status IN ('pending','running')`,
    [step.id, msg.slice(0, 500)]);
  const skipped = await sql<{ step_id: string }>(
    `UPDATE run_steps SET status = 'skipped', finished_at = now()
      WHERE run_id = $1 AND status IN ('pending','running') RETURNING step_id`,
    [run.id]);
  await emitEvent(run, "step_failed", step.step_id, { job_id: step.job_id, error: msg.slice(0, 500) });
  for (const s of skipped) await emitEvent(run, "step_skipped", s.step_id);
  await emitEvent(run, "run_failed", null, { failed_step: step.step_id });
  await emitTool(run, "tool_result", { step_id: step.step_id, job_id: step.job_id, error: msg });
  await emitStatus(run, `Run failed - ${msg}. Completed steps kept their results.`);
}

/* ---------------------------- control ------------------------------------ */

export type RunAction = "approve" | "stop" | "pause" | "resume";

/**
 * approve: awaiting_approval → running, then the first tick submits step 1.
 * pause: running → paused - the claim guard refuses new submissions while
 *   set; an in-flight job keeps running and reconciles on the next tick.
 * resume: paused → running, then ticks again.
 * stop: cancels the live job (cancelJob refunds it), marks unfinished steps
 * canceled and the run stopped.
 * All are safe to call repeatedly - every run-status transition is claimed
 * atomically, so a duplicate request just re-reads the state.
 */
export async function controlRun(userId: string, runId: string, action: RunAction): Promise<boolean | null> {
  const [run] = await sql<RunRow>(
    `SELECT * FROM agent_runs WHERE id = $1 AND user_id = $2`, [runId, userId]);
  if (!run) return null;

  if (action === "approve") {
    if (run.status !== "awaiting_approval") return true;
    const upd = await sql(
      `UPDATE agent_runs SET status = 'running', updated_at = now() WHERE id = $1 AND status = 'awaiting_approval' RETURNING id`,
      [runId]);
    if (upd.length) {
      await emitEvent(run, "run_approved");
      await emitStatus(run, "Approved - run started.");
      await tickRun(runId);
    }
    return true;
  }

  if (action === "pause") {
    if (run.status === "paused") return true; // repeating the current state stays 200
    if (run.status !== "running")
      throw new JobError(`run is ${run.status} - only a running run can pause`, 409);
    const upd = await sql(
      `UPDATE agent_runs SET status = 'paused', updated_at = now()
        WHERE id = $1 AND status = 'running' RETURNING id`,
      [runId]);
    if (upd.length) {
      const [live] = await sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM run_steps WHERE run_id = $1 AND status = 'running'`, [runId]);
      await emitEvent(run, "run_paused", null, { in_flight: live?.n ?? 0 });
      await emitStatus(run, (live?.n ?? 0) > 0
        ? "Paused - the running step finishes its job; nothing new submits."
        : "Paused - no step submits until you resume.");
    }
    return true;
  }

  if (action === "resume") {
    if (run.status === "running") return true; // already resumed - idempotent
    if (run.status !== "paused")
      throw new JobError(`run is ${run.status} - only a paused run can resume`, 409);
    const upd = await sql(
      `UPDATE agent_runs SET status = 'running', updated_at = now()
        WHERE id = $1 AND status = 'paused' RETURNING id`,
      [runId]);
    if (upd.length) {
      await emitEvent(run, "run_resumed");
      await emitStatus(run, "Resumed - the run continues.");
      await tickRun(runId);
    }
    return true;
  }

  // stop - cancel the live job first so its refund lands even if we die after
  if (TERMINAL_RUN.has(run.status)) return true;
  const steps = await sql<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1`, [runId]);
  const cur = steps.find((s) => s.status === "running" && s.job_id);
  if (cur?.job_id) await cancelJob(userId, cur.job_id).catch(() => {});
  const upd = await sql(
    `UPDATE agent_runs SET status = 'stopped', updated_at = now()
      WHERE id = $1 AND status NOT IN ('done','failed','stopped') RETURNING id`,
    [runId]);
  if (upd.length) {
    const canceled = await sql<{ step_id: string }>(
      `UPDATE run_steps SET status = 'canceled', finished_at = now()
        WHERE run_id = $1 AND status = 'pending' RETURNING step_id`,
      [runId]);
    if (cur?.job_id) {
      // the running step lands canceled - unless its job had already
      // completed before the cancel won the race; then it lands done
      const [job] = await sql<{ status: string; outputs: unknown }>(
        `SELECT status, outputs FROM jobs WHERE id = $1`, [cur.job_id]);
      if (job?.status === "completed") {
        await sql(
          `UPDATE run_steps SET status = 'done', outputs = $2::jsonb, finished_at = now()
            WHERE id = $1 AND status = 'running'`,
          [cur.id, JSON.stringify(job.outputs ?? [])]);
      } else {
        await sql(
          `UPDATE run_steps SET status = 'canceled', finished_at = now()
            WHERE id = $1 AND status = 'running'`, [cur.id]);
        await emitEvent(run, "step_canceled", cur.step_id, { job_id: cur.job_id });
      }
    } else {
      // running-but-never-submitted step - straight to canceled
      const killed = await sql<{ step_id: string }>(
        `UPDATE run_steps SET status = 'canceled', finished_at = now()
          WHERE run_id = $1 AND status = 'running' RETURNING step_id`, [runId]);
      for (const s of killed) await emitEvent(run, "step_canceled", s.step_id);
    }
    for (const s of canceled) await emitEvent(run, "step_canceled", s.step_id);
    await emitEvent(run, "run_stopped");
    await emitStatus(run, "Run stopped - pending steps canceled; finished steps keep their results.");
  }
  return true;
}

/* ---------------------------- step editing -------------------------------- */

export interface StepEdit {
  title?: string;
  /** merges onto the stored params - media values ($step refs, /files/ urls)
   *  ride along unchanged unless the caller overwrites them */
  params?: Record<string, unknown>;
  /** Custom mode: swap the endpoint (same output kind; required media params
   *  a transitive dep feeds are auto-wired to "$step:<dep>.outputs[0]") */
  endpoint_id?: string;
  /** effort level - derives the endpoint's own quality knobs (modes.ts) */
  effort?: Effort;
  /** optimistic concurrency - must equal the step's current rev or 409 */
  rev: number;
}

/** 409 carrying the step's current rev - the route returns it in the body so
 *  the client can refresh instead of retrying blind. */
export class StaleRevError extends JobError {
  rev: number;
  constructor(rev: number) {
    super("the step changed since you loaded it - refresh and try again", 409);
    this.rev = rev;
  }
}

/** Run states where a step edit is legal - a live run refuses (409). */
const EDITABLE_RUN = new Set(["awaiting_approval", "paused", "done", "failed", "stopped"]);

const SNAPSHOT_COLS =
  `(run_id, run_step_id, step_id, rev, title, endpoint_id, params, depends_on, input_hash, job_id, status, outputs, error)`;
const snapshotRow = (
  q: (query: string, params?: unknown[]) => Promise<unknown[]>,
  runId: string, s: StepRow,
) => q(
  `INSERT INTO run_step_revisions ${SNAPSHOT_COLS}
   VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb,$13)`,
  [runId, s.id, s.step_id, s.rev, s.title, s.endpoint_id, JSON.stringify(s.params),
   s.depends_on, s.input_hash, s.job_id, s.status, JSON.stringify(s.outputs ?? []), s.error],
);

const RESET_SQL =
  `UPDATE run_steps
      SET status = 'pending', job_id = NULL, outputs = '[]'::jsonb, input_hash = NULL,
          error = NULL, started_at = NULL, finished_at = NULL, rev = rev + 1
    WHERE id = $1`;

/** Would `v` survive validatePlan's per-field checks? Mirrors the coercion
 *  contract: a numeric-enum field takes the parsed number's membership, a
 *  numeric field takes the parsed number's range, a boolean takes a real
 *  boolean (or the strings coerceParams reshapes). Used to refit carried
 *  params after a model swap - not to pre-clear explicit user input. */
function fitsField(f: ParamField, v: unknown): boolean {
  if (Array.isArray(f.enum) && f.enum.length) {
    const nums = f.enum.filter((x): x is number => typeof x === "number");
    if (nums.length === f.enum.length) {
      const n = typeof v === "number" ? v : parseFloat(String(v));
      return Number.isFinite(n) && nums.includes(n);
    }
    return f.enum.some((x) => x === v);
  }
  if (["number", "integer", "slider"].includes(f.type)) {
    const n = typeof v === "number" ? v : parseFloat(String(v));
    if (!Number.isFinite(n)) return false;
    if (f.min !== undefined && n < f.min) return false;
    if (f.max !== undefined && n > f.max) return false;
    return true;
  }
  if (f.type === "boolean") return typeof v === "boolean" || v === "true" || v === "false";
  return true;
}

/**
 * Edit a step's title/params and re-run it plus everything downstream.
 *
 * The edit is legal only while the run is parked (awaiting_approval, paused)
 * or finished (done/failed/stopped) - a running run refuses, and so do the
 * step and its transitive descendants while any of them is running. `rev` is
 * optimistic concurrency: stale → 409 with the current rev.
 *
 * Inside the per-user advisory lock the rows are re-read, the whole edited
 * plan replays through validatePlan (a broken downstream $step ref refuses
 * 422 plainly), and then - atomically - the edited step, every transitive
 * descendant, and every transitive ancestor that isn't done (canceled,
 * skipped or failed links included: a reopened run must never finalize
 * "done" while a link it still feeds never ran) snapshot their superseded
 * row into run_step_revisions (done or failed ones; the edited step always
 * snapshots so an edited pending spec is auditable too), reset to pending
 * with job/hash/outputs cleared, and bump rev. Done ancestors and unrelated
 * steps keep their job, hash and outputs.
 *
 * The gate re-applies on the pending delta only: ask_first, a delta above
 * AUTO_APPROVE_CAP_CREDITS, or a custom-mode run parks at awaiting_approval.
 * A paused run STAYS paused (its in-flight step keeps reconciling) - resume
 * continues it. Only done/failed/stopped runs reopen to running, and the
 * kick tick submits the first reset step.
 */
export async function editStep(
  userId: string, runId: string, stepId: string, edit: StepEdit,
): Promise<{ step: StepRow; rev: number } | null> {
  const [run] = await sql<RunRow>(
    `SELECT * FROM agent_runs WHERE id = $1 AND user_id = $2`, [runId, userId]);
  if (!run) return null;
  if (!EDITABLE_RUN.has(run.status))
    throw new JobError(`run is ${run.status} - steps can't be edited while it's live`, 409);

  // the Settings Offline lock narrows the effective mode - an "auto" run
  // can't widen back out while the user keeps the net closed (C1). A prefs
  // read failure fails closed: unverifiable means offline.
  const offlineNow = await userOffline(userId).catch(() => true);
  const policy = await modePolicy(offlineNow ? "offline" : run.mode, userId);
  const eps = policy.endpoints;
  const optIn = await currentOptIn(userId);

  const applied = await tx(async (q) => {
    await q(`SELECT pg_advisory_xact_lock(hashtext($1))`, [userId]);
    // re-read inside the lock - the run may have moved since the pre-check
    const [fresh] = await qRows(q, z.array(RUN_STATE),
      `SELECT status, ask_first, mode FROM agent_runs WHERE id = $1`,
      [runId]);
    if (!fresh || !EDITABLE_RUN.has(fresh.status))
      throw new JobError(`run is ${fresh?.status ?? "gone"} - steps can't be edited while it's live`, 409);
    const steps = await qRows(q, STEP_ROWS,
      `SELECT * FROM run_steps WHERE run_id = $1 ORDER BY idx`, [runId]);
    const step = steps.find((s) => s.step_id === stepId);
    if (!step) return null;
    if (step.rev !== edit.rev) throw new StaleRevError(step.rev);

    // transitive descendant closure - everything that (transitively) waits on
    // this step's output re-runs with it; unrelated steps don't
    const desc = new Set<string>();
    for (let grew = true; grew;) {
      grew = false;
      for (const s of steps) {
        if (s.step_id === stepId || desc.has(s.step_id)) continue;
        if (s.depends_on.some((d) => d === stepId || desc.has(d))) { desc.add(s.step_id); grew = true; }
      }
    }
    // endpoint pick (Custom's model picker): same output kind only; required
    // media params a transitive dep can feed are auto-wired to $step refs
    const nextEndpoint = edit.endpoint_id ?? step.endpoint_id;
    const params = edit.params ? { ...step.params, ...edit.params } : { ...step.params };
    let depends_on = step.depends_on;
    let modelChoice = step.model_choice ?? null;
    if (nextEndpoint !== step.endpoint_id) {
      const curWf = findEndpoint(step.endpoint_id)?.workflow;
      const newWf = findEndpoint(nextEndpoint)?.workflow;
      if (curWf && newWf && JOB_KIND_OUTPUT[curWf.kind] !== JOB_KIND_OUTPUT[newWf.kind])
        throw new JobError(
          `a model pick can't change the step's output kind (${JOB_KIND_OUTPUT[curWf.kind]} → ${JOB_KIND_OUTPUT[newWf.kind]})`, 422);
      if (newWf) {
        // the new model takes its own parameter shape - fields the old
        // endpoint declared but the new one doesn't are dropped (keeping a
        // $step ref on an undeclared field would 422 anyway), and a kept
        // value the new field refuses falls back to the field's default -
        // or drops out when it has none - so a pick the picker offers can
        // never 422 on values the old spec left behind. Values posted
        // explicitly in this edit stay strict: they keep their spot in
        // params and validatePlan refuses them plainly.
        const declared = new Set(newWf.params.map((f) => f.name));
        for (const k of Object.keys(params))
          if (!declared.has(k) && !(edit.params && k in edit.params)) delete params[k];
        for (const f of newWf.params) {
          if (edit.params && f.name in edit.params) continue;
          if (mediaKindOf(f)) continue;
          const v = params[f.name];
          if (v === undefined || v === "" || v === null) continue;
          if (!fitsField(f, v)) {
            if (f.default !== undefined) params[f.name] = f.default;
            else delete params[f.name];
          }
        }
        for (const f of newWf.params) {
          if (!f.required) continue;
          const cur = params[f.name];
          if (cur !== undefined && cur !== "" && cur !== null) continue;
          const kind = mediaKindOf(f);
          if (!kind) continue; // validatePlan refuses plainly below
          const dep = nearestDepOfKind(
            { step_id: stepId, depends_on }, steps, mediaBaseKind(kind));
          if (dep) {
            params[f.name] = kind === "images" ? [`$step:${dep}.outputs[0]`] : `$step:${dep}.outputs[0]`;
            if (!depends_on.includes(dep)) depends_on = [...depends_on, dep];
          }
        }
      }
      modelChoice = nextEndpoint;
    }
    // effort provenance: an explicit effort in this edit wins and re-derives
    // the knobs on the (possibly new) endpoint; an endpoint-only swap keeps
    // the stored level and re-applies it onto the new workflow - its numbers
    // may not exist there. A params edit touching a knob effort owns clears
    // the level - the user's own numbers stand.
    const storedEffortParsed = z.enum(EFFORTS).safeParse(step.effort);
    const storedEffort = storedEffortParsed.success ? storedEffortParsed.data : null;
    const effort = edit.effort !== undefined ? edit.effort
      : edit.params && Object.keys(edit.params).some((k) => EFFORT_PARAMS.has(k)) ? null
      : storedEffort;
    if (effort) {
      const wf = findEndpoint(nextEndpoint)?.workflow;
      if (wf) Object.assign(params, effortParams(wf, effort, optIn));
    }

    const next = {
      title: edit.title ?? step.title,
      endpoint_id: nextEndpoint,
      params,
      depends_on,
    };

    // transitive ancestors (of the NEW dep set - an auto-wired dep counts)
    // that terminated WITHOUT output join the reset too: a step can't claim
    // done on a $step link whose producer never ran. pending/running
    // ancestors are left alone - they still feed the dependent in order
    const anc = new Set<string>();
    {
      const stack = [...depends_on];
      while (stack.length) {
        const d = stack.pop();
        if (d === undefined || anc.has(d)) continue;
        anc.add(d);
        stack.push(...(steps.find((s) => s.step_id === d)?.depends_on ?? []));
      }
    }
    const deadAnc = new Set(
      steps.filter((s) => anc.has(s.step_id) && ["canceled", "failed", "skipped"].includes(s.status))
        .map((s) => s.step_id));
    const affected = steps.filter((s) =>
      s.step_id === stepId || desc.has(s.step_id) || deadAnc.has(s.step_id));
    const runningNow = affected.find((s) => s.status === "running");
    if (runningNow)
      throw new JobError(
        `step "${runningNow.step_id}" is still running - wait for it to finish (or stop the run) before editing`, 409);

    // whole-plan replay on the locked rows - other steps keep their stored
    // spec; a broken downstream ref or bad param refuses 422 before any write
    const replayed: Plan = {
      title: undefined,
      steps: steps.map((s) => s.step_id === stepId
        ? { id: s.step_id, title: next.title, endpoint_id: next.endpoint_id, params: next.params, depends_on: next.depends_on }
        : { id: s.step_id, title: s.title, endpoint_id: s.endpoint_id, params: s.params, depends_on: s.depends_on }),
    };
    const normalized = validatePlan(replayed, eps, {
      mode: offlineNow ? "offline" : fresh.mode === "custom" ? "custom" : "auto", optIn,
    });

    // pending delta only - what this edit leaves to run and to charge
    const est = await estimateSteps(normalized, { median: (ep) => medianSecondsTx(q, ep) });
    const pendingIds = new Set(
      steps.filter((s) => s.status === "pending" || affected.includes(s)).map((s) => s.step_id));
    const pending = est.perStep.filter((e) => pendingIds.has(e.stepId));
    const delta = pending.reduce((a, e) => a + e.cost, 0);
    const eta = pending.length > 0 && pending.every((e) => e.etaSeconds != null)
      ? pending.reduce((a, e) => a + (e.etaSeconds ?? 0), 0)
      : null;

    // the edited step always snapshots (audit of the spec swap), then takes
    // the new spec + pending state
    await snapshotRow(q, runId, step);
    const [row] = await qRows(q, STEP_ROWS,
      `UPDATE run_steps
          SET title = $3, endpoint_id = $4, params = $5::jsonb, depends_on = $6,
              model_choice = $7, effort = $8, status = 'pending', job_id = NULL,
              outputs = '[]'::jsonb, input_hash = NULL, error = NULL,
              started_at = NULL, finished_at = NULL, rev = rev + 1
        WHERE id = $1 AND run_id = $2 RETURNING *`,
      [step.id, runId, next.title, next.endpoint_id, JSON.stringify(next.params),
       next.depends_on, modelChoice, effort]);

    // descendants + unfinished ancestors reset with it - done/failed rows
    // leave a revision behind so "earlier versions" keeps what they produced;
    // pending/canceled/skipped rows have nothing to preserve
    for (const s of affected.filter((x) => x.step_id !== stepId)) {
      if (s.status === "done" || s.status === "failed") await snapshotRow(q, runId, s);
      await q(RESET_SQL, [s.id]);
    }

    // approval gate on the pending delta - awaiting_approval stays parked, a
    // paused run stays paused, terminal runs reopen to running
    const gated = fresh.ask_first || delta > AUTO_APPROVE_CAP_CREDITS || policy.gate === "always";
    const nextStatus = fresh.status === "awaiting_approval" || gated
      ? "awaiting_approval"
      : fresh.status === "paused" ? "paused" : "running";
    await q(
      `UPDATE agent_runs
          SET estimate_credits = $2, eta_seconds = $3, status = $4, updated_at = now()
        WHERE id = $1`,
      [runId, String(delta), eta, nextStatus]);
    return {
      row, resetIds: affected.filter((s) => s.step_id !== stepId).map((s) => s.step_id),
      nextStatus, delta,
    };
  });
  if (!applied) return null;
  const { row, resetIds, nextStatus, delta } = applied;

  await emitEvent(run, "step_edited", stepId, {
    rev: row.rev, reset: resetIds,
    changed: {
      title: edit.title !== undefined, params: edit.params !== undefined,
      endpoint: edit.endpoint_id !== undefined, effort: edit.effort !== undefined,
    },
  });
  for (const d of resetIds) await emitEvent(run, "step_reset", d, { because: stepId });
  if (nextStatus === "running") await emitEvent(run, "run_reopened", null, { estimate_credits: delta });
  else if (nextStatus === "awaiting_approval") await emitEvent(run, "run_awaiting_approval", null, { estimate_credits: delta });
  await emitStatus(run, nextStatus === "running"
    ? `Step "${row.title}" edited - re-running ${resetIds.length + 1} step(s) (~${delta.toFixed(2)} cr).`
    : nextStatus === "paused"
      ? `Step "${row.title}" edited - ${resetIds.length + 1} step(s) to re-run (~${delta.toFixed(2)} cr); resume to run.`
      : `Step "${row.title}" edited - ${resetIds.length + 1} step(s) to re-run (~${delta.toFixed(2)} cr); approval needed.`);
  if (nextStatus === "running") await tickRun(runId);
  return { step: row, rev: row.rev };
}
