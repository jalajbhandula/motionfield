import { NextRequest } from "next/server";
import { json, err, requireApiUser } from "@/lib/api";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const body = await req.json();
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["displayName", "bio", "avatarUrl", "specialty", "studio", "location"] as const) {
      if (body[k] !== undefined) patch[k] = typeof body[k] === "string" ? body[k].slice(0, 2000) : null;
    }
    if (body.handle !== undefined) {
      const h = String(body.handle).toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 32);
      if (!h) return json({ error: "invalid handle" }, 400);
      const db0 = await getDb();
      const [clash] = await db0.select().from(schema.profiles).where(eq(schema.profiles.handle, h)).limit(1);
      if (clash && clash.userId !== user.id) return json({ error: "handle taken" }, 409);
      patch.handle = h;
    }
    if (body.links !== undefined) patch.links = body.links;
    if (body.interests !== undefined) patch.interests = body.interests;
    if (body.onboarded !== undefined) patch.onboarded = !!body.onboarded;
    if (body.autoPublish !== undefined) patch.autoPublish = !!body.autoPublish;
    const db = await getDb();
    const [profile] = await db.update(schema.profiles).set(patch).where(eq(schema.profiles.userId, user.id)).returning();
    return json({ profile });
  } catch (e) {
    return err(e);
  }
}
