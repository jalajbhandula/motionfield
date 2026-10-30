import { z } from "zod";
import { JobError } from "@/lib/jobs";
import { isLoopbackUrl } from "@/lib/llm/offline";
import { turnEndpoints } from "@/lib/runs/endpoints";
import { catalogTools, searchTools } from "./catalog";
import { listRefs } from "./refs";
import { quoteUntrusted, webFetch } from "./web";
import type { AgentTool } from "./registry";

/**
 * Builtin tool executors - the job-less step path. Each returns the leaf
 * body the run engine saves as a run file (text or pretty-printed JSON).
 * schedule_create answers not_available - it is registered so its schema
 * exists, never offered to the planner, and never pretends to schedule.
 */

export interface ToolExecCtx {
  userId: string;
  runId: string;
  sessionId: string | null;
  mode: "auto" | "offline" | "custom";
  /** the EFFECTIVE offline flag at exec time - run.mode OR the user's live
   *  Settings Offline pref, re-checked when the step actually runs */
  offline: boolean;
}

export interface ToolResult {
  /** the run-file body - plain text or pretty-printed JSON */
  body: string;
}

const searxngResult = z.looseObject({
  results: z.array(z.looseObject({
    title: z.string().optional(),
    url: z.string().optional(),
    content: z.string().optional(),
  })).optional(),
});

