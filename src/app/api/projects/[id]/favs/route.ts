import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { sql } from "@/db";
import { JobError } from "@/lib/jobs";

export const runtime = "nodejs";

/** /api/projects/:id/favs - pinned targets inside the caller's own project.
 *  POST {target_type: job|upload|asset, target_id} pins; DELETE unpins.
 *  A job/asset fav must belong to THIS project (not just the caller);
 *  an upload fav just needs to be the caller's own upload. */

const FavPost = z.strictObject({
  target_type: z.enum(["job", "upload", "asset"]),
  target_id: z.string().uuid(),
});

/** PATCH {target_type, target_id, folder_id|null} - file a pin under a
 *  folder of THIS project (null = unfiled). A folder id that isn't a
 *  folder of this project 404s - the fav row is never half-updated. */
const FavPatch = z.strictObject({
  target_type: z.enum(["job", "upload", "asset"]),
  target_id: z.string().uuid(),
  folder_id: z.string().uuid().nullable(),
});

async function ownProject(userId: string, projectId: string) {
  const rows = z.array(z.looseObject({ user_id: z.string() })).parse(await sql(
    `SELECT user_id FROM projects WHERE id = $1`, [projectId]));
  if (!rows[0] || rows[0].user_id !== userId) throw new JobError("project not found", 404);
}

/** The fav'd row must exist and belong in scope - jobs/assets to the
 *  project itself, uploads to the caller (uploads carry no project_id). */
async function favTargetOk(userId: string, projectId: string, type: string, targetId: string) {
  const rows = type === "upload"
    ? z.array(z.looseObject({ user_id: z.string() }))
        .parse(await sql(`SELECT user_id FROM uploads WHERE id = $1`, [targetId]))
    : z.array(z.looseObject({ user_id: z.string(), project_id: z.string().nullable() }))
        .parse(await sql(
          `SELECT user_id, project_id FROM ${type === "asset" ? "assets" : "jobs"} WHERE id = $1`,
          [targetId]));
  const r = rows[0];
  if (!r || r.user_id !== userId) throw new JobError("not found", 404);
  if (type !== "upload" && "project_id" in r && r.project_id !== projectId)
    throw new JobError(`that ${type} isn't in this project`, 404);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    await ownProject(user.id, id);
    const parsed = FavPost.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const b = parsed.data;
    await favTargetOk(user.id, id, b.target_type, b.target_id);
    await sql(
      `INSERT INTO project_favs (project_id, target_type, target_id) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`, [id, b.target_type, b.target_id]);
    return json({ fav: b }, 201);
  } catch (e) {
    return err(e);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    await ownProject(user.id, id);
    const parsed = FavPatch.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const b = parsed.data;
    if (b.folder_id) {
      // the folder must live in THIS project - a foreign folder id 404s
      const folder = z.array(z.looseObject({ project_id: z.string() })).parse(await sql(
        `SELECT project_id FROM project_folders WHERE id = $1`, [b.folder_id]));
      if (!folder[0] || folder[0].project_id !== id) return json({ error: "folder not found" }, 404);
    }
    const rows = await sql(
      `UPDATE project_favs SET folder_id = $4
        WHERE project_id = $1 AND target_type = $2 AND target_id = $3 RETURNING target_id`,
      [id, b.target_type, b.target_id, b.folder_id]);
    if (!rows.length) return json({ error: "pin not found" }, 404);
    return json({ fav: { target_type: b.target_type, target_id: b.target_id, folder_id: b.folder_id } });
  } catch (e) {
    return err(e);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    await ownProject(user.id, id);
    const parsed = FavPost.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const b = parsed.data;
    await sql(
      `DELETE FROM project_favs WHERE project_id = $1 AND target_type = $2 AND target_id = $3`,
      [id, b.target_type, b.target_id]);
    return json({ ok: true });
  } catch (e) {
    return err(e);
  }
}
