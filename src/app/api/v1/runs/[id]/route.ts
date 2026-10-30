import { NextRequest } from "next/server";
import { z } from "zod";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err, v1error } from "@/lib/api/v1";
import { runViewV1 } from "@/lib/api/runs-v1";
import { getRunView, tickRun } from "@/lib/runs";

export const runtime = "nodejs";

/**
 * GET /api/v1/runs/:id - the caller's run, or 404 (another user's run is
 * indistinguishable from a missing one). A live run ticks once on read -
 * the same lazy driver GET /api/v1/jobs/:id uses - then the fresh view
 * answers.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    const { id } = await params;
    const parsed = z.string().uuid().safeParse(id);
    if (!parsed.success) return v1error("not_found", "run not found", 404);

    const view = await getRunView(auth.userId, parsed.data);
    if (!view) return v1error("not_found", "run not found", 404);
    await tickRun(parsed.data);
    return v1json(await runViewV1((await getRunView(auth.userId, parsed.data)) ?? view));
  } catch (e) {
    return v1err(e);
  }
}
