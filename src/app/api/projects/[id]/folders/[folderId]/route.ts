import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { sql } from "@/db";
import { JobError } from "@/lib/jobs";

export const runtime = "nodejs";

/** DELETE /api/projects/:id/folders/:folderId - removes the folder from the
 *  caller's own project. Pinned items inside are unfiled, never unpinned
 *  (project_favs.folder_id is ON DELETE SET NULL). A folder that isn't in
 *  this project answers a plain 404. */

async function ownProject(userId: string, projectId: string) {
  const rows = z.array(z.looseObject({ user_id: z.string() })).parse(await sql(
    `SELECT user_id FROM projects WHERE id = $1`, [projectId]));
  if (!rows[0] || rows[0].user_id !== userId) throw new JobError("project not found", 404);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; folderId: string }> },
) {
  try {
    const { user } = await requireApiUser(req);
    const { id, folderId } = await params;
    // non-uuid ids are a plain 404 - never a driver error surfacing as a 500
    if (!z.string().uuid().safeParse(id).success || !z.string().uuid().safeParse(folderId).success)
      return json({ error: "not found" }, 404);
    await ownProject(user.id, id);
    const rows = await sql(
      `DELETE FROM project_folders WHERE id = $1 AND project_id = $2 RETURNING id`,
      [folderId, id]);
    if (!rows.length) return json({ error: "not found" }, 404);
    return json({ ok: true });
  } catch (e) {
    return err(e);
  }
}
