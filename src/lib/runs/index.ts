import { sql } from "@/db";
import { JobError } from "@/lib/jobs";
import { findEndpoint } from "@/lib/catalog/video-models";
import { validatePlan, PLAN, type Plan, type LiveEndpoint } from "./plan";
import { turnEndpoints, currentOptIn } from "./endpoints";
import { AUTO_APPROVE_CAP_CREDITS, estimateSteps, medianSeconds, type RunEstimate } from "./estimate";
import { controlRun, editStep, emitEvent, tickRun, TERMINAL_RUN, type RunRow, type StepRow } from "./executor";
import { effortDiffers, modePolicy, stepModelOptions, type RunMode, type StepModelOption } from "./modes";
import { userOffline } from "@/lib/llm/settings";
import { resolveAtRefs } from "./refs";
import { toolForEndpoint } from "@/lib/agent/tools/registry";

/**
 * Run engine - public surface.
 *
 * createRun: validate the plan (shape, endpoint allowlist, license,
 *   dependencies, refs, params) → estimate → approval gate → durable rows.
 *   A run that needs approval waits at `awaiting_approval` and never touches
 *   a job until approve; an auto-approved run starts ticking immediately.
 *
 * The engine is tick-driven: request-path polls (session messages GET, run
 * GET, the run's SSE stream) call tickRun; the worker sweep calls tickRuns.
 * A request-path tick reconciles at most one in-flight step and never
 * continues past a builtin tool leaf - a poll can't eat several inline
 * execs; the sweep chains through builtin leaves since it owns no request.
 */

export { PLAN, PLAN_STEP, STEP_REF, collectRefs, planRefuse, validatePlan } from "./plan";
export { MEDIA_TYPES, MEDIA_PARAM_KIND, mediaBaseKind, mediaKindOf } from "./media";
export type { MediaBase, MediaKind } from "./media";
export type { LiveEndpoint, NormalizedStep, Plan, PlanStep } from "./plan";
export { turnEndpoints, allowedEndpointIds, currentOptIn, liveEndpoints } from "./endpoints";
export { AUTO_APPROVE_CAP_CREDITS, estimateSteps } from "./estimate";
export type { RunEstimate } from "./estimate";
export {
  deterministicPlan, llmPlan, attKind, extractPrompt, parsePlannerPick, BUILTIN_PLANNER,
  builtinIntentPlan, explicitMemoryBrief,
} from "./planner";
export type { BriefAttachment, PlanTurn } from "./planner";
export { controlRun, editStep, tickRun, inputHash, TERMINAL_RUN, StaleRevError } from "./executor";
export type { RunRow, StepRow, RunAction, StepEdit } from "./executor";
export { RUN_MODES, EFFORTS, EFFORT_PARAMS, effortDiffers, modePolicy, effortParams, stepModelOptions } from "./modes";
export type { RunMode, Effort, ModePolicy, StepModelOption } from "./modes";
export { resolveAtRefs } from "./refs";

export interface StepView {
  id: string;
  step_id: string;
  idx: number;
  title: string;
  endpoint_id: string;
  status: string;
  depends_on: string[];
  /** the params the step runs (declared values; $step refs resolve at submit) */
  params: Record<string, unknown>;
  job_id: string | null;
  input_hash: string | null;
  outputs: unknown;
  error: string | null;
  /** spec revision - bumped by every editStep; prior specs in run_step_revisions */
  rev: number;
  /** catalog cost over the stored params - what the job is/was charged */
  cost: number | null;
  /** median of the endpoint's last 20 completed jobs; null = honest unknown */
  eta_seconds: number | null;
  /** when this spec's run started (ISO), null while it waits - the footer's
   *  "time left" subtracts the running step's elapsed from its ETA */
  started_at: string | null;
  /** catalog model label for the tree ("Wan 2.1", …) - null if uninstalled */
  model_label: string | null;
  /** Custom mode: the endpoint the user explicitly picked (null = planner's) */
  model_choice: string | null;
  /** effort level applied to the spec (null = endpoint defaults) */
  effort: string | null;
  /** Custom mode: same-output-kind picker options with fillable inputs */
  model_options: StepModelOption[];
  /** superseded specs, newest first - "earlier versions" with their outputs */
  revisions: StepRevision[];
}

export interface StepRevision {
  rev: number;
  outputs: unknown;
  job_id: string | null;
  created_at: string;
}

export interface RunView {
  id: string;
  status: string;
  title: string | null;
  session_id: string | null;
  project_id: string | null;
  mode: string;
  ask_first: boolean;
  estimate_credits: number;
  eta_seconds: number | null;
  /** planner route that produced the plan - null for literal plans (s6+) */
  via: string | null;
  /** planner fallback/error note recorded at submit - null when clean */
  planner_note: string | null;
  plan: Plan;
  steps: StepView[];
  created_at: string;
  updated_at: string;
}

