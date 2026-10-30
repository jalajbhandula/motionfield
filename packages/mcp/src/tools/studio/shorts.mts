import { z } from "zod";
import { notAvailable, type ToolDef } from "../../registry.mts";

const Input = z.object({
  action: z.enum(["create", "preset_create"]).optional(),
  video_url: z.string().optional().describe("create - the footage, a /files/ url you own (≤2 min)"),
  preset: z.string().optional().describe("a shorts preset id"),
});

export default {
  name: "shorts",
  toolset: "studio",
  capability: "shorts",
  owner: "WS4 s13b",
  pending: true,
  description:
    "Shorts sessions - restyled short clips and your own shorts presets. Not in this build yet.",
  input: Input,
  async handler() {
    return notAvailable("capability 'shorts' is not reported by this server - it lands when its owner step (WS4 s13b) merges");
  },
} satisfies ToolDef;
