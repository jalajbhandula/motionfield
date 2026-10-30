/** Server-only license gate - reads the license_optins table.
 *  Never import this from the client bundle (pulls in the db).
 *  Pure license resolution lives in ./licenses (endpointLicenseFor); this file
 *  adds the COMFY_MODEL_MAP reversal and the opt-in DB check. */
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import type { LicenseInfo, WorkflowDef } from "./types";
import { endpointLicenseFor, LICENSE_VERSION } from "./licenses";

export const LICENSE_ENABLE_PATH = "/settings/licenses";

/** Thrown when an endpoint's license class forbids submission - 403 with a
 *  structured body: restricted → { error: { code: "restricted_license",
 *  license, enable_at } }; banned → { error: { code: "banned_license",
 *  license } } (no enable_at - banned nodes can never be opted into). */
export class RestrictedLicenseError extends Error {
  readonly status = 403;
  readonly license: string;
  readonly code: "restricted_license" | "banned_license";
  constructor(license: string, code: "restricted_license" | "banned_license" = "restricted_license") {
    super(code === "banned_license"
      ? `banned license: ${license} - this node/weight may not run`
      : `restricted license: ${license} - enable at ${LICENSE_ENABLE_PATH}`);
    this.name = "RestrictedLicenseError";
    this.license = license;
    this.code = code;
  }
  get body() {
    const base = { code: this.code, license: this.license };
    return { error: this.code === "banned_license" ? base : { ...base, enable_at: LICENSE_ENABLE_PATH } };
  }
}

/** COMFY_MODEL_MAP (JSON env) rewrites shipped weight names to deployment-
 *  local names at submit time. A stored/forked graph_json carries the deployed
 *  name - map it back to the shipped source name so the fork keeps the source
 *  license instead of turning "unlisted". */
export function unremapGraph(graph: Record<string, unknown>): Record<string, unknown> {
  let mm: Record<string, string>;
  try { mm = JSON.parse(process.env.COMFY_MODEL_MAP || "{}"); }
  catch { mm = {}; }
  const rev: Record<string, string> = {};
  for (const [source, target] of Object.entries(mm))
    if (typeof target === "string") rev[target] = source;
  if (!Object.keys(rev).length) return graph;
  const out: Record<string, unknown> = {};
  for (const [id, node] of Object.entries(graph)) {
    if (id === "_meta" || !node || typeof node !== "object") { out[id] = node; continue; }
    const n = node as { class_type?: unknown; inputs?: unknown };
    if (!n.inputs || typeof n.inputs !== "object" || Array.isArray(n.inputs)) { out[id] = node; continue; }
    const inputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n.inputs))
      inputs[k] = typeof v === "string" && Object.hasOwn(rev, v) ? rev[v] : v;
    out[id] = { ...n, inputs };
  }
  return out;
}

/** Back-compat alias - the pure resolver now lives in ./licenses. Callers on
 *  the server pass the graph override through unremapGraph first. */
export function endpointLicense(
  workflow: WorkflowDef,
  params: Record<string, unknown> = {},
  graphOverride?: Record<string, unknown> | null,
): LicenseInfo {
  return endpointLicenseFor(workflow, params, graphOverride ? unremapGraph(graphOverride) : graphOverride);
}

function licenseLabel(lic: LicenseInfo, cls: LicenseInfo["class"]): string {
  const names = [...new Set(lic.components.filter((c) => c.class === cls).map((c) => c.license))];
  return names.join(" + ") || cls;
}

/** Does the user hold an opt-in row at the CURRENT LICENSE_VERSION? A stale
 *  row (older version) doesn't count - restricted endpoints ask again. */
export async function hasCurrentOptIn(userId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db.select().from(schema.licenseOptins)
    .where(eq(schema.licenseOptins.userId, userId)).limit(1);
  return !!row && row.version === LICENSE_VERSION;
}

/** Gate one job submission: banned endpoints always throw (code
 *  "banned_license"); restricted endpoints throw unless the user has an
 *  opt-in row at the CURRENT LICENSE_VERSION. Call before any charge or
 *  provider submit. */
export async function assertLicenseAllowed(
  workflow: WorkflowDef,
  userId: string,
  params: Record<string, unknown> = {},
  graphOverride?: Record<string, unknown> | null,
): Promise<void> {
  const lic = endpointLicense(workflow, params, graphOverride);
  const known = lic.components.filter((c) => c.class === "banned-known");
  if (known.length)
    console.warn(`[license] ${workflow.endpointId} runs component(s) with known licensing issues: ${known.map((c) => c.name).join(", ")}`);
  if (lic.class === "banned") throw new RestrictedLicenseError(licenseLabel(lic, "banned"), "banned_license");
  if (lic.class !== "restricted") return;
  if (!await hasCurrentOptIn(userId)) throw new RestrictedLicenseError(licenseLabel(lic, "restricted"));
}
