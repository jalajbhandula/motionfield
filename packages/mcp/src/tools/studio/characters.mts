import { z } from "zod";
import { notAvailable, type ToolDef } from "../../registry.mts";

const Input = z.object({
  action: z.enum(["list", "create"]).optional(),
  name: z.string().optional().describe("create only"),
  character_id: z.string().optional().describe("an existing character id to list details for"),
  images: z.array(z.string()).optional().describe("create only - /files/ reference images"),
});

export default {
  name: "characters",
  toolset: "studio",
  capability: "characters",
  owner: "WS4 s8",
  pending: true,
  description:
    "Reusable characters - list or create. Not in this build yet.",
  input: Input,
  async handler() {
    return notAvailable("capability 'characters' is not reported by this server - it lands when its owner step (WS4 s8) merges");
  },
} satisfies ToolDef;
