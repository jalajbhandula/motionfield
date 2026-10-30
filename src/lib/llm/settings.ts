import { z } from "zod";
import { isWireId, type WireId } from "./adapters";
import { encryptSecret, keyAad } from "./crypto";
import { hostedMode, isLoopbackUrl, offlineMode } from "./offline";
import { PROVIDERS, providerById, type ProviderPreset } from "./providers";
import { readProviderKey } from "./provider-key";
import { LLM_TASKS, routeFromPreset, SUGGESTED_ROUTE, type ResolvedRoute, type TaskKind } from "./router";
import { LlmUnavailable } from "./types";

/**
 * Per-user LLM settings: provider keys + base URLs (llm_provider_settings),
 * per-task routes (llm_task_routes) and the offline flag (llm_user_prefs).
 * Keys are AES-256-GCM with AAD `${userId}:${providerId}` - a row copied to
 * another user or provider can never be decrypted. Reads never return key
 * material; `hasKey` is the only thing a client learns.
 */

const TABLE_MISSING = /does not exist|undefined_table|no such table|42P01/i;
export const isTableMissing = (e: unknown) => TABLE_MISSING.test(String((e as Error)?.message ?? e));

/** Error carrying an HTTP status - LLM route handlers map it to a response. */
export class LlmHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "LlmHttpError";
  }
}

const db = async () => (await import("@/db")).getDb();
const sch = async () => (await import("@/db")).schema;
const dq = async () => import("drizzle-orm");

/* ----------------------------- zod bodies ------------------------------ */

const WIRE_ENUM = z.enum(["openai-chat", "ollama"]);

export const ProviderPutBody = z.strictObject({
  apiKey: z.string().min(1).max(500).optional(),
  baseUrl: z.string().max(500).optional(),
  wire: WIRE_ENUM.optional(),
});

export const RoutePutBody = z.strictObject({
  providerId: z.string().min(1).max(80),
  model: z.string().max(200).optional(),
  wire: WIRE_ENUM.optional(),
});

export const TestBody = z.strictObject({
  providerId: z.string().min(1).max(80).optional(),
  task: z.enum(LLM_TASKS).optional(),
  model: z.string().max(200).optional(),
}).refine((b) => (b.providerId === undefined) !== (b.task === undefined), {
  message: "send exactly one of providerId or task",
});

export const PrefsPutBody = z.strictObject({
  offline: z.boolean().optional(),
  /** the caller's own SearXNG base URL - "" clears it, null clears it */
  searxngUrl: z.string().max(500).nullable().optional(),
}).refine((b) => b.offline !== undefined || b.searxngUrl !== undefined, {
  message: "nothing to save",
});

/** An Ollama tag (`qwen3.5:9b`, `org/name:tag`) or hf.co/<org>/<repo>[:quant]. */
const PULL_SEG = /[\w](?:[\w.-]*[\w])?/;
export const PULL_NAME = new RegExp(
  `^(?:hf\\.co/${PULL_SEG.source}/${PULL_SEG.source}|${PULL_SEG.source}(?:/${PULL_SEG.source})?)(?::${PULL_SEG.source})?$`);
export const PullBody = z.strictObject({ name: z.string().min(1).max(200).regex(PULL_NAME, "not an Ollama tag or hf.co/<org>/<repo>[:quant]") });

export const ScriptBody = z.strictObject({ text: z.string().min(1).max(4000) });

/* --------------------------- provider rows ----------------------------- */

export interface ProviderRow {
  providerId: string;
  baseUrl: string | null;
  wire: string | null;
  hasKey: boolean;
  updatedAt: Date;
}

const shapeRow = (r: {
  providerId: string; baseUrl: string | null; wire: string | null;
  apiKeyEnc: string | null; updatedAt: Date;
}): ProviderRow => ({ providerId: r.providerId, baseUrl: r.baseUrl, wire: r.wire, hasKey: !!r.apiKeyEnc, updatedAt: r.updatedAt });

