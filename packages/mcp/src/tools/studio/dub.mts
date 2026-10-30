import { z } from "zod";
import { liveEndpoint, toolError, type ToolDef } from "../../registry.mts";
import { submitJob, waitField, consentField } from "./_job.mts";

const ENDPOINTS = ["motionfield/dub/v1"];

const Input = z.object({
  video_url: z.string().min(1).describe("the English talking clip to dub - a /files/ url you own (≤120s)"),
  language: z.enum(["es", "fr", "it", "pt", "hi", "ja", "zh"]).describe("target language"),
  voice: z.enum(["auto", "female", "male"]).optional().describe("native base voice converted to the speaker's timbre - auto picks from their pitch"),
  lipsync: z.boolean().optional().describe("re-sync the lips with MuseTalk (default true; false is much faster)"),
  original_volume: z.number().min(0).max(0.5).optional().describe("keep the original audio underneath at this level (0 = replace)"),
  likeness_consent: consentField,
  wait_s: waitField,
});

export default {
  name: "dub",
  toolset: "studio",
  endpoints: ENDPOINTS,
  description:
    "Dub an English talking clip into Spanish, French, Italian, Portuguese, Hindi, Japanese or Mandarin - " +
    "transcribed, translated by the server's local LLM, spoken natively and converted to the speaker's own " +
    "voice, lips re-synced. likeness_consent:true is required - you assert the right to use that person's voice and likeness.",
  input: Input,
  async handler(args, ctx) {
    const { likeness_consent, wait_s, ...rest } = Input.parse(args);
    if (likeness_consent !== true)
      return toolError("consent_required",
        "pass likeness_consent:true to assert you may use this person's voice and likeness");
    const params: Record<string, unknown> = { likeness_consent };
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) params[k] = v;
    return submitJob(ctx, liveEndpoint({ endpoints: ENDPOINTS }, ctx)!, params, wait_s);
  },
} satisfies ToolDef;
