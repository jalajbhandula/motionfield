import { z } from "zod";
import { getDb, schema } from "@/db";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { JobError } from "@/lib/jobs";
import { findEndpoint } from "@/lib/catalog/video-models";
import { llmConfigured, resolveRoute, unloadLocalModel, type ResolvedRoute } from "@/lib/llm/index";
import { LlmUnavailable } from "@/lib/llm";
import { resolveExplicitRoute, userOffline } from "@/lib/llm/settings";
import {
  attKind, builtinIntentPlan, controlRun, createRun, deterministicPlan, extractPrompt, llmPlan,
  modePolicy, parsePlannerPick, tickSessionRuns, turnEndpoints,
  type Plan,
} from "@/lib/runs";
import { resolveRefsInText } from "@/lib/agent/tools/refs";
import { JOB_KIND_OUTPUT } from "@/lib/generation/types";
import { sql } from "@/db";

/**
 * Assistant agent - async session protocol.
 * Contract: POST sessions -> POST messages (async) -> GET messages?after=<seq>
 * -> POST interrupt. Session status reaches `awaiting_input` when the planner
 * needs a user answer before continuing (mirrors the observed protocol).
 *
 * Step 4: planner turns produce a Plan that becomes a durable run
 * (src/lib/runs) - estimate + ETA on the card, approve gate, sequential
 * steps, Stop. The engine owns jobs; this file owns the session protocol.
 */

export type Attachment = { url: string; mime?: string; name?: string };

const AgentCtxSchema = z.object({
  mode: z.enum(["auto", "offline", "custom"]).optional(),
  /** approval gate for the session - the page sends it with each message */
  askFirst: z.boolean().optional(),
  /** planner picker choice: "builtin" or "<providerId>:<model>" (s5) */
  planner: z.string().max(200).optional(),
  pendingTool: z.object({
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
    needs: z.array(z.string()),
  }).optional(),
  /** last completed output url per media kind - feeds chained steps.
   *  partialRecord, not record: z.record(enum) is exhaustive in zod 4 - a ctx
   *  holding only {image} failed the whole parse and patchCtx wrote back a
   *  context with lastOutputs (and pendingTool) silently dropped. */
  lastOutputs: z.partialRecord(z.enum(["image", "video", "audio"]), z.string()).optional(),
  /** the working checklist - the planner refreshes it each turn; the page
   *  renders it above the composer and the user can tick items (T5) */
  todo: z.object({
    items: z.array(z.object({ text: z.string(), done: z.boolean() })).max(50),
  }).optional(),
}).catchall(z.unknown()); // tolerate forward-compatible extras

export type AgentCtx = z.infer<typeof AgentCtxSchema>;

