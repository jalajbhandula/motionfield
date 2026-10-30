/**
 * Model-agnostic LLM types - one internal request/response shape that every
 * wire adapter (openai-chat, ollama) translates
 * to and from. No SDK dependencies; everything goes through fetch.
 */

export const LLM_TIMEOUT_MS = 120_000; // local models are slow (weight load + thinking)

/** Transport/policy failures callers can branch on. */
export class LlmUnavailable extends Error {}

/** Non-retryable (or retries-exhausted) HTTP failure from the provider. */
export class LlmRequestError extends LlmUnavailable {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string = "",
  ) {
    super(message);
    this.name = "LlmRequestError";
  }
}

/** Offline guard rejected a non-loopback endpoint before any network call.
 *  An LlmUnavailable subclass so callers' "LLM off" handling covers it. */
export class OfflineBlocked extends LlmUnavailable {
  constructor(message: string) {
    super(message);
    this.name = "OfflineBlocked";
  }
}

/** Strip qwen-style <think>…</think> blocks (closed or truncated) from visible text. */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; base64: string };

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments object, or the raw JSON string when the provider emitted one. */
  arguments: unknown;
  /** Opaque provider-side payload to echo back with this call on the next
   *  turn. Never interpreted, only carried. */
  meta?: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[];
  /** Assistant messages: tool calls the model asked for. */
  toolCalls?: ToolCall[];
  /** Tool messages: the call this result answers. */
  toolCallId?: string;
  /** Tool messages: tool name (required by some wires). */
  name?: string;
}

export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description?: string;
  /** JSON Schema for the arguments object. */
  parameters: JsonSchema;
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  /** JSON Schema the reply must satisfy (sent only where the wire supports it). */
  responseSchema?: JsonSchema;
  temperature?: number;
  maxTokens?: number;
  /** Ollama `think` passthrough (qwen3-style reasoning toggle). */
  think?: boolean;
  /** Ollama options.num_ctx. */
  numCtx?: number;
  /** Ollama keep_alive: 0 - unload the model after the reply. */
  unload?: boolean;
  /** Caller cancellation - aborts propagate, they are never converted to failures. */
  signal?: AbortSignal;
  /** Flag this request offline-only: any non-loopback base URL throws OfflineBlocked. */
  offline?: boolean;
  /** Per-request timeout override (defaults to LLM_TIMEOUT_MS). */
  timeoutMs?: number;
}

export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  usage?: ChatUsage;
  /** Raw provider payload - kept for debugging, shape is wire-specific. */
  raw: unknown;
  /** Resolved route - set by the router (`chat`), absent on raw wire calls. */
  providerId?: string;
  model?: string;
}
