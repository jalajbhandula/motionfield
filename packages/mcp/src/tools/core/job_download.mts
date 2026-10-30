import { z } from "zod";
import { ok, type ToolDef } from "../../registry.mts";
import { GuardError, jobIdArg, writeOutput } from "../../guards.mts";

const Input = z.object({
  id: z.string().describe("job UUID"),
  index: z.number().int().min(0).optional().describe("output index - 0 is the first output (default)"),
});

export default {
  name: "job_download",
  toolset: "core",
  capability: "jobs",
  description:
    "Save one output of a completed job into MOTIONFIELD_MCP_OUT_DIR as <jobId>-<index>.<ext>. " +
    "Returns the absolute path, byte count and content type.",
  input: Input,
  async handler(args, ctx) {
    const { id, index } = Input.parse(args);
    const i = index ?? 0;
    const job = await ctx.client.get(jobIdArg(id));
    const output = job.outputs[i];
    if (!output)
      throw new GuardError(`job ${id} has no output at index ${i} (${job.outputs.length} output(s), status ${job.status})`);
    // http callers fetch the bytes themselves - the server holds no download
    // dir, so the result url + declared mime/bytes are returned as-is
    if (ctx.transport === "http")
      return ok({
        url: `${ctx.client.baseUrl}/api/v1/jobs/${id}/result?i=${i}`,
        mime: output.type,
        bytes: output.bytes,
      });
    const { bytes, contentType } = await ctx.client.download(id, { index: i });
    const path = writeOutput(ctx.outDir, id, i, contentType ?? output.type, output.url, bytes);
    return ok({ path, bytes: bytes.length, content_type: contentType ?? output.type });
  },
} satisfies ToolDef;
