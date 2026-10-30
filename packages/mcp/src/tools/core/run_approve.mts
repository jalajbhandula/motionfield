import { z } from "zod";
import { ok, type ToolDef } from "../../registry.mts";
import { jobIdArg } from "../../guards.mts";

const Input = z.object({
  id: z.string().describe("run UUID"),
});

export default {
  name: "run_approve",
  toolset: "core",
  capability: "runs",
  description:
    "Approve a run's plan so its steps start executing. Idempotent - approving a run already " +
    "past the gate returns its view; an unknown run is not_found.",
  input: Input,
  async handler(args, ctx) {
    const { id } = Input.parse(args);
    return ok(await ctx.client.approveRun(jobIdArg(id, "run")));
  },
} satisfies ToolDef;
