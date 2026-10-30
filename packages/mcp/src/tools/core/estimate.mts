import { z } from "zod";
import { ok, type ToolDef } from "../../registry.mts";

const Input = z.object({
  endpoint: z.string().describe("endpoint id from models_list"),
  params: z.record(z.string(), z.unknown()).optional(),
});

export default {
  name: "estimate",
  toolset: "core",
  capability: "estimate",
  description: "Credit + USD cost preview for an endpoint + params - identical to what submit would charge.",
  input: Input,
  async handler(args, ctx) {
    const { endpoint, params } = Input.parse(args);
    return ok(await ctx.client.estimate(endpoint, params ?? {}));
  },
} satisfies ToolDef;
