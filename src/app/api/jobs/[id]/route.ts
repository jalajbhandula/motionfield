import { NextRequest } from "next/server";
import { isUuid, json, err, apiUser  } from "@/lib/api";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { tickPublicJob } from "@/lib/job-query";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await apiUser(req);
    const { id } = await params;
    if (!isUuid(id)) return json({ error: "not found" }, 404);
    const db = await getDb();
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
    if (!job) return json({ error: "not found" }, 404);
    if (job.userId !== ctx?.user.id && job.visibility !== "public") return json({ error: "not found" }, 404);
    // opportunistic tick so client polls advance without a worker in dev
    if (["queued", "in_progress"].includes(job.status)) await tickPublicJob(id).catch(() => {});
    const [fresh] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
    return json({ job: fresh });
  } catch (e) {
    return err(e);
  }
}
