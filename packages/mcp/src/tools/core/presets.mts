import { z } from "zod";
import { ok, toolError, type ToolDef } from "../../registry.mts";

const Input = z.object({
  action: z.enum(["list", "get", "resolve"]).describe("list | get | resolve"),
  kind: z.string().optional().describe("list only - preset kind: motion, effect, style, palette, mixed-media"),
  id: z.string().optional().describe("get only - preset id from presets{action:list}"),
  endpoint: z.string().optional().describe("resolve only - endpoint id the params will be submitted to"),
  params: z.record(z.string(), z.unknown()).optional().describe("resolve only - params that may carry preset ids (`*_preset`, `preset_id`, `look_id`)"),
});

export default {
  name: "presets",
  toolset: "core",
  capability: "presets",
  description:
    "Named param recipes - styles, effects, shot presets. " +
    "list: the catalog (optionally filtered by kind). get: one preset by id - its apply " +
    "params, prompt fragment, input requirement and credit cost. resolve: preview what " +
    "preset markers in a params block (`*_preset`, `preset_id`, `look_id`) merge into " +
    "for one endpoint, without creating a job.",
  input: Input,
  async handler(args, ctx) {
    const a = Input.parse(args);
    switch (a.action) {
      case "list":
        return ok({ presets: await ctx.client.listPresets({ kind: a.kind }) });
      case "get": {
        if (!a.id) return toolError("invalid_params", "presets{action:get} needs id");
        const found = (await ctx.client.listPresets()).find((p) => p.id === a.id);
        if (!found) return toolError("not_found", `no preset "${a.id}"`);
        return ok(found);
      }
      case "resolve": {
        if (!a.endpoint) return toolError("invalid_params", "presets{action:resolve} needs endpoint");
        return ok(await ctx.client.resolvePreset(a.endpoint, a.params ?? {}));
      }
    }
  },
} satisfies ToolDef;
