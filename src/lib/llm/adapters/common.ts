import type { ChatMessage, ChatRequest, ChatResponse, ContentPart } from "../types";

/** What the router hands each wire adapter. */
export interface AdapterCtx {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Provider label for error messages. */
  label: string;
}

export type WireAdapter = (ctx: AdapterCtx, req: ChatRequest) => Promise<ChatResponse>;

export const textOf = (content: ChatMessage["content"]): string =>
  typeof content === "string"
    ? content
    : content.filter((p): p is ContentPart & { type: "text" } => p.type === "text").map((p) => p.text).join("");

export const partsOf = (content: ChatMessage["content"]): ContentPart[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;

/** ToolCall.arguments → object (wires that want a JSON object). */
export function argsToObject(a: unknown): Record<string, unknown> {
  if (a && typeof a === "object" && !Array.isArray(a)) return a as Record<string, unknown>;
  if (typeof a === "string") {
    try {
      const j = JSON.parse(a);
      if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>;
    } catch { /* fall through */ }
  }
  return {};
}

/** ToolCall.arguments → JSON string (wires that want a string). */
export const argsToString = (a: unknown): string =>
  typeof a === "string" ? a : JSON.stringify(a ?? {});
