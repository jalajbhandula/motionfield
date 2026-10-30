import { z } from "zod";
import { ok, type ToolDef } from "../../registry.mts";
import { jobIdArg } from "../../guards.mts";

const Input = z.object({
  id: z.string().describe("run UUID"),
  action: z.enum(["pause", "resume", "stop", "cancel"]).describe("control verb - cancel is an alias for stop"),
});

export default {
  name: "run_control",
  toolset: "core",
  capability: "runs",
  description:
    "Pause, resume or stop a run. Pause parks it (an in-flight step still finishes); resume " +
    "continues; stop ends the run for good (cancel is the same verb). " +
    "Each verb is idempotent; a transition the current status forbids is a conflict.",
  input: Input,
  async handler(args, ctx) {
    const { id, action } = Input.parse(args);
    return ok(await ctx.client.controlRun(jobIdArg(id, "run"), action === "cancel" ? "stop" : action));
  },
} satisfies ToolDef;