/** Per-batch caches a view call shares: endpoint ETA medians, and the
 *  custom-mode picker ctx (one turnEndpoints + opt-in read per user - a
 *  session's run list and the SSE stream both reuse it, never re-query
 *  per-step/per-frame). */
export interface ViewShared {
  eta: Map<string, number | null>;
  custom: Map<string, { eps: LiveEndpoint[]; optIn: boolean }>;
}
export const newViewShared = (): ViewShared => ({ eta: new Map(), custom: new Map() });

/** catalog cost over stored params - throws go to a null so a bad legacy row
 *  can't wedge every view of the run */
const safeCost = (wf: LiveEndpoint["workflow"], params: Record<string, unknown>): number | null => {
  try { return Math.max(0, wf.cost({ ...params })); } catch { return null; }
};

async function toView(run: RunRow, steps: StepRow[], shared?: ViewShared): Promise<RunView> {
  const parsedPlan = PLAN.safeParse(run.plan ?? {});
  const plan: Plan = parsedPlan.success ? parsedPlan.data : { steps: [] };
  // ETA medians - a caller may share the cache (the SSE stream keeps one for
  // the stream's lifetime so long streams stop re-querying per frame)
  const etaCache = shared?.eta ?? new Map<string, number | null>();
  const etaOf = async (endpointId: string) => {
    if (!etaCache.has(endpointId)) etaCache.set(endpointId, await medianSeconds(endpointId).catch(() => null));
    return etaCache.get(endpointId) ?? null;
  };
  // Custom-mode steps carry their model picker - the option set is the run's
  // own mode allowlist, same output kind, media inputs the deps can feed.
  // The ctx computes once per user per batch - not once per step (C2).
  let pickerEps: LiveEndpoint[] | null = null;
  let optIn = false;
  if (run.mode === "custom") {
    const cache = shared?.custom;
    let ctx = cache?.get(run.user_id);
    if (!ctx) {
      ctx = { eps: await turnEndpoints("custom", run.user_id), optIn: await currentOptIn(run.user_id) };
      cache?.set(run.user_id, ctx);
    }
    pickerEps = ctx.eps;
    optIn = ctx.optIn;
  }
  const revRows = await sql<{
    step_id: string; rev: number; job_id: string | null; outputs: unknown; created_at: Date | string;
  }>(
    `SELECT step_id, rev, job_id, outputs, created_at
       FROM run_step_revisions WHERE run_id = $1 ORDER BY step_id, rev DESC`, [run.id]);
  const revisionsByStep = new Map<string, StepRevision[]>();
  for (const r of revRows) {
    const list = revisionsByStep.get(r.step_id) ?? [];
    list.push({
      rev: r.rev, outputs: r.outputs, job_id: r.job_id,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    });
    revisionsByStep.set(r.step_id, list);
  }
  return {
    id: run.id,
    status: run.status,
    title: plan.title ?? null,
    session_id: run.session_id,
    project_id: run.project_id,
    mode: run.mode,
    ask_first: run.ask_first,
    estimate_credits: Number(run.estimate_credits),
    eta_seconds: run.eta_seconds,
    via: run.via ?? null,
    planner_note: run.planner_note ?? null,
    plan,
    steps: await Promise.all(steps.map(async (s) => {
      const ep = findEndpoint(s.endpoint_id);
      const tool = ep ? null : toolForEndpoint(s.endpoint_id);
      // the endpoint median only applies at endpoint defaults - a step whose
      // effort knobs differ shows "ETA unknown", never a borrowed number;
      // builtin tool steps are job-less: 0 cr and no median at all
      const eta = tool ? null : await etaOf(s.endpoint_id);
      return {
        id: s.id,
        step_id: s.step_id,
        idx: s.idx,
        title: s.title,
        endpoint_id: s.endpoint_id,
        status: s.status,
        depends_on: s.depends_on,
        params: s.params,
        job_id: s.job_id,
        input_hash: s.input_hash,
        outputs: s.outputs,
        error: s.error,
        rev: s.rev ?? 0,
        cost: ep ? safeCost(ep.workflow, s.params) : tool ? 0 : null,
        eta_seconds: tool ? null : eta != null && ep && effortDiffers(ep.workflow, s.params) ? null : eta,
        started_at: s.started_at == null ? null
          : s.started_at instanceof Date ? s.started_at.toISOString() : String(s.started_at),
        model_label: ep?.model.label ?? tool?.name ?? null,
        model_choice: s.model_choice ?? null,
        effort: s.effort ?? null,
        model_options: pickerEps ? stepModelOptions(s, steps, pickerEps, optIn) : [],
        revisions: revisionsByStep.get(s.step_id) ?? [],
      };
    })),
    created_at: run.created_at instanceof Date ? run.created_at.toISOString() : String(run.created_at),
    updated_at: run.updated_at instanceof Date ? run.updated_at.toISOString() : String(run.updated_at),
  };
}

