import crypto from "crypto";
import type { LookupFunction } from "net";
import http from "http";
import https from "https";
import { promises as fsp } from "fs";
import { sql } from "@/db";
import { filePathFor } from "@/lib/storage";
import { jobView, type JobOutput } from "./job-shape";
import {
  defaultLookup, pinningLookup, webhookTargetDenied, DestinationDeniedError,
} from "./net-guard";
import type { LookupAll } from "./net-guard";

// The destination guard lives in ./net-guard so the MCP process can share it;
// keep the historical import path working for callers and tests.
export { webhookTargetDenied, pinningLookup, DestinationDeniedError };
export type { LookupAll };

/**
 * Signed webhook delivery for job terminal events.
 *
 * Every API key carries a signing secret (`ofwh_…`) shown once at creation or
 * rotation, stored AES-256-GCM-encrypted under a key derived from
 * BETTER_AUTH_SECRET via HKDF-SHA256 (info "motionfield-webhook-secret").
 * Deliveries are enqueued once per job per terminal type and retried on a fixed
 * schedule; the frozen `body` is resent verbatim so signatures stay stable.
 */

/* ---------- signing-secret crypto ---------- */

const HKDF_INFO = "motionfield-webhook-secret";
const ENC_PREFIX = "ofe1";

function encKey(): Buffer {
  const ikm = process.env.BETTER_AUTH_SECRET
    ?? (process.env.MOTIONFIELD_HOSTED === "1" ? null : "dev-secret-change-me-in-production-0123456789");
  if (!ikm) throw new Error("BETTER_AUTH_SECRET is required when MOTIONFIELD_HOSTED=1");
  return Buffer.from(crypto.hkdfSync("sha256", ikm, "motionfield", HKDF_INFO, 32));
}

export function generateWebhookSecret(): string {
  return `ofwh_${crypto.randomBytes(32).toString("base64url")}`;
}

/** `aad` binds the envelope to the owning api_keys.id so it can't be
 *  transplanted onto another key. */
export function encryptWebhookSecret(plain: string, aad?: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  if (aad) c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${ENC_PREFIX}.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
}

/** Returns the plaintext `ofwh_…` secret, or null when the stored value is not
 *  a decryptable `ofe1.` envelope. Envelopes written before AAD binding existed
 *  still decrypt - the no-AAD read is the fallback, not the primary. */
export function decryptWebhookSecret(stored: string, aad?: string): string | null {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== ENC_PREFIX) return null;
  const [, iv, tag, ct] = parts;
  for (const a of aad ? [aad, undefined] : [undefined]) {
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", encKey(), Buffer.from(iv, "base64url"));
      if (a) d.setAAD(Buffer.from(a, "utf8"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
    } catch { /* fall through to the no-AAD read */ }
  }
  return null;
}