export async function listProviderRows(userId: string): Promise<ProviderRow[]> {
  const [d, s, { eq }] = await Promise.all([db(), sch(), dq()]);
  try {
    const rows = await d.select().from(s.llmProviderSettings)
      .where(eq(s.llmProviderSettings.userId, userId));
    return rows.map(shapeRow);
  } catch (e) {
    if (isTableMissing(e)) return [];
    throw e;
  }
}

/** The raw drizzle row (includes apiKeyEnc) - internal use only; never let it
 *  reach a response. */
export async function getProviderRowRaw(userId: string, providerId: string) {
  const [d, s, { and, eq }] = await Promise.all([db(), sch(), dq()]);
  try {
    const [r] = await d.select().from(s.llmProviderSettings)
      .where(and(eq(s.llmProviderSettings.userId, userId), eq(s.llmProviderSettings.providerId, providerId)))
      .limit(1);
    return r ?? null;
  } catch (e) {
    if (isTableMissing(e)) return null;
    throw e;
  }
}

export async function getProviderRow(userId: string, providerId: string): Promise<ProviderRow | null> {
  const r = await getProviderRowRaw(userId, providerId);
  return r ? shapeRow(r) : null;
}

/**
 * Validate + persist one provider row. Keys encrypt with AAD; `apiKey` unset
 * keeps the stored key, "" clears it. Throws LlmHttpError on bad input.
 */
export async function putProviderRow(
  userId: string,
  providerId: string,
  body: z.infer<typeof ProviderPutBody>,
  lookup?: import("@/lib/api/webhooks").LookupAll,
): Promise<ProviderRow> {
  const preset = providerById(providerId);
  if (!preset) {
    // a non-preset id is only meaningful once a row exists (custom endpoints
    // ride the "custom" preset - arbitrary ids come from saved rows)
    const existing = await getProviderRow(userId, providerId);
    if (!existing) throw new LlmHttpError(`unknown provider "${providerId}"`, 404);
  }

  if (hostedMode() && preset?.local) {
    throw new LlmHttpError(`${preset.label}: local providers are not available in hosted mode`, 403);
  }
  if (body.baseUrl !== undefined && body.baseUrl !== "") {
    const why = await checkBaseUrl(body.baseUrl, lookup);
    if (why) throw new LlmHttpError(why, 400);
  }
  if (body.wire !== undefined && !isWireId(body.wire)) throw new LlmHttpError(`unknown wire "${body.wire}"`, 400);

  const [d, s, { and, eq }] = await Promise.all([db(), sch(), dq()]);
  const [existing] = await d.select().from(s.llmProviderSettings)
    .where(and(eq(s.llmProviderSettings.userId, userId), eq(s.llmProviderSettings.providerId, providerId))).limit(1);

  const apiKeyEnc = body.apiKey === undefined
    ? existing?.apiKeyEnc ?? null
    : body.apiKey === "" ? null : encryptSecret(body.apiKey, keyAad(userId, providerId));
  const baseUrl = body.baseUrl === undefined ? existing?.baseUrl ?? null : body.baseUrl || null;
  const wire = body.wire === undefined ? existing?.wire ?? null : body.wire;

  const [row] = await d.insert(s.llmProviderSettings)
    .values({ userId, providerId, baseUrl, wire, apiKeyEnc, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [s.llmProviderSettings.userId, s.llmProviderSettings.providerId],
      set: { baseUrl, wire, apiKeyEnc, updatedAt: new Date() },
    })
    .returning();
  return shapeRow(row);
}

export async function deleteProviderRow(userId: string, providerId: string): Promise<boolean> {
  const [d, s, { and, eq }] = await Promise.all([db(), sch(), dq()]);
  const rows = await d.delete(s.llmProviderSettings)
    .where(and(eq(s.llmProviderSettings.userId, userId), eq(s.llmProviderSettings.providerId, providerId)))
    .returning({ providerId: s.llmProviderSettings.providerId });
  return rows.length > 0;
}

