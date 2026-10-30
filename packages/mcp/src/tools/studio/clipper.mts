import { z } from "zod";
import { notAvailable, type ToolDef } from "../../registry.mts";

const Input = z.object({
  video_url: z.string().optional()
    .describe("the clip to cut - local uploads only (/files/uploads/)"),
  range: z.string().optional().describe("the range to keep, e.g. \"0:04-0:12\""),
});

export default {
  name: "clipper",
  toolset: "studio",
  capability: "clipper",
  pending: true,
  description:
    "Clip cutter - cut a range out of one of your own uploaded clips (not in this build yet).",
  input: Input,
  async handler() {
    return notAvailable("capability 'clipper' is not reported by this server - it lands when its owner step merges");
  },
} satisfies ToolDef;
