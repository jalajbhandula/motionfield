import { z } from "zod";
import { notAvailable, type ToolDef } from "../../registry.mts";

const Input = z.object({
  video_urls: z.array(z.string()).optional()
    .describe("the synced angle clips - /files/ urls you own"),
  audio_url: z.string().optional().describe("the mixed track - a /files/ url you own"),
});

export default {
  name: "podcast_edit",
  toolset: "studio",
  capability: "podcast",
  owner: "WS2 s16",
  pending: true,
  description:
    "Podcast multi-angle edit - speaker detection → auto-cut → an MP4. Not in this build yet.",
  input: Input,
  async handler() {
    return notAvailable("capability 'podcast' is not reported by this server - it lands when its owner step (WS2 s16) merges");
  },
} satisfies ToolDef;
