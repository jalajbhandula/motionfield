import type { WireId } from "./adapters";

/**
 * Provider presets - open-weights runtimes you run yourself. Each has a label,
 * wire protocol, default loopback base URL, auth style and a rough capability
 * map (advisory: actual support depends on the chosen model). There are no
 * hosted/closed model APIs here on purpose: MotionField is open-weights only.
 * "custom" points the OpenAI-compatible wire at your own server (another
 * machine, a GPU box, a self-hosted vLLM/TGI/SGLang).
 */

export interface ProviderPreset {
  id: string;
  label: string;
  wire: WireId;
  baseUrl: string;
  auth: "bearer" | "none";
  local: boolean;
  capabilities: { tools: boolean; vision: boolean; jsonSchema: boolean };
  defaultModel?: string;
  /** Public API documentation the baseUrl was taken from. */
  doc: string;
}

const caps = (tools: boolean, vision: boolean, jsonSchema: boolean) => ({ tools, vision, jsonSchema });

export const PROVIDERS: ProviderPreset[] = [
  {
    id: "ollama", label: "Ollama (local)", wire: "ollama",
    baseUrl: "http://127.0.0.1:11434", auth: "none", local: true,
    capabilities: caps(true, true, true),
    defaultModel: "qwen3.5:9b", // the planner model our setup docs recommend
    doc: "https://github.com/ollama/ollama/blob/main/docs/api.md#chat",
  },
  {
    id: "lmstudio", label: "LM Studio (local)", wire: "openai-chat",
    baseUrl: "http://127.0.0.1:1234/v1", auth: "bearer", local: true,
    capabilities: caps(true, true, true),
    doc: "https://lmstudio.ai/docs/app/api/endpoints/openai",
  },
  {
    id: "llamacpp", label: "llama.cpp server (local)", wire: "openai-chat",
    baseUrl: "http://127.0.0.1:8080/v1", auth: "bearer", local: true,
    capabilities: caps(true, true, true),
    doc: "https://github.com/ggml-org/llama.cpp/tree/master/tools/server",
  },
  {
    id: "vllm", label: "vLLM (local)", wire: "openai-chat",
    baseUrl: "http://127.0.0.1:8000/v1", auth: "bearer", local: true,
    capabilities: caps(true, true, true),
    doc: "https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html",
  },
  {
    id: "custom", label: "Custom self-hosted endpoint", wire: "openai-chat",
    baseUrl: "", auth: "bearer", local: false,
    capabilities: caps(true, true, true),
    doc: "user-supplied base URL; wire selectable via LLM_WIRE",
  },
];

/** Curated local-model picks surfaced in Settings → Models & LLMs.
 *  qwen3.5:9b stays the default; anything bigger is opt-in with the
 *  memory requirement stated up front. Open weights only. */
export const LOCAL_MODEL_PRESETS = [
  { tag: "qwen3.5:9b", label: "Qwen3.5 9B", note: "default - vision + tools, ~7.6 GB" },
  { tag: "qwen3.8:27b-q4_K_M", label: "Qwen3.8 27B · Q4_K_M", note: "intended quality upgrade - 18 GB download plus runtime/context memory; check available RAM before loading", heavy: true },
] as const;

export const providerById = (id: string): ProviderPreset | undefined =>
  PROVIDERS.find((p) => p.id === id);
