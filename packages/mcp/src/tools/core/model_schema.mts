import { z } from "zod";
import { ok, toolError, type ToolDef } from "../../registry.mts";

const Input = z.object({
  endpoint: z.string().describe("endpoint id, e.g. motionfield/z-image-turbo/text-to-image"),
});

export default {
  name: "model_schema",
  toolset: "core",
  capability: "models",
  description: "One endpoint's full record - inputs JSON Schema, license and estimate.",
  input: Input,
  async handler(args, ctx) {
    const { endpoint } = Input.parse(args);
    const found = (await ctx.client.models()).find((m) => m.id === endpoint);
    if (!found) return toolError("not_found", `no endpoint "${endpoint}" in the catalog`);
    return ok(found);
  },
} satisfies ToolDef;
