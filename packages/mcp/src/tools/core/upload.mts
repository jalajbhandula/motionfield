import { z } from "zod";
import { ok, type ToolDef } from "../../registry.mts";
import { GuardError, provenLocalUpload } from "../../guards.mts";
import { fetchRemoteFile } from "../../netfetch.mts";
import { extname } from "node:path";
import { extForMime } from "../../../../cli/src/util.mts";

const Input = z.object({
  path: z.string().optional().describe("local media file - image/audio/video"),
  url: z.string().optional().describe("remote http(s) media URL - fetched, then uploaded"),
});

export default {
  name: "upload",
  toolset: "core",
  capability: "uploads",
  description:
    "Stage input media for a job - a local file path OR a remote http(s) URL. Local files are " +
    "checked against the upload allowlist (media types only, ≤200MB); remote URLs are fetched " +
    "through an SSRF guard (private/loopback/link-local targets refused). Returns { url } to " +
    "feed into generate params.",
  input: Input.refine((v) => (v.path == null) !== (v.url == null), { message: "exactly one of path or url" }),
  async handler(args, ctx) {
    // parse the un-refined shape - the XOR lives on the advertised schema and
    // the both-missing case still gets the plain guard error here.
    const { path, url } = Input.parse(args);
    if (path != null) {
      // http callers have no filesystem on the other end - only a fetchable url
      if (ctx.transport === "http")
        throw new GuardError("upload{path} - local paths are stdio-only; pass {url} with an http(s) URL");
      const local = provenLocalUpload(path);
      const up = await ctx.client.upload(local.bytes, { filename: local.filename, contentType: local.mime });
      return ok({ url: up.url, bytes: local.bytes.length, mime: local.mime });
    }
    if (url == null) throw new GuardError("upload needs path or url");
    const remote = await fetchRemoteFile(url);
    const name = `remote.${extname(new URL(remote.url).pathname).slice(1).toLowerCase() || extForMime(remote.contentType)}`;
    const up = await ctx.client.upload(remote.bytes, { filename: name, contentType: remote.contentType });
    return ok({ url: up.url, bytes: remote.bytes.length, mime: remote.contentType });
  },
} satisfies ToolDef;
