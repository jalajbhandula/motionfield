import { z } from "zod";
import { notAvailable, type ToolDef } from "../../registry.mts";

const Input = z.object({
  query: z.string().optional().describe("what the clip should look like"),
  tags: z.array(z.string()).optional().describe("clip tags to filter on"),
});

export default {
  name: "anim_clips",
  toolset: "3d",
  capability: "anim_clips",
  owner: "WS5b S1",
  pending: true,
  description:
    "Search the animation-clip library for a Stage character rig. Not in this build yet.",
  input: Input,
  async handler() {
    return notAvailable("capability 'anim_clips' is not reported by this server - it lands when its owner step (WS5b S1) merges");
  },
} satisfies ToolDef;