export { readProviderKey } from "./provider-key";

/* ----------------------------- task routes ------------------------------ */

export interface TaskRouteRow {
  task: string;
  providerId: string;
  model: string;
  wire: string | null;
  updatedAt: Date;
}

export async function listTaskRoutes(userId: string): Promise<TaskRouteRow[]> {
  const [d, s, { eq }] = await Promise.all([db(), sch(), dq()]);
  try {
    const rows = await d.select().from(s.llmTaskRoutes)
      .where(eq(s.llmTaskRoutes.userId, userId));
    return rows.map((r: { task: string; providerId: string; model: string; wire: string | null; updatedAt: Date }) => ({ task: r.task, providerId: r.providerId, model: r.model, wire: r.wire, updatedAt: r.updatedAt }));
  } catch (e) {
    if (isTableMissing(e)) return [];
    throw e;
  }
}

/** Why a provider can't serve a task, or null. Used by the API and the UI
 *  (the same reason disables the option and rejects the write). */
export function taskGuard(
  task: string,
  caps: { tools: boolean; vision: boolean; jsonSchema: boolean },
): string | null {
  if (task === "planner" && !caps.tools) return "planner needs tool use";
  if (task === "vision" && !caps.vision) return "vision needs image input";
  return null;
}

/**
 * Validate + persist a per-task route. Provider must be a preset or an id
 * with a saved provider row carrying a base URL.
 * Capability mismatches are refused with the reason, not just disabled in UI.
 */
export async function putTaskRoute(
  userId: string,
  task: TaskKind,
  body: z.infer<typeof RoutePutBody>,
): Promise<TaskRouteRow> {
  if (!LLM_TASKS.includes(task)) throw new LlmHttpError(`unknown task "${task}"`, 404);
  const preset = providerById(body.providerId);
  const row = await getProviderRow(userId, body.providerId);

  if (!preset && !row?.baseUrl) {
    throw new LlmHttpError(`unknown provider "${body.providerId}" - save its base URL first`, 404);
  }
  if (preset?.id === "custom" && !row?.baseUrl) {
    throw new LlmHttpError("Custom needs a base URL - save one under Self-hosted endpoint first", 400);
  }

  if (preset?.local && hostedMode()) {
    throw new LlmHttpError(`${preset.label}: local providers are not available in hosted mode`, 403);
  }
  const caps = preset?.capabilities ?? providerById("custom")!.capabilities;
  const guarded = taskGuard(task, caps);
  if (guarded) throw new LlmHttpError(`${preset?.label ?? body.providerId}: ${guarded}`, 400);

  const model = (body.model ?? "").trim();
  if (!model && !preset?.defaultModel) {
    throw new LlmHttpError("model is required for this provider", 400);
  }
  const wire: WireId | null = body.wire ?? (row?.wire as WireId | null) ?? preset?.wire ?? null;

  const [d, s, { and, eq }] = await Promise.all([db(), sch(), dq()]);
  const [saved] = await d.insert(s.llmTaskRoutes)
    .values({ userId, task, providerId: body.providerId, model, wire, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [s.llmTaskRoutes.userId, s.llmTaskRoutes.task],
      set: { providerId: body.providerId, model, wire, updatedAt: new Date() },
    })
    .returning();
  return { task: saved.task, providerId: saved.providerId, model: saved.model, wire: saved.wire, updatedAt: saved.updatedAt };
}

export async function deleteTaskRoute(userId: string, task: string): Promise<boolean> {
  const [d, s, { and, eq }] = await Promise.all([db(), sch(), dq()]);
  const rows = await d.delete(s.llmTaskRoutes)
    .where(and(eq(s.llmTaskRoutes.userId, userId), eq(s.llmTaskRoutes.task, task)))
    .returning({ task: s.llmTaskRoutes.task });
  return rows.length > 0;
}

