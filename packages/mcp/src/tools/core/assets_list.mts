import { z } from "zod";
import { notAvailable, ok, type ToolDef } from "../../registry.mts";

const Input = z.object({
  kind: z.string().optional().describe("asset kind - image, video, audio, file"),
  source: z.enum(["ui", "api", "cli", "mcp", "agent"]).optional().describe("the surface that produced the asset"),
  cursor: z.string().optional().describe("next_cursor from a previous call"),
  limit: z.number().int().min(1).max(100).optional(),
});

export default {
  name: "assets_list",
  toolset: "core",
  capability: "assets",
  description:
    "The account's generated assets (output files), newest first - filter by kind or the " +
    "surface that produced them. Follow next_cursor as `cursor`.",
  input: Input,
  async handler(args, ctx) {
    const a = Input.parse(args);
    if (a.source && !ctx.caps.has("jobs.source"))
      return notAvailable("source filters need the 'jobs.source' capability");
    return ok(await ctx.client.listAssets({ kind: a.kind, source: a.source, before: a.cursor, limit: a.limit }));
  },
} satisfies ToolDef;
