import { z } from "zod";
import { ok, toolError, type ToolDef } from "../../registry.mts";

const Input = z.object({
  plan: z.looseObject({
    title: z.string().optional(),
    steps: z.array(z.looseObject({
      id: z.string(),
      title: z.string(),
      endpoint_id: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
      depends_on: z.array(z.string()).optional(),
    })).min(1),
  }).optional().describe("literal plan - the same {title, steps[{id,title,endpoint_id,params,depends_on}]} shape the API takes"),
  brief: z.string().optional().describe("what the run should produce - the skill's brief, or a plain-language brief the server planner turns into a plan"),
  planner: z.string().optional().describe("planner pick for a brief-only run - \"builtin\" or \"<provider>:<model>\""),
  skill: z.string().optional().describe("skill slug to run - from skills{action:list}"),
  params: z.record(z.string(), z.unknown()).optional().describe("intake answers for the skill (skill runs only)"),
  answers: z.record(z.string(), z.unknown()).optional()
    .describe("alias of `params` - the API/SDK spelling for intake answers"),
  inputs: z.array(z.object({ url: z.string(), mime: z.string().optional() })).optional()
    .describe("media the run can consume - /files/ urls (text and skill runs only)"),
  mode: z.enum(["auto", "offline"]).optional().describe("auto allows every licensed endpoint; offline keeps planning + steps local"),
  ask_first: z.boolean().optional().describe("park the run at awaiting_approval until run_approve"),
});

export default {
  name: "run_create",
  toolset: "core",
  capability: "runs",
  description:
    "Create a multi-step run - exactly one form: a literal `plan`, `skill` + `brief` (+ optional " +
    "intake `params`) so the catalog skill's pipeline becomes the plan, or `brief` alone (+ optional " +
    "`planner` pick: \"builtin\" or \"<provider>:<model>\") for the server planner. `inputs` supply " +
    "media the skill/planner fills in. Returns the run view - status awaiting_approval means it waits " +
    "for run_approve before any step submits. Poll with run_get; gate it with ask_first to review first.",
  input: Input,
  async handler(args, ctx) {
    const a = Input.parse(args);
    const intake = a.params ?? a.answers; // `answers` is the API/SDK spelling
    if (a.plan !== undefined) {
      if (a.skill !== undefined || a.brief !== undefined || intake !== undefined || a.planner !== undefined)
        return toolError("invalid_params", "plan runs take only plan (+ mode/ask_first) - brief, skill, params/answers and planner don't apply");
      if (a.inputs !== undefined)
        return toolError("invalid_params", "inputs only apply to text and skill runs");
      return ok(await ctx.client.createRun({
        plan: a.plan, mode: a.mode, ask_first: a.ask_first,
      }));
    }
    if (a.skill !== undefined) {
      if (!a.brief)
        return toolError("invalid_params", "skill runs need brief - the topic the skill expands on");
      if (a.planner !== undefined)
        return toolError("invalid_params", "planner only applies to brief runs - skill runs name their own pipeline");
      const answers = intake
        ? Object.fromEntries(Object.entries(intake).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]))
        : undefined;
      return ok(await ctx.client.createRun({
        skill: a.skill, brief: a.brief, answers, inputs: a.inputs, mode: a.mode, ask_first: a.ask_first,
      }));
    }
    if (a.brief !== undefined) {
      if (intake) return toolError("invalid_params", "params/answers only apply to skill runs - pass a skill slug too");
      return ok(await ctx.client.createRun({
        text: a.brief, planner: a.planner, inputs: a.inputs, mode: a.mode, ask_first: a.ask_first,
      }));
    }
    if (a.planner !== undefined || intake !== undefined)
      return toolError("invalid_params", "planner and params/answers only apply alongside brief or skill - pass one too");
    return toolError("invalid_params", "run_create needs plan, brief (with or without a skill slug)");
  },
} satisfies ToolDef;
