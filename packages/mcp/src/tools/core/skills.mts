import { z } from "zod";
import { notAvailable, ok, toolError, type ToolDef } from "../../registry.mts";

const Input = z.object({
  action: z.enum(["list", "get", "run", "import"]).describe("list | get | run | import"),
  slug: z.string().optional().describe("get/run - skill slug from skills{action:list}"),
  brief: z.string().optional().describe("run - the topic/brief the skill expands on (required for run)"),
  params: z.record(z.string(), z.unknown()).optional().describe("run - intake answers for the skill"),
  answers: z.record(z.string(), z.unknown()).optional()
    .describe("run - alias of `params`, the API/SDK spelling for intake answers"),
  inputs: z.array(z.object({ url: z.string(), mime: z.string().optional() })).optional()
    .describe("run - media the pipeline consumes (/files/ urls from the upload tool or earlier outputs)"),
  path: z.string().optional().describe("import - local folder holding the skill definition"),
});

export default {
  name: "skills",
  toolset: "core",
  capability: "skills.read",
  description:
    "Skill pipelines - multi-step generation recipes. " +
    "list: the catalog (slug, name, what each produces). get: one skill plus its generated " +
    "SKILL.md - front matter, pipeline steps, intake questions, endpoints. " +
    "run: start a skill run (needs the 'runs' capability). " +
    "import: bring your own skill folder (needs the 'skills.import' capability).",
  input: Input,
  async handler(args, ctx) {
    const a = Input.parse(args);
    switch (a.action) {
      case "list":
        return ok({ skills: await ctx.client.skills() });
      case "get": {
        if (!a.slug) return toolError("invalid_params", "skills{action:get} needs slug");
        return ok(await ctx.client.skill(a.slug));
      }
      case "run": {
        if (!ctx.caps.has("runs"))
          return notAvailable("skills{action:run} needs the 'runs' capability - this server does not report it");
        if (!a.slug) return toolError("invalid_params", "skills{action:run} needs slug");
        if (!a.brief)
          return toolError("invalid_params", "skills{action:run} needs brief - the topic the skill expands on");
        // intake answers ride the run body's `answers` - strings on the wire;
        // `answers` is accepted as an alias of `params` (the API/SDK spelling)
        const intake = a.params ?? a.answers;
        const answers = Object.fromEntries(
          Object.entries(intake ?? {})
            .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
        return ok(await ctx.client.createRun({
          skill: a.slug, brief: a.brief, ...(Object.keys(answers).length ? { answers } : {}),
          ...(a.inputs?.length ? { inputs: a.inputs } : {}),
        }));
      }
      case "import":
        if (!ctx.caps.has("skills.import"))
          return notAvailable("skills{action:import} needs the 'skills.import' capability - this server does not report it");
        return notAvailable("skill import lands in a later step - this server reports 'skills.import' but there is no import endpoint yet");
    }
  },
} satisfies ToolDef;
