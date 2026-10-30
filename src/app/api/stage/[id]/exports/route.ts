import crypto from "crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { JobError } from "@/lib/jobs";
import { readCappedForm } from "@/lib/render/body";
import { saveBytes } from "@/lib/storage";
import { getDb, schema } from "@/db";
import { stageApiUser, loadOwnScene, sceneIdSchema } from "@/lib/stage/api";
import { validateGlb, validatePng, GLB_LIMITS } from "@/lib/stage/exports";

export const runtime = "nodejs";

const STILL_MAX = 16 * 1024 * 1024;
const BODY_CAP = GLB_LIMITS.maxBytes + 64 * 1024; // headroom for form fields
const DIM = z.coerce.number().int().min(64).max(4096);

/**
 * POST /api/stage/:id/exports - multipart upload of an artifact the editor
 * just rendered: kind=still (PNG, ≤16 MB, IHDR must equal the declared w×h)
 * or kind=glb (≤32 MB, self-contained glTF 2.0 via gltf-transform). Clean
 * bytes go through saveBytes into an uploads row for the caller so the file
 * lists in /api/uploads (and GLBs appear in Add → Model).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!sceneIdSchema.safeParse(id).success) throw new JobError("not found", 404);
    const auth = await stageApiUser(req);
    const row = await loadOwnScene(auth.userId, id);
    if (!row) throw new JobError("not found", 404);

    const form = await readCappedForm(req, BODY_CAP);
    const kind = form.fields.kind;
    if (kind !== "still" && kind !== "glb") {
      throw new JobError('expected kind="still" or kind="glb"', 400);
    }
    const file = form.files.find((f) => f.name === "file");
    if (!file || file.data.length === 0) throw new JobError("missing file part", 400);

    let mime: string;
    let ext: string;
    if (kind === "still") {
      if (file.data.length > STILL_MAX) throw new JobError("still too large (>16 MB)", 413);
      const w = DIM.safeParse(form.fields.w);
      const h = DIM.safeParse(form.fields.h);
      if (!w.success || !h.success) throw new JobError("still needs integer w/h fields in 64…4096", 400);
      const bad = validatePng(file.data, w.data, h.data);
      if (bad) throw new JobError(bad, 400);
      mime = "image/png"; ext = "png";
    } else {
      const bad = await validateGlb(file.data, GLB_LIMITS);
      if (bad) throw new JobError(bad, 400);
      mime = "model/gltf-binary"; ext = "glb";
    }

    const key = `uploads/${crypto.randomUUID()}.${ext}`;
    const url = await saveBytes(key, file.data);
    const db = await getDb();
    const [up] = await db.insert(schema.uploads).values({
      userId: auth.userId,
      url,
      mime,
      bytes: file.data.length,
      name: file.filename ?? `stage-${kind}.${ext}`,
    }).returning();
    return json({ url: up.url, mime: up.mime, bytes: up.bytes, name: up.name }, 201);
  } catch (e) {
    return err(e);
  }
}
