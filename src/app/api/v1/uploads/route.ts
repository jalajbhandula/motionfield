import { NextRequest } from "next/server";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err, v1error, requestSource } from "@/lib/api/v1";
import { saveCheckedUpload } from "@/lib/api/uploads";
import { sql } from "@/db";

export const runtime = "nodejs";

/** POST /api/v1/uploads - multipart form field `file`, up to 200 MB. */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return v1error("bad_request", "multipart form must include a `file` field", 400);
    const { url, bytes, mime } = await saveCheckedUpload(file);
    await sql(
      `INSERT INTO uploads (id, user_id, url, mime, bytes, name, source) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [crypto.randomUUID(), auth.userId, url, mime, bytes, file.name, requestSource(req)],
    );
    return v1json({ url }, 201);
  } catch (e) {
    return v1err(e);
  }
}