function normalizeCtx(raw: unknown): AgentCtx {
  const parsed = AgentCtxSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/** Read-modify-write the session context (avoids clobbering interleaved writes). */
async function patchCtx(sessionId: string, patch: (ctx: AgentCtx) => void) {
  const db = await getDb();
  const [s] = await db.select({ context: schema.agentSessions.context })
    .from(schema.agentSessions).where(eq(schema.agentSessions.id, sessionId)).limit(1);
  const ctx = normalizeCtx(s?.context);
  patch(ctx);
  await db.update(schema.agentSessions)
    .set({ context: ctx as never, updatedAt: new Date() })
    .where(eq(schema.agentSessions.id, sessionId));
  return ctx;
}

async function addMessage(sessionId: string, role: string, kind: string, content: Record<string, unknown>) {
  const db = await getDb();
  const [m] = await db.insert(schema.agentMessages).values({
    sessionId, role, kind, content: content as never,
  }).returning();
  return { ...m, seq: Number(m.seq) };
}

export async function createSession(userId: string, opts: { title?: string; projectId?: string; mode?: "auto" | "offline" | "custom" } = {}) {
  const db = await getDb();
  // a session only binds to the caller's OWN project - the check runs before
  // any row exists, so a foreign project id can't even write a session
  if (opts.projectId) {
    const [p] = await sql<{ user_id: string }>(
      `SELECT user_id FROM projects WHERE id = $1`, [opts.projectId]);
    if (!p || p.user_id !== userId) throw new JobError("project not found", 404);
  }
  // a saved Offline pref (or MOTIONFIELD_OFFLINE=1) starts new sessions offline -
  // the page sends the mode on every message anyway, this just sets the default
  const mode = opts.mode ?? ((await userOffline(userId).catch(() => false)) ? "offline" as const : undefined);
  const [s] = await db.insert(schema.agentSessions).values({
    userId,
    title: opts.title ?? null,
    projectId: opts.projectId ?? null,
    context: (mode ? { mode } : {}) as never,
  }).returning();
  await addMessage(s.id, "system", "status", { text: "session_started", status: "active" });
  return s;
}

export async function getSession(userId: string, sessionId: string) {
  const db = await getDb();
  const [s] = await db.select().from(schema.agentSessions)
    .where(and(eq(schema.agentSessions.id, sessionId), eq(schema.agentSessions.userId, userId))).limit(1);
  return s ?? null;
}

export async function listSessions(userId: string) {
  const db = await getDb();
  return db.select().from(schema.agentSessions)
    .where(eq(schema.agentSessions.userId, userId))
    .orderBy(asc(schema.agentSessions.createdAt)).limit(50);
}

export async function getMessages(sessionId: string, after?: number) {
  const db = await getDb();
  const rows = await db.select().from(schema.agentMessages)
    .where(and(
      eq(schema.agentMessages.sessionId, sessionId),
      after !== undefined ? gt(schema.agentMessages.seq, BigInt(after)) : undefined,
    ))
    .orderBy(asc(schema.agentMessages.seq)).limit(200);
  return rows.map((m: typeof schema.agentMessages.$inferSelect) => ({ ...m, seq: Number(m.seq) }));
}

/** Live (queued/in-progress) jobs owned by the session - for UI progress cards. */
export async function liveSessionJobs(sessionId: string) {
  const db = await getDb();
  // the job behind any running run step
  const runJobs = await sql<{ job_id: string }>(
    `SELECT rs.job_id FROM run_steps rs
       JOIN agent_runs ar ON ar.id = rs.run_id
      WHERE ar.session_id = $1 AND rs.status = 'running' AND rs.job_id IS NOT NULL`,
    [sessionId]);
  const ids = [...new Set(runJobs.map((r) => r.job_id))];
  if (!ids.length) return [];
  return db.select({
    id: schema.jobs.id, status: schema.jobs.status, progress: schema.jobs.progress,
    endpointId: schema.jobs.endpointId, kind: schema.jobs.kind,
  }).from(schema.jobs).where(inArray(schema.jobs.id, ids));
}

/** The user ticking checklist items - same ctx the todo tool writes (T5). */
export async function setSessionTodo(
  userId: string, sessionId: string, items: { text: string; done: boolean }[],
): Promise<void> {
  const s = await getSession(userId, sessionId);
  if (!s) throw new JobError("session not found", 404); // another user's session is a write wall
  await patchCtx(sessionId, (c) => {
    const byText = new Map(items.map((i) => [i.text, i.done]));
    c.todo = {
      items: (c.todo?.items ?? [])
        .filter((i) => byText.has(i.text))
        .map((i) => ({ text: i.text, done: byText.get(i.text) ?? i.done })),
    };
  });
}

export async function interruptSession(userId: string, sessionId: string) {
  const db = await getDb();
  const s = await getSession(userId, sessionId);
  if (!s) return null;
  const ctx = normalizeCtx(s.context);
  // stop every live run - cancelJob refunds the in-flight step's job
  const runs = await sql<{ id: string }>(
    `SELECT id FROM agent_runs WHERE session_id = $1 AND status NOT IN ('done','failed','stopped')`,
    [sessionId]);
  for (const r of runs) await controlRun(userId, r.id, "stop").catch(() => {});
  // session ended - release the planner model's VRAM (local ollama only);
  // a picked route unloads too when it's the local one that planned
  const picked = ctx.planner && ctx.planner !== "builtin"
    ? (() => { try { return parsePlannerPick(ctx.planner!); } catch { return null; } })()
    : null;
  (picked
    ? resolveExplicitRoute(userId, picked.providerId, picked.model)
    : resolveRoute("planner", userId)
  ).then((r) => unloadLocalModel(r)).catch(() => {});
  ctx.pendingTool = undefined;
  await db.update(schema.agentSessions)
    .set({ status: "interrupted", context: ctx as never, updatedAt: new Date() })
    .where(eq(schema.agentSessions.id, sessionId));
  await addMessage(sessionId, "system", "status", { text: "interrupted - remaining steps cancelled", status: "interrupted" });
  return { ...s, status: "interrupted" };
}

/** Post a user message then run one planner turn (async in the same tick).
 *  `plan:false` records the brief without a turn - used by skill runs, which
 *  submit their own pre-built plan to /api/agent/runs right after. */
export async function postUserMessage(
  userId: string, sessionId: string, text: string,
  attachments: Attachment[] = [], mode?: "auto" | "offline" | "custom", askFirst?: boolean,
  opts: { plan?: boolean; planner?: string; projectId?: string | null } = {},
) {
  const s = await getSession(userId, sessionId);
  if (!s) throw new JobError("session not found", 404);
  if (s.status === "interrupted") throw new JobError("session interrupted - start a new one", 409);
  // an explicit project binding is owner-checked BEFORE any write - a 404
  // leaves the feed untouched
  if (opts.projectId) {
    const [p] = await sql<{ user_id: string }>(
      `SELECT user_id FROM projects WHERE id = $1`, [opts.projectId]);
    if (!p || p.user_id !== userId) throw new JobError("project not found", 404);
  }
  // the page sends mode + ask-first + planner pick on every message - a
  // header change takes effect on the very next turn without session rows
  if (mode || askFirst !== undefined || opts.planner !== undefined) await patchCtx(sessionId, (c) => {
    if (mode) c.mode = mode;
    if (askFirst !== undefined) c.askFirst = askFirst;
    if (opts.planner !== undefined) c.planner = opts.planner || undefined;
  });
  const atts = attachments.filter((a) => a && typeof a.url === "string" && a.url.startsWith("/files/"));
  const msg = await addMessage(sessionId, "user", "text", { text, ...(atts.length ? { attachments: atts } : {}) });
  const db = await getDb();
  // resume from awaiting_input on new user input + title the session from the first brief
  const upd: Record<string, unknown> = { updatedAt: new Date() };
  if (s.status === "awaiting_input") upd.status = "active";
  if (!s.title) upd.title = text.trim().slice(0, 60);
  await db.update(schema.agentSessions).set(upd).where(eq(schema.agentSessions.id, sessionId));
  if (opts.plan !== false) await runPlannerTurn(userId, sessionId, text, atts, opts.projectId).catch(async (e) => {
    await addMessage(sessionId, "system", "status", { text: `planner_error: ${e instanceof Error ? e.message : e}` });
  });
  return msg;
}

/* ------------------------------------------------------------------ */
/* Planner turn - LLM (chatJson PLAN) or the deterministic table - both */
/* end at createRun; the run engine owns execution from there.          */

async function narratePlanFailure(sessionId: string, prefix: string, e: unknown) {
  if (e instanceof JobError) {
    await addMessage(sessionId, "system", "status", { text: `${prefix}: ${e.message}` });
  }
}

/** A plan refusal the user can read - emitted as a tool_result + status, never thrown. */
async function submitRunPlan(
  userId: string, sessionId: string, plan: Plan, ctx: AgentCtx,
  opts: { via?: string; projectId?: string | null; plannerRoute?: ResolvedRoute | null; plannerNote?: string | null;
          atts?: Attachment[] } = {},
) {
  try {
    await createRun(userId, {
      plan, sessionId, mode: ctx.mode ?? "auto", askFirst: ctx.askFirst,
      projectId: opts.projectId ?? null, via: opts.via, plannerNote: opts.plannerNote,
      atts: opts.atts ?? [], lastOutputs: ctx.lastOutputs ?? {},
    });
    // the checklist mirrors the accepted plan - the page renders it above the
    // composer and the agent refreshes it each turn (T5). A plan carrying its
    // own todo step writes the real checklist when it runs - the mirror must
    // not clobber it with plan titles afterwards.
    if (!plan.steps.some((s) => s.endpoint_id === "agent/todo")) {
      await patchCtx(sessionId, (c) => {
        c.todo = { items: plan.steps.map((s) => ({ text: s.title, done: false })) };
      });
    }
  } catch (e) {
    if (!(e instanceof JobError)) throw e;
    await addMessage(sessionId, "tool", "tool_result", { tool: "run_plan", error: e.message, via: opts.via ?? null });
    await narratePlanFailure(sessionId, "plan_error", e);
    return;
  }
  // a media run just got a job - release the planner model's local VRAM
  // (the picker's explicit route unloads too when it's the local one used)
  const kinds = new Set(plan.steps.map((s) => JOB_KIND_OUTPUT[findEndpoint(s.endpoint_id)?.workflow.kind ?? "image"]));
  if (kinds.has("image") || kinds.has("video")) {
    const route = opts.plannerRoute ?? await resolveRoute("planner", userId).catch(() => null);
    if (route) await unloadLocalModel(route);
  }
}

async function runPlannerTurn(userId: string, sessionId: string, text: string, atts: Attachment[] = [], projectId?: string | null) {
  const db = await getDb();
  const [s] = await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, sessionId)).limit(1);
  const ctx = normalizeCtx(s?.context);
  // the effective project for this turn - an explicit binding wins, else the
  // session's own; memory retrieval + project instructions scope to it
  const projId = projectId ?? s?.projectId ?? null;

  // Resume path: we were awaiting input for a pending tool call.
  if (ctx.pendingTool) {
    const pending = ctx.pendingTool;
    const params = { ...((pending.args.params ?? {}) as Record<string, unknown>) };
    const prompt = extractPrompt(text) ?? (text.trim().length >= 10 ? text.trim() : null);
    if (pending.needs.includes("prompt") && prompt) {
      params.prompt = prompt;
      pending.needs = pending.needs.filter((n) => n !== "prompt");
    }
    for (const media of ["video", "image", "audio"] as const) {
      if (pending.needs.includes(media)) {
        const url = atts.find((a) => attKind(a) === media)?.url ?? ctx.lastOutputs?.[media];
        if (url) {
          params[`${media}_url`] = url;
          pending.needs = pending.needs.filter((n) => n !== media);
        }
      }
    }
    pending.args.params = params;
    if (pending.needs.length === 0) {
      await patchCtx(sessionId, (c) => { c.pendingTool = undefined; });
      const endpointId = String(pending.args.endpoint_id ?? "");
      const label = findEndpoint(endpointId)?.workflow.label ?? endpointId;
      await submitRunPlan(userId, sessionId, {
        title: `Run ${label}`,
        steps: [{ id: "s1", title: label, endpoint_id: endpointId, params, depends_on: [] }],
      }, ctx, { via: "built-in planner", projectId: projId, atts });
      return;
    }
    await patchCtx(sessionId, (c) => { c.pendingTool = pending; });
    await addMessage(sessionId, "assistant", "question", {
      question: `Still need: ${pending.needs.join(", ")} - describe it or attach a file.`,
      status: "awaiting_input",
      via: "built-in planner",
    });
    return;
  }

  const eps = await turnEndpoints(ctx.mode, userId);
  const policy = await modePolicy(ctx.mode ?? "auto", userId);

  // @refs - "@name" resolves only to the caller's own refs; an unknown name
  // asks first ("no ref named @x"), never guesses (T8)
  const resolved = await resolveRefsInText(userId, text);
  if (resolved.missing.length) {
    await db.update(schema.agentSessions).set({ status: "awaiting_input" }).where(eq(schema.agentSessions.id, sessionId));
    await addMessage(sessionId, "assistant", "question", {
      question: `I don't have a ref named @${resolved.missing[0]} - create it under Refs, or describe what to make without it.`,
      status: "awaiting_input",
      via: "built-in planner",
    });
    return;
  }
  for (const r of resolved.refs) {
    // only stored /files/ images join the attachable set - a ref row pointing
    // anywhere else never reaches the planner's media list
    for (const url of r.images.filter((u) => u.startsWith("/files/")).slice(0, 3)) {
      atts.push({ url, mime: "image/*", name: `@${r.name}` });
    }
  }

  // llmConfigured is per-user and task-scoped: an env route for "planner" OR
  // a saved llm_task_routes row for this session's owner. Offline sessions
  // still try a loopback route - a remote one throws OfflineBlocked and lands
  // in the fallback branch. A picked route ("<provider>:<model>") overrides;
  // "builtin" skips the LLM entirely. A pick that fails to resolve is
  // narrated, not silently honored - and a pick the mode's llmRouteOk refuses
  // (a remote route in Offline) fails the same way, before any network call.
  // only memory phrasings skip the model - "remember …", "save this as
  // NAME", "forget memory NAME" run the intent table's memory slice BEFORE
  // any model call: a planner route can never reroute or drop a memory
  // write, and a stubbed/flaky LLM can't eat the phrasing either. Every
  // other builtin phrasing (fetch/search/jot/refs/catalog) reaches the
  // model first; deterministicPlan's full table still answers them when no
  // LLM is configured or planner=builtin.
  let turn = builtinIntentPlan(text, { atts, lastOutputs: ctx.lastOutputs ?? {} }, { memoryOnly: true });
  let plannerRoute = null as Awaited<ReturnType<typeof resolveExplicitRoute>> | null;
  let plannerNote: string | null = null;
  const forceBuiltin = ctx.planner === "builtin";
  if (!forceBuiltin && ctx.planner) {
    try {
      const pick = parsePlannerPick(ctx.planner);
      const route = await resolveExplicitRoute(userId, pick.providerId, pick.model);
      if (policy.llmRouteOk(route)) plannerRoute = route;
      else {
        plannerNote = `planner "${ctx.planner}" needs a remote route - ${policy.mode} only uses local models`;
        await addMessage(sessionId, "system", "status",
          { text: `planner_error: ${plannerNote}` });
      }
    } catch (e) {
      plannerNote = `planner "${ctx.planner}" unavailable - ${e instanceof Error ? e.message : e}; used the configured route`;
      await addMessage(sessionId, "system", "status",
        { text: `planner_error: ${plannerNote}` });
    }
  }
  if (!turn && !forceBuiltin && (plannerRoute || await llmConfigured(userId, "planner"))) {
    try {
      turn = await llmPlan(userId, text, atts, ctx.lastOutputs ?? {}, eps, ctx.mode === "offline",
        plannerRoute ? { route: plannerRoute, refs: resolved.refs, projectId: projId } : { refs: resolved.refs, projectId: projId });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      plannerNote = m;
      await addMessage(sessionId, "system", "status", { text: `llm_error: ${m}` });
      if (e instanceof LlmUnavailable && ctx.mode !== "offline")
        await addMessage(sessionId, "assistant", "text", { text: `${m} - using the built-in planner meanwhile.`, via: "built-in planner" });
    }
  }
  if (!turn) {
    if (ctx.mode === "offline")
      await addMessage(sessionId, "assistant", "text", { text: "offline: using the built-in planner", via: "built-in planner" });
    turn = deterministicPlan(text, atts, ctx.lastOutputs ?? {}, eps, ctx.mode, resolved.refs);
  }

  if (turn.kind === "plan") {
    await submitRunPlan(userId, sessionId, turn.plan, ctx, { via: turn.via, projectId: projId, plannerRoute, plannerNote, atts });
    return;
  }
  if (turn.kind === "ask") {
    await db.update(schema.agentSessions).set({ status: "awaiting_input" }).where(eq(schema.agentSessions.id, sessionId));
    await addMessage(sessionId, "assistant", "question", {
      question: turn.question,
      ...(turn.options?.length ? { options: turn.options } : {}),
      ...(turn.fields ? { fields: turn.fields } : {}),
      status: "awaiting_input",
      via: "built-in planner",
    });
    if (turn.pending) await patchCtx(sessionId, (c) => { c.pendingTool = turn.pending; });
    return;
  }
  if (turn.kind === "status") {
    await addMessage(sessionId, "system", "status", { text: turn.text });
    return;
  }
  // none - an ambiguous brief asks with up to 3 suggested app briefs as chips
  // (tool suggestion); a tap sends the option as the next brief (T5)
  await db.update(schema.agentSessions).set({ status: "awaiting_input" }).where(eq(schema.agentSessions.id, sessionId));
  await addMessage(sessionId, "assistant", "question", {
    question: "What should we make? Pick one, or describe it - video, image, restyle, shot chains.",
    ...(turn.options?.length ? { options: turn.options } : {}),
    status: "awaiting_input",
    via: "built-in planner",
  });
}

/* ------------------------------------------------------------------ */
/* Lazy ticking - the run engine owns execution; each session poll ticks */
/* the session's live runs once.                                        */
/* ------------------------------------------------------------------ */

export async function tickSession(sessionId: string) {
  await tickSessionRuns(sessionId);
}
