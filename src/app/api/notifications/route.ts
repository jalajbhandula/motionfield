import { NextRequest } from "next/server";
import { json, err, requireApiUser } from "@/lib/api";
import { getDb, schema } from "@/db";
import { eq, desc } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const db = await getDb();
    const items = await db.select().from(schema.notifications)
      .where(eq(schema.notifications.userId, user.id))
      .orderBy(desc(schema.notifications.createdAt)).limit(50);
    return json({ notifications: items });
  } catch (e) {
    return err(e);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const db = await getDb();
    await db.update(schema.notifications).set({ readAt: new Date() })
      .where(eq(schema.notifications.userId, user.id));
    return json({ ok: true });
  } catch (e) {
    return err(e);
  }
}
