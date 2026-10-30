import { NextRequest } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err, v1error } from "@/lib/api/v1";
import { JOB_SOURCES } from "@/lib/jobs";
import { getDb, schema } from "@/db";

export const runtime = "nodejs";

const LIST_LIMIT_MAX = 100;
const LIST_LIMIT_DEFAULT = 20;
const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
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
  // Round-trip: JS Date normalizes impossible fields (2030-02-30 rolls into
  // March) while Postgres' timestamptz cast throws - a mismatch must 400.
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "invalid";
  if (d.toISOString().slice(0, 19) !== ts.slice(0, ts.indexOf("."))) return "invalid";
  return { ts, id };
}

/**
 * GET /api/v1/assets?kind=&source=&limit=&before=
 * The caller's own generated/derived assets - output files, newest first,
 * keyset-paginated like /api/v1/jobs.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    const sp = req.nextUrl.searchParams;

    const limitRaw = sp.get("limit");
    let limit = LIST_LIMIT_DEFAULT;
    if (limitRaw != null && limitRaw !== "") {
      if (!/^\d+$/.test(limitRaw)) return v1error("bad_request", "limit must be a positive integer", 400);
      limit = Number(limitRaw);
      if (limit < 1 || limit > LIST_LIMIT_MAX)
        return v1error("bad_request", `limit must be 1..${LIST_LIMIT_MAX}`, 400);
    }
    const kind = sp.get("kind");
    if (kind != null && kind !== "" && !/^[a-z][a-z0-9_-]{0,31}$/.test(kind))
      return v1error("bad_request", "kind must be an asset kind slug", 400);
    const source = sp.get("source");
    if (source != null && source !== "" && !(JOB_SOURCES as readonly string[]).includes(source))
      return v1error("bad_request", `source must be one of ${JOB_SOURCES.join(", ")}`, 400);
    const cursor = decodeCursor(sp.get("before"));
    if (cursor === "invalid") return v1error("bad_request", "before must be a cursor returned by next_cursor", 400);

    const db = await getDb();
    const rows = await db.select({
      id: schema.assets.id,
      jobId: schema.assets.jobId,
      kind: schema.assets.kind,
      url: schema.assets.url,
      mime: schema.assets.mime,
      width: schema.assets.width,
      height: schema.assets.height,
      durationSec: schema.assets.durationSec,
      bytes: schema.assets.bytes,
      prompt: schema.assets.prompt,
      endpointId: schema.assets.endpointId,
      createdAt: schema.assets.createdAt,
      source: schema.assetsWs1.source,
      cursorTs: sql<string>`to_char(${schema.assets.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    }).from(schema.assets)
      .where(and(
        eq(schema.assets.userId, auth.userId),
        kind ? eq(schema.assets.kind, kind) : undefined,
        source ? sql`${schema.assetsWs1.source} = ${source}` : undefined,
        cursor ? sql`(${schema.assets.createdAt}, ${schema.assets.id}) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)` : undefined,
      ))
      .orderBy(desc(schema.assets.createdAt), desc(schema.assets.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const next_cursor = rows.length > limit && page.length
      ? encodeCursor(page[page.length - 1].cursorTs, page[page.length - 1].id)
      : null;

    return v1json({
      assets: page.map((a: (typeof rows)[number]) => ({
        id: a.id,
        job_id: a.jobId,
        kind: a.kind,
        url: a.url,
        mime: a.mime,
        width: a.width,
        height: a.height,
        duration_sec: a.durationSec == null ? null : Number(a.durationSec),
        bytes: a.bytes,
        prompt: a.prompt,
        endpoint_id: a.endpointId,
        source: a.source,
        created_at: a.createdAt instanceof Date ? a.createdAt.toISOString() : String(a.createdAt),
      })),
      next_cursor,
    });
  } catch (e) {
    return v1err(e);
  }
}
