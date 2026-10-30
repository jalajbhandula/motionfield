/* Caller-key verification - every request carries its own `of_…` bearer,
 *  checked against GET /api/v1/me and cached ≤60 s. The cache key is the
 *  key's sha256, never the cleartext, and the same entry holds the caller's
 *  capabilities + model catalog so a request burst doesn't re-hit the API.
 *  A refusal caches ONLY on the API's own 401/403 - a network error or a
 *  5xx is upstream trouble: nothing is cached (the next request retries)
 *  and server.mts answers 502, not 401. The map is bounded on every insert:
 *  stale entries drop first, then the oldest while it's still over 1024. */

import { createHash } from "node:crypto";
import { MotionField, MotionFieldError, type Model } from "../../../sdk-ts/src/index.ts";
import type { HttpEnv } from "./env.mts";

const TTL_MS = 60_000;
const MAX_ENTRIES = 1024;

export interface CallerCtx {
  /** the caller's key - lives only inside this request's ctx client. */
  key: string;
  userId: string;
  caps: Set<string>;
  endpoints: Set<string> | null;
  models: ReadonlyMap<string, Model> | null;
}

/** What the key check decided - server.mts maps it onto 200/401/502. */
export type CallerResult =
  | { kind: "ok"; ctx: CallerCtx }
  /** the API itself refused the key (401/403) - cached so a hammered bad
   *  key doesn't re-verify every request. */
  | { kind: "refused" }
  /** the API couldn't answer (network error, or still failing after the
   *  SDK's 5xx retries) - never cached; the caller sees 502. */
  | { kind: "upstream" };

interface CacheEntry {
  at: number;
  /** null = the key was refused (cached so a hammered bad key doesn't
   *  re-verify every request). */
  ok: CallerCtx | null;
}

const cache = new Map<string, CacheEntry>();

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Insert `entry` under `sha`, then bound the map - every insert, refusals
 *  included: stale entries always drop first; still over the cap → evict
 *  oldest-first (Map iterates in insertion order). */
function insert(sha: string, entry: CacheEntry): void {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at >= TTL_MS) cache.delete(k);
  cache.delete(sha); // re-insert at the tail so an existing key refreshes its age
  cache.set(sha, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Resolved caller for `key` - refused only on the API's own 401/403,
 *  upstream when /api/v1/me couldn't answer. The caller's caps+models fetch
 *  with the same key and degrade exactly like stdio when either fetch fails
 *  (gated tools answer not_available, nothing crashes). */
export async function callerCtx(env: HttpEnv, key: string): Promise<CallerResult> {
  const sha = sha256(key);
  const hit = cache.get(sha);
  if (hit && Date.now() - hit.at < TTL_MS)
    return hit.ok ? { kind: "ok", ctx: hit.ok } : { kind: "refused" };

  const client = new MotionField({ baseUrl: env.url, apiKey: key, source: "mcp" });
  let userId: string;
  try {
    userId = (await client.me()).user_id;
  } catch (e) {
    if (e instanceof MotionFieldError && (e.status === 401 || e.status === 403)) {
      insert(sha, { at: Date.now(), ok: null });
      return { kind: "refused" };
    }
    return { kind: "upstream" };
  }

  let caps = new Set<string>();
  try { caps = new Set(await client.capabilities()); } catch { /* degrade */ }
  let endpoints: Set<string> | null = null;
  let models: Map<string, Model> | null = null;
  try {
    const list = await client.models();
    endpoints = new Set(list.map((m) => m.id));
    models = new Map(list.map((m) => [m.id, m]));
  } catch { /* degrade - gated tools report not_available */ }

  const ok: CallerCtx = { key, userId, caps, endpoints, models };
  insert(sha, { at: Date.now(), ok });
  return { kind: "ok", ctx: ok };
}
