import { z } from "zod";
import { type ToolDef } from "../../registry.mts";
import { submitJob, waitField } from "./_job.mts";

const ENDPOINT = "motionfield/motion-render/mp4";

const Input = z.object({
  spec_id: z.string().uuid().describe("uuid of a render_specs row you own - the scene to render"),
  values: z.record(z.string(), z.number()).optional()
    .describe("param-id → number overrides the spec declared (passes through to the renderer)"),
  wait_s: waitField,
});

export default {
  name: "motion_graphics",
  toolset: "studio",
  endpoints: [ENDPOINT],
  description:
    "Render a stored motion-graphic SceneSpec to MP4 (the deterministic three.js exporter) - " +
    "titles, lower thirds, stingers. spec_id is a render_specs row you own (made in the app's " +
    "Motion tab); values is an optional {param-id: number} override map.",
  input: Input,
  async handler(args, ctx) {
    const { spec_id, values, wait_s } = Input.parse(args);
    const params: Record<string, unknown> = { spec_id };
    if (values !== undefined) params.values = values;
    return submitJob(ctx, ENDPOINT, params, wait_s);
  },
} satisfies ToolDef;