/** Cheap owner check - a route's 404 before it ticks/streams (and before
 *  any heavier getRunView). */
export async function ownsRun(userId: string, runId: string): Promise<boolean> {
  const [r] = await sql<{ id: string }>(
    `SELECT id FROM agent_runs WHERE id = $1 AND user_id = $2`, [runId, userId]);
  return !!r;
}

export async function getRunView(
  userId: string, runId: string, shared?: ViewShared,
): Promise<RunView | null> {
  const [run] = await sql<RunRow>(`SELECT * FROM agent_runs WHERE id = $1 AND user_id = $2`, [runId, userId]);
  if (!run) return null;
  const steps = await sql<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 ORDER BY idx`, [runId]);
  return toView(run, steps, shared);
}

/** A session's runs (newest first) - the poll payload for the plan cards.
 *  One ViewShared (eta medians + per-user picker ctx) serves the whole batch. */
export async function listSessionRuns(sessionId: string, limit = 10): Promise<RunView[]> {
  const runs = await sql<RunRow>(
    `SELECT * FROM agent_runs WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [sessionId, limit]);
  const shared = newViewShared();
  const out: RunView[] = [];
  for (const run of runs) {
    const steps = await sql<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 ORDER BY idx`, [run.id]);
    out.push(await toView(run, steps, shared));
  }
  return out;
}

/** Tick every live run bound to the session - one transition each. Paused
 *  runs tick too: an in-flight job still reconciles while nothing new submits. */
export async function tickSessionRuns(sessionId: string): Promise<void> {
  const runs = await sql<{ id: string }>(
    `SELECT id FROM agent_runs WHERE session_id = $1 AND status IN ('running','paused') ORDER BY created_at`,
    [sessionId]);
  for (const r of runs) await tickRun(r.id).catch(() => {});
}

/**
 * Validate + estimate + gate + persist a run. When `status` comes back
 * "running" the first step is already claimed (or being submitted) by the
 * kick tick - session-bound runs narrate themselves into agent_messages.
 */
export async function createRun(userId: string, input: {
  plan: unknown;
  sessionId?: string | null;
  mode?: RunMode;
  askFirst?: boolean;
  projectId?: string | null;
  /** which planner produced the plan ("built-in planner", "ollama·qwen3…") */
  via?: string;
  /** planner fallback/error note shown on the run node (LLM down → built-in) */
  plannerNote?: string | null;
  /** the brief's attachments + session last outputs - the literal-kind
   *  check resolves a media url's real file kind against them */
  atts?: { url: string; mime?: string; name?: string }[];
  lastOutputs?: Partial<Record<"image" | "video" | "audio", string>>;
}): Promise<RunView> {
  let mode: RunMode = input.mode ?? "auto";
  // the Settings Offline lock forces the narrowest mode - a posted mode
  // can't widen the net the user asked to keep closed
  if (await userOffline(userId).catch(() => false)) mode = "offline";
  if (input.sessionId) {
    const [s] = await sql<{ user_id: string }>(
      `SELECT user_id FROM agent_sessions WHERE id = $1`, [input.sessionId]);
    if (!s || s.user_id !== userId) throw new JobError("session not found", 404);
  }
  if (input.projectId) {
    const [p] = await sql<{ user_id: string }>(
      `SELECT user_id FROM projects WHERE id = $1`, [input.projectId]);
    if (!p || p.user_id !== userId) throw new JobError("project not found", 404);
  }
  const policy = await modePolicy(mode, userId);
  mode = policy.mode;
  const eps = policy.endpoints;
  const optIn = await currentOptIn(userId);
  // @ref names in media params resolve to the caller's own ref images before
  // validation - unknown/foreign refs refuse here (the session path asks first)
  const plan = await resolveAtRefs(userId, PLAN.parse(input.plan)); // strips extras; validatePlan already shape-checked
  const steps = validatePlan(plan, eps, {
    mode, optIn, atts: input.atts ?? [], lastOutputs: input.lastOutputs ?? {},
  }); // JobError(422) - plain wording
  const est = await estimateSteps(steps);

  const askFirst = !!input.askFirst;
  const needsApproval = policy.gate === "always" || askFirst || est.total > AUTO_APPROVE_CAP_CREDITS;
  const status = needsApproval ? "awaiting_approval" : "running";

  const [run] = await sql<RunRow>(
    `INSERT INTO agent_runs (user_id, session_id, project_id, mode, status, plan, estimate_credits, eta_seconds, ask_first, via, planner_note)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11) RETURNING *`,
    [
      userId, input.sessionId ?? null, input.projectId ?? null, mode, status,
      JSON.stringify(plan), String(est.total), est.etaSeconds, askFirst,
      input.via ?? null, input.plannerNote ?? null,
    ]);
  for (const [i, s] of steps.entries()) {
    await sql(
      `INSERT INTO run_steps (run_id, idx, step_id, title, endpoint_id, params, depends_on)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [run.id, i, s.stepId, s.title, s.endpointId, JSON.stringify(s.params), s.dependsOn]);
  }
  await emitEvent(run, "run_created", null, {
    title: plan.title ?? null, via: input.via ?? null,
    estimate_credits: est.total, eta_seconds: est.etaSeconds, steps: steps.length, status,
  });

  if (run.session_id) {
    const title = plan.title?.trim().slice(0, 120) || `Run ${steps.length} step${steps.length === 1 ? "" : "s"}`;
    const perStep = new Map(est.perStep.map((e) => [e.stepId, e]));
    await sql(
      `INSERT INTO agent_messages (session_id, role, kind, content) VALUES ($1,'assistant','plan',$2::jsonb)`,
      [run.session_id, JSON.stringify({
        run_id: run.id,
        text: `Plan: ${title} - ${steps.length} step${steps.length === 1 ? "" : "s"} · ${est.total} cr${est.etaSeconds != null ? ` · ~${est.etaSeconds}s` : " · ETA unknown"}`,
        title,
        via: input.via ?? null,
        status,
        estimate: { total: est.total, eta_seconds: est.etaSeconds },
        steps: steps.map((s) => ({
          id: s.stepId, title: s.title, endpoint_id: s.endpointId,
          cost: perStep.get(s.stepId)?.cost ?? s.cost,
          eta_seconds: perStep.get(s.stepId)?.etaSeconds ?? null,
        })),
      })]);
  }

  if (status === "running") await tickRun(run.id);
  return (await getRunView(userId, run.id))!;
}

