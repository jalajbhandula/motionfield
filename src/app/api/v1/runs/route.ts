import { NextRequest } from "next/server";
import { z } from "zod";
import { sql } from "@/db";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err, v1error } from "@/lib/api/v1";
import { hashMismatch, isValidIdempotencyKey } from "@/lib/api/idempotency";
import {
  findRunIdem, finishRunIdem, hashRunRequest, readBodyCapped,
  releaseRunIdem, reserveRunIdem, runInputs, runViewV1, skillPlan,
} from "@/lib/api/runs-v1";
import {
  createRun, getRunView,
  deterministicPlan, llmPlan, parsePlannerPick, BUILTIN_PLANNER,
  modePolicy, PLAN, type Plan, type PlanTurn,
} from "@/lib/runs";
import { skillById } from "@/lib/catalog/skills";
import { llmConfigured, LlmUnavailable } from "@/lib/llm/index";
import { resolveExplicitRoute } from "@/lib/llm/settings";
import { resolveRefsInText } from "@/lib/agent/tools/refs";
import type { ResolvedRoute } from "@/lib/llm/router";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 1024 * 1024;

const RunCreate = z.object({
  plan: PLAN.optional(),
  text: z.string().trim().min(1).max(8000).optional(),
  /** planner route: "builtin" or "<provider>:<model>" - text runs only */
  planner: z.string().min(1).max(200).optional(),
  skill: z.string().min(1).max(80).optional(),
  brief: z.string().trim().min(1).max(8000).optional(),
  answers: z.record(z.string().max(80), z.string().max(2000)).optional(),
  /** uploaded media the plan can fill (skill media slots, planner briefs) -
   *  /files/ urls only, everything else is dropped before planning */
  inputs: z.array(z.object({
    url: z.string().min(1),
    mime: z.string().optional(),
  })).max(8).optional(),
  mode: z.enum(["auto", "offline"]).optional(),
  ask_first: z.boolean().optional(),
  project_id: z.string().uuid().nullable().optional(),
}).superRefine((b, ctx) => {
  const forms = [b.plan !== undefined, b.text !== undefined, b.skill !== undefined]
    .filter(Boolean).length;
  if (forms !== 1)
    ctx.addIssue({ code: "custom", message: "body needs exactly one of plan, text or skill" });
  if (b.skill !== undefined && b.brief === undefined)
    ctx.addIssue({ code: "custom", message: "skill runs need a brief" });
  if (b.skill === undefined && (b.brief !== undefined || b.answers !== undefined))
    ctx.addIssue({ code: "custom", message: "brief/answers only apply to skill runs" });
  if (b.text === undefined && b.planner !== undefined)
    ctx.addIssue({ code: "custom", message: "planner only applies to text runs" });
  if (b.plan !== undefined && b.inputs !== undefined)
    ctx.addIssue({ code: "custom", message: "inputs only apply to text and skill runs" });
});

/** Turn a planner answer into a plan or the refusal it answered with -
 *  the same 422s the session route returns for ask/status/none turns. */
function turnOutcome(turn: PlanTurn):
  { plan: Plan; via?: string } | { refuse: string } {
  if (turn.kind === "plan") return { plan: turn.plan, via: turn.via };
  if (turn.kind === "ask") return { refuse: turn.question };
  if (turn.kind === "status") return { refuse: turn.text };
  return { refuse: "couldn't turn that brief into a plan - try naming a task (video, image, restyle…)" };
}

