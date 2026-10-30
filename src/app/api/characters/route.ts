import { NextRequest } from "next/server";
import { json, err, requireApiUser } from "@/lib/api";
import { getDb, schema, sql } from "@/db";
import { eq, desc } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const db = await getDb();
    const characters = await db.select().from(schema.characters)
      .where(eq(schema.characters.userId, user.id)).orderBy(desc(schema.characters.createdAt)).limit(50);
    // refs live on the elements table - normalized through the same view the
    // refs API returns so this payload matches /api/refs
    const refs = (await sql<{
      id: string; name: string; category: string; kind: string | null;
      description: string | null; images: unknown; created_at: unknown;
    }>(`SELECT * FROM elements WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [user.id]))
      .map((r) => ({
        id: r.id,
        name: r.name,
        category: ({ location: "environment", character: "character" } as Record<string, string>)[r.category] ?? r.category,
        kind: r.kind ?? null,
        description: r.description,
        images: Array.isArray(r.images) ? r.images : [],
        created_at: r.created_at,
      }));
    return json({ characters, refs });
  } catch (e) {
    return err(e);
  }
}

/** Character characters are reference-based - saved as @refs with the
 *  caller's own images (POST /api/refs), never trained. The old mock
 *  "training" POST is gone; this route stays read-only. */
