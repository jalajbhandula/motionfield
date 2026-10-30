import { z } from "zod";
import { isWireId, type WireId } from "./adapters";
import { chatJson, dispatchChat, llmConfigured } from "./index";
import { hostedMode } from "./offline";
import { providerById } from "./providers";
import { readProviderKey } from "./provider-key";
import {
  routeFromPreset,
  resolveRoute,
  type ResolvedRoute,
  type TaskKind,
} from "./router";
import { getProviderRow, getProviderRowRaw, LlmHttpError, probeLocalProviders } from "./settings";
import { LlmRequestError, LlmUnavailable, OfflineBlocked } from "./types";

/**
 * API-facing operations built on the routed LLM layer: a one-shot connection
 * test and the narration-script writer the Assistant calls for spoken
 * steps.
 */

const TEST_PROMPT = "Reply with the single word: ok";
const TEST_MAX_TOKENS = 8;
const TEST_TIMEOUT_MS = 15_000;

export interface TestResult {
  ok: boolean;
  latencyMs?: number;
  provider?: string;
  model?: string;
  error?: string;
}

/** Build a ResolvedRoute for one provider id - a preset, or an id with a
 *  saved base-URL row (the custom-provider path). */
export async function resolveProviderRoute(
  userId: string,
  providerId: string,
  model?: string,
): Promise<ResolvedRoute> {
  const row = await getProviderRowRaw(userId, providerId);
  const preset = providerById(providerId)
    ?? (row ? { ...providerById("custom")!, id: providerId, label: providerId } : undefined);
  if (!preset) throw new LlmHttpError(`unknown provider "${providerId}"`, 404);
  if (preset.local && hostedMode()) {
    throw new LlmHttpError(`${preset.label}: local providers are not available in hosted mode`, 403);
  }

  const baseUrl = (row?.baseUrl ?? preset.baseUrl).replace(/\/$/, "");
  let m = model?.trim() ?? "";
  if (!m && preset.local) {
    // prefer the first model the local server actually reports
    const saved = new Map(row?.baseUrl ? [[providerId, row.baseUrl]] : []);
    const probes = await probeLocalProviders(saved);
    m = probes.find((p) => p.id === providerId)?.models[0] ?? "";
  }
  m ||= preset.defaultModel ?? "";
  if (!baseUrl) throw new LlmHttpError(`${preset.label} has no base URL - save one first`, 400);
  if (!m) throw new LlmHttpError("no model to test - pick one or pull it first", 400);

  const apiKey = row ? await readProviderKey(row) : undefined;
  const wire = isWireId(String(row?.wire ?? "")) ? (row!.wire as WireId) : undefined;
  return routeFromPreset(preset, m, { baseUrl, apiKey, wire }, "db");
}

/** Terse, secret-free error text: a host + status, or our own refusal line. */
function testError(e: unknown, route: ResolvedRoute | null): string {
  const host = route && /^https?:/i.test(route.baseUrl) ? new URL(route.baseUrl).host : route?.label ?? "provider";
  // the overall AbortSignal.timeout cap fires mid-retry - a raw TimeoutError,
  // not an LlmUnavailable
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return `${host}: timed out`;
  if (e instanceof LlmRequestError) return `${host}: HTTP ${e.status}`;
  if (e instanceof OfflineBlocked) return "offline: remote route blocked";
  if (e instanceof LlmHttpError) return e.message; // our own policy wording
  if (e instanceof LlmUnavailable) {
    const msg = e.message;
    if (/timed? ?out|can'?t reach|ECONNREFUSED|ENOTFOUND|unreachable/i.test(msg)) return `${host}: unreachable`;
    if (msg.startsWith(route?.label ?? "\0")) return msg.slice(0, 160);
    return `${host}: ${msg.slice(0, 120)}`;
  }
  return `${host}: error`;
}

/**
 * The Settings "Test" button: resolve the route (task or provider) and make
 * one tiny chat - ≤8 output tokens, 15 s ceiling. `ok:false` is a truthful
 * diagnostic, never a synthetic probe of an unconfigured provider.
 */
export async function testConnection(
  userId: string,
  body: { providerId?: string; task?: TaskKind; model?: string },
): Promise<TestResult> {
  let route: ResolvedRoute;
  try {
    route = body.task
      ? await resolveRoute(body.task, userId)
      : await resolveProviderRoute(userId, body.providerId!, body.model);
  } catch (e) {
    return { ok: false, error: testError(e, null) };
  }
  const started = Date.now();
  try {
    await dispatchChat(route, {
      messages: [{ role: "user", content: TEST_PROMPT }],
      maxTokens: TEST_MAX_TOKENS,
      temperature: 0,
      timeoutMs: TEST_TIMEOUT_MS,
      // hard ceiling across retries: each attempt may burn a full timeoutMs
      // and a stalled first attempt gets one retry - the cap keeps the total
      // at 15 s, not 15 s per attempt
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    }, userId);
    return { ok: true, latencyMs: Date.now() - started, provider: route.label, model: route.model };
  } catch (e) {
    return { ok: false, error: testError(e, route) };
  }
}

/* ------------------------- narration script writer ---------------------- */

const SCRIPT_SHAPE = z.object({ script: z.string().min(1) });

/**
 * "Reads your text" steps get a spoken-word script from the writer route when
 * one is configured - verbatim text otherwise (the step label stays honest
 * either way).
 */
export async function narrationScript(
  userId: string,
  text: string,
  signal?: AbortSignal,
): Promise<{ script: string; byLlm: boolean }> {
  if (!(await llmConfigured(userId))) return { script: text, byLlm: false };
  try {
    const out = await chatJson("writer", SCRIPT_SHAPE, {
      messages: [
        {
          role: "system",
          content:
            "Rewrite the given text as a short spoken-word narration script for a video voice-over. " +
            'Strict JSON: {"script": string}. Natural spoken English - no stage directions, no markdown, ' +
            "no headings. Keep it under ~90 words unless the source is longer.",
        },
        { role: "user", content: text },
      ],
      timeoutMs: 30_000,
      signal,
    }, { userId });
    const script = out.data.script.trim();
    return script ? { script, byLlm: true } : { script: text, byLlm: false };
  } catch {
    // unreachable writer → the step still reads the user's text verbatim
    return { script: text, byLlm: false };
  }
}
