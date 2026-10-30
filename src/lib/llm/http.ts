import { LLM_TIMEOUT_MS, LlmRequestError, LlmUnavailable } from "./types";

/**
 * Shared POST-JSON transport for every wire adapter.
 *
 * Retry policy: up to `retries` re-attempts (default 3) on 429 and 5xx - a
 * local model may still be loading on the first call. Timeouts and
 * connection failures get ONE retry at most: each attempt can burn a full
 * `timeoutMs` (120 s default), so a bigger budget multiplies worst-case
 * latency far beyond what callers expect. Backoff is exponential
 * (400ms · 2^n, capped 8s, +jitter) and honors a server Retry-After header
 * (capped 15s).
 *
 * Every attempt gets a FRESH AbortSignal.any([caller, timeout]) - a previous
 * attempt's timeout must not carry over and pre-abort the retry. Caller
 * aborts re-throw unchanged; they are never converted into transport errors.
 */

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(t);
    rej(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
  }, { once: true });
});

/** Parse Retry-After (seconds or HTTP-date), capped at 15s. */
function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  const ms = Number.isFinite(secs)
    ? secs * 1000
    : Math.max(0, Date.parse(h) - Date.now());
  return Number.isFinite(ms) ? Math.min(ms, 15_000) : null;
}

const backoffMs = (attempt: number) =>
  Math.min(8_000, 400 * 2 ** attempt) + Math.floor(Math.random() * 200);

const hostOf = (url: string) => {
  try { return new URL(url).host; } catch { return url; }
};

export interface PostJsonOptions {
  headers?: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Extra attempts after the first (default 3 → up to 4 total for 429/5xx;
   *  timeouts and connection failures retry at most once regardless). */
  retries?: number;
  /** Provider label + model for actionable error messages. */
  label?: string;
  model?: string;
}

export async function postJson(url: string, opts: PostJsonOptions): Promise<{ status: number; json: unknown }> {
  const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;
  const maxAttempts = 1 + Math.max(0, opts.retries ?? 3);
  const where = opts.label ?? hostOf(url);
  // timeouts + connection failures each burn up to timeoutMs - one retry only
  const transportBudget = Math.min(1, maxAttempts - 1);
  let transportRetries = 0;
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    opts.signal?.throwIfAborted();
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...opts.headers },
        body: JSON.stringify(opts.body),
        signal,
        // hosted deployments never follow redirects - a 30x to a private
        // address would sidestep the base-URL validation
        redirect: process.env.MOTIONFIELD_HOSTED === "1" ? "error" : "follow",
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e; // caller canceled - not a transport failure
      const err = e as Error;
      const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
      lastErr = new LlmUnavailable(
        timedOut
          ? `LLM at ${where} timed out after ${Math.round(timeoutMs / 1000)}s (${opts.model ?? "model"} may still be loading - retry)`
          : `can't reach the LLM at ${where} - is the provider running and the model pulled?`,
      );
      if (attempt < maxAttempts - 1 && transportRetries < transportBudget) {
        transportRetries++;
        await sleep(backoffMs(attempt), opts.signal);
        continue;
      }
      throw lastErr;
    }

    if (res.ok) {
      const json = await res.json().catch(() => {
        throw new LlmUnavailable(`LLM at ${where} returned a non-JSON body - a proxy or error page answered instead of the API`);
      });
      return { status: res.status, json };
    }

    const body = await res.text().catch(() => {
      throw new LlmUnavailable(`LLM request failed (${res.status}) at ${where} - error body unreadable`);
    });
    // 429 + 5xx retry - except 501, which is a stable "not implemented" signal
    const retryable = res.status === 429 || (res.status >= 500 && res.status !== 501);
    if (retryable && attempt < maxAttempts - 1) {
      await sleep(retryAfterMs(res) ?? backoffMs(attempt), opts.signal);
      continue;
    }
    if (res.status === 404 || /not found|does not exist|pull .*model/i.test(body)) {
      throw new LlmRequestError(
        `model "${opts.model ?? "?"}" not available at ${where} - pull/load it first`,
        res.status, body,
      );
    }
    throw new LlmRequestError(`LLM request failed (${res.status}) at ${where}`, res.status, body);
  }
  throw lastErr ?? new LlmUnavailable(`LLM at ${where} timed out`);
}
