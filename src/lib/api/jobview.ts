import { promises as fs } from "fs";
import { getDb, sql, schema } from "@/db";
import { eq, getTableColumns } from "drizzle-orm";
import { tickJob } from "@/lib/jobs";
import { filePathFor } from "@/lib/storage";
import { kickWebhookDelivery } from "./webhooks";
import { jobView, type AssetInfo, type JobOutput, type JobViewRow } from "./job-shape";

export type { JobOutput, JobViewRow };

async function localFileBytes(url: string): Promise<number | null> {
  const p = filePathFor(url);
  if (!p) return null;
  try { return (await fs.stat(p)).size; } catch { return null; }
}

/** Load a job owned by `userId`, ticking it once if still live (dev worker
 *  substitute), and shape it for the v1 API. Returns null when not found. */
export async function fetchJobView(userId: string, id: string) {
  const db = await getDb();
  const cols = { ...getTableColumns(schema.jobs), source: schema.jobsWs1.source };
  const [job] = await db.select(cols).from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
  if (!job || job.userId !== userId) return null;
  if (["queued", "in_progress"].includes(job.status)) await tickJob(id).catch(() => {});
  const [fresh] = await db.select(cols).from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
  const row = fresh ?? job;
  const outputs = (row.outputs as JobOutput[] | null) ?? [];
  const assetInfo = new Map<string, AssetInfo>();
  if (outputs.length) {
    const rows = await sql<{ url: string; bytes: number | null; mime: string | null }>(
      `SELECT url, bytes, mime FROM assets WHERE job_id = $1`, [id]);
    for (const r of rows) assetInfo.set(r.url, { bytes: r.bytes == null ? null : Number(r.bytes), mime: r.mime });
    await Promise.all(outputs.map(async (o) => {
      if (assetInfo.get(o.url)?.bytes == null) {
        const info = assetInfo.get(o.url) ?? { bytes: null, mime: null };
        info.bytes = await localFileBytes(o.url);
        assetInfo.set(o.url, info);
      }
    }));
  }
  // Reads double as the dev-mode delivery pump (no separate worker required) -
  // kicked, never awaited, so a slow webhook target can't block this request.
  kickWebhookDelivery();
  return jobView(row, assetInfo);
}
