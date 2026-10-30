import { z } from "zod";
import { ok, type ToolDef } from "../../registry.mts";
import { jobIdArg } from "../../guards.mts";

const Input = z.object({
  id: z.string().describe("run UUID"),
});

export default {
  name: "run_get",
  toolset: "core",
  capability: "runs",
  description:
    "One run's live view - status (awaiting_approval | running | paused | done | failed | stopped), " +
    "steps with per-step status/rev/outputs/error, estimate, planner info. A live run ticks once on read.",
  input: Input,
  async handler(args, ctx) {
    const { id } = Input.parse(args);
    return ok(await ctx.client.getRun(jobIdArg(id, "run")));
  },
} satisfies ToolDef;
