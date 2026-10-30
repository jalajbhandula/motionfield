import { NextRequest } from "next/server";
import { json, err, requireApiUser } from "@/lib/api";
import { getDb, schema, sql } from "@/db";
import { and, eq } from "drizzle-orm";
import { notify } from "@/lib/jobs";

export const runtime = "nodejs";

/** POST {action: like|unlike|follow|unfollow, targetType?, targetId} */
export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const body = await req.json();
    const db = await getDb();
    const action = String(body.action);

    if (action === "like" || action === "unlike") {
      const t = String(body.targetType ?? "job");
      const tid = String(body.targetId);
      if (action === "like") {
        await sql(`INSERT INTO likes (user_id, target_type, target_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [user.id, t, tid]);
        await sql(`UPDATE jobs SET likes_count = likes_count + 1 WHERE id = $1 AND EXISTS (SELECT 1 FROM likes WHERE user_id=$2 AND target_type=$3 AND target_id=$1)`, [tid, user.id, t]);
        const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, tid)).limit(1);
        if (job && job.userId !== user.id) await notify(job.userId, "like", "Someone liked your generation", job.title ?? undefined, `/jobs/${tid}`);
      } else {
        const deleted = await sql(`DELETE FROM likes WHERE user_id=$1 AND target_type=$2 AND target_id=$3 RETURNING target_id`, [user.id, t, tid]);
        if (deleted.length) await sql(`UPDATE jobs SET likes_count = greatest(likes_count-1,0) WHERE id=$1`, [tid]);
      }
      return json({ ok: true });
    }

    if (action === "follow" || action === "unfollow") {
      const target = String(body.targetId);
      if (action === "follow") {
        await sql(`INSERT INTO follows (follower_id, following_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [user.id, target]);
        await notify(target, "follow", "You have a new follower", undefined, `/@${target}`);
      } else {
        await sql(`DELETE FROM follows WHERE follower_id=$1 AND following_id=$2`, [user.id, target]);
      }
      return json({ ok: true });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return err(e);
  }
}
