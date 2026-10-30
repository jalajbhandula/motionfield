import { NextRequest } from "next/server";
import { createReadStream } from "fs";
import { promises as fs } from "fs";
import path from "path";
import { Readable } from "stream";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1err, v1error } from "@/lib/api/v1";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { filePathFor } from "@/lib/storage";
import { mimeForUrl } from "@/lib/api/mime";
import type { JobOutput } from "@/lib/api/jobview";

export const runtime = "nodejs";

/** Served bytes are never sniffed - every response this route emits carries
 *  nosniff, not just the file body. */
const NOSNIFF = { "x-content-type-options": "nosniff" };

/** GET /api/v1/jobs/:id/result?i=0 - stream the stored output file. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) {
      auth.headers.set("x-content-type-options", "nosniff");
      return auth;
    }
    const { id } = await params;
    const db = await getDb();
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
    if (!job || job.userId !== auth.userId) return v1error("not_found", "job not found", 404, NOSNIFF);
    if (job.status !== "completed") return v1error("not_ready", `job is ${job.status} - results are available once it completes`, 409, NOSNIFF);

    const outputs = (job.outputs as JobOutput[] | null) ?? [];
    const index = Math.max(0, Number(req.nextUrl.searchParams.get("i")) || 0);
    const output = outputs[index];
    if (!output) return v1error("not_found", `no output at index ${index}`, 404, NOSNIFF);

    const filePath = filePathFor(output.url);
    if (!filePath) {
      // non-local output URLs (provider-hosted) - redirect the caller
      if (/^https?:\/\//.test(output.url))
        return new Response(null, { status: 302, headers: { location: output.url, ...NOSNIFF } });
      return v1error("not_found", "output file not found", 404, NOSNIFF);
    }
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) return v1error("not_found", "output file not found", 404, NOSNIFF);

    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mime = mimeForUrl(filePath);
    // Browser-renderable types must never be inlined from the API - an output
    // that is (or is crafted to look like) HTML/SVG would otherwise execute
    // under the app's origin. Everything else may render inline.
    const disposition = mime === "text/html" || mime === "image/svg+xml" ? "attachment" : "inline";
    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": mime,
        "content-length": String(stat.size),
        "content-disposition": `${disposition}; filename="${job.id}${ext ? `.${ext}` : ""}"`,
        "cache-control": "private, max-age=60",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    const res = v1err(e);
    res.headers.set("x-content-type-options", "nosniff");
    return res;
  }
}
