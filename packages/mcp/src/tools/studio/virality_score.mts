import { z } from "zod";
import { notAvailable, type ToolDef } from "../../registry.mts";

const Input = z.object({
  video_url: z.string().optional().describe("the clip to score - a /files/ url you own"),
});

export default {
  name: "virality_score",
  toolset: "studio",
  capability: "virality",
  owner: "WS2 s14",
  pending: true,
  description:
    "Virality analysis - a rubric score {overall, hook, sustain, retention_risk, reasons} " +
    "labelled \"heuristic\". Not in this build yet.",
  input: Input,
  async handler() {
    return notAvailable("capability 'virality' is not reported by this server - it lands when its owner step (WS2 s14) merges");
  },
} satisfies ToolDef;
