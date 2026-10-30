import { z } from "zod";
import { ok, type ToolDef } from "../../registry.mts";
import { jobIdArg } from "../../guards.mts";

const Input = z.object({
  id: z.string().describe("job UUID"),
});

export default {
  name: "job_cancel",
  toolset: "core",
  capability: "jobs",
  description: "Cancel a queued or in-progress job - the credit hold is refunded automatically.",
  input: Input,
  async handler(args, ctx) {
    const { id } = Input.parse(args);
    return ok(await ctx.client.cancel(jobIdArg(id)));
  },
} satisfies ToolDef;
