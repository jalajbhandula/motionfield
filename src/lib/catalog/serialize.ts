import type { ModelDef, WorkflowDef } from "./types";
import { attachLicenses } from "./licenses";
import { WORKFLOW_LICENSES } from "./licenses.generated";
import { comingSoonReason } from "./coming-soon";

/** The one catalog gate: only workflows backed by a shipped Comfy graph or a
 *  server-side recipe are exposed, and models left with no such workflow are dropped.
 *  Every surviving workflow also gets its license info attached (pure data -
 *  resolved from licenses.generated via the bundled graph filename). */
export function comfyBacked(ms: ModelDef[]): ModelDef[] {
  const gated = ms
    .map((m) => ({ ...m, workflows: m.workflows.filter((w) => w.providers.comfy?.workflow || w.providers.recipe?.name) }))
    .filter((m) => m.workflows.length > 0);
  return attachLicenses(gated, WORKFLOW_LICENSES);
}

/** Client-safe shapes (server functions stripped for the RSC→client boundary). */
export type ClientWorkflow = Omit<WorkflowDef, "cost" | "providers" | "validate"> & { cost?: never; providers?: never; validate?: never };
export type ClientModel = Omit<ModelDef, "workflows"> & { workflows: ClientWorkflow[] };

export function clientWorkflow(w: WorkflowDef): ClientWorkflow {
  const { cost, providers, validate, ...rest } = w;
  const soon = comingSoonReason(w.endpointId);
  return soon ? { ...rest, comingSoon: soon } : rest;
}

export function clientModel(m: ModelDef): ClientModel {
  return { ...m, workflows: m.workflows.map(clientWorkflow) };
}

export function clientModels(ms: ModelDef[]): ClientModel[] {
  return ms.map(clientModel);
}
