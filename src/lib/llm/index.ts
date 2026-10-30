import { z } from "zod";
import { WIRES, type WireId } from "./adapters";
import { assertOfflineOk, hostedMode, isLoopbackUrl, offlineMode } from "./offline";
import { checkBaseUrl, userOffline } from "./settings";
import {
  llmConfigured,
  llmEnvConfigured,
  resolveRoute,
  type ResolvedRoute,
  type TaskKind,
} from "./router";
import {
  LlmRequestError,
  LlmUnavailable,
  OfflineBlocked,
  stripThink,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ChatUsage,
  type JsonSchema,
} from "./types";

/**
 * Public entry point of the WS2 LLM layer.
 *   chat(task, request, ctx?) - one routed round trip
 *   chatJson(task, zodSchema, req) - schema-constrained (where the wire
 *                                    supports it), zod-validated, one repair retry
 * src/lib/llm.ts is a thin facade over this for the existing callers.
 */

export interface ChatCtx {
  /** Enables the per-user DB route override (llm_task_routes). */
  userId?: string;
  /** An already-resolved route (e.g. the planner picker's explicit choice).
   *  dispatchChat still applies offline/hosted policy to it. */
  route?: ResolvedRoute;
}

export async function chat(task: TaskKind, request: ChatRequest, ctx?: ChatCtx): Promise<ChatResponse> {
  const route = ctx?.route ?? await resolveRoute(task, ctx?.userId);
  return dispatchChat(route, request, ctx?.userId);
}

/**
 * One round trip over an already-resolved route (the test-connection endpoint
 * resolves a provider directly instead of a task). Applies the per-user
 * offline flag to every call and the hosted refusals in one place.
 */
export async function dispatchChat(
  route: ResolvedRoute,
  request: ChatRequest,
  userId?: string,
): Promise<ChatResponse> {
  const req = { ...request };
  // the user's Offline toggle rides every call - a session that was created
  // before the toggle flipped still honors it on the very next turn
  if (!req.offline && userId && (await userOffline(userId))) req.offline = true;

  // hosted: a user-saved (db) route is re-checked at dispatch, not only at
  // save time - a row written before the policy or via SQL, or DNS that
  // flips after the save, must never reach fetch. Env routes are the
  // operator's own config and keep their trust level.
  if (hostedMode() && route.source === "db") {
    if (route.local || isLoopbackUrl(route.baseUrl)) {
      throw new LlmUnavailable(
        `${route.label}: stored LLM route refused in hosted mode - local and loopback base URLs are not allowed`,
      );
    }
    const why = await checkBaseUrl(route.baseUrl);
    if (why) throw new LlmUnavailable(`${route.label}: ${why}`);
  }

  assertOfflineOk(route.baseUrl, req); // before ANY network call
  const wire = WIRES[route.wire];
  if (req.responseSchema && !route.capabilities.jsonSchema) delete req.responseSchema;
  const res = await wire.call(
    { baseUrl: route.baseUrl, apiKey: route.apiKey, model: route.model, label: route.label },
    req,
  );
  return { ...res, providerId: route.providerId, model: route.model };
}

/** Pull the first JSON value out of a chat reply (tolerates leading prose). */
function extractJson(text: string): unknown {
  const t = stripThink(text);
  try { return JSON.parse(t); } catch { /* fall through to slicing */ }
  const a = t.search(/[[{]/), open = a >= 0 ? t[a] : "";
  const close = open === "[" ? "]" : "}";
  const b = t.lastIndexOf(close);
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch { /* malformed slice */ }
  }
  if (a >= 0) {
    // last-ditch: small local models occasionally transpose or drop the
    // trailing brackets (`}]} → }}]`) - the bracket-repair rebuild below
    // fixes that shape; zod still validates whatever it yields
    try { return JSON.parse(repairCloseBrackets(t.slice(a))); } catch { /* give up */ }
  }
  return undefined;
}

/** Rebuild near-miss JSON whose brackets got transposed or dropped.
 *  Scanning left to right: a closer whose matching open exists deeper in the
 *  stack first emits the closers for whatever is still open above it
 *  (`}}]` on `{…[…` becomes `]}}`), a closer with no matching open at all is
 *  dropped, and anything left open at the end is closed (truncated replies).
 *  String contents are never touched. Not a JSON5 parser - it only fixes
 *  bracket order, which is the failure small models actually produce. */
function repairCloseBrackets(t: string): string {
  const stack: string[] = [];
  const open: Record<string, string> = { "}": "{", "]": "[" };
  let out = "", inStr = false, esc = false;
  for (const ch of t) {
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === "{" || ch === "[") { stack.push(ch); out += ch; continue; }
    if (ch === "}" || ch === "]") {
      const at = stack.lastIndexOf(open[ch]);
      if (at === -1) continue; // stray closer - no open to match it
      while (stack.length > at + 1) out += stack.pop() === "{" ? "}" : "]";
      stack.pop(); // the matching open - its closer is ch
      out += ch;
      continue;
    }
    out += ch;
  }
  while (stack.length) out += stack.pop() === "{" ? "}" : "]";
  return out;
}

