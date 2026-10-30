import { NextRequest } from "next/server";
import { json, err, requireApiUser } from "@/lib/api";
import { getDb, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { JobError } from "@/lib/jobs";
import { resolveOwnedMedia } from "@/lib/media-owned";
import { filePathFor } from "@/lib/storage";
import { ff } from "@/lib/re-edit-ffmpeg";
import { PERSON_SWAP_ENDPOINT } from "@/lib/generation/recipes/person-swap";
import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

/**
 * GET /api/person-swap/[id]/export - side-by-side (source | result) mp4 of a
 * completed person-swap run. Rendered on demand into generated/ and reused; the
 * job's output is fixed once the run completes so the file is idempotent.
 * A foreign id, a non-person-swap job and a bad id all 404 identically.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    const db = await getDb();
    const [job] = await db.select().from(schema.jobs)
      .where(and(eq(schema.jobs.id, id), eq(schema.jobs.userId, user.id),
        eq(schema.jobs.endpointId, PERSON_SWAP_ENDPOINT)))
      .limit(1);
    if (!job) return json({ error: "not found" }, 404);
    if (job.status !== "completed") throw new JobError("run is not finished", 409);
    const outs = (job.outputs ?? []) as { type?: string; url?: string }[];
    const outUrl = outs.find((o) => o.type === "video" && o.url)?.url;
    if (!outUrl) return json({ error: "not found" }, 404);

    const name = `generated/person-swap-sxs-${id}.mp4`;
    const dst = filePathFor(`/files/${name}`);
    if (!dst) return json({ error: "not found" }, 404);
    if (!(await fs.stat(dst).then(() => true, () => false))) {
      const p = (job.params ?? {}) as Record<string, unknown>;
      // an aspect-cropped run compares against the crop the model actually
      // saw - the compare clip the recipe kept inside this job's own dir
      const meta = (job.providerMeta as Record<string, unknown> | null)?.person_swap as { compare_src?: string } | undefined;
      let srcFile: string | null = null;
      if (meta?.compare_src === `/files/generated/.person_swap/${id}/src-aspect.mp4`)
        srcFile = filePathFor(meta.compare_src);
      if (!srcFile) srcFile = await resolveOwnedMedia(user.id, String(p.video_url ?? ""));
      const outFile = filePathFor(outUrl);
      if (!outFile) return json({ error: "not found" }, 404);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      // same display size by construction - scale to a common height and stack.
      // temp file + rename: the final url only ever sees a complete file.
      const tmp = `${dst}.tmp-${crypto.randomUUID().slice(0, 8)}.mp4`;
      try {
        await ff([
          "-i", srcFile, "-i", outFile,
          "-filter_complex", "[0:v]scale=-2:640[a];[1:v]scale=-2:640[b];[a][b]hstack=inputs=2,pad=ceil(iw/2)*2:ceil(ih/2)*2[v]",
          "-map", "[v]", "-map", "0:a?",
          "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", tmp,
        ]);
        await fs.rename(tmp, dst);
      } catch (e) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
    }
    return json({ url: `/files/${name}` });
  } catch (e) {
    return err(e);
  }
}
