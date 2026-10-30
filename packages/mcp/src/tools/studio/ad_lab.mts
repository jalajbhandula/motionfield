import { z } from "zod";
import { notAvailable, type ToolDef } from "../../registry.mts";

const Input = z.object({
  action: z.enum(["kit_from_url", "products", "avatars", "create", "presets"]).optional(),
  url: z.string().optional().describe("kit_from_url - the product page to build a kit from"),
  brief: z.string().optional().describe("create - the ad to make"),
  preset_id: z.string().optional().describe("create - a presets pick"),
});

export default {
  name: "ad_lab",
  toolset: "studio",
  capability: "ads",
  owner: "WS4 s11",
  pending: true,
  description:
    "Ad Lab - brand kits, product shots, avatars and ad generation. Not in this build yet.",
  input: Input,
  async handler() {
    return notAvailable("capability 'ads' is not reported by this server - it lands when its owner step (WS4 s11) merges");
  },
} satisfies ToolDef;
