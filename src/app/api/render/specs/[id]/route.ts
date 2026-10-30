import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

/** GET /api/render/specs/:id - owner-only read of a stored SceneSpec. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await ctx.params;
    if (!z.uuid().safeParse(id).success) return json({ error: "not found" }, 404);
    const db = await getDb();
    const rows = await db.select().from(schema.renderSpecs)
      .where(eq(schema.renderSpecs.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.userId !== user.id) return json({ error: "not found" }, 404);
    return json({
      id: row.id, spec: row.spec, created_at: row.createdAt,
      title: row.title, prompt: row.prompt, source_url: row.sourceUrl, parent_id: row.parentId,
    });
  } catch (e) {
    return err(e);
  }
}