async function searxngSearch(userId: string, args: Record<string, unknown>, offline: boolean): Promise<ToolResult> {
  const { getSearxngUrl } = await import("@/lib/llm/settings");
  const base = await getSearxngUrl(userId);
  if (!base) throw new JobError("web_search isn't configured - set a SearXNG base URL in Settings → Models & LLMs", 400);
  if (offline && !isLoopbackUrl(base)) {
    throw new JobError("offline mode - the configured SearXNG must be loopback", 400);
  }
  const query = String(args.query ?? "");
  const url = `${base.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
  const page = await webFetch(url, { offline });
  const parsed = searxngResult.safeParse(JSON.parse(page.text));
  const results = parsed.success
    ? (parsed.data.results ?? []).slice(0, Number(args.count) || 10).map((r) => ({
        title: r.title ?? "", url: r.url ?? "", content: (r.content ?? "").slice(0, 500),
      }))
    : [];
  return { body: JSON.stringify({ query, results }, null, 2) };
}

async function catalogSearch(ctx: ToolExecCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const eps = await turnEndpoints(ctx.mode, ctx.userId);
  const hits = searchTools(String(args.query ?? ""), catalogTools(eps));
  return {
    body: JSON.stringify({
      query: args.query,
      tools: hits.map((t) => ({
        name: t.name, endpoint_id: t.endpointId, input: t.input, output: t.output,
        restricted: t.restricted, description: t.description,
      })),
    }, null, 2),
  };
}

/** Session-context todo write - a run step may refresh the checklist the
 *  composer shows (same shape the planner writes on plan turns). */
async function writeSessionTodo(sessionId: string, items: { text: string; done: boolean }[]): Promise<void> {
  const { sql } = await import("@/db");
  const rows = await sql<{ context: unknown }>(
    `SELECT context FROM agent_sessions WHERE id = $1`, [sessionId]);
  const cur = z.looseObject({}).catch({}).parse(rows[0]?.context ?? {});
  await sql(
    `UPDATE agent_sessions SET context = $2::jsonb, updated_at = now() WHERE id = $1`,
    [sessionId, JSON.stringify({ ...cur, todo: { items } })]);
}

export async function execBuiltin(
  ctx: ToolExecCtx,
  tool: AgentTool,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // re-parse args at run time - validatePlan gated the submit, but the stored
  // row is the only contract once a step exists (edits, replays, direct writes)
  const parsed = tool.args ? tool.args.safeParse(args) : null;
  if (parsed && !parsed.success) {
    const issue = parsed.error.issues[0];
    throw new JobError(`bad ${tool.name} args - ${issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid"}`, 400);
  }
  const argv = parsed?.data ?? args;
  const offline = ctx.offline;
  switch (tool.builtin) {
    case "web_fetch": {
      const page = await webFetch(String(argv.url ?? ""), { offline });
      const truncated = page.truncated ? "\n\n[truncated at 2 MB]" : "";
      // the leaf itself carries the untrusted-data markers - anything that
      // later feeds this text to a model sees the framing, not instructions
      return { body: `${quoteUntrusted(page.text)}${truncated}` };
    }
    case "web_search":
      return searxngSearch(ctx.userId, argv, offline);
    case "notes":
      return { body: String(argv.text ?? "") };
    case "ask_user": {
      const options = Array.isArray(argv.options) ? argv.options.filter((x): x is string => typeof x === "string") : [];
      return {
        body: `${argv.question}${options.length ? `\n\noptions: ${options.map((o) => `[${o}]`).join(" ")}` : ""}`,
      };
    }
    case "todo": {
      const items = z.array(z.object({ text: z.string(), done: z.boolean() })).parse(argv.items ?? []);
      if (ctx.sessionId) await writeSessionTodo(ctx.sessionId, items);
      return { body: JSON.stringify({ items }, null, 2) };
    }
    case "catalog_search":
      return catalogSearch(ctx, argv);
    case "refs_list": {
      const refs = await listRefs(ctx.userId);
      return { body: JSON.stringify({ refs }, null, 2) };
    }
    case "memory_save": {
      // the step inherits the run's project scope - a memory saved inside a
      // project-bound run is a project memory; unbound runs save user-wide
      const { sql } = await import("@/db");
      const { upsertMemory, MEMORY_KINDS } = await import("@/lib/memory");
      const [run] = await sql<{ project_id: string | null }>(
        `SELECT project_id FROM agent_runs WHERE id = $1`, [ctx.runId]);
      const kind = typeof argv.kind === "string"
        ? (MEMORY_KINDS.find((k) => k === argv.kind) ?? "note") : "note";
      // a bare "save this as NAME" links the saved memory to the caller's
      // own job/upload the last-output url came from - a url that maps to
      // neither fails the step, never a dangling guess
      const links: { target_type: "job" | "upload"; target_id: string }[] = [];
      if (typeof argv.link_url === "string" && argv.link_url) {
        const [j] = await sql<{ id: string }>(
          `SELECT id FROM jobs WHERE user_id = $1
             AND EXISTS (SELECT 1 FROM jsonb_array_elements(outputs) o
                          WHERE o->>'url' = $2)
            LIMIT 1`, [ctx.userId, argv.link_url]);
        if (j) links.push({ target_type: "job", target_id: j.id });
        else {
          const [u] = await sql<{ id: string }>(
            `SELECT id FROM uploads WHERE user_id = $1 AND url = $2 LIMIT 1`,
            [ctx.userId, argv.link_url]);
          if (u) links.push({ target_type: "upload", target_id: u.id });
          else throw new JobError("that output isn't one of your jobs or uploads anymore", 404);
        }
      }
      const mem = await upsertMemory(ctx.userId, {
        name: String(argv.name), kind, content: String(argv.content),
        projectId: run?.project_id ?? null, links,
      });
      return { body: `saved memory "${mem.name}" (${mem.kind})${mem.project_id ? " - scoped to this project" : ""}` };
    }
    case "memory_forget": {
      const { forgetMemory } = await import("@/lib/memory");
      const gone = await forgetMemory(ctx.userId, {
        id: typeof argv.id === "string" ? argv.id : undefined,
        name: typeof argv.name === "string" ? argv.name : undefined,
      });
      if (!gone) {
        throw new JobError(`no memory ${argv.name ? `named "${argv.name}"` : `with id ${argv.id}`} to forget`, 404);
      }
      return { body: `forgot memory "${gone.name}"` };
    }
    case "schedule_create":
      throw new JobError("not_available: scheduling isn't built yet - the schedules engine lands in a later step", 400, "not_available");
    default:
      throw new JobError(`unknown builtin tool ${tool.name}`, 400);
  }
}
