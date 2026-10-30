import { LIKENESS_CONSENT_PARAM } from "./likeness";

/** Reopen the original executor and inputs; consent must be asserted anew. */
export function recreateHref(job: {
  kind: string; modelId: string; workflow: string; params: unknown;
}): string {
  const params: Record<string, unknown> = job.params && typeof job.params === "object" && !Array.isArray(job.params)
    ? { ...job.params as Record<string, unknown> } : {};
  delete params[LIKENESS_CONSENT_PARAM];
  const route = ["video", "v2v", "avatar"].includes(job.kind) ? "/ai/video"
    : job.kind === "audio" ? "/audio" : "/ai/image";
  return `${route}?${new URLSearchParams({ model: job.modelId, flow: job.workflow, params: JSON.stringify(params) })}`;
}
