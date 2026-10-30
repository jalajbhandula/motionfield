import { z } from "zod";
import { notAvailable, type ToolDef } from "../../registry.mts";
import { submitJob, waitField } from "./_job.mts";

const ENDPOINT = "motionfield/reshoot/video";

const Input = z.strictObject({
  video_url: z.string().min(1)
    .describe("the source clip - a /files/ url you own (≤2s advised locally, ≤31s hard cap)"),
  moves: z.array(z.string().min(1)).min(1).max(3).optional()
    .describe("1-3 catalog trajectory ids (video-capable) - '+'-joined for the endpoint; default locked-off"),
  prompt: z.string().optional().describe("scene/style prompt - blank keeps the scene's own description"),
  negative_prompt: z.string().optional(),
  backend: z.enum(["local", "cloud"]).optional()
    .describe("local = Mac DA3 + rig + Wan VACE (default) · cloud = Uni3C 14B - cloud-recommended, untested"),
  strength: z.number().min(0.25).max(2).optional().describe("move strength 0.25-2 (default 1)"),
  distance: z.number().min(0.5).max(20).optional().describe("subject distance, metres (default 4)"),
  steps: z.number().int().min(2).max(50).optional().describe("sampler steps (default 8)"),
  seed: z.number().int().optional().describe("noise seed - random when unset"),
  wait_s: waitField,
});

export default {
  name: "reshoot",
  toolset: "studio",
  endpoints: [ENDPOINT],
  description:
    "Re-shoot your clip along a new camera path - DA3 recovers the source camera, the rig " +
    "re-projects each frame through its recovered pose, Wan VACE fills disocclusions. Timing " +
    "matches the source frame-for-frame; output is silent. Probes the clip server-side for the " +
    "frames/fps/duration/dims the endpoint requires.",
  input: Input,
  async handler(args, ctx) {
    const a = Input.parse(args);
    if (!ctx.models?.has(ENDPOINT))
      return notAvailable(`endpoint ${ENDPOINT} is not in the startup model catalog`);
    const { probe } = await ctx.client.probe(a.video_url);
    // the same fields /api/reshoot/submit stamps from the real probe - the
    // endpoint's validate refuses hand-built numbers
    const params: Record<string, unknown> = {
      video_url: a.video_url,
      frames: probe.frames,
      fps: probe.fps,
      duration: probe.frames / probe.fps,
      width: probe.render_width,
      height: probe.render_height,
    };
    if (a.moves?.length) params.moves = a.moves.join("+");
    if (a.prompt !== undefined) params.prompt = a.prompt;
    if (a.negative_prompt !== undefined) params.negative_prompt = a.negative_prompt;
    if (a.backend !== undefined) params.backend = a.backend;
    if (a.strength !== undefined) params.strength = a.strength;
    if (a.distance !== undefined) params.distance = a.distance;
    if (a.steps !== undefined) params.steps = a.steps;
    if (a.seed !== undefined) params.seed = a.seed;
    return submitJob(ctx, ENDPOINT, params, a.wait_s);
  },
} satisfies ToolDef;
