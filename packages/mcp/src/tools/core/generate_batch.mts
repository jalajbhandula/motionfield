import { z } from "zod";
import { MotionFieldError } from "../../../../sdk-ts/src/index.ts";
import { ok, type ToolDef } from "../../registry.mts";

const Input = z.object({
  requests: z.array(z.object({
    endpoint: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  })).min(1).max(12).describe("endpoint + params pairs, 1-12"),
});

export default {
  name: "generate_batch",
  toolset: "core",
  capability: "jobs",
  description:
    "Submit several generation jobs at once (1-12 items). Each item gets its own id, in " +
    "request order; a per-item API error is reported in place and does not stop the rest. " +
    "Poll the ids with job_wait / jobs_list{ids}.",
  input: Input,
  async handler(args, ctx) {
    const { requests } = Input.parse(args);
    const results: unknown[] = [];
    for (const item of requests) {
      try {
        const created = await ctx.client.submit(item.endpoint, item.params ?? {});
        results.push({ endpoint: item.endpoint, id: created.id, status: created.status });
      } catch (e) {
        results.push({
          endpoint: item.endpoint,
          error: e instanceof MotionFieldError
            ? { code: e.code, message: e.message, status: e.status, ...(e.license ? { license: e.license, enable_at: e.enableAt } : {}) }
            : { code: "internal_error", message: e instanceof Error ? e.message : String(e) },
        });
      }
    }
    return ok({ results });
  },
} satisfies ToolDef;
