import { NextRequest } from "next/server";
import { z } from "zod";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err, v1error, jobLinks, ts, requestSource } from "@/lib/api/v1";
import { hashJobRequest, hashMismatch, isValidIdempotencyKey } from "@/lib/api/idempotency";
import { createJobEx, findJobByIdemKey, tickJob, applyDailyCredits, JOB_SOURCES } from "@/lib/jobs";
import { getDb, sql as rawSql, schema } from "@/db";
import { jobView, type AssetInfo, type JobOutput } from "@/lib/api/job-shape";
import { filePathFor } from "@/lib/storage";
import { promises as fsp } from "node:fs";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 1024 * 1024;

const CreateJob = z.object({
  endpoint: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  webhook_url: z.url({ protocol: /^https?$/ }).max(2048)
    .refine((u) => { const p = new URL(u); return !p.username && !p.password; }, "webhook_url must not carry credentials")
    .optional(),
});

function jobCreated(job: { id: string; status: string; createdAt?: unknown; created_at?: unknown }, status: number) {
  return v1json({
    id: job.id,
    status: job.status,
    created_at: ts(job.createdAt ?? job.created_at),
    links: jobLinks(job.id),
  }, status);
}

/**
 * Read the request body as text, enforcing the byte cap while streaming - a
 * chunked request without Content-Length can't overshoot the limit. Returns
 * "too_large" / "unreadable" markers instead of throwing.
 */
async function readBodyCapped(req: NextRequest): Promise<{ text: string } | "too_large" | "unreadable"> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return "too_large";
  const stream = req.body;
  if (!stream) return { text: "" };
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? 0;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return "too_large";
      }
      if (value) chunks.push(Buffer.from(value));
    }
  } catch {
    return "unreadable";
  }
  return { text: Buffer.concat(chunks).toString("utf8") };
}

