import { z } from "zod";
import { MotionFieldError } from "../../../../sdk-ts/src/index.ts";
import { ok, toolError, type ToolDef } from "../../registry.mts";
import { jobIdArg } from "../../guards.mts";

const Input = z.object({
  id: z.string().describe("run UUID"),
  step_id: z.string().describe("the step's id inside the plan - s1, s2, … as run_get lists them"),
  rev: z.number().int().min(0).describe("the step's current revision - run_get shows it per step; a stale rev is refused with the head rev"),
  title: z.string().optional().describe("new step title"),
  params: z.record(z.string(), z.unknown()).optional().describe("params merged onto the step's stored spec - the whole step revalidates"),
});

export default {
  name: "run_edit_step",
  toolset: "core",
  capability: "runs",
  description:
    "Edit one step's spec - title and/or params - against the revision run_get last showed " +
    "(optimistic concurrency). A stale rev answers stale_revision carrying head_rev: refetch " +
    "run_get and resend at the head revision.",
  input: Input,
  async handler(args, ctx) {
    const a = Input.parse(args);
    if (a.title === undefined && (a.params === undefined || !Object.keys(a.params).length))
      return toolError("invalid_params", "run_edit_step needs title and/or params to merge onto the step's spec");
    try {
      return ok(await ctx.client.editStep(jobIdArg(a.id, "run"), a.step_id, {
        rev: a.rev, title: a.title, params: a.params,
      }));
    } catch (e) {
      if (e instanceof MotionFieldError && e.code === "stale_revision")
        return toolError("stale_revision", e.message, {
          status: 409,
          ...(e.headRev != null ? { head_rev: e.headRev } : {}),
        });
      throw e;
    }
  },
} satisfies ToolDef;
