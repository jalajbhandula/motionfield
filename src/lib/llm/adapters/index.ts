import type { WireAdapter } from "./common";
import { openaiChat } from "./openai-chat";
import { ollama } from "./ollama";

export const WIRES = {
  "openai-chat": { call: openaiChat },
  "ollama": { call: ollama },
} as const satisfies Record<string, { call: WireAdapter }>;

export type WireId = keyof typeof WIRES;

export const isWireId = (s: string): s is WireId => s in WIRES;
