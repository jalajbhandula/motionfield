import { NextRequest } from "next/server";
import { z } from "zod";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err, v1error } from "@/lib/api/v1";
import { runViewV1 } from "@/lib/api/runs-v1";
import { approveRun, getRunView } from "@/lib/runs";

export const runtime = "nodejs";

/**
 * POST /api/v1/runs/:id/approve - release an awaiting_approval run to
 * running. Idempotent like the control verbs: approving a run that's
 * already past the gate answers its view, not an error.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    const { id } = await params;
    const parsed = z.string().uuid().safeParse(id);
    if (!parsed.success) return v1error("not_found", "run not found", 404);

    const ok = await approveRun(auth.userId, parsed.data);
    if (!ok) return v1error("not_found", "run not found", 404);
    const view = await getRunView(auth.userId, parsed.data);
    if (!view) return v1error("not_found", "run not found", 404);
    return v1json(await runViewV1(view));
  } catch (e) {
    return v1err(e);
  }
}
