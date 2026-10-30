import type { GenerationProvider, ProviderName } from "./types";
import { mockProvider } from "./mock";
import { comfyProvider } from "./comfy";
import { recipeProvider } from "./recipe";

const providers: Record<ProviderName, GenerationProvider> = {
  mock: mockProvider, comfy: comfyProvider, recipe: recipeProvider,
};

export function getProvider(name?: string): GenerationProvider {
  const wanted = (name || process.env.GENERATION_PROVIDER || "comfy") as ProviderName;
  const p = providers[wanted];
  if (!p) throw new Error(`unknown GENERATION_PROVIDER: ${wanted}`);
  return p;
}

export function activeProviderName(): ProviderName {
  const wanted = (process.env.GENERATION_PROVIDER || "comfy") as ProviderName;
  return wanted in providers ? wanted : "mock";
}

export type { GenerationProvider, ProviderName, SubmitInput, SubmitResult, ProviderStatus, ProviderOutput } from "./types";
