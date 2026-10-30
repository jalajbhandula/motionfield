import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { getRunView, tickRun } from "@/lib/runs";

export const runtime = "nodejs";

const RUN_ID = z.string().uuid();

/** GET /api/agent/runs/:id - one tick (the lazy driver) then the fresh view.
 *  Another user's run answers 404 - existence stays private. A malformed id
 *  is also a 404, not a 500 on the uuid column. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    const parsed = RUN_ID.safeParse(id);
    if (!parsed.success) return json({ error: "not found" }, 404);
    const view = await getRunView(user.id, parsed.data);
    if (!view) return json({ error: "not found" }, 404);
    await tickRun(parsed.data);
    return json({ run: (await getRunView(user.id, parsed.data)) ?? view });
  } catch (e) {
    return err(e);
  }
}
