import { z } from "zod";
import { ok, type ToolDef } from "../../registry.mts";
import { jobIdArg } from "../../guards.mts";

const Input = z.object({
  id: z.string().describe("job UUID"),
});

export default {
  name: "job_status",
  toolset: "core",
  capability: "jobs.list",
  description: "One job's live view - status, progress, outputs (url/type/bytes), error, source.",
  input: Input,
  async handler(args, ctx) {
    const { id } = Input.parse(args);
    return ok(await ctx.client.get(jobIdArg(id)));
  },
} satisfies ToolDef;
