import { z } from "zod";
import { postJson } from "../http";
import { LlmUnavailable, type ChatMessage, type ChatResponse, type ToolCall } from "../types";
import { argsToObject, partsOf, textOf, type AdapterCtx, type WireAdapter } from "./common";

/**
 * Ollama native /api/chat wire (stream:false).
 * - images ride on the message as base64 `images: []`
 * - responseSchema → `format: <schema>` (Ollama enforces it in the sampler)
 * - `think` passes straight through (qwen3-style reasoning toggle)
 * - options.num_ctx, keep_alive=0 on unload
 *
 * Doc: https://github.com/ollama/ollama/blob/main/docs/api.md#chat
 */

type OllamaMsg = Record<string, unknown>;

/** Process-wide counter stamping Ollama tool-call ids (call_<n>_<i>). */
let ollamaCallSeq = 0;

/** The fields we read off /api/chat - parsed, not trusted. */
const OLLAMA_RESPONSE = z.looseObject({
  message: z.looseObject({
    content: z.string().optional(),
    tool_calls: z.array(z.looseObject({
      function: z.looseObject({
        name: z.string().optional(),
        arguments: z.unknown().optional(),
      }).optional(),
    })).optional(),
  }).optional(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
});

function toOllamaMessage(m: ChatMessage, callNames: Map<string, string>): OllamaMsg {
  if (m.role === "tool") {
    // the wire names the field `tool_name` - resolved from the call id via
    // earlier assistant turns when the caller didn't set ChatMessage.name
    const name = m.name ?? (m.toolCallId ? callNames.get(m.toolCallId) : undefined);
    return { role: "tool", content: textOf(m.content), ...(name ? { tool_name: name } : {}) };
  }
  const msg: OllamaMsg = { role: m.role, content: textOf(m.content) };
  if (m.role === "user" && typeof m.content !== "string") {
    const images = partsOf(m.content)
      .filter((p) => p.type === "image")
      .map((p) => (p as { base64: string }).base64);
    if (images.length) msg.images = images;
  }
  if (m.role === "assistant" && m.toolCalls?.length) {
    msg.tool_calls = m.toolCalls.map((tc) => ({
      function: { name: tc.name, arguments: argsToObject(tc.arguments) },
    }));
  }
  return msg;
}

export const ollama: WireAdapter = async (ctx: AdapterCtx, req): Promise<ChatResponse> => {
  // users paste the OpenAI-compat base URL with a /v1 suffix - the native
  // API lives at the root, so strip it before joining /api/chat
  const base = ctx.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const url = `${base}/api/chat`;

  // toolCallId → name, from earlier assistant tool calls
  const callNames = new Map<string, string>();
  for (const m of req.messages) for (const tc of m.toolCalls ?? []) callNames.set(tc.id, tc.name);
  const options: Record<string, unknown> = {};
  if (req.temperature !== undefined) options.temperature = req.temperature;
  if (req.maxTokens !== undefined) options.num_predict = req.maxTokens;
  if (req.numCtx !== undefined) options.num_ctx = req.numCtx;

  const body: Record<string, unknown> = {
    model: ctx.model,
    messages: req.messages.map((m) => toOllamaMessage(m, callNames)),
    stream: false,
    ...(Object.keys(options).length ? { options } : {}),
    ...(req.responseSchema ? { format: req.responseSchema } : {}),
    ...(req.think !== undefined ? { think: req.think } : {}),
    ...(req.unload ? { keep_alive: 0 } : {}),
  };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  const { json } = await postJson(url, {
    headers: ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {},
    body,
    signal: req.signal,
    timeoutMs: req.timeoutMs,
    label: ctx.label,
    model: ctx.model,
  });

  const parsed = OLLAMA_RESPONSE.safeParse(json);
  if (!parsed.success) {
    throw new LlmUnavailable(`unexpected response shape from ${ctx.label} - not an Ollama /api/chat reply`);
  }
  const msg = parsed.data.message ?? {};
  // ids must be unique across the whole session, not just this reply - a
  // repeated call_0 would collide in toolCallId→name resolution and any
  // provider-side dedup
  const tag = ++ollamaCallSeq;
  const toolCalls: ToolCall[] = (msg.tool_calls ?? [])
    .filter((tc) => tc?.function?.name)
    .map((tc, i) => ({
      id: `call_${tag}_${i}`,
      name: String(tc.function!.name),
      arguments: tc.function!.arguments ?? {},
    }));
  return {
    text: typeof msg.content === "string" ? msg.content : "",
    toolCalls,
    usage: parsed.data.eval_count !== undefined
      ? { inputTokens: parsed.data.prompt_eval_count, outputTokens: parsed.data.eval_count }
      : undefined,
    raw: json,
  };
};