/**
 * A one-off provider+model pick (the composer's planner picker) resolved
 * against the user's saved provider row - base URL, wire and API key come
 * from llm_provider_settings exactly like a stored task route. Same policy:
 * local providers are refused in hosted mode, unknown ids need a saved base
 * URL. The returned
 * route still goes through dispatchChat's offline/hosted gates.
 */
export async function resolveExplicitRoute(
  userId: string, providerId: string, model?: string,
): Promise<ResolvedRoute> {
  const preset = providerById(providerId);
  const raw = await getProviderRowRaw(userId, providerId);
  if (!preset && !raw?.baseUrl) {
    throw new LlmHttpError(`unknown provider "${providerId}" - save its base URL first`, 404);
  }
  if (hostedMode() && preset?.local) {
    throw new LlmHttpError(`${preset.label}: local providers are not available in hosted mode`, 403);
  }
  const base = preset ?? { ...providerById("custom")!, id: providerId, label: providerId };
  const apiKey = raw ? await readProviderKey(raw) : undefined;
  const wire = isWireId(String(raw?.wire ?? "")) ? (raw!.wire as WireId) : undefined;
  return routeFromPreset(base, model || undefined, {
    baseUrl: raw?.baseUrl || undefined,
    apiKey,
    wire,
  }, "db");
}

/* ------------------------------ user prefs ------------------------------ */

export interface UserPrefs {
  offline: boolean;
  locked: boolean;
  /** the caller's SearXNG base URL or null (web_search disabled) */
  searxngUrl: string | null;
}

export async function getPrefs(userId: string): Promise<UserPrefs> {
  const locked = offlineMode(); // MOTIONFIELD_OFFLINE=1 forces the toggle on
  const [d, s, { eq }] = await Promise.all([db(), sch(), dq()]);
  try {
    const [row] = await d.select().from(s.llmUserPrefs)
      .where(eq(s.llmUserPrefs.userId, userId)).limit(1);
    return { offline: locked || !!row?.offline, locked, searxngUrl: row?.searxngUrl ?? null };
  } catch (e) {
    if (isTableMissing(e)) return { offline: locked, locked, searxngUrl: null };
    throw e;
  }
}

export async function setPrefs(userId: string, offline: boolean): Promise<{ offline: boolean; locked: boolean }> {
  if (offlineMode()) throw new LlmHttpError("Offline is locked on by MOTIONFIELD_OFFLINE=1", 409);
  const [d, s, { eq }] = await Promise.all([db(), sch(), dq()]);
  await d.insert(s.llmUserPrefs)
    .values({ userId, offline, updatedAt: new Date() })
    .onConflictDoUpdate({ target: s.llmUserPrefs.userId, set: { offline, updatedAt: new Date() } });
  if (offline) {
    // turning Offline on aborts a live hub transfer - the network it needs
    // is refused from here on (lazy import keeps the module graph acyclic)
    const { abortActiveHubTransfers } = await import("@/lib/model-hub/downloads");
    abortActiveHubTransfers();
  }
  return { offline, locked: false };
}

/** The per-user offline flag every LLM call honors: env OR saved pref. */
export async function userOffline(userId: string): Promise<boolean> {
  if (offlineMode()) return true;
  return (await getPrefs(userId)).offline;
}

/* ------------------------- web search (SearXNG) ------------------------- */

/** The configured SearXNG base URL, or null - web_search's only provider.
 *  An external AGPL service the user runs themselves; never bundled. */
export async function getSearxngUrl(userId: string): Promise<string | null> {
  return (await getPrefs(userId)).searxngUrl;
}

/**
 * Save/clear the caller's SearXNG base URL. http(s) always; while Offline is
 * on only loopback passes; hosted deployments need an https URL that
 * survives the webhook SSRF deny rules. Clearing keeps the row's other prefs.
 */
