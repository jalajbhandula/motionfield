import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { sql } from "@/db";

export const runtime = "nodejs";

/** Community feed: public completed jobs + public projects. */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const kind = sp.get("kind"); // image | video | null = all
    const limit = Math.min(60, Number(sp.get("limit")) || 30);
    const jobs = await sql<Record<string, unknown>>(
      `SELECT j.id, j.kind, j.model_id, j.workflow, j.prompt, j.outputs, j.likes_count, j.created_at,
              (j.graph_json IS NOT NULL) AS has_graph,
              (SELECT count(*)::int FROM jobs f WHERE f.graph_forked_from = j.id) AS graph_forks,
              p.handle, p.display_name, p.avatar_url
       FROM jobs j JOIN profiles p ON p.user_id = j.user_id
       WHERE j.visibility = 'public' AND j.status = 'completed'
         AND ($1::text IS NULL OR j.kind = $1 OR ($1 = 'image' AND j.kind IN ('image','edit','upscale')))
       ORDER BY j.created_at DESC LIMIT $2`,
      [kind, limit]);
    const projects = await sql<Record<string, unknown>>(
      `SELECT pr.id, pr.slug, pr.title, pr.description, pr.cover_url, pr.likes_count, pr.created_at,
              p.handle, p.display_name, p.avatar_url
       FROM projects pr JOIN profiles p ON p.user_id = pr.user_id
       WHERE pr.visibility = 'public'
       ORDER BY pr.created_at DESC LIMIT 20`, []);
    return json({ jobs, projects });
  } catch (e) {
    return err(e);
  }
}