/* ------------------ public surface for the WS1 worker/s8 (§5.5) ------------------ */

/** getRunView under the name the public API wraps. */
export const getRun = getRunView;

/** approve under the public name - owner-checked + idempotent via controlRun. */
export const approveRun = (userId: string, runId: string) => controlRun(userId, runId, "approve");

/** One tick for every live run (running + paused - a paused run's in-flight
 *  step still reconciles), oldest first - the worker calls this each loop.
 *  A run whose tick throws doesn't stop the sweep. Each ticked row is
 *  touched, so a run past `limit` isn't starved: oldest-updated-first order
 *  rotates ticked runs to the back of the next sweep. Sweeps chain through
 *  builtin tool leaves (chain=true) - a builtin-only plan completes in one
 *  pass instead of waiting a sweep per step. Returns how many runs were
 *  ticked. */
export async function tickRuns(limit = 20): Promise<number> {
  const runs = await sql<{ id: string }>(
    `SELECT id FROM agent_runs WHERE status IN ('running','paused') ORDER BY updated_at LIMIT $1`,
    [limit]);
  for (const r of runs) {
    await tickRun(r.id, true, true).catch(() => {});
    await sql(`UPDATE agent_runs SET updated_at = now() WHERE id = $1 AND status IN ('running','paused')`, [r.id])
      .catch(() => {});
  }
  return runs.length;
}

/* ------------------------------ run events (B4) --------------------------- */

export interface RunEvent {
  seq: number;
  kind: string;
  step_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

/** Owner-scoped event list for the SSE route - null when the run isn't the
 *  caller's. `afterSeq` resumes a stream (events are seq-ordered). */
export async function listRunEvents(
  userId: string, runId: string, afterSeq = 0, limit = 500,
): Promise<RunEvent[] | null> {
  const [run] = await sql<{ id: string }>(
    `SELECT id FROM agent_runs WHERE id = $1 AND user_id = $2`, [runId, userId]);
  if (!run) return null;
  const rows = await sql<{ seq: string | number; kind: string; step_id: string | null; payload: unknown; created_at: Date | string }>(
    `SELECT seq, kind, step_id, payload, created_at FROM run_events
      WHERE run_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [runId, afterSeq, limit]);
  return rows.map((r) => ({
    seq: Number(r.seq),
    kind: r.kind,
    step_id: r.step_id,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}