export async function setSearxngUrl(
  userId: string,
  url: string | null,
  lookup?: import("@/lib/api/net-guard").LookupAll,
): Promise<{ searxngUrl: string | null }> {
  const clean = url === null || url.trim() === "" ? null : url.trim().replace(/\/+$/, "");
  if (clean !== null) {
    let u: URL;
    try { u = new URL(clean); } catch { throw new LlmHttpError("invalid SearXNG base URL", 400); }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new LlmHttpError("SearXNG base URL must be http or https", 400);
    }
    if (await userOffline(userId) && !isLoopbackUrl(clean)) {
      throw new LlmHttpError("Offline mode - the SearXNG base URL must be loopback", 400);
    }
    if (hostedMode()) {
      const why = await checkBaseUrl(clean, lookup);
      if (why) throw new LlmHttpError(why, 400);
    }
  }
  const [d, s, { eq }] = await Promise.all([db(), sch(), dq()]);
  await d.insert(s.llmUserPrefs)
    .values({ userId, searxngUrl: clean, updatedAt: new Date() })
    .onConflictDoUpdate({ target: s.llmUserPrefs.userId, set: { searxngUrl: clean, updatedAt: new Date() } });
  return { searxngUrl: clean };
}

/* ---------------------------- URL validation ---------------------------- */

/**
 * Base-URL policy. Always: a parseable http(s) URL. Hosted: https only and
 * it must survive the webhook SSRF deny rules - loopback/private/link-local/
 * metadata addresses, checked after DNS.
 */
