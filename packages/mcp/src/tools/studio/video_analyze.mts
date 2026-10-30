import { z } from "zod";
import { notAvailable, type ToolDef } from "../../registry.mts";

const Input = z.object({
  video_url: z.string().optional().describe("the clip to analyze - a /files/ url you own"),
  question: z.string().optional().describe("what to look for"),
});

export default {
  name: "video_analyze",
  toolset: "studio",
  capability: "video_analyze",
  owner: "WS2 s17",
  pending: true,
  description:
    "Vision analysis of a clip. Not in this build yet.",
  input: Input,
  async handler() {
    return notAvailable("capability 'video_analyze' is not reported by this server - it lands when its owner step (WS2 s17) merges");
  },
} satisfies ToolDef;