/** provider·model pairs that already rejected a schema constraint - it's not
 *  sent again for the life of the process (skips a wasted 4xx/501 round trip). */
const schemaDropCache = new Set<string>();

/**
 * Best-effort wire constraint for a zod schema. Only an object-root JSON
 * Schema is expressible across wires (OpenAI-compatible strict mode needs
 * an object root) - and
 * z.toJSONSchema throws on transforms, dates and preprocess. In every other
 * case there is no wire knob; zod validation + the repair turn still enforce.
 */
function wireSchema(schema: z.ZodType): JsonSchema | undefined {
  try {
    const s = z.toJSONSchema(schema) as Record<string, unknown>;
    return s?.type === "object" ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Chat → JSON validated by a zod schema. The wire-level schema constraint is
 * sent where supported; on a 4xx complaining about the schema knob we drop it
 * and still enforce via zod + one repair turn (same contract as the old
 * chatJson: the assistant reply plus the validation error is echoed back once).
 */
export async function chatJson<S extends z.ZodType>(
  task: TaskKind,
  schema: S,
  request: ChatRequest,
  ctx?: ChatCtx,
): Promise<{ data: z.infer<S>; providerId: string; model: string; usage?: ChatUsage }> {
  const responseSchema = wireSchema(schema);
  // resolve once for the cache key - an explicit ctx.route wins (chat() reuses it)
  const route = ctx?.route ?? await resolveRoute(task, ctx?.userId);
  const dropKey = `${route.providerId}·${route.model}`;
  const send = (messages: ChatMessage[]) =>
    chat(task, { ...request, messages, responseSchema: schemaDropCache.has(dropKey) ? undefined : responseSchema }, ctx)
      .catch((e) => {
        // wire can't express the schema constraint (e.g. Ollama <0.5 answers
        // 501 "structured output is unavailable") - drop it; zod + repair below
        const statusHits = e instanceof LlmRequestError
          && (e.status === 501 || (e.status >= 400 && e.status < 500));
        if (!schemaDropCache.has(dropKey) && statusHits
          && /response_?format|json_?schema|response_?schema|structured output|additionalproperties|is required|unsupported/i.test(`${e.message} ${e.body}`)) {
          schemaDropCache.add(dropKey);
          return chat(task, { ...request, messages }, ctx);
        }
        throw e;
      });

  const attempt = async (extra: ChatMessage[]) => {
    const res = await send([...request.messages, ...extra]);
    const raw = extractJson(res.text);
    return { res, parsed: schema.safeParse(raw) };
  };

  const route_ = { providerId: route.providerId, model: route.model };
  const addUsage = (a?: ChatUsage, b?: ChatUsage): ChatUsage | undefined =>
    !a && !b ? undefined
      : { inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
          outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0) };
  const first = await attempt([]);
  if (first.parsed.success) return { data: first.parsed.data, ...route_, usage: first.res.usage };
  const issue = first.parsed.error.issues[0];
  const err = `${issue ? `${issue.path.join(".") || "(root)"}: ` : ""}${first.parsed.error.message}`.slice(0, 500);
  const repair: ChatMessage[] = [];
  // some servers 400 on empty assistant turns - only echo the bad reply
  // back when there is text to echo
  if (first.res.text) repair.push({ role: "assistant", content: first.res.text });
  repair.push({ role: "user", content: `That reply failed validation (${err}). Reply with ONLY the corrected JSON - no commentary.` });
  const retry = await attempt(repair);
  if (retry.parsed.success)
    return { data: retry.parsed.data, ...route_, usage: addUsage(first.res.usage, retry.res.usage) };
  // the preview makes dead-wire failures diagnosable - the reply is the
  // model's own output, never a credential or user secret
  const head = retry.res.text.trim().replace(/\s+/g, " ").slice(0, 200);
  const tail = retry.res.text.trim().replace(/\s+/g, " ").slice(-200);
  const preview = head === tail ? head : `${head} … ${tail}`;
  throw new Error(`LLM output failed schema validation (after one repair): ${retry.parsed.error.message.slice(0, 300)} - reply (${retry.res.text.length}ch): ${preview || "(empty)"}`);
}

/** Best-effort VRAM release: ask a local Ollama to drop the model
 *  (keep_alive:0 on an empty /api/generate). Only fires for a local ollama
 *  route; every failure is swallowed - this is cleanup, never a blocker. */
export async function unloadLocalModel(route: {
  providerId: string; local: boolean; baseUrl: string; model: string;
}): Promise<void> {
  if (hostedMode() || route.providerId !== "ollama" || !route.local) return;
  const base = route.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
  await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: route.model, keep_alive: 0 }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

export { llmConfigured, llmEnvConfigured, resolveRoute };
export type { TaskKind };
export type { ResolvedRoute } from "./router";
export { LLM_TASKS, SUGGESTED_ROUTE } from "./router";
export { PROVIDERS, providerById } from "./providers";
export { WIRES } from "./adapters";
export { assertOfflineOk, isLoopbackUrl, offlineMode } from "./offline";
export { encryptSecret, decryptSecret } from "./crypto";
export * from "./types";
