import { promises as fs } from "fs";
import path from "path";
import { ALL_MODELS } from "@/lib/catalog/video-models";
import { endpointLicense, hasCurrentOptIn } from "@/lib/catalog/license-gate";
import { needsOptIn } from "@/lib/catalog/licenses";
import type { LiveEndpoint } from "./plan";

/**
 * The catalog endpoints a planning turn may name and a run may submit:
 * endpoints backed by a shipped Comfy workflow file or a recipe - open
 * license, plus restricted-license ones only while the user holds a current
 * opt-in. Offline mode additionally drops "heavy" endpoints.
 */

const WF_DIR = path.join(process.cwd(), "workflows");
let wfFilesCache: Set<string> | null = null;
async function workflowFiles(): Promise<Set<string>> {
  if (!wfFilesCache) {
    try { wfFilesCache = new Set(await fs.readdir(WF_DIR)); }
    catch { wfFilesCache = new Set(); }
  }
  return wfFilesCache;
}

export async function liveEndpoints(): Promise<LiveEndpoint[]> {
  const files = await workflowFiles();
  const out: LiveEndpoint[] = [];
  for (const m of ALL_MODELS)
    for (const w of m.workflows)
      if ((w.providers.comfy?.workflow && files.has(w.providers.comfy.workflow)) || w.providers.recipe?.name)
        out.push({ model: m, workflow: w });
  return out;
}

/** The user's current license opt-in - owned by the catalog license gate. */
export async function currentOptIn(userId: string): Promise<boolean> {
  return hasCurrentOptIn(userId).catch(() => false);
}

/** Endpoint ids deliberately kept off the planner list even though they run. */
const EXCLUDED_ENDPOINTS = new Set([
  // its `windows` count comes from the detect step - not a planner primitive
  "motionfield/re-edit/v1.0",
]);

/** The endpoint list a turn may offer and submit - everything not banned:
 *  open-license endpoints ("banned-known" components already resolve to
 *  class "open") and permissive-terms flow straight through; only
 *  restricted-license endpoints wait on the user's current opt-in.
 *  Offline mode drops heavy endpoints too. Submit-time gating in validatePlan
 *  + createJob stays authoritative - this list is what the model may *name*. */
export async function turnEndpoints(mode: "auto" | "offline" | "custom" | undefined, userId: string): Promise<LiveEndpoint[]> {
  const optIn = await currentOptIn(userId);
  return (await liveEndpoints()).filter((e) => {
    if (EXCLUDED_ENDPOINTS.has(e.workflow.endpointId)) return false;
    const cls = endpointLicense(e.workflow).class;
    if (cls === "banned") return false;
    if (needsOptIn(cls) && !optIn) return false;
    return mode === "offline" ? !e.workflow.heavy : true;
  });
}

export async function allowedEndpointIds(mode: "auto" | "offline" | "custom" | undefined, userId: string): Promise<Set<string>> {
  return new Set((await turnEndpoints(mode, userId)).map((e) => e.workflow.endpointId));
}
