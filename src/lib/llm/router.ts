import { isWireId, type WireId } from "./adapters";
import { hostedMode, isLoopbackUrl } from "./offline";
import { readProviderKey } from "./provider-key";
import { providerById, PROVIDERS, type ProviderPreset } from "./providers";
import { LlmUnavailable } from "./types";

/**
 * Per-task LLM routing. Tasks: planner | writer | vision | coder | enhancer | judge.
 *
 * Resolution order (first hit wins):
 *   1. per-user DB override (llm_task_routes + llm_provider_settings)
 *   2. env LLM_TASK_<TASK>=<provider>:<model>   (model may contain ':')
 *   3. env LLM_PROVIDER (+LLM_MODEL/LLM_BASE_URL/LLM_API_KEY),
 *      or back-compat: LLM_BASE_URL+LLM_MODEL(+LLM_API_KEY) → openai-chat wire
 *
 * Nothing configured → resolveRoute throws LlmUnavailable BEFORE any network
 * call: there is no implicit route. llmEnvConfigured()/llmOn() stay env-only
 * so the regex fallback planner still runs; SUGGESTED_ROUTE exists for docs
 * and the Settings picker only.
 */

export const LLM_TASKS = ["planner", "writer", "vision", "coder", "enhancer", "judge"] as const;
export type TaskKind = (typeof LLM_TASKS)[number];

export interface ResolvedRoute {
  providerId: string;
  label: string;
  wire: WireId;
  baseUrl: string;
  apiKey?: string;
  model: string;
  local: boolean;
  capabilities: ProviderPreset["capabilities"];
  source: "db" | "env-task" | "env";
}

/** What our docs suggest and Settings pre-selects - never used implicitly. */
export const SUGGESTED_ROUTE = { providerId: "ollama", model: "qwen3.5:9b" } as const;

export function routeFromPreset(
  preset: ProviderPreset,
  model: string | undefined,
  overrides: { baseUrl?: string; apiKey?: string; wire?: WireId },
  source: ResolvedRoute["source"],
): ResolvedRoute {
  const baseUrl = (overrides.baseUrl ?? preset.baseUrl).replace(/\/$/, "");
  const wire = overrides.wire ?? preset.wire;
  const resolved: ResolvedRoute = {
    providerId: preset.id,
    label: preset.label,
    wire,
    baseUrl,
    apiKey: overrides.apiKey,
    model: model ?? preset.defaultModel ?? "",
    // `local` reflects the URL actually used: an overridden base URL is
    // judged on itself; otherwise the preset's own class applies
    local: overrides.baseUrl !== undefined ? isLoopbackUrl(baseUrl) : preset.local,
    capabilities: preset.capabilities,
    source,
  };
  if (!resolved.model) {
    throw new Error(`provider "${preset.id}" has no default model - set LLM_MODEL or pick one in settings`);
  }
  if (!resolved.baseUrl) {
    throw new Error(`provider "${preset.id}" needs a base URL - set LLM_BASE_URL`);
  }
  return resolved;
}

/** Parse `<provider>:<model>` - the model part may itself contain colons. */
function parseRouteSpec(spec: string): { providerId: string; model: string } {
  const i = spec.indexOf(":");
  if (i <= 0) throw new Error(`route "${spec}" must look like <provider>:<model>`);
  return { providerId: spec.slice(0, i).trim(), model: spec.slice(i + 1).trim() };
}

/**
 * API key for a resolved provider id. `LLM_API_KEY_<ID>` always applies; the
 * bare `LLM_API_KEY` applies only to the provider named by LLM_PROVIDER
 * (or "custom" when unset, i.e. the legacy single-endpoint mode) - otherwise
 * one service's key would leak to another as an auth header.
 */
function envKeyFor(providerId: string): string | undefined {
  const specific = process.env[`LLM_API_KEY_${providerId.toUpperCase()}`];
  if (specific) return specific;
  return providerId === (process.env.LLM_PROVIDER || "custom")
    ? process.env.LLM_API_KEY || undefined
    : undefined;
}

/** 2+3. env sources - shared by resolveRoute and the facade's legacy path. */
function envRoute(task: TaskKind): ResolvedRoute | null {
  // env LLM_TASK_<TASK>=<provider>:<model>
  const taskSpec = process.env[`LLM_TASK_${task.toUpperCase()}`];
  if (taskSpec) {
    const { providerId, model } = parseRouteSpec(taskSpec);
    const preset = providerById(providerId);
    if (!preset) throw new Error(`LLM_TASK_${task.toUpperCase()}: unknown provider "${providerId}"`);
    return routeFromPreset(preset, model, { apiKey: envKeyFor(providerId) }, "env-task");
  }

  // env LLM_PROVIDER + friends
  const providerId = process.env.LLM_PROVIDER;
  if (providerId) {
    const preset = providerById(providerId);
    if (!preset) throw new Error(`LLM_PROVIDER: unknown provider "${providerId}"`);
    const wireEnv = process.env.LLM_WIRE;
    const wire = wireEnv && isWireId(wireEnv) ? wireEnv : undefined;
    return routeFromPreset(preset, process.env.LLM_MODEL || undefined, {
      baseUrl: process.env.LLM_BASE_URL || undefined,
      apiKey: envKeyFor(providerId),
      wire,
    }, "env");
  }

  // back-compat: today's single OpenAI-compatible endpoint
  const baseUrl = process.env.LLM_BASE_URL, model = process.env.LLM_MODEL;
  if (baseUrl && model) {
    const custom = providerById("custom")!;
    return routeFromPreset({ ...custom, id: "custom", label: "env LLM_BASE_URL" }, model, {
      baseUrl, apiKey: process.env.LLM_API_KEY || undefined,
    }, "env");
  }
  return null;
}

