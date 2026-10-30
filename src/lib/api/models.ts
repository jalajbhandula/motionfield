import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ALL_MODELS } from "@/lib/catalog/video-models";
import { endpointLicense } from "@/lib/catalog/license-gate";
import { planById } from "@/lib/catalog/plans";
import { resolveParams, coerceParams } from "@/lib/jobs";
import { paramsJsonSchema } from "./v1";
import type { ModelDef, WorkflowDef } from "@/lib/catalog/types";

/** Credit estimate for the endpoint's default params - the same
 *  resolve+coerce pipeline the job path runs, so it matches the charge a
 *  default-param submission would produce. Null when the endpoint has no
 *  usable default invocation (e.g. a required upload param). */
function defaultEstimate(w: WorkflowDef): { credits: number | null } {
  try {
    const params: Record<string, unknown> = {};
    for (const f of w.params) if (f.default !== undefined) params[f.name] = f.default;
    return { credits: w.cost(coerceParams(w, resolveParams(params))) };
  } catch {
    return { credits: null };
  }
}

/**
 * The v1 endpoint catalog for one user: every callable endpoint with its
 * input JSON Schema, license class + attribution components, and a default-
 * param credit estimate. `banned` endpoints are never listed; `restricted`
 * endpoints appear only once the user has a license_optins row.
 */
export async function listV1Models(userId: string) {
  const db = await getDb();
  const [optin] = await db.select({ userId: schema.licenseOptins.userId })
    .from(schema.licenseOptins)
    .where(eq(schema.licenseOptins.userId, userId))
    .limit(1);
  // One profile read per call - the plan rule matches estimateJob: a model on
  // the caller's unlimited list estimates 0 credits.
  const [profile] = await db.select({ planId: schema.profiles.planId })
    .from(schema.profiles)
    .where(eq(schema.profiles.userId, userId))
    .limit(1);
  const unlimited = new Set(planById(profile?.planId).unlimitedModels ?? []);
  return ALL_MODELS.flatMap((m: ModelDef) =>
    m.workflows.flatMap((w: WorkflowDef) => {
      const lic = endpointLicense(w);
      if (lic.class === "banned") return [];
      if (lic.class === "restricted" && !optin) return [];
      const est = defaultEstimate(w);
      return [{
        id: w.endpointId,
        kind: w.kind,
        label: `${m.label} · ${w.label}`,
        tags: m.tags ?? [],
        inputs: paramsJsonSchema(w.params),
        license: {
          class: lic.class,
          components: lic.components.map((c) => ({ name: c.name, license: c.license, url: c.url })),
        },
        estimate: { credits: est.credits == null ? null : unlimited.has(m.id) ? 0 : est.credits },
        tier: w.heavy ? "cloud" : "local",
      }];
    }),
  );
}
