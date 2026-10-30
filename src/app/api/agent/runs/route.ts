import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { sql } from "@/db";
import { llmConfigured, LlmUnavailable } from "@/lib/llm/index";
import { JobError } from "@/lib/jobs";
import { resolveExplicitRoute, userOffline } from "@/lib/llm/settings";
import { resolveRefsInText } from "@/lib/agent/tools/refs";
import {
  builtinIntentPlan, createRun, deterministicPlan, llmPlan, modePolicy, parsePlannerPick,
  turnEndpoints, PLAN, type Plan,
} from "@/lib/runs";

export const runtime = "nodejs";

/**
 * POST /api/agent/runs - validate + estimate + gate + persist a run.
 * Body: either a literal `plan` (validated here) or `text` (planned like a
 * session turn: LLM chatJson first, deterministic table as fallback -
 * a turn that can't produce a plan answers 422, plainly).
 * Session-bound runs narrate into the session feed; every run is durable.
 */
const Attachment = z.object({
  url: z.string().min(1).max(2048),
  mime: z.string().max(100).optional(),
  name: z.string().max(255).optional(),
});
const RunPost = z.object({
  session_id: z.string().uuid().optional(),
  text: z.string().max(8000).optional(),
  attachments: z.array(Attachment).max(8).optional(),
  mode: z.enum(["auto", "offline", "custom"]).optional(),
  ask_first: z.boolean().optional(),
  plan: PLAN.optional(),
  project_id: z.string().uuid().nullable().optional(),
  /** planner picker: "builtin" or "<providerId>:<model>" (text runs only) */
  planner: z.string().max(200).optional(),
}).refine((b) => !!b.plan || !!b.text?.trim(), { message: "send a plan or a brief" });

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const parsed = RunPost.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const b = parsed.data;

    // session + project ownership are checked before ANY planning or feed
    // write - a failed planner narrates into the session, so the gates can't
    // wait for createRun's own checks
    let sessionProjectId: string | null = null;
    let lastOutputs: Partial<Record<"image" | "video" | "audio", string>> = {};
    if (b.session_id) {
      const [s] = await sql<{ user_id: string; project_id: string | null; context: unknown }>(
        `SELECT user_id, project_id, context FROM agent_sessions WHERE id = $1`, [b.session_id]);
      if (!s || s.user_id !== user.id) return json({ error: "session not found" }, 404);
      sessionProjectId = s.project_id;
      // a bare "save this as NAME" on a bound session resolves the session's
      // last-output url the same way the chat path does
      const ctx = z.looseObject({
        lastOutputs: z.partialRecord(z.enum(["image", "video", "audio"]), z.string()).optional(),
      }).safeParse(s.context ?? {});
      if (ctx.success) lastOutputs = ctx.data.lastOutputs ?? {};
    }
    if (b.project_id) {
      const [p] = await sql<{ user_id: string }>(
        `SELECT user_id FROM projects WHERE id = $1`, [b.project_id]);
      if (!p || p.user_id !== user.id) return json({ error: "project not found" }, 404);
    }
    // memory retrieval + project instructions scope to the run's effective
    // project - an explicit project_id wins, else the bound session's
    const effProjectId = b.project_id ?? sessionProjectId;

    let plan: Plan | null = b.plan ?? null;
    let via: string | undefined;
    let fallbackReason: string | null = null;
    let usage = null as { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
    // the Settings Offline lock narrows the posted mode once - every planner
    // surface (endpoints, route policy, the plan itself) uses the same
    // effective mode; createRun coerces it again for the stored row (C1)
    const effMode = (await userOffline(user.id)) ? "offline" : (b.mode ?? "auto");
    // the brief's attachments - text planning uses them for media params;
    // a posted plan still gets them for the literal-file kind check
    const atts = (b.attachments ?? []).filter((a) => a.url.startsWith("/files/"));
    if (!plan) {
      // the refine guarantees a brief when no plan was posted
      const text = (b.text ?? "").trim();
      const eps = await turnEndpoints(effMode, user.id);
      let turn = null as Awaited<ReturnType<typeof llmPlan>> | null;
      // planner pick: "builtin" forces the deterministic table; a
      // "<provider>:<model>" pick resolves to an explicit route - a bad pick
      // is visible (fallback_reason), never silently honored; a pick the
      // mode's llmRouteOk refuses (remote in Offline) fails the same way,
      // before any network call
      const forceBuiltin = b.planner === "builtin";
      const policy = await modePolicy(effMode, user.id);
      let pickedRoute = null as Awaited<ReturnType<typeof resolveExplicitRoute>> | null;
      if (!forceBuiltin && b.planner) {
        try {
          const pick = parsePlannerPick(b.planner);
          const route = await resolveExplicitRoute(user.id, pick.providerId, pick.model);
          if (policy.llmRouteOk(route)) pickedRoute = route;
          else {
            fallbackReason = `planner "${b.planner}" needs a remote route - ${policy.mode} only uses local models`;
            if (b.session_id) {
              await sql(
                `INSERT INTO agent_messages (session_id, role, kind, content) VALUES ($1,'system','status',$2::jsonb)`,
                [b.session_id, JSON.stringify({ text: `planner_error: ${fallbackReason}` })]);
            }
          }
        } catch (e) {
          fallbackReason = `planner "${b.planner}" unavailable - ${e instanceof Error ? e.message : e}`;
          if (b.session_id) {
            await sql(
              `INSERT INTO agent_messages (session_id, role, kind, content) VALUES ($1,'system','status',$2::jsonb)`,
              [b.session_id, JSON.stringify({ text: `planner_error: ${fallbackReason}` })]);
          }
        }
      }
      // @ref names in the brief pull the caller's own ref images in as
      // attachments - an unknown name refuses plainly rather than guessing
      const refs = await resolveRefsInText(user.id, text);
      if (refs.missing.length)
        return json({ error: `no ref named @${refs.missing[0]} - create it under Refs first` }, 422);
      // only stored /files/ images join the attachable set - a ref row
      // pointing anywhere else never reaches the planner's media list
      atts.push(...refs.refs.flatMap((r) =>
        r.images.filter((u) => u.startsWith("/files/")).slice(0, 3).map((url) => ({ url, mime: "image/*" }))));

      // only memory phrasings skip the model - "remember …", "save this as
      // NAME", "forget memory NAME" run the intent table's memory slice
      // before any model call, so a planner route can never reroute or drop
      // a memory write. fetch/search/jot/refs/catalog phrasings reach the
      // model first; deterministicPlan's full table still answers them when
      // no LLM is configured or planner=builtin.
      turn = builtinIntentPlan(text, { atts, lastOutputs }, { memoryOnly: true });

      if (!turn && !forceBuiltin && (pickedRoute || await llmConfigured(user.id, "planner"))) {
        try {
          turn = await llmPlan(user.id, text, atts, lastOutputs, eps, effMode === "offline",
            pickedRoute ? { route: pickedRoute, refs: refs.refs, projectId: effProjectId } : { refs: refs.refs, projectId: effProjectId });
        } catch (e) {
          // never hide a failed planner - the response carries the reason, and
          // a session-bound run narrates the same note the session path writes
          fallbackReason = e instanceof Error ? e.message : String(e);
          if (b.session_id) {
            await sql(
              `INSERT INTO agent_messages (session_id, role, kind, content) VALUES ($1,'system','status',$2::jsonb)`,
              [b.session_id, JSON.stringify({ text: `llm_error: ${fallbackReason}` })]);
            if (e instanceof LlmUnavailable && effMode !== "offline")
              await sql(
                `INSERT INTO agent_messages (session_id, role, kind, content) VALUES ($1,'assistant','text',$2::jsonb)`,
                [b.session_id, JSON.stringify({ text: `${fallbackReason} - using the built-in planner meanwhile.`, via: "built-in planner" })]);
          }
        }
      }
      turn ??= deterministicPlan(text, atts, lastOutputs, eps, effMode, refs.refs);
      if (turn.kind === "plan") { plan = turn.plan; via = turn.via; usage = turn.usage ?? null; }
      else {
        // a refusal is a plan outcome - narrate it into the session feed the
        // same way submitRunPlan narrates createRun's 422s
        const refuse = turn.kind === "ask" ? turn.question
          : turn.kind === "status" ? turn.text
          : "couldn't turn that brief into a plan - try naming a task (video, image, restyle…)";
        if (b.session_id) {
          await sql(
            `INSERT INTO agent_messages (session_id, role, kind, content) VALUES ($1,'system','status',$2::jsonb)`,
            [b.session_id, JSON.stringify({ text: `plan_error: ${refuse}` })]);
        }
        return json({ error: refuse }, 422);
      }
    }
    const view = await createRun(user.id, {
      plan,
      sessionId: b.session_id ?? null,
      mode: effMode,
      askFirst: b.ask_first,
      projectId: effProjectId,
      via,
      plannerNote: fallbackReason,
      atts,
      lastOutputs,
    }).catch(async (e) => {
      // createRun's validatePlan is authoritative - narrate its refusal into
      // a bound session so the feed shows WHY nothing was created
      if (b.session_id && e instanceof JobError) {
        await sql(
          `INSERT INTO agent_messages (session_id, role, kind, content) VALUES ($1,'system','status',$2::jsonb)`,
          [b.session_id, JSON.stringify({ text: `plan_error: ${e.message}` })]).catch(() => {});
      }
      throw e;
    });
    return json({
      run: view,
      ...(via !== undefined
        ? { planner: { via: via ?? null, ...(fallbackReason ? { fallback_reason: fallbackReason } : {}), ...(usage ? { usage } : {}) } }
        : {}),
    }, 201);
  } catch (e) {
    return err(e);
  }
}

/** GET /api/agent/runs - the user's runs, newest first (light rows). */
export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const rows = await sql<{
      id: string; status: string; mode: string; ask_first: boolean;
      estimate_credits: string; eta_seconds: number | null;
      session_id: string | null; project_id: string | null; created_at: Date;
      plan: { title?: string };
      steps: number;
    }>(
      `SELECT r.id, r.status, r.mode, r.ask_first, r.estimate_credits, r.eta_seconds,
              r.session_id, r.project_id, r.created_at, r.plan,
              (SELECT count(*)::int FROM run_steps s WHERE s.run_id = r.id) AS steps
         FROM agent_runs r WHERE r.user_id = $1
        ORDER BY r.created_at DESC LIMIT 50`,
      [user.id]);
    return json({
      runs: rows.map((r) => ({
        id: r.id, status: r.status, mode: r.mode, ask_first: r.ask_first,
        title: r.plan?.title ?? null, steps: r.steps,
        estimate_credits: Number(r.estimate_credits), eta_seconds: r.eta_seconds,
        session_id: r.session_id, project_id: r.project_id,
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
    });
  } catch (e) {
    return err(e);
  }
}
