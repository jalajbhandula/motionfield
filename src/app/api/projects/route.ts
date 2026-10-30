import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { getDb, schema, sql } from "@/db";
import { eq, desc } from "drizzle-orm";
import crypto from "crypto";

export const runtime = "nodejs";

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || crypto.randomBytes(4).toString("hex");

const ProjectPost = z.strictObject({
  title: z.string().max(120).optional(),
  description: z.string().max(2000).optional(),
  visibility: z.enum(["public", "private"]).optional(),
  cover_url: z.string().max(2048).nullable().optional(),
  slug: z.string().max(80).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const db = await getDb();
    const projects = await db.select().from(schema.projects)
      .where(eq(schema.projects.userId, user.id)).orderBy(desc(schema.projects.updatedAt)).limit(100);
    const counts = z.array(z.looseObject({ project_id: z.string(), n: z.number() }))
      .parse(await sql(
        `SELECT project_id, count(*)::int AS n FROM memories
          WHERE user_id = $1 AND project_id IS NOT NULL GROUP BY project_id`,
        [user.id]));
    const byProject = new Map(counts.map((c) => [c.project_id, c.n]));
    return json({
      projects: projects.map((p: typeof schema.projects.$inferSelect) => ({
        ...p, memory_count: byProject.get(p.id) ?? 0,
      })),
    });
  } catch (e) {
    return err(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const parsed = ProjectPost.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const body = parsed.data;
    const db = await getDb();
    const title = (body.title ?? "Untitled project").slice(0, 120) || "Untitled project";
    let slug = body.slug ? slugify(body.slug) : slugify(title);
    for (let i = 0; i < 10; i++) {
      const clash = await db.select().from(schema.projects).where(eq(schema.projects.slug, slug)).limit(1);
      if (!clash.length) break;
      slug = `${slugify(body.slug ?? title)}-${crypto.randomBytes(2).toString("hex")}`;
    }
    const [project] = await db.insert(schema.projects).values({
      userId: user.id, title, slug,
      description: body.description?.slice(0, 2000) ?? null,
      visibility: body.visibility ?? "private",
      coverUrl: body.cover_url ?? null,
    }).returning();
    return json({ project }, 201);
  } catch (e) {
    return err(e);
  }
}
