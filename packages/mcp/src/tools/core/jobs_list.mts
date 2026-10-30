import { z } from "zod";
import { notAvailable, ok, type ToolDef } from "../../registry.mts";

const Input = z.object({
  ids: z.array(z.string()).max(12).optional().describe("job UUIDs - fetch exactly these"),
  kind: z.string().optional().describe("job kind - image, video, audio, edit, upscale, character, v2v, avatar, threed"),
  source: z.enum(["ui", "api", "cli", "mcp", "agent"]).optional().describe("the surface that submitted the jobs"),
  status: z.enum(["queued", "in_progress", "completed", "failed", "nsfw", "canceled"]).optional(),
  cursor: z.string().optional().describe("next_cursor from a previous call"),
  limit: z.number().int().min(1).max(100).optional(),
});

export default {
  name: "jobs_list",
  toolset: "core",
  capability: "jobs.list",
  description:
    "The account's jobs, newest first - filter by status/kind/source or fetch up to 12 " +
    "ids directly (ids returns the found set in request order). Follow next_cursor as `cursor`.",
  input: Input,
  async handler(args, ctx) {
    const a = Input.parse(args);
    if (a.source && !ctx.caps.has("jobs.source"))
      return notAvailable("source filters need the 'jobs.source' capability");
    return ok(await ctx.client.listJobs({
      ids: a.ids, kind: a.kind, source: a.source,
      status: a.status, before: a.cursor, limit: a.limit,
    }));
  },
} satisfies ToolDef;
