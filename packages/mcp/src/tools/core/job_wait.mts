import { z } from "zod";
import { MotionFieldError, type Job, type MotionField } from "../../../../sdk-ts/src/index.ts";
import { ok, type ToolDef } from "../../registry.mts";
import { jobIdArg } from "../../guards.mts";

const TIMEOUT_CAP_S = 50;

const Input = z.object({
  ids: z.array(z.string()).min(1).max(12).describe("job UUIDs"),
  timeout_s: z.number().positive().max(TIMEOUT_CAP_S).optional().describe(`wait budget in seconds (max ${TIMEOUT_CAP_S})`),
});

/** One bad id must not sink the whole batch - errors land in place, the way
 *  generate_batch reports per-item failures. */
async function waitOne(client: MotionField,
  id: string, timeoutS?: number): Promise<Job | { id: string; error: { code: string; message: string } }> {
  try {
    return await client.wait(id, { timeoutMs: Math.min(timeoutS ?? TIMEOUT_CAP_S, TIMEOUT_CAP_S) * 1000 });
  } catch (e) {
    let err = e;
    if (err instanceof MotionFieldError && err.code === "wait_timeout") {
      try {
        // wait budget expired is a status, not a failure - surface the live view
        return await client.get(id);
      } catch (e2) {
        err = e2;
      }
    }
    return {
      id,
      error: err instanceof MotionFieldError
        ? { code: err.code, message: err.message }
        : { code: "internal_error", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

export default {
  name: "job_wait",
  toolset: "core",
  capability: "jobs.list",
  description:
    `Poll up to 12 jobs until they reach a terminal status (or ${TIMEOUT_CAP_S}s max). ` +
    "Returns each job's view - a job still live at the deadline comes back with its current status, " +
    "and a job that fails to fetch (bad id, network) reports its error in place.",
  input: Input,
  async handler(args, ctx) {
    const { ids, timeout_s } = Input.parse(args);
    const uuids = ids.map((id) => jobIdArg(id));
    const jobs = await Promise.all(uuids.map((id) => waitOne(ctx.client, id, timeout_s)));
    return ok({ jobs });
  },
} satisfies ToolDef;
