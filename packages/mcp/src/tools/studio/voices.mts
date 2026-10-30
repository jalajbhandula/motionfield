import { z } from "zod";
import { notAvailable, toolError, type ToolDef } from "../../registry.mts";
import { submitJob, waitField } from "./_job.mts";

const ENDPOINT = "motionfield/chatterbox/voice-clone";

const Input = z.object({
  action: z.enum(["list", "create"]),
  audio_url: z.string().optional()
    .describe("create only - the voice sample, a /files/ url you own (omit → get the recorder page)"),
  prompt: z.string().optional().describe("create only - the line the voice should speak"),
  consent: z.boolean().optional()
    .describe("create only - required true: you assert the right to clone this voice"),
  exaggeration: z.number().min(0.25).max(2).optional().describe("create only - expressiveness (0.25-2)"),
  wait_s: waitField,
});

export default {
  name: "voices",
  toolset: "studio",
  endpoints: [ENDPOINT],
  description:
    "Voices - create clones a voice sample saying a line (Chatterbox; needs consent:true). " +
    "list shows your saved voices once the 'voices' capability lands. Call create without " +
    "audio_url to get the app's recording page.",
  input: Input,
  async handler(args, ctx) {
    const a = Input.parse(args);
    if (a.action === "list")
      return notAvailable("capability 'voices' is not reported by this server - it lands when its owner step (WS5) merges");

    // create
    if (!a.audio_url)
      return toolError("invalid_params",
        "create needs audio_url - a /files/ url you own; record one in the app first " +
        `(${process.env.MOTIONFIELD_URL ?? "http://localhost:3000"}/audio), upload it, then call create again`);
    if (!a.prompt)
      return toolError("invalid_params", "create needs prompt - the line the voice should speak");
    if (a.consent !== true)
      return toolError("consent_required", "pass consent:true to assert you may clone this voice");
    const params: Record<string, unknown> = { audio_url: a.audio_url, prompt: a.prompt };
    if (a.exaggeration !== undefined) params.exaggeration = a.exaggeration;
    return submitJob(ctx, ENDPOINT, params, a.wait_s);
  },
} satisfies ToolDef;
