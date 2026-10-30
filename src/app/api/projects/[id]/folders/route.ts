import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { sql } from "@/db";
import { JobError } from "@/lib/jobs";

export const runtime = "nodejs";

/** POST /api/projects/:id/folders - {name} → a named grouping inside the
 *  caller's own project (409 on a duplicate name). GET lists them. */

const FolderPost = z.strictObject({ name: z.string().min(1).max(80) });
const FolderRow = z.looseObject({ id: z.string(), name: z.string(), created_at: z.unknown() });

async function ownProject(userId: string, projectId: string) {
  const rows = z.array(z.looseObject({ user_id: z.string() })).parse(await sql(
    `SELECT user_id FROM projects WHERE id = $1`, [projectId]));
  if (!rows[0] || rows[0].user_id !== userId) throw new JobError("project not found", 404);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    await ownProject(user.id, id);
    const folders = z.array(FolderRow).parse(await sql(
      `SELECT id, name, created_at FROM project_folders
        WHERE project_id = $1 ORDER BY created_at`, [id]));
    return json({ folders });
  } catch (e) {
    return err(e);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    await ownProject(user.id, id);
    const parsed = FolderPost.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const rows = z.array(FolderRow).parse(await sql(
      `INSERT INTO project_folders (project_id, name) VALUES ($1, $2)
       ON CONFLICT (project_id, name) DO NOTHING RETURNING id, name, created_at`,
      [id, parsed.data.name.trim()]));
    if (!rows[0]) throw new JobError(`a folder named "${parsed.data.name.trim()}" already exists`, 409);
    return json({ folder: rows[0] }, 201);
  } catch (e) {
    return err(e);
  }
}
