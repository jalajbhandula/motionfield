import { z } from "zod";
import { MotionFieldError } from "../../../../sdk-ts/src/index.ts";
import { ok, type ToolDef } from "../../registry.mts";

const WAIT_CAP_S = 50;

const Input = z.object({
  endpoint: z.string().describe("endpoint id from models_list"),
  params: z.record(z.string(), z.unknown()).optional().describe("the endpoint's params - prompt, aspect_ratio, preset_id, media urls from upload, …"),
  wait_s: z.number().positive().max(WAIT_CAP_S).optional().describe(`poll this many seconds for completion (max ${WAIT_CAP_S})`),
});

export default {
  name: "generate",
  toolset: "core",
  capability: "jobs",
  description:
    "Submit one generation job on an endpoint from models_list. Returns the job id + status; " +
    "with wait_s it polls until the job reaches a terminal state (or the wait budget - never " +
    "longer than 50s - expires, returning the live status). Download outputs with job_download.",
  input: Input,
  async handler(args, ctx) {
    const { endpoint, params, wait_s } = Input.parse(args);
    const created = await ctx.client.submit(endpoint, params ?? {});
    if (!wait_s) return ok(created);
    try {
      return ok(await ctx.client.wait(created.id, { timeoutMs: Math.min(wait_s, WAIT_CAP_S) * 1000 }));
    } catch (e) {
      // wait budget expired is a status, not a failure - surface the live view
      if (e instanceof MotionFieldError && e.code === "wait_timeout")
        return ok(await ctx.client.get(created.id));
      throw e;
    }
  },
} satisfies ToolDef;
