import { NextRequest } from "next/server";
import { json, err, requireApiUser } from "@/lib/api";
import { getDb, schema } from "@/db";
import { eq, desc } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const db = await getDb();
    const entries = await db.select().from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, user.id))
      .orderBy(desc(schema.creditLedger.createdAt)).limit(200);
    return json({ entries });
  } catch (e) {
    return err(e);
  }
}