/* ---------- signature ---------- */

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "${t}.${body}")>` */
export function signWebhookHeader(secret: string, body: string, timestampSec = Math.floor(Date.now() / 1000)): string {
  const sig = crypto.createHmac("sha256", secret).update(`${timestampSec}.${body}`, "utf8").digest("hex");
  return `t=${timestampSec},v1=${sig}`;
}

/** Receiver-side verification: parses `t=…,v1=…`, enforces the timestamp
 *  tolerance and compares digests in constant time. */
export function verifyWebhookSignature(
  secret: string,
  header: string | null | undefined,
  body: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  const fields = new Map(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(fields.get("t"));
  const v1 = fields.get("v1") ?? "";
  if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  const a = Buffer.from(v1, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- enqueue ---------- */

export type TerminalEventType = "job.completed" | "job.failed" | "job.nsfw" | "job.canceled";

type QueryRunner = (query: string, params?: unknown[]) => Promise<unknown[]>;

interface EnqueueJobRow {
  id: string;
  status: string;
  progress: number;
  outputs: unknown;
  error: string | null;
  endpoint_id: string;
  kind: string;
  params: unknown;
  created_at: unknown;
  updated_at: unknown;
  api_key_id: string | null;
  provider_meta: Record<string, unknown> | null;
  source: string;
}

async function localFileBytes(url: string): Promise<number | null> {
  const p = filePathFor(url);
  if (!p) return null;
  try { return (await fsp.stat(p)).size; } catch { return null; }
}

/**
 * Enqueue the (single) terminal delivery for a job. Called from the
 * claim-winner branch of each terminal transition; pass the transaction's
 * query runner so the delivery row is atomic with the claim. No-op unless the
 * job has both an api_key_id and a stored webhook_url.
 */
export async function enqueueTerminalWebhook(
  jobId: string,
  type: TerminalEventType,
  opts: { q?: QueryRunner } = {},
): Promise<void> {
  const run: QueryRunner = opts.q ?? ((query, params) => sql(query, params ?? []));
  const [job] = (await run(
    `SELECT id, status, progress, outputs, error, endpoint_id, kind, params,
            created_at, updated_at, api_key_id, provider_meta, source
     FROM jobs WHERE id = $1`,
    [jobId])) as EnqueueJobRow[];
  if (!job?.api_key_id) return;
  const url = (job.provider_meta ?? {}).webhook_url;
  if (typeof url !== "string" || !url) return;

  const outputs = (job.outputs as JobOutput[] | null) ?? [];
  const assetRows = (await run(
    `SELECT url, bytes, mime FROM assets WHERE job_id = $1`, [jobId])) as { url: string; bytes: number | null; mime: string | null }[];
  const assets = new Map(assetRows.map((r) => [r.url, { bytes: r.bytes == null ? null : Number(r.bytes), mime: r.mime }]));
  // stat fallback for asset rows written before bytes was persisted (same rule
  // as GET /api/v1/jobs/:id)
  await Promise.all(outputs.map(async (o) => {
    if (o.url && assets.get(o.url)?.bytes == null) {
      const info = assets.get(o.url) ?? { bytes: null, mime: null };
      info.bytes = await localFileBytes(o.url);
      assets.set(o.url, info);
    }
  }));

  // Frozen at enqueue: retries resend these exact bytes.
  const data = jobView(
    { id: job.id, status: job.status, progress: job.progress, outputs: job.outputs, error: job.error,
      endpointId: job.endpoint_id, kind: job.kind, params: job.params,
      source: job.source, createdAt: job.created_at, updatedAt: job.updated_at },
    assets,
  );
  const id = crypto.randomUUID();
  const body = JSON.stringify({ id, type, created: Math.floor(Date.now() / 1000), data });
  await run(
    `INSERT INTO webhook_deliveries (id, job_id, api_key_id, type, url, body, status, next_attempt_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending', now())
     ON CONFLICT (job_id, type) DO NOTHING`,
    [id, jobId, job.api_key_id, type, url, body]);
}

/* ---------- delivery ---------- */

const MAX_DELIVERIES_PER_SWEEP = 10;
const ATTEMPT_TIMEOUT_MS = 10_000;
const STALE_DELIVERING_MS = 60_000;
const RESPONSE_READ_CAP = 64 * 1024;
const MAX_ATTEMPTS = 6;
/** Delays after attempt n (seconds): +30s, +2m, +10m, +30m, +60m, then exhausted. */
const RETRY_DELAYS_S = [30, 120, 600, 1800, 3600];
const MAX_SPAN_MS = 2 * 3600 * 1000; // never retry past 2h after the first attempt

interface DeliveryRow {
  id: string;
  job_id: string;
  api_key_id: string | null;
  type: string;
  url: string;
  body: string;
  status: string;
  attempts: number;
  first_attempt_at: unknown;
  next_attempt_at: unknown;
}

/**
 * What a transport must do: POST `body` verbatim to `url` with `headers`,
 * resolving the host through `lookup` (already pinned to guard-approved
 * answers), no redirects, `timeoutMs` covering the whole attempt, and the
 * response body drained to at most RESPONSE_READ_CAP bytes. Resolves with the
 * HTTP status; rejects on network/DNS errors (DestinationDeniedError = final).
 */
export interface WebhookRequestSpec {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  lookup: LookupFunction;
}

export type WebhookTransport = (spec: WebhookRequestSpec) => Promise<{ status: number }>;

export interface DeliveryDeps {
  transport?: WebhookTransport;
  lookup?: LookupAll;
}

function retryableStatus(code: number): boolean {
  return code === 408 || code === 429 || (code >= 500 && code <= 599);
}

/** node http(s) transport - connects only via the pinned `spec.lookup`. */
function nodeTransport(spec: WebhookRequestSpec): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(spec.url); } catch { reject(new DestinationDeniedError()); return; }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      reject(new DestinationDeniedError());
      return;
    }
    const mod = u.protocol === "https:" ? https : http;
    let settled = false;
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }));
    }, spec.timeoutMs);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = mod.request(
      {
        hostname: u.hostname.replace(/^\[|\]$/g, ""),
        port: u.port ? Number(u.port) : undefined,
        path: `${u.pathname}${u.search}`,
        method: "POST",
        headers: spec.headers,
        lookup: spec.lookup,
        agent: false,
      },
      (res) => {
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          // status is all we need - drop the connection past the read cap
          if (received > RESPONSE_READ_CAP) res.destroy();
        });
        const done = () => finish(() => resolve({ status: res.statusCode ?? 0 }));
        res.on("end", done);
        res.on("close", done);
        res.on("error", done);
      },
    );
    req.on("error", (e) => finish(() => reject(e)));
    req.end(spec.body);
  });
}

async function finalize(
  d: DeliveryRow,
  now: Date,
  outcome:
    | { kind: "delivered" | "failed"; status: number | null; error: string | null }
    | { kind: "retry"; status: number | null; error: string | null },
) {
  const attempts = d.attempts + 1;
  const firstAttemptAt = d.first_attempt_at ?? now;
  if (outcome.kind !== "retry") {
    await sql(
      `UPDATE webhook_deliveries SET status=$2, attempts=$3,
         first_attempt_at=COALESCE(first_attempt_at,$4), last_status=$5, last_error=$6,
         next_attempt_at=NULL ${outcome.kind === "delivered" ? ", delivered_at=$4" : ""}
       WHERE id=$1`,
      [d.id, outcome.kind, attempts, now, outcome.status, outcome.error]);
    return;
  }
  let nextAt: Date | null = null;
  if (attempts < MAX_ATTEMPTS) {
    const candidate = new Date(now.getTime() + RETRY_DELAYS_S[attempts - 1] * 1000);
    const cap = new Date(new Date(firstAttemptAt as string | number | Date).getTime() + MAX_SPAN_MS);
    nextAt = candidate <= cap ? candidate : null;
  }
  await sql(
    `UPDATE webhook_deliveries SET status=$2, attempts=$3,
       first_attempt_at=COALESCE(first_attempt_at,$4), last_status=$5, last_error=$6,
       next_attempt_at=$7
     WHERE id=$1`,
    [d.id, nextAt ? "pending" : "exhausted", attempts, now, outcome.status, outcome.error, nextAt]);
}

async function deliverOne(d: DeliveryRow, nowMs: number, deps: DeliveryDeps) {
  const now = new Date(nowMs);
  const lookup = deps.lookup ?? defaultLookup;
  const hosted = process.env.MOTIONFIELD_HOSTED === "1";

  // SSRF guard runs before every attempt - DNS answers can change between tries.
  const denied = await webhookTargetDenied(d.url, lookup);
  if (denied) {
    await finalize(d, now, denied.retryable
      ? { kind: "retry", status: null, error: denied.reason }
      : { kind: "failed", status: null, error: denied.reason });
    return;
  }

  const [key] = await sql<{ webhook_secret: string | null }>(
    `SELECT webhook_secret FROM api_keys WHERE id = $1`, [d.api_key_id]);
  const secret = key?.webhook_secret ? decryptWebhookSecret(key.webhook_secret, d.api_key_id ?? undefined) : null;
  if (!secret) {
    await finalize(d, now, { kind: "failed", status: null, error: "webhook secret unavailable" });
    return;
  }

  const transport = deps.transport ?? nodeTransport;
  const t = Math.floor(nowMs / 1000);
  try {
    const res = await transport({
      url: d.url,
      timeoutMs: ATTEMPT_TIMEOUT_MS,
      headers: {
        "content-type": "application/json",
        "user-agent": "MotionField-Webhooks/1",
        "x-motionfield-event-id": d.id,
        "x-motionfield-signature": signWebhookHeader(secret, d.body, t),
      },
      body: d.body,
      // DNS is resolved again at connect time and re-classified - a flipped
      // answer can only reach an approved address.
      lookup: pinningLookup(lookup, hosted),
    });
    if (res.status >= 200 && res.status <= 299) {
      await finalize(d, now, { kind: "delivered", status: res.status, error: null });
    } else if (retryableStatus(res.status)) {
      await finalize(d, now, { kind: "retry", status: res.status, error: `http ${res.status}` });
    } else {
      await finalize(d, now, { kind: "failed", status: res.status, error: `http ${res.status}` });
    }
  } catch (e) {
    // A connect-time denial is final, not retryable - resending can't change it.
    if (e instanceof DestinationDeniedError) {
      await finalize(d, now, { kind: "failed", status: null, error: e.message });
      return;
    }
    await finalize(d, now, {
      kind: "retry", status: null,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Claim up to MAX_DELIVERIES_PER_SWEEP due deliveries (FOR UPDATE SKIP LOCKED)
 * and attempt each once. Rows stuck `delivering` for over a minute are
 * reclaimed. `nowMs`/`deps` are injectable for tests.
 */
export async function deliverDueWebhooks(nowMs: number = Date.now(), deps: DeliveryDeps = {}): Promise<number> {
  const now = new Date(nowMs);
  const staleBefore = new Date(nowMs - STALE_DELIVERING_MS);
  const rows = (await sql(
    `UPDATE webhook_deliveries SET status = 'delivering', next_attempt_at = $2
     WHERE id IN (
       SELECT id FROM webhook_deliveries
       WHERE (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $1))
          OR (status = 'delivering' AND next_attempt_at < $3)
       ORDER BY created_at
       LIMIT ${MAX_DELIVERIES_PER_SWEEP}
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [now, now, staleBefore])) as DeliveryRow[];
  // Claimed rows are attempted concurrently - a slow target must not delay
  // the other deliveries in the sweep.
  await Promise.allSettled(rows.map((d) =>
    deliverOne(d, nowMs, deps).catch(async (e) => {
      console.error(`webhook ${d.id} attempt error`, e);
      await finalize(d, now, { kind: "retry", status: null, error: "internal error" }).catch(() => {});
    }),
  ));
  return rows.length;
}

