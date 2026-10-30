/** Owned-media resolution - shared by the ReCut and refs surfaces.
 *
 *  A media url is only usable when it points under /files/, resolves to a
 *  real file on disk, and belongs to the caller (an uploads row or an
 *  assets row). External urls are a 400; a /files/ url the user does not
 *  own (or that does not exist) is a 404 - no existence leak. */
import path from "node:path";
import { promises as fs } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { JobError } from "@/lib/jobs";
import { filePathFor } from "@/lib/storage";

/** video_url / image_urls must point at this user's own upload or generated
 *  asset - an external url is a 400, a /files/ url they don't own is a 404. */
export async function resolveOwnedMedia(userId: string, url: string): Promise<string> {
  if (!/^\/files\//.test(url)) throw new JobError("external urls are not allowed", 400);
  const file = filePathFor(url);
  if (!file) throw new JobError("not found", 404);
  const db = await getDb();
  const [upload] = await db.select({ url: schema.uploads.url })
    .from(schema.uploads)
    .where(and(eq(schema.uploads.url, url), eq(schema.uploads.userId, userId)))
    .limit(1);
  if (!upload) {
    const [asset] = await db.select({ url: schema.assets.url })
      .from(schema.assets)
      .where(and(eq(schema.assets.url, url), eq(schema.assets.userId, userId)))
      .limit(1);
    if (!asset) throw new JobError("not found", 404);
  }
  await fs.access(file).catch(() => { throw new JobError("not found", 404); });
  return path.resolve(file);
}
