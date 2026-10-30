import { z } from "zod";
import { liveEndpoint, toolError, type ToolDef } from "../../registry.mts";
import { submitJob, waitField, consentField } from "./_job.mts";

const ENDPOINTS = ["motionfield/wan-vace/character-swap", "motionfield/wan-animate/character-swap"];

const Input = z.object({
  video_url: z.string().min(1).describe("the source clip - a /files/ url you own (≥4s, ≤30s)"),
  image_url: z.string().min(1).describe("the replacement character - a /files/ image url you own"),
  likeness_consent: consentField,
  prompt: z.string().optional().describe("extra direction for the swap"),
  wait_s: waitField,
});

export default {
  name: "person_swap",
  toolset: "studio",
  endpoints: ENDPOINTS,
  description:
    "Swap the performer in a clip for the person in an image - Wan VACE character swap, or " +
    "Wan Animate when that's the one the catalog lists. likeness_consent:true is required - " +
    "you assert the right to use that person's likeness.",
  input: Input,
  async handler(args, ctx) {
    const { video_url, image_url, likeness_consent, prompt, wait_s } = Input.parse(args);
    if (likeness_consent !== true)
      return toolError("consent_required",
        "pass likeness_consent:true to assert you may use this person's likeness");
    const params: Record<string, unknown> = {
      video_url, image_urls: [image_url], likeness_consent,
    };
    if (prompt !== undefined) params.prompt = prompt;
    return submitJob(ctx, liveEndpoint({ endpoints: ENDPOINTS }, ctx)!, params, wait_s);
  },
} satisfies ToolDef;