/**
 * POST /api/v1/runs - exactly one of:
 *   { plan }                        a literal plan (same shape the app takes)
 *   { text, planner? }              a brief through the same planner pick
 *   { skill, brief, answers? }      a catalog skill's steps as the plan
 * plus inputs (uploaded media for skill/planner media slots), mode
 * (auto|offline), ask_first, project_id.
 * Idempotency-Key works like POST /jobs, with one difference: the ledger row
 * is RESERVED before planning (planner calls can take minutes), so a
 * concurrent same-key request sees the in-flight reservation and gets 409
 * idempotency_in_progress + Retry-After instead of minting a second run.
 * Same key + same body replays the recorded run (200); a different body is
 * 422 idempotency_mismatch.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;

    const raw = await readBodyCapped(req, MAX_BODY_BYTES);
    if (raw === "too_large")
      return v1error("payload_too_large", "request body too large (1MB max)", 413);
    if (raw === "unreadable")
      return v1error("bad_request", "body must be JSON: { plan } | { text, planner? } | { skill, brief, answers? }", 400);
    let jsonBody: unknown = null;
    try { jsonBody = JSON.parse(raw.text); } catch { /* handled below */ }
    const parsed = RunCreate.safeParse(jsonBody);
    if (!parsed.success)
      return v1error("bad_request",
        parsed.error.issues[0]?.message ?? "body must be JSON: { plan } | { text, planner? } | { skill, brief, answers? }",
        400);
    const b = parsed.data;

    const idemKey = req.headers.get("idempotency-key")?.trim() || null;
    if (idemKey && !isValidIdempotencyKey(idemKey))
      return v1error("bad_request", "Idempotency-Key must be 1-255 printable ASCII characters", 400);
    const requestHash = idemKey ? hashRunRequest(b) : null;

    // Reserve the key BEFORE any planning - a planner call can outlive the
    // caller's own timeout, so the row must exist while this request works.
    let reserved = false;
    if (idemKey && requestHash) {
      reserved = await reserveRunIdem(auth.userId, idemKey, requestHash);
      if (!reserved) {
        const prev = await findRunIdem(auth.userId, idemKey);
        if (!prev || prev.run_id === null)
          return v1error("idempotency_in_progress",
            "a request with this idempotency key is still being processed - retry shortly",
            409, { "Retry-After": "2" });
        if (hashMismatch(prev.request_hash, requestHash))
          return v1error("idempotency_mismatch", "Idempotency-Key was already used with a different request payload", 422);
        const view = await getRunView(auth.userId, prev.run_id);
        if (!view) return v1error("not_found", "run not found", 404);
        return v1json(await runViewV1(view), 200);
      }
    }

    let resolved = false;
    try {
      // the app lane's same ownership check before any planner call is spent
      if (b.project_id) {
        const [prj] = await sql<{ id: string }>(
          "SELECT id FROM projects WHERE id = $1 AND user_id = $2", [b.project_id, auth.userId]);
        if (!prj) return v1error("not_found", "project not found", 404);
      }

      const atts = runInputs(b.inputs);
      let plan: Plan | null = b.plan ?? null;
      let via: string | undefined;
      let fallbackReason: string | null = null;

      if (!plan && b.text !== undefined) {
        /* The app route's planner pick: an explicit "<provider>:<model>" route
         * when it resolves (and is legal in this mode), else the configured
         * planner, else the built-in one - with the failure recorded on the
         * run as planner_note instead of silently rerouting. */
        const policy = await modePolicy(b.mode ?? "auto", auth.userId);
        const eps = policy.endpoints;
        let pickedRoute: ResolvedRoute | null = null;
        const forceBuiltin = b.planner === BUILTIN_PLANNER;
        if (b.planner && !forceBuiltin) {
          try {
            const { providerId, model } = parsePlannerPick(b.planner);
            const route = await resolveExplicitRoute(auth.userId, providerId, model);
            if (policy.llmRouteOk(route)) pickedRoute = route;
            else fallbackReason = `planner "${b.planner}" needs a remote route - ${policy.mode} only uses local models`;
          } catch (e) {
            fallbackReason = `planner "${b.planner}" unavailable - ${e instanceof Error ? e.message : e}`;
          }
        }
        // @ref names in the brief pull the caller's own ref images into the
        // attachable set - the same resolution the app route applies: an
        // unknown name refuses plainly, and only stored /files/ images can
        // ever reach the planner's media list
        const refs = await resolveRefsInText(auth.userId, b.text);
        if (refs.missing.length)
          return v1error("unprocessable_entity",
            `no ref named @${refs.missing[0]} - create it under Refs first`, 422);
        atts.push(...refs.refs.flatMap((r) =>
          r.images.filter((u) => u.startsWith("/files/")).slice(0, 3)
            .map((url) => ({ url, mime: "image/*" }))));

        if (!forceBuiltin && (pickedRoute || (await llmConfigured(auth.userId, "planner")))) {
          try {
            const out = turnOutcome(await llmPlan(
              auth.userId, b.text, atts, {}, eps, policy.mode === "offline",
              pickedRoute
                ? { route: pickedRoute, refs: refs.refs, projectId: b.project_id ?? null }
                : { refs: refs.refs, projectId: b.project_id ?? null }));
            if ("refuse" in out) return v1error("unprocessable_entity", out.refuse, 422);
            plan = out.plan; via = out.via;
          } catch (e) {
            fallbackReason ??= e instanceof LlmUnavailable
              ? e.message
              : `planner failed: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        if (!plan) {
          const out = turnOutcome(deterministicPlan(b.text, atts, {}, eps, policy.mode, refs.refs));
          if ("refuse" in out) return v1error("unprocessable_entity", out.refuse, 422);
          plan = out.plan; via = out.via;
        }
      } else if (!plan && b.skill !== undefined) {
        const skill = skillById(b.skill);
        if (!skill) return v1error("not_found", `no skill ${b.skill}`, 404);
        if (b.brief === undefined) // unreachable per schema - kept honest
          return v1error("bad_request", "skill runs need a brief", 400);
        plan = skillPlan(skill, b.brief, b.answers, atts);
        via = `skill·${skill.id}`;
      }

      const view = await createRun(auth.userId, {
        plan,
        mode: b.mode,
        askFirst: b.ask_first,
        projectId: b.project_id ?? null,
        via,
        plannerNote: fallbackReason,
      });

      // a ledger write that fails AFTER createRun must not 500 the create -
      // the run is real; the reservation just stays NULL, so a same-key
      // retry answers 409 for 10 minutes (reserveRunIdem reclaims stale NULL
      // rows past that) instead of minting a second run
      if (idemKey) await finishRunIdem(auth.userId, idemKey, view.id).catch(() => {});
      resolved = true;
      return v1json(await runViewV1(view), 201);
    } finally {
      // any non-success exit - error return or throw - frees the reserved key
      // (only a still-NULL reservation can be ours)
      if (!resolved && reserved && idemKey)
        await releaseRunIdem(auth.userId, idemKey).catch(() => {});
    }
  } catch (e) {
    return v1err(e);
  }
}
