import { z } from "zod";
import { notAvailable, toolError, type ToolDef } from "../../registry.mts";
import { submitJob, waitField } from "./_job.mts";

const ENDPOINT = "motionfield/ltx-video/vfx-lab-plate";
const VFX_FPS = 24;
const RES_BOXES: Record<string, [number, number]> = { "480p": [832, 480], "720p": [1280, 704] };

/** Largest 8n+1 frame count at 24 fps no bigger than `sec` - the same
 *  math the submit route derives from the plate probe (vfxFrames). */
const vfxFrames = (sec: number) => {
  const target = Math.round(sec * VFX_FPS);
  return Math.max(17, Math.floor((target - 1) / 8) * 8 + 1);
};

const Input = z.strictObject({
  video_url: z.string().min(1)
    .describe("the plate clip - a /files/ url you own (0.7-10 s)"),
  prompt: z.string().optional().describe("the effect to apply to the plate"),
  negative_prompt: z.string().optional(),
  engine: z.enum(["ltx095", "ltx098"]).optional()
    .describe("ltx095 = LTX-Video 2B 0.9.5 (runs on this Mac) · ltx098 = distilled - only when the checkpoint is installed"),
  plate_lock: z.enum(["light", "medium", "strong", "full"]).optional()
    .describe("how much of the plate survives - light ≈ denoise 0.4, full re-generates (default medium)"),
  hold: z.union([z.literal(0), z.literal(9), z.literal(17), z.literal(25)]).optional()
    .describe("plate frames pinned as the opening guide (default 9)"),
  end_image_url: z.string().optional()
    .describe("optional last-frame keyframe - a /files/ image url you own"),
  target_strength: z.number().min(0.5).max(1).optional()
    .describe("how hard the end keyframe pulls (default 0.8)"),
  resolution: z.enum(["480p", "720p"]).optional().describe("default 480p"),
  steps: z.number().int().min(2).max(50).optional().describe("sampler steps (default 8)"),
  wait_s: waitField,
});

export default {
  name: "vfx_lab",
  toolset: "studio",
  endpoints: [ENDPOINT],
  description:
    "VFX Lab - apply an effect to your plate clip on LTX-Video 2B: pick the plate-lock " +
    "(how much of the original survives), an optional first-frame hold, and an optional " +
    "end keyframe. Probes the plate server-side for the frames/fps/duration/dims the " +
    "endpoint requires.",
  input: Input,
  async handler(args, ctx) {
    const a = Input.parse(args);
    if (!ctx.models?.has(ENDPOINT))
      return notAvailable(`endpoint ${ENDPOINT} is not in the startup model catalog`);
    const { probe } = await ctx.client.probe(a.video_url);
    const duration = probe.frames / probe.fps;
    if (duration > 10)
      return toolError("invalid_params", `plate is ${duration.toFixed(1)}s - the VFX plate tops out at 10s`);
    const [w, h] = RES_BOXES[a.resolution ?? "480p"];
    const params: Record<string, unknown> = {
      video_url: a.video_url,
      // probe-stamped fields - the endpoint's validate refuses hand-built numbers
      frames: vfxFrames(duration),
      fps: VFX_FPS,
      duration,
      width: w,
      height: h,
    };
    if (a.prompt !== undefined) params.prompt = a.prompt;
    if (a.negative_prompt !== undefined) params.negative_prompt = a.negative_prompt;
    if (a.engine !== undefined) params.engine = a.engine;
    if (a.plate_lock !== undefined) params.plate_lock = a.plate_lock;
    if (a.hold !== undefined) params.hold = a.hold;
    if (a.end_image_url !== undefined) params.end_image_url = a.end_image_url;
    if (a.target_strength !== undefined) params.target_strength = a.target_strength;
    if (a.resolution !== undefined) params.resolution = a.resolution;
    if (a.steps !== undefined) params.steps = a.steps;
    return submitJob(ctx, ENDPOINT, params, a.wait_s);
  },
} satisfies ToolDef;