export async function checkBaseUrl(
  baseUrl: string,
  lookup?: import("@/lib/api/webhooks").LookupAll,
): Promise<string | null> {
  let u: URL;
  try { u = new URL(baseUrl); } catch { return "invalid base URL"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "base URL must be http or https";
  if (!hostedMode()) return null;
  if (u.protocol !== "https:") return "hosted mode requires https base URLs";
  const { webhookTargetDenied } = await import("@/lib/api/webhooks");
  const denied = await webhookTargetDenied(baseUrl, lookup);
  return denied ? `base URL not allowed in hosted mode (${denied.reason})` : null;
}

/* ----------------------------- local probe ------------------------------ */

const PROBE_TIMEOUT_MS = 1_500;
const TAGS_SHAPE = z.looseObject({ models: z.array(z.looseObject({ name: z.string() })).optional() });
const MODELS_SHAPE = z.looseObject({ data: z.array(z.looseObject({ id: z.string() })).optional() });

const stripV1 = (u: string) => u.replace(/\/+$/, "").replace(/\/v1$/i, "");

/** One loopback probe per local preset (1.5 s). Returns detected + reported
 *  model names; a dead endpoint just reports detected:false. */
export async function probeLocalProviders(
  savedBaseUrls: Map<string, string> = new Map(),
): Promise<{ id: string; detected: boolean; models: string[] }[]> {
  return Promise.all(PROVIDERS.filter((p) => p.local).map(async (p) => {
    const base = (savedBaseUrls.get(p.id) ?? p.baseUrl).replace(/\/+$/, "");
    try {
      if (p.id === "ollama") {
        const res = await fetch(`${stripV1(base)}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) return { id: p.id, detected: false, models: [] };
        const j = TAGS_SHAPE.safeParse(await res.json().catch(() => null));
        return { id: p.id, detected: true, models: j.success ? (j.data.models ?? []).map((m) => m.name) : [] };
      }
      const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!res.ok) return { id: p.id, detected: false, models: [] };
      const j = MODELS_SHAPE.safeParse(await res.json().catch(() => null));
      return { id: p.id, detected: true, models: j.success ? (j.data.data ?? []).map((m) => m.id) : [] };
    } catch {
      return { id: p.id, detected: false, models: [] };
    }
  }));
}

/* ------------------------------ Ollama pull ----------------------------- */

export interface PullEvent {
  status: string;
  percent?: number;
  total?: number;
  completed?: number;
  error?: string;
  done: boolean;
}

/**
 * Proxy one Ollama /api/pull on a loopback base, forwarding NDJSON progress as
 * normalized events. Never a real pull in tests - the base URL is injectable
 * so a stub server stands in.
 */
export async function pullOllamaModel(
  name: string,
  opts: { baseUrl: string; signal?: AbortSignal; onEvent?: (e: PullEvent) => void },
): Promise<void> {
  const base = stripV1(opts.baseUrl);
  if (!isLoopbackUrl(base)) throw new LlmUnavailable("model pull only works against a loopback Ollama");
  const res = await fetch(`${base}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, stream: true }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const host = new URL(base).host;
    throw new LlmUnavailable(`${host}: HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let sawSuccess = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let j: { status?: string; total?: number; completed?: number; error?: string };
      try { j = JSON.parse(line); } catch { continue; }
      if (j.error) throw new LlmUnavailable(`${new URL(base).host}: ${String(j.error).slice(0, 200)}`);
      const status = String(j.status ?? "");
      if (status === "success") sawSuccess = true;
      const ev: PullEvent = {
        status,
        total: typeof j.total === "number" ? j.total : undefined,
        completed: typeof j.completed === "number" ? j.completed : undefined,
        percent: j.total && j.completed !== undefined ? Math.min(100, Math.round((j.completed / j.total) * 100)) : undefined,
        done: status === "success",
      };
      opts.onEvent?.(ev);
    }
  }
  // the stream only "completed" when Ollama's own success line arrived - a
  // dropped connection mid-pull is NOT a successful pull
  opts.onEvent?.(sawSuccess
    ? { status: "success", percent: 100, done: true }
    : { status: "pull ended early", error: "pull ended early - no success line from Ollama", done: true });
}

/** Ollama base URL for pulls: the user's saved row, else the preset default. */
export async function ollamaBase(userId: string): Promise<string> {
  const row = await getProviderRow(userId, "ollama").catch(() => null);
  return (row?.baseUrl ?? providerById("ollama")!.baseUrl);
}

/* ------------------------- grouped provider view ------------------------ */

export interface ProviderView {
  id: string;
  label: string;
  doc: string;
  group: "local" | "endpoint";
  status: string;
  hasKey?: boolean;
  baseUrl?: string | null;
  wire?: string | null;
  models?: string[];
  defaultModel?: string;
  capabilities: ProviderPreset["capabilities"];
  local: boolean;
}

/**
 * The Settings → Models & LLMs payload: local runtimes (probed) plus the
 * custom self-hosted endpoint. Hosted mode omits the local group entirely
 * (it's refused server-side too).
 */
export async function buildProvidersView(userId: string): Promise<{
  hosted: boolean;
  suggested: typeof SUGGESTED_ROUTE;
  providers: ProviderView[];
}> {
  const hosted = hostedMode();
  const rows = await listProviderRows(userId);
  const rowOf = (id: string) => rows.find((r) => r.providerId === id);
  const providers: ProviderView[] = [];

  if (!hosted) {
    const saved = new Map(rows.filter((r) => r.baseUrl).map((r) => [r.providerId, r.baseUrl!]));
    const probes = await probeLocalProviders(saved);
    for (const p of PROVIDERS.filter((x) => x.local)) {
      const probe = probes.find((x) => x.id === p.id);
      providers.push({
        id: p.id, label: p.label, doc: p.doc, group: "local", local: true,
        status: probe?.detected ? "detected" : "not_set",
        models: probe?.models ?? [],
        baseUrl: rowOf(p.id)?.baseUrl ?? null,
        defaultModel: p.defaultModel, capabilities: p.capabilities,
      });
    }
  }

  for (const p of PROVIDERS.filter((x) => !x.local)) {
    const row = rowOf(p.id);
    providers.push({
      id: p.id, label: p.label, doc: p.doc, group: "endpoint", local: false,
      status: row?.hasKey ? "key saved" : "not set",
      hasKey: row?.hasKey ?? false,
      baseUrl: row?.baseUrl ?? null,
      wire: row?.wire ?? null,
      defaultModel: p.defaultModel, capabilities: p.capabilities,
    });
  }

  return { hosted, suggested: SUGGESTED_ROUTE, providers };
}