/**
 * POST /api/v1/jobs { endpoint, params, webhook_url? }
 * Idempotency-Key header: same key + same payload → the original job (200);
 * same key + different payload → 422 idempotency_mismatch.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;

    const raw = await readBodyCapped(req);
    if (raw === "too_large")
      return v1error("payload_too_large", "request body too large (1MB max)", 413);
    if (raw === "unreadable")
      return v1error("bad_request", "body must be JSON: { endpoint, params?, webhook_url? }", 400);
    const text = raw.text;

    let jsonBody: unknown = null;
    try { jsonBody = JSON.parse(text); } catch { /* handled as bad_request below */ }
    const parsed = CreateJob.safeParse(jsonBody);
    if (!parsed.success) return v1error("bad_request", "body must be JSON: { endpoint, params?, webhook_url? }", 400);
    const body = parsed.data;
    const endpoint = body.endpoint;
    const params = body.params ?? {};

    const idemKey = req.headers.get("idempotency-key")?.trim() || null;
    if (idemKey && !isValidIdempotencyKey(idemKey))
      return v1error("bad_request", "Idempotency-Key must be 1-255 printable ASCII characters", 400);
    const requestHash = idemKey ? hashJobRequest(endpoint, params) : null;

    if (body.webhook_url && !auth.hasWebhookSecret)
      return v1error("webhook_secret_missing", "this API key has no webhook signing secret - create or rotate it via POST /api/keys/:id/webhook-secret", 400);

    // Replay check runs before the concurrency gate: a retry must see the
    // original job even when the key is saturated.
    if (idemKey) {
      const prev = await findJobByIdemKey(auth.userId, idemKey);
      if (prev) {
        if (requestHash && hashMismatch(prev.request_hash, requestHash))
          return v1error("idempotency_mismatch", "Idempotency-Key was already used with a different request payload", 422);
        // backfill the hash on rows created before request_hash existed
        if (requestHash && prev.request_hash == null)
          await rawSql(`UPDATE jobs SET request_hash = $2 WHERE id = $1`, [prev.id, requestHash]);
        return jobCreated(prev, 200);
      }
    }

    // Per-key concurrency: count only jobs submitted with this key that are
    // still live. Reconcile them first so finished jobs free their slots.
    const live = await rawSql<{ id: string }>(
      `SELECT id FROM jobs WHERE api_key_id = $1 AND status IN ('queued','in_progress') AND provider_request_id IS NOT NULL LIMIT 10`,
      [auth.keyId]);
    for (const j of live) await tickJob(j.id).catch(() => {});
    const [{ n }] = await rawSql<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs WHERE api_key_id = $1 AND status IN ('queued','in_progress')`,
      [auth.keyId]);
    if (n >= auth.maxConcurrency) {
      return v1error("concurrency_limit", `API key concurrency limit reached (${auth.maxConcurrency} live jobs)`, 429, { "Retry-After": "5" });
    }

    await applyDailyCredits(auth.userId);
    const { job, replayed } = await createJobEx(auth.userId, {
      endpointId: endpoint,
      params,
      idempotencyKey: idemKey ?? undefined,
      requestHash,
      apiKeyId: auth.keyId,
      webhookUrl: body.webhook_url ?? null,
      source: requestSource(req),
    });
    return jobCreated(job, replayed ? 200 : 202);
  } catch (e) {
    return v1err(e);
  }
}

/* ---------- GET /api/v1/jobs - the caller's jobs, newest first ---------- */

const JOB_STATUSES = ["queued", "in_progress", "completed", "failed", "nsfw", "canceled"] as const;
const LIST_LIMIT_MAX = 100;

/** Opaque cursor: base64url of `created_at | job id` where created_at keeps
 *  Postgres' full microsecond precision - a JS Date truncates to ms, which
 *  would drop tied rows between pages. The (created_at, id) tuple orders the
 *  listing so ties never duplicate or skip rows. */
const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}
function decodeCursor(raw: string | null): { ts: string; id: string } | null | "invalid" {
  if (raw == null || raw === "") return null;
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const sep = decoded.lastIndexOf("|");
  if (sep <= 0) return "invalid";
  const ts = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!CURSOR_TS.test(ts) || !CURSOR_ID.test(id)) return "invalid";
  // Round-trip the timestamp: JS Date normalizes impossible fields (a cursor
  // like 2030-02-30T… rolls into March) but Postgres' timestamptz cast throws
  // on them. Render the parsed date back and compare the whole-field part -
  // a mismatch means the literal can't reach SQL.
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "invalid";
  const head = ts.slice(0, ts.indexOf("."));
  if (d.toISOString().slice(0, 19) !== head) return "invalid";
  return { ts, id };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `ids=a,b,c` - up to 12 UUIDs, comma-separated. */
function parseIds(raw: string | null): string[] | null | "invalid" {
  if (raw == null || raw === "") return null;
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return null;
  if (ids.length > 12 || ids.some((id) => !UUID_RE.test(id))) return "invalid";
  return ids;
}

/**
 * GET /api/v1/jobs?limit=1..100&status=...&before=<cursor>
 * Snapshot list - reads do not tick jobs. `{ jobs, next_cursor }`; follow
 * next_cursor until null for the full history.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;

    const sp = req.nextUrl.searchParams;
    const limitRaw = Number(sp.get("limit") ?? "50");
    if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > LIST_LIMIT_MAX)
      return v1error("bad_request", `limit must be an integer 1..${LIST_LIMIT_MAX}`, 400);
    const status = sp.get("status");
    if (status != null && status !== "" && !(JOB_STATUSES as readonly string[]).includes(status))
      return v1error("bad_request", `status must be one of ${JOB_STATUSES.join(", ")}`, 400);
    const cursor = decodeCursor(sp.get("before"));
    if (cursor === "invalid") return v1error("bad_request", "before must be a cursor returned by next_cursor", 400);

    const ids = parseIds(sp.get("ids"));
    if (ids === "invalid") return v1error("bad_request", "ids must be 1-12 comma-separated UUIDs", 400);
    const kind = sp.get("kind");
    if (kind != null && kind !== "" && !/^[a-z][a-z0-9_-]{0,31}$/.test(kind))
      return v1error("bad_request", "kind must be a job kind slug", 400);
    const source = sp.get("source");
    if (source != null && source !== "" && !(JOB_SOURCES as readonly string[]).includes(source))
      return v1error("bad_request", `source must be one of ${JOB_SOURCES.join(", ")}`, 400);

    const db = await getDb();
    const rows: (typeof schema.jobs.$inferSelect & { cursorTs: string; source: string })[] = await db.select({
      ...getTableColumns(schema.jobs),
      source: schema.jobsWs1.source,
      // µs-precision cursor timestamp - created_at through a Date loses the
      // sub-millisecond digits Postgres stores
      cursorTs: sql<string>`to_char(${schema.jobs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    }).from(schema.jobs)
      .where(and(
        eq(schema.jobs.userId, auth.userId),
        status ? eq(schema.jobs.status, status) : undefined,
        kind ? eq(schema.jobs.kind, kind) : undefined,
        source ? sql`${schema.jobsWs1.source} = ${source}` : undefined,
        ids ? inArray(schema.jobs.id, ids) : undefined,
        cursor ? sql`(${schema.jobs.createdAt}, ${schema.jobs.id}) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)` : undefined,
      ))
      .orderBy(desc(schema.jobs.createdAt), desc(schema.jobs.id))
      .limit(ids ? ids.length : limitRaw + 1);

    // ?ids= returns the requested set in request order - batch pollers care
    // about which position errored, not chronology.
    if (ids) {
      const rank = new Map(ids.map((id, i) => [id.toLowerCase(), i]));
      rows.sort((a, b) => (rank.get(a.id.toLowerCase()) ?? 1e9) - (rank.get(b.id.toLowerCase()) ?? 1e9));
    }

    const page = ids ? rows : rows.slice(0, limitRaw);
    const next_cursor = !ids && rows.length > limitRaw && page.length
      ? encodeCursor(page[page.length - 1].cursorTs, page[page.length - 1].id)
      : null;

    // asset bytes/mime for every output on the page, in one query
    const assetInfo = new Map<string, Map<string, AssetInfo>>();
    const jobIds = page.map((j) => j.id);
    if (jobIds.length) {
      const assets = await db.select({
        jobId: schema.assets.jobId, url: schema.assets.url,
        bytes: schema.assets.bytes, mime: schema.assets.mime,
      }).from(schema.assets).where(inArray(schema.assets.jobId, jobIds));
      for (const a of assets) {
        if (!a.jobId) continue;
        const m = assetInfo.get(a.jobId) ?? new Map<string, AssetInfo>();
        m.set(a.url, { bytes: a.bytes == null ? null : Number(a.bytes), mime: a.mime });
        assetInfo.set(a.jobId, m);
      }
    }
    // fill any missing byte counts from the filesystem - same fallback
    // fetchJobView uses for outputs without an asset row
    await Promise.all(page.map(async (j) => {
      const outputs = (j.outputs as JobOutput[] | null) ?? [];
      if (!outputs.length) return;
      const m = assetInfo.get(j.id) ?? new Map<string, AssetInfo>();
      assetInfo.set(j.id, m);
      await Promise.all(outputs.map(async (o) => {
        const info = m.get(o.url) ?? { bytes: null, mime: null };
        m.set(o.url, info);
        if (info.bytes != null) return;
        const p = filePathFor(o.url);
        if (!p) return;
        try { info.bytes = (await fsp.stat(p)).size; } catch { /* leave null */ }
      }));
    }));

    return v1json({
      jobs: page.map((j) => jobView(j, assetInfo.get(j.id) ?? new Map())),
      next_cursor,
    });
  } catch (e) {
    return v1err(e);
  }
}
