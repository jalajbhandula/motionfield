import { z } from "zod";
import { postJson } from "../http";
import { LlmUnavailable, type ChatMessage, type ChatResponse, type JsonSchema, type ToolCall } from "../types";
import { argsToString, partsOf, textOf, type AdapterCtx, type WireAdapter } from "./common";

/**
 * OpenAI-compatible /chat/completions wire - Ollama /v1, LM Studio,
 * llama.cpp, vLLM, SGLang, TGI, ... all speak this.
 *
 * Doc: https://platform.openai.com/docs/api-reference/chat/create
 */

/** Can this schema be expressed in OpenAI strict mode? Strict needs every
 *  object sealed (additionalProperties:false) AND every property required -
 *  a record (schema-valued additionalProperties) or an optional field can't
 *  be represented, so those schemas go out as-is with strict:false instead
 *  of mangling them. */
function strictable(s: JsonSchema): boolean {
  if (s.type === "object" || s.properties || s.additionalProperties !== undefined) {
    if (s.additionalProperties && typeof s.additionalProperties === "object") return false;
    const props = (s.properties ?? {}) as Record<string, JsonSchema>;
    const req = Array.isArray(s.required) ? s.required as unknown[] : [];
    if (Object.keys(props).some((k) => !req.includes(k))) return false;
    if (Object.values(props).some((v) => typeof v === "object" && !strictable(v))) return false;
  }
  if (s.items && typeof s.items === "object" && !strictable(s.items as JsonSchema)) return false;
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(s[key]) && (s[key] as JsonSchema[]).some((x) => !strictable(x))) return false;
  }
  if (s.$defs && typeof s.$defs === "object"
    && Object.values(s.$defs).some((v) => typeof v === "object" && !strictable(v as JsonSchema))) return false;
  return true;
}

/** Strict-mode schemas need additionalProperties:false + every prop required.
 *  Only called when strictable() already proved the shape fits. */
function strictify(schema: JsonSchema): JsonSchema {
  const s: JsonSchema = { ...schema };
  if (s.type === "object" || s.properties) {
    if (s.properties && typeof s.properties === "object") {
      const props = Object.fromEntries(
        Object.entries(s.properties as Record<string, JsonSchema>).map(([k, v]) => [k, strictify(v)]),
      );
      s.properties = props;
      s.required = Object.keys(props);
    }
    s.additionalProperties = false;
  }
  if (s.items && typeof s.items === "object") s.items = strictify(s.items as JsonSchema);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(s[key])) s[key] = (s[key] as JsonSchema[]).map(strictify);
  }
  if (s.$defs && typeof s.$defs === "object") {
    s.$defs = Object.fromEntries(
      Object.entries(s.$defs as Record<string, JsonSchema>).map(([k, v]) => [k, strictify(v)]),
    );
  }
  delete s.$schema;
  return s;
}

type OaiMsg = Record<string, unknown>;

function toOaiMessage(m: ChatMessage): OaiMsg {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId ?? "", content: textOf(m.content) };
  }
  const msg: OaiMsg = { role: m.role };
  if (typeof m.content === "string") {
    msg.content = m.content;
  } else {
    msg.content = partsOf(m.content).map((p) =>
      p.type === "text"
        ? { type: "text", text: p.text }
        : { type: "image_url", image_url: { url: `data:${p.mime};base64,${p.base64}` } });
  }
  if (m.role === "assistant" && m.toolCalls?.length) {
    msg.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: argsToString(tc.arguments) },
    }));
    if (msg.content === "" || msg.content === undefined) msg.content = null;
  }
  return msg;
}

/** The fields we read off a chat-completion response - parsed, not trusted.
 *  Loose: providers add fields freely; a reply that isn't this shape is a
 *  transport-level failure, not silently empty. */
const OAI_RESPONSE = z.looseObject({
  choices: z.array(z.looseObject({
    message: z.looseObject({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.looseObject({
        id: z.string().optional(),
        type: z.string().optional(),
        function: z.looseObject({
          name: z.string().optional(),
          arguments: z.unknown().optional(),
        }).optional(),
      })).optional(),
    }).optional(),
  })).optional(),
  usage: z.looseObject({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
  }).optional(),
});

type OaiToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: unknown } };

function fromOaiToolCalls(raw: OaiToolCall[] | undefined): ToolCall[] {
  return (raw ?? [])
    .filter((tc) => tc?.function?.name)
    .map((tc, i) => ({
      id: String(tc.id ?? `call_${i}`),
      name: String(tc.function!.name!),
      arguments: (() => { const a = tc.function!.arguments; try { return typeof a === "string" ? JSON.parse(a) : a; } catch { return a; } })(),
    }));
}

export const openaiChat: WireAdapter = async (ctx: AdapterCtx, req): Promise<ChatResponse> => {
  const url = `${ctx.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const body: Record<string, unknown> = {
    model: ctx.model,
    messages: req.messages.map(toOaiMessage),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
  };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    if (req.toolChoice) {
      body.tool_choice = typeof req.toolChoice === "string"
        ? req.toolChoice
        : { type: "function", function: { name: req.toolChoice.name } };
    }
  }
  if (req.responseSchema) {
    const strict = strictable(req.responseSchema);
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "response",
        schema: strict ? strictify(req.responseSchema) : req.responseSchema,
        strict,
      },
    };
  }
  const { json } = await postJson(url, {
    headers: ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {},
    body,
    signal: req.signal,
    timeoutMs: req.timeoutMs,
    label: ctx.label,
    model: ctx.model,
  });
  const parsed = OAI_RESPONSE.safeParse(json);
  if (!parsed.success) {
    throw new LlmUnavailable(`unexpected response shape from ${ctx.label} - not an OpenAI-compatible chat completion`);
  }
  const msg = parsed.data.choices?.[0]?.message;
  const usage = parsed.data.usage;
  return {
    text: typeof msg?.content === "string" ? msg.content : "",
    toolCalls: fromOaiToolCalls(msg?.tool_calls),
    usage: usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } : undefined,
    raw: json,
  };
};
