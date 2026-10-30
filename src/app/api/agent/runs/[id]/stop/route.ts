import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { controlRun, getRunView } from "@/lib/runs";

export const runtime = "nodejs";

const RUN_ID = z.string().uuid();

/** POST /api/agent/runs/:id/stop - cancel the live job (refund), mark
 *  unfinished steps canceled, the run stopped. Idempotent - repeating the
 *  call on a terminal run just returns the view. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    const parsed = RUN_ID.safeParse(id);
    if (!parsed.success) return json({ error: "not found" }, 404);
    const ok = await controlRun(user.id, parsed.data, "stop");
    if (ok === null) return json({ error: "not found" }, 404);
    return json({ run: await getRunView(user.id, parsed.data) });
  } catch (e) {
    return err(e);
  }
}
