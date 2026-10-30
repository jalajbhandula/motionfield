import type { JobKind, ModelDef, WorkflowDef } from "@/lib/catalog/types";

export type ProviderName = "mock" | "comfy" | "recipe";

export interface SubmitInput {
  jobId: string;
  model: ModelDef;
  workflow: WorkflowDef;
  params: Record<string, unknown>;
  /** owning user - recipes use it to license-gate the sub-jobs they spawn */
  userId?: string;
  /** caller-supplied Comfy graph (forked/edited) - provider uses it instead of the bundled workflow file */
  graphOverride?: Record<string, unknown>;
  /** absolute base url of this app for webhook/callback-free polling fallbacks */
  appBaseUrl: string;
}

export interface SubmitResult {
  providerJobId: string;
  /** provider-specific extra data to persist (queue urls, comfy prompt_id...) */
  meta?: Record<string, unknown>;
}

export type ProviderStatus =
  | { state: "queued"; position?: number }
  | { state: "in_progress"; progress?: number; stage?: string }
  | { state: "completed"; output: ProviderOutput }
  | { state: "failed"; error: string }
  | { state: "nsfw"; error?: string }
  | { state: "canceled" };

export interface ProviderOutputItem {
  type: "image" | "video" | "audio" | "model";
  url: string;
  width?: number;
  height?: number;
  duration?: number;
  /** finishing pass marks its output "finished" and tags the kept
   *  pre-finish render "raw" so the UI can offer a before/after */
  role?: string;
}

export interface ProviderOutput {
  items: ProviderOutputItem[];
  meta?: Record<string, unknown>;
}

export interface GenerationProvider {
  name: ProviderName;
  submit(input: SubmitInput): Promise<SubmitResult>;
  poll(providerJobId: string, meta: Record<string, unknown>): Promise<ProviderStatus>;
  cancel(providerJobId: string, meta: Record<string, unknown>): Promise<void>;
}

export const JOB_KIND_OUTPUT: Record<JobKind, ProviderOutputItem["type"]> = {
  image: "image", edit: "image", upscale: "image", character: "image", threed: "model",
  video: "video", v2v: "video", avatar: "video",
  audio: "audio",
};
