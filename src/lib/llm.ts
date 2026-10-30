import { z } from "zod";
import { chat as routedChat, chatJson as routedChatJson, llmEnvConfigured } from "./llm/index";
import {
  LlmUnavailable,
  LLM_TIMEOUT_MS,
  stripThink,
  type ChatMessage,
  type ChatRole,
  type ToolDef,
} from "./llm/types";

/**
 * Back-compat facade over src/lib/llm/ - keeps the exported names and
 * signatures the pre-router callers (agent.ts, recipes) already use, so
 * they compile unchanged. The LLM is OFF unless explicitly configured;
 * callers check llmOn() and degrade or fail explicitly rather than faking it.
 */

export const llmCfg = () => ({
  url: (process.env.LLM_BASE_URL || "").replace(/\/$/, ""),
  key: process.env.LLM_API_KEY || "",
  model: process.env.LLM_MODEL || "",
});

/**
 * True only when an LLM is explicitly configured: LLM_PROVIDER, the legacy
 * LLM_BASE_URL+LLM_MODEL pair, or any LLM_TASK_* route. With every LLM_*
 * unset this is false - the agent keeps its deterministic fallback and the
 * default ollama route is NOT an implicit on-switch.
 */
export const llmOn = () => llmEnvConfigured();

export { LLM_TIMEOUT_MS, LlmUnavailable, stripThink };

export interface OaiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: unknown };
  /** Opaque provider payload echoed back with the call; passes through
   *  untouched. */
  meta?: Record<string, unknown>;
}
export interface OaiMsg {
  role: string;
  content?: string | null;
  reasoning?: string | null;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
}

function toToolDef(t: unknown): ToolDef {
  const o = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
  const fnRaw = o.type === "function" ? o.function : o;
  const fn = (fnRaw && typeof fnRaw === "object" ? fnRaw : {}) as Record<string, unknown>;
  return {
    name: String(fn.name ?? "tool"),
    description: typeof fn.description === "string" ? fn.description : undefined,
    parameters: (fn.parameters && typeof fn.parameters === "object"
      ? fn.parameters
      : { type: "object", properties: {} }) as ToolDef["parameters"],
  };
}

function toChatMessage(m: OaiMsg): ChatMessage {
  if (m.role === "tool") {
    return { role: "tool", toolCallId: m.tool_call_id, content: m.content ?? "" };
  }
  const msg: ChatMessage = {
    role: (["system", "user", "assistant", "tool"].includes(m.role) ? m.role : "user") as ChatRole,
    content: m.content ?? "",
  };
  if (m.role === "assistant" && m.tool_calls?.length) {
    msg.toolCalls = m.tool_calls
      .filter((tc) => tc?.function?.name)
      .map((tc, i) => ({
        id: tc.id ?? `call_${i}`,
        name: String(tc.function!.name),
        arguments: (() => {
          const a = tc.function!.arguments;
          if (typeof a !== "string") return a;
          try { return JSON.parse(a); } catch { return a; }
        })(),
        ...(tc.meta ? { meta: tc.meta } : {}),
      }));
  }
  return msg;
}

function toOaiMsg(res: {
  text: string;
  toolCalls: { id: string; name: string; arguments: unknown; meta?: Record<string, unknown> }[];
}): OaiMsg | null {
  if (!res.text && !res.toolCalls.length) return null; // genuinely empty reply
  const msg: OaiMsg = { role: "assistant", content: res.text || null };
  if (res.toolCalls.length) {
    msg.tool_calls = res.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
      },
      ...(tc.meta ? { meta: tc.meta } : {}),
    }));
  }
  return msg;
}

type LlmChatOpts = {
  tools?: unknown[]; temperature?: number; signal?: AbortSignal; timeoutMs?: number;
  /** per-user DB route (llm_task_routes) - without it only env routes apply */
  userId?: string;
  /** offline-only: any non-loopback route throws OfflineBlocked */
  offline?: boolean;
};

/**
 * One chat round trip through the routed LLM layer (task "planner"), with the
 * route that served it attached. Retries (with a fresh timeout signal per
 * attempt) live in the wire adapter; transport failures surface as
 * LlmUnavailable subclasses.
 */
export async function llmChatRouted(
  msgs: OaiMsg[],
  opts: LlmChatOpts = {},
): Promise<{ msg: OaiMsg | null; providerId: string; model: string }> {
  const res = await routedChat("planner", {
    messages: msgs.map(toChatMessage),
    tools: opts.tools?.map(toToolDef),
    temperature: opts.temperature ?? 0.4,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    offline: opts.offline,
  }, { userId: opts.userId });
  return { msg: toOaiMsg(res), providerId: res.providerId ?? "", model: res.model ?? "" };
}

/** Same call, returning just the message - the historical signature callers
 *  outside the agent (e.g. ws5 render deps) are typed against. */
export async function llmChat(msgs: OaiMsg[], opts: LlmChatOpts = {}): Promise<OaiMsg | null> {
  const { msg } = await llmChatRouted(msgs, opts);
  return msg;
}

type ChatJsonOpts = {
  signal?: AbortSignal; temperature?: number; timeoutMs?: number; userId?: string; offline?: boolean;
  /** qwen-style reasoning toggle - JSON writers pass false (thinking burns the timeout) */
  think?: boolean;
};

/**
 * Chat → JSON validated by a zod schema (task "writer"), with the route that
 * served it attached. One repair call on parse/validation failure, then
 * throws. Abort/cancel from opts.signal propagates instead of being
 * converted into a parse failure.
 */
export async function chatJsonRouted<S extends z.ZodType>(
  schema: S,
  msgs: OaiMsg[],
  opts: ChatJsonOpts = {},
): Promise<{ data: z.infer<S>; providerId: string; model: string }> {
  return routedChatJson("writer", schema, {
    messages: msgs.map(toChatMessage),
    temperature: opts.temperature,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    offline: opts.offline,
    ...(opts.think !== undefined ? { think: opts.think } : {}),
  }, { userId: opts.userId });
}

/** Same call, returning just the parsed data - the historical signature. */
export async function chatJson<S extends z.ZodType>(
  schema: S,
  msgs: OaiMsg[],
  opts: ChatJsonOpts = {},
): Promise<z.infer<S>> {
  const { data } = await chatJsonRouted(schema, msgs, opts);
  return data;
}
