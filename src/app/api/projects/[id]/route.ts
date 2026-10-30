import { NextRequest } from "next/server";
import { z } from "zod";
import { isUuid, json, err, requireApiUser, apiUser  } from "@/lib/api";
import { getDb, schema, sql } from "@/db";
import { eq } from "drizzle-orm";
import { listMemories, projectInstructions, setProjectInstructions } from "@/lib/memory";

export const runtime = "nodejs";

const JobRow = z.looseObject({
  id: z.string(), kind: z.string(), endpoint_id: z.string(), title: z.string().nullable(),
  status: z.string(), outputs: z.unknown(),
  created_at: z.custom<Date | string>((v) => v instanceof Date || typeof v === "string"),
});
const UploadRow = z.looseObject({
  id: z.string(), url: z.string(), mime: z.string(), name: z.string().nullable(),
  created_at: z.custom<Date | string>((v) => v instanceof Date || typeof v === "string"),
});
const FolderRow = z.looseObject({ id: z.string(), name: z.string() });
const FavRow = z.looseObject({ target_type: z.string(), target_id: z.string(), folder_id: z.string().nullable() });

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await apiUser(req);
    const { id } = await params;
    if (!isUuid(id)) return json({ error: "not found" }, 404);
    const db = await getDb();
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1);
    if (!project) return json({ error: "not found" }, 404);
    const isOwner = !!ctx && project.userId === ctx.user.id;
    if (!isOwner && project.visibility !== "public") return json({ error: "not found" }, 404);
    // owner-scoped too: a row carrying a foreign user_id - or another
    // user's row stamped with this project_id - never reaches the list
    const items = await sql(
      `SELECT a.* FROM assets a WHERE a.project_id = $1 AND a.user_id = $2
        ORDER BY a.created_at DESC`, [id, project.userId]);
    const [owner] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, project.userId)).limit(1);
    // owner-only extras - instructions, project memories, folders, favs and
    // the project's jobs/uploads never ride a public page view
    if (!isOwner) return json({ project, items, owner, is_owner: false });
    const [memories, instructions, folders, favs, jobs, uploads] = await Promise.all([
      listMemories(project.userId, id),
      projectInstructions(project.userId, id),
      z.array(FolderRow).parse(await sql(
        `SELECT id, name FROM project_folders WHERE project_id = $1 ORDER BY created_at`, [id])),
      z.array(FavRow).parse(await sql(
        `SELECT target_type, target_id, folder_id FROM project_favs WHERE project_id = $1`, [id])),
      z.array(JobRow).parse(await sql(
        `SELECT id, kind, endpoint_id, title, status, outputs, created_at
           FROM jobs WHERE project_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 100`,
        [id, project.userId])),
      // uploads have no project column - a project "has" an upload when it
      // was attached inside a project-bound session message, fav'd into the
      // project, or a project memory links to it
      z.array(UploadRow).parse(await sql(
        `SELECT DISTINCT u.id, u.url, u.mime, u.name, u.created_at
           FROM uploads u
          WHERE u.user_id = $2 AND (
            EXISTS (SELECT 1 FROM project_favs f
                     WHERE f.project_id = $1 AND f.target_type = 'upload' AND f.target_id = u.id)
            OR EXISTS (SELECT 1 FROM memory_links ml
                        JOIN memories m ON m.id = ml.memory_id
                        WHERE m.project_id = $1 AND ml.target_type = 'upload' AND ml.target_id = u.id)
            OR EXISTS (SELECT 1
                         FROM agent_sessions s
                         JOIN agent_messages msg ON msg.session_id = s.id
                        CROSS JOIN LATERAL jsonb_array_elements(
                          CASE WHEN jsonb_typeof(msg.content->'attachments') = 'array'
                               THEN msg.content->'attachments' ELSE '[]'::jsonb END) att
                        WHERE s.project_id = $1 AND s.user_id = $2
                          AND att->>'url' = u.url)
          )
          ORDER BY u.created_at DESC LIMIT 50`, [id, project.userId])),
    ]);
    return json({
      project, items, owner, is_owner: true, memories, instructions: instructions ?? "",
      folders, favs, jobs, uploads,
    });
  } catch (e) {
    return err(e);
  }
}

const ProjectPatch = z.strictObject({
  title: z.string().max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  cover_url: z.string().max(2048).nullable().optional(),
  coverUrl: z.string().max(2048).nullable().optional(),
  visibility: z.enum(["public", "private"]).optional(),
  /** project_settings.instructions - the owner's planner config */
  instructions: z.string().max(4000).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    if (!isUuid(id)) return json({ error: "not found" }, 404);
    const parsed = ProjectPatch.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const body = parsed.data;
    const db = await getDb();
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1);
    if (!p || p.userId !== user.id) return json({ error: "not found" }, 404);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.title !== undefined) patch.title = body.title;
    if (body.description !== undefined) patch.description = body.description;
    if (body.cover_url !== undefined || body.coverUrl !== undefined)
      patch.coverUrl = body.cover_url ?? body.coverUrl;
    if (body.visibility !== undefined) patch.visibility = body.visibility;
    const [updated] = await db.update(schema.projects).set(patch).where(eq(schema.projects.id, id)).returning();
    if (body.instructions !== undefined) await setProjectInstructions(user.id, id, body.instructions);
    return json({ project: updated });
  } catch (e) {
    return err(e);
  }
}
