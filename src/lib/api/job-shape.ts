import { mimeForJobOutput } from "./mime";

/**
 * Pure job-view shaping shared by GET /api/v1/jobs/:id and the webhook payload
 * builder. Deliberately free of db/jobs imports so webhooks.ts can use it
 * without re-entering the jobs module.
 */

/** Serialize a Date-or-string timestamp as ISO-8601. */
export function ts(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

export interface JobOutput {
  url: string;
  type?: string;
  assetId?: string;
  width?: number;
  height?: number;
  duration?: number;
}

/** Minimal shape needed to render the GET /api/v1/jobs/:id object - satisfied
 *  by the drizzle row and by the snake_case raw row (adapted by callers). */
export interface JobViewRow {
  id: string;
  status: string;
  progress: number;
  outputs: unknown;
  error: string | null;
  /** what the job was submitted on - endpoint id + job kind + the params as sent. */
  endpointId?: string;
  kind?: string;
  params?: unknown;
  /** provenance tag - ui | api | cli | mcp | agent (absent reads as ui). */
  source?: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface AssetInfo {
  bytes: number | null;
  mime: string | null;
}

export function jobView(job: JobViewRow, assetInfo: Map<string, AssetInfo>) {
  const outputs = (job.outputs as JobOutput[] | null) ?? [];
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    endpoint: job.endpointId,
    kind: job.kind,
    params: job.params,
    outputs: outputs.map((o) => ({
      url: o.url,
      type: assetInfo.get(o.url)?.mime ?? mimeForJobOutput(o.type, o.url),
      bytes: assetInfo.get(o.url)?.bytes ?? null,
    })),
    error: job.error,
    source: job.source ?? "ui",
    created_at: ts(job.createdAt),
    updated_at: ts(job.updatedAt),
  };
}
