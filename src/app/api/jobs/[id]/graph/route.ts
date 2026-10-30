import { NextRequest } from "next/server";
import { isUuid, json, err, apiUser  } from "@/lib/api";
import { getDb, schema } from "@/db";
import { eq, sql } from "drizzle-orm";

export const runtime = "nodejs";

/**
 * GET /api/jobs/[id]/graph - the resolved workflow graph behind a generation.
 * This is the workflow-remix primitive: fetch the graph, edit nodes/params,
 * then POST /api/jobs with { graph_json, graph_forked_from: id }.
 * Public jobs are forkable by anyone (optionally authenticated).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await apiUser(req);
    const { id } = await params;
    if (!isUuid(id)) return json({ error: "not found" }, 404);
    const db = await getDb();
    const [job] = await db.select({
      id: schema.jobs.id,
      userId: schema.jobs.userId,
      endpointId: schema.jobs.endpointId,
      modelId: schema.jobs.modelId,
      workflow: schema.jobs.workflow,
      params: schema.jobs.params,
      prompt: schema.jobs.prompt,
      graphJson: schema.jobs.graphJson,
      graphForkedFrom: schema.jobs.graphForkedFrom,
      parentJobId: schema.jobs.parentJobId,
      visibility: schema.jobs.visibility,
      status: schema.jobs.status,
      createdAt: schema.jobs.createdAt,
    }).from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
    if (!job) return json({ error: "not found" }, 404);
    if (job.userId !== ctx?.user.id && job.visibility !== "public") return json({ error: "not found" }, 404);

    // lineage: direct forks of this graph + the graph this one forked from
    const [{ n: forks }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.jobs)
      .where(eq(schema.jobs.graphForkedFrom, id));

    let forkedFrom = null;
    if (job.graphForkedFrom) {
      const [p] = await db.select({
        id: schema.jobs.id,
        userId: schema.jobs.userId,
        endpointId: schema.jobs.endpointId,
        prompt: schema.jobs.prompt,
        visibility: schema.jobs.visibility,
        createdAt: schema.jobs.createdAt,
      }).from(schema.jobs).where(eq(schema.jobs.id, job.graphForkedFrom)).limit(1);
      if (p && (p.userId === ctx?.user.id || p.visibility === "public")) forkedFrom = p;
    }

    return json({
      job_id: job.id,
      endpoint_id: job.endpointId,
      model_id: job.modelId,
      workflow: job.workflow,
      params: job.params,
      prompt: job.prompt,
      graph: job.graphJson,
      lineage: { forked_from: forkedFrom, forks },
    });
  } catch (e) {
    return err(e);
  }
}
