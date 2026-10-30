import { NextRequest } from "next/server";
import { json, err, requireApiUser } from "@/lib/api";
import { saveCheckedUpload } from "@/lib/api/uploads";
import { getDb, schema } from "@/db";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "no file" }, 400);
    const { url, bytes, mime } = await saveCheckedUpload(file);
    const db = await getDb();
    await db.insert(schema.uploads).values({ userId: user.id, url, mime, bytes, name: file.name });
    return json({ url, mime, bytes, name: file.name }, 201);
  } catch (e) {
    return err(e);
  }
}

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const db = await getDb();
    const { desc } = await import("drizzle-orm");
    const { eq } = await import("drizzle-orm");
    const uploads = await db.select().from(schema.uploads)
      .where(eq(schema.uploads.userId, user.id)).orderBy(desc(schema.uploads.createdAt)).limit(100);
    return json({ uploads });
  } catch (e) {
    return err(e);
  }
}
