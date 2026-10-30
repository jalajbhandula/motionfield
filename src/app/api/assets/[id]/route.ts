import { NextRequest } from "next/server";
import { isUuid, json, err, requireApiUser, apiUser  } from "@/lib/api";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await apiUser(req);
    const { id } = await params;
    if (!isUuid(id)) return json({ error: "not found" }, 404);
    const db = await getDb();
    const [asset] = await db.select().from(schema.assets).where(eq(schema.assets.id, id)).limit(1);
    if (!asset) return json({ error: "not found" }, 404);
    if (asset.userId !== ctx?.user.id && asset.visibility !== "public") return json({ error: "not found" }, 404);
    let job = null;
    if (asset.jobId) {
      [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, asset.jobId)).limit(1);
    }
    const [owner] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, asset.userId)).limit(1);
    return json({ asset, job, owner });
  } catch (e) {
    return err(e);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    if (!isUuid(id)) return json({ error: "not found" }, 404);
    const body = await req.json();
    const db = await getDb();
    const [asset] = await db.select().from(schema.assets).where(eq(schema.assets.id, id)).limit(1);
    if (!asset || asset.userId !== user.id) return json({ error: "not found" }, 404);
    const patch: Record<string, unknown> = {};
    if (body.favorite !== undefined) patch.favorite = !!body.favorite;
    if (body.visibility !== undefined) patch.visibility = body.visibility === "public" ? "public" : "private";
    const [updated] = await db.update(schema.assets).set(patch).where(eq(schema.assets.id, id)).returning();
    return json({ asset: updated });
  } catch (e) {
    return err(e);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    if (!isUuid(id)) return json({ error: "not found" }, 404);
    const db = await getDb();
    const [asset] = await db.select().from(schema.assets).where(eq(schema.assets.id, id)).limit(1);
    if (!asset || asset.userId !== user.id) return json({ error: "not found" }, 404);
    await db.delete(schema.assets).where(eq(schema.assets.id, id));
    return json({ ok: true });
  } catch (e) {
    return err(e);
  }
}