/* ---------- background sweep ---------- */

const sweepState = globalThis as typeof globalThis & {
  __ofWebhookSweep?: Promise<unknown>;
  __ofWebhookSweepRerun?: boolean;
  __ofWebhookDeps?: DeliveryDeps;
};

/** Test hook: swap the transport/resolver used by kicked sweeps. */
export function setWebhookSweepDepsForTest(deps: DeliveryDeps | null): void {
  sweepState.__ofWebhookDeps = deps ?? undefined;
}

async function sweepOnce(deps: DeliveryDeps): Promise<number> {
  try {
    return await deliverDueWebhooks(Date.now(), deps);
  } catch (e) {
    console.error("webhook sweep error", e);
    return 0;
  }
}

/**
 * Fire-and-forget delivery sweep. Job polling and job GETs kick this after a
 * terminal transition enqueues a delivery so a slow webhook target can never
 * block a request. At most one sweep runs at a time; a kick that lands while
 * a sweep is running sets a rerun flag, and a sweep that claimed a full
 * MAX_DELIVERIES_PER_SWEEP window also runs again - no delivery waits on an
 * unrelated request. Errors are logged, never thrown.
 */
export function kickWebhookDelivery(): void {
  if (sweepState.__ofWebhookSweep) {
    sweepState.__ofWebhookSweepRerun = true;
    return;
  }
  const deps = sweepState.__ofWebhookDeps ?? {};
  sweepState.__ofWebhookSweep = (async () => {
    try {
      for (;;) {
        sweepState.__ofWebhookSweepRerun = false;
        const claimed = await sweepOnce(deps);
        if (!sweepState.__ofWebhookSweepRerun && claimed < MAX_DELIVERIES_PER_SWEEP) return;
      }
    } finally {
      sweepState.__ofWebhookSweep = undefined;
      // a kick could have landed between the last flag check and clearing the
      // in-flight marker - honor it rather than dropping the delivery
      if (sweepState.__ofWebhookSweepRerun) kickWebhookDelivery();
    }
  })();
}

/** Resolves once no sweep is running - lets tests outlive their deliveries. */
export async function webhookSweepIdle(): Promise<void> {
  while (sweepState.__ofWebhookSweep) {
    await sweepState.__ofWebhookSweep.catch(() => {});
  }
}
