import type { GenerationProvider, ProviderOutputItem, ProviderStatus, SubmitInput, SubmitResult } from "./types";
import { RECIPES } from "./recipes";

/**
 * Recipe provider - server-side pipelines that orchestrate several ComfyUI
 * jobs inside a single MotionField job. A recipe-backed workflow carries
 * `providers.recipe.name` instead of a bundled graph; the recipe drives the
 * sub-steps through comfyProvider itself, so intermediate artifacts never
 * enter the gallery - only the item(s) the recipe returns become assets.
 */

export type RecipeCtx = {
  signal: AbortSignal;
  /** 0-100 overall progress plus a stage label for the job row */
  progress: (pct: number, stage?: string) => void;
};
export type RecipeFn = (input: SubmitInput, ctx: RecipeCtx) => Promise<ProviderOutputItem[]>;

type Run = { ac: AbortController; stage: string; pct: number; done?: ProviderStatus; doneAt?: number };
/** globalThis so Next.js dev HMR doesn't drop in-flight runs on module reload. */
const runs: Map<string, Run> = (globalThis as { __ofRecipeRuns?: Map<string, Run> }).__ofRecipeRuns ??= new Map();
/** finished runs stay pollable for a while so a second poll returns the same result */
const DONE_TTL_MS = 10 * 60_000;

function sweep(now = Date.now()) {
  for (const [id, st] of runs) if (st.done && (st.doneAt ?? 0) < now - DONE_TTL_MS) runs.delete(id);
}

export const recipeProvider: GenerationProvider = {
  name: "recipe",

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const name = input.workflow.providers.recipe?.name;
    const fn = name ? RECIPES[name] : undefined;
    if (!name || !fn) throw new Error(`unknown recipe: ${name ?? "(none)"}`);
    const id = `recipe-${input.jobId}`;
    const st: Run = { ac: new AbortController(), stage: "queued", pct: 0 };
    runs.set(id, st);
    fn(input, {
      signal: st.ac.signal,
      progress: (pct, stage) => { st.pct = pct; if (stage) st.stage = stage; },
    }).then((items) => {
      st.done = { state: "completed", output: { items } };
      st.doneAt = Date.now();
    }).catch((e) => {
      st.done = st.ac.signal.aborted
        ? { state: "canceled" }
        : { state: "failed", error: e instanceof Error ? e.message : String(e) };
      st.doneAt = Date.now();
    });
    return { providerJobId: id, meta: { recipe: name } };
  },

  async poll(providerJobId: string): Promise<ProviderStatus> {
    sweep();
    const st = runs.get(providerJobId);
    if (!st) return { state: "failed", error: "recipe run lost (server restarted) - resubmit" };
    if (st.done) return st.done; // idempotent: repeated polls keep reporting the same result
    return { state: "in_progress", progress: Math.max(1, Math.min(99, Math.round(st.pct))), stage: st.stage };
  },

  async cancel(providerJobId: string) {
    runs.get(providerJobId)?.ac.abort();
  },
};
