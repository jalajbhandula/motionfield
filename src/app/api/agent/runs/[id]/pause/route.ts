import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { controlRun, getRunView } from "@/lib/runs";

export const runtime = "nodejs";

const RUN_ID = z.string().uuid();

/** POST /api/agent/runs/:id/pause - running → paused. No new step submits
 *  while paused; an in-flight job finishes and reconciles. Idempotent. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    const parsed = RUN_ID.safeParse(id);
    if (!parsed.success) return json({ error: "not found" }, 404);
    const ok = await controlRun(user.id, parsed.data, "pause");
    if (ok === null) return json({ error: "not found" }, 404);
    return json({ run: await getRunView(user.id, parsed.data) });
  } catch (e) {
    return err(e);
  }
}
