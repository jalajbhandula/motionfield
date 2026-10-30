import { NextRequest } from "next/server";
import { json, err, requireApiUser } from "@/lib/api";
import { getDb, schema, sql } from "@/db";
import { eq, desc, and, inArray } from "drizzle-orm";

import { recreateHref } from "@/lib/recreate";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const db = await getDb();
    const sp = req.nextUrl.searchParams;
    const kind = sp.get("kind");
    const fav = sp.get("favorite") === "1";
    const folder = sp.get("folder");
    const conds = [eq(schema.assets.userId, user.id)];
    if (kind) conds.push(eq(schema.assets.kind, kind));
    if (fav) conds.push(eq(schema.assets.favorite, true));
    let q = db.select().from(schema.assets).where(and(...conds)).orderBy(desc(schema.assets.createdAt)).limit(200);
    const rows: (typeof schema.assets.$inferSelect)[] = await q;
    const jobIds = [...new Set(rows.flatMap((a) => a.jobId ? [a.jobId] : []))];
    // One batched owner-scoped lookup, never another user's private inputs.
    const jobs: { id: string; kind: string; modelId: string; workflow: string; params: unknown }[] = jobIds.length ? await db.select({ id: schema.jobs.id,
      kind: schema.jobs.kind, modelId: schema.jobs.modelId,
      workflow: schema.jobs.workflow, params: schema.jobs.params,
    }).from(schema.jobs).where(and(eq(schema.jobs.userId, user.id), inArray(schema.jobs.id, jobIds))) : [];
    const links = new Map(jobs.map((j) => [j.id, recreateHref(j)]));
    const assets = rows.map((a) => ({ ...a, recreateHref: a.jobId ? links.get(a.jobId) : undefined }));
    if (folder) {
      const rows = await sql<{ asset_id: string }>(
        `SELECT asset_id FROM folder_items fi JOIN folders f ON f.id = fi.folder_id WHERE f.id = $1`, [folder]);
      const ids = new Set(rows.map((r: { asset_id: string }) => r.asset_id));
      return json({ assets: assets.filter((a: { id: string }) => ids.has(a.id)) });
    }
    return json({ assets });
  } catch (e) {
    return err(e);
  }
}
