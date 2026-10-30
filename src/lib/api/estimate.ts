import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { findEndpoint } from "@/lib/catalog/video-models";
import { planById } from "@/lib/catalog/plans";
import { JobError, resolveParams, coerceParams } from "@/lib/jobs";

export interface EstimateResult {
  credits: number;
  usd: number;
  unlimited: boolean;
}

/** Credit + USD cost preview. Runs the same resolve+coerce pipeline as
 *  createJob so the estimate always equals the charge. `userId` may be null
 *  for anonymous callers (no plan discounts applied). */
export async function estimateJob(
  userId: string | null,
  endpointId: string,
  rawParams: Record<string, unknown>,
): Promise<EstimateResult> {
  const found = findEndpoint(endpointId);
  if (!found) throw new JobError(`unknown endpoint ${endpointId}`, 404);
  const params = coerceParams(found.workflow, resolveParams(rawParams));

  let unlimited = false;
  if (userId) {
    const db = await getDb();
    const [p] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, userId)).limit(1);
    unlimited = (planById(p?.planId).unlimitedModels ?? []).includes(found.model.id);
  }
  const credits = unlimited ? 0 : found.workflow.cost(params);
  return { credits, usd: Math.round(credits / 18 * 100) / 100, unlimited };
}