/** 1. per-user DB route - dynamic import so unit tests never open PGlite. */
async function dbRoute(userId: string, task: TaskKind): Promise<ResolvedRoute | null> {
  const { getDb, schema } = await import("@/db");
  const { and, eq } = await import("drizzle-orm");
  const db = await getDb();
  const [route] = await db.select().from(schema.llmTaskRoutes)
    .where(and(eq(schema.llmTaskRoutes.userId, userId), eq(schema.llmTaskRoutes.task, task))).limit(1);
  if (!route) return null;
  const [settings] = await db.select().from(schema.llmProviderSettings)
    .where(and(eq(schema.llmProviderSettings.userId, userId), eq(schema.llmProviderSettings.providerId, route.providerId))).limit(1);
  const preset = providerById(route.providerId)
    ?? { ...providerById("custom")!, id: route.providerId, label: route.providerId };
  const apiKey = settings ? await readProviderKey(settings) : undefined;
  const wire = isWireId(String(route.wire ?? "")) ? (route.wire as WireId)
    : isWireId(String(settings?.wire ?? "")) ? (settings!.wire as WireId) : undefined;
  return routeFromPreset(preset, route.model || undefined, {
    baseUrl: settings?.baseUrl || undefined,
    apiKey,
    wire,
  }, "db");
}

const TABLE_MISSING = /does not exist|undefined_table|no such table|42P01/i;

/** Full resolution chain. Throws a clear error on malformed env config. */
export async function resolveRoute(task: TaskKind, userId?: string): Promise<ResolvedRoute> {
  let r: ResolvedRoute | null = null;
  if (userId) {
    r = await dbRoute(userId, task).catch((e) => {
      // table genuinely absent (migration not applied yet) → the user simply
      // has no DB route. Any other failure (corrupt key, dead db) must NOT
      // silently fall through to another provider's route.
      if (TABLE_MISSING.test(String((e as Error)?.message ?? e))) return null;
      if (e instanceof LlmUnavailable) throw e;
      throw new LlmUnavailable(`llm route lookup failed: ${(e as Error)?.message ?? e}`);
    });
  }
  r ??= envRoute(task);
  if (!r) {
    throw new LlmUnavailable(
      "no LLM configured - set LLM_PROVIDER (e.g. ollama) or LLM_BASE_URL+LLM_MODEL",
    );
  }
  // hosted hard rule: a stored user route must resolve to https - a saved
  // http or loopback base URL is an SSRF the user typed, not an operator
  // choice.
  if (hostedMode() && r.source === "db" && !r.baseUrl.toLowerCase().startsWith("https://")) {
    throw new LlmUnavailable(`stored LLM route refused in hosted mode - user base URLs must be https`);
  }
  return r;
}

/**
 * Sync env check - is any LLM explicitly configured? (LLM_PROVIDER, the
 * LLM_BASE_URL+LLM_MODEL pair, or any LLM_TASK_*). Env-only on purpose: the
 * suggested ollama route is documentation, never an implicit on-switch.
 */
export function llmEnvConfigured(): boolean {
  if (process.env.LLM_PROVIDER) return true;
  if (process.env.LLM_BASE_URL && process.env.LLM_MODEL) return true;
  // only known task envs count - a stray LLM_TASK_* typo must not flip the
  // whole layer on
  return LLM_TASKS.some((t) => !!process.env[`LLM_TASK_${t.toUpperCase()}`]);
}

/**
 * Async variant that also checks for a per-user DB route. With `task` given,
 * the answer is about that task specifically - e.g. an LLM_TASK_VISION-only
 * setup does not turn the planner on.
 */
export async function llmConfigured(userId?: string, task?: TaskKind): Promise<boolean> {
  if (task) {
    try { await resolveRoute(task, userId); return true; }
    catch (e) { if (e instanceof LlmUnavailable) return false; throw e; }
  }
  if (llmEnvConfigured()) return true;
  if (!userId) return false;
  try {
    const { getDb, schema } = await import("@/db");
    const { and, eq } = await import("drizzle-orm");
    const db = await getDb();
    const [r] = await db.select({ task: schema.llmTaskRoutes.task }).from(schema.llmTaskRoutes)
      .where(and(eq(schema.llmTaskRoutes.userId, userId))).limit(1);
    return !!r;
  } catch {
    return false;
  }
}

export { PROVIDERS };
