import { z } from "zod";
import { notAvailable, toolError, type ToolDef } from "../../registry.mts";
import { consentField, submitJob, waitField } from "./_job.mts";

const ENDPOINT = "motionfield/re-edit/v1.0";
const FLOWS = ["character-swap", "motion-transfer", "restyle"] as const;

const Input = z.strictObject({
  video_url: z.string().min(1)
    .describe("the reference edit - a /files/ url you own (1-30 s)"),
  flow: z.enum(FLOWS).default("character-swap")
    .describe("character-swap puts your people in the shots · motion-transfer keeps the motion on a new subject · restyle re-renders the look"),
  image_urls: z.array(z.string().max(4096)).max(3).default([])
    .describe("subject refs - /files/ urls you own; character-swap takes up to 3, motion-transfer/restyle use the first one"),
  likeness_consent: consentField,
  instructions: z.string().max(2000).optional()
    .describe("per-shot edit notes - e.g. keep the opening wide shot, put my product in the hero frame"),
  preset_id: z.string().max(200).optional().describe("a verified restyle preset id (restyle flow only)"),
  resolution: z.enum(["480p", "720p"]).default("480p"),
  steps: z.number().int().min(2).max(50).optional()
    .describe("sampler steps - blank runs each flow graph's own default"),
  wait_s: waitField,
});

export default {
  name: "re_edit",
  toolset: "studio",
  endpoints: [ENDPOINT],
  description:
    "ReCut - rebuild a reference edit with your own subjects. The server splits the clip " +
    "into shots (detected server-side, reported via probe), regenerates each window on " +
    "Wan 2.1 VACE, and returns one file with the original shot order, timing, aspect, fps " +
    "and soundtrack - ONE recipe job, no child jobs.",
  input: Input,
  async handler(args, ctx) {
    const a = Input.parse(args);
    if (!ctx.models?.has(ENDPOINT))
      return notAvailable(`endpoint ${ENDPOINT} is not in the startup model catalog`);
    if (a.flow !== "restyle" && a.image_urls.length === 0)
      return toolError("invalid_params", `${a.flow} needs at least one image_urls entry`);
    if (a.flow !== "restyle" && a.likeness_consent !== true)
      return toolError("consent_required",
        "pass likeness_consent:true to assert you may use this person's likeness");
    if (a.preset_id && a.flow !== "restyle")
      return toolError("invalid_params", "preset_id only applies to the restyle flow");
    const { probe } = await ctx.client.probe(a.video_url);
    if (probe.windows == null)
      return toolError("probe_failed", "shot detection failed on this clip - can't size the ReCut charge");
    const params: Record<string, unknown> = {
      video_url: a.video_url,
      flow: a.flow,
      image_urls: a.image_urls,
      resolution: a.resolution,
      likeness_consent: a.likeness_consent === true,
      windows: probe.windows,
    };
    if (a.instructions !== undefined) params.instructions = a.instructions;
    if (a.preset_id !== undefined) params.preset_id = a.preset_id;
    if (a.steps !== undefined) params.steps = a.steps;
    return submitJob(ctx, ENDPOINT, params, a.wait_s);
  },
} satisfies ToolDef;
