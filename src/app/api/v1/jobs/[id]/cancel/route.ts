import { NextRequest } from "next/server";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err, v1error } from "@/lib/api/v1";
import { cancelJob } from "@/lib/jobs";
import { fetchJobView } from "@/lib/api/jobview";

export const runtime = "nodejs";

/** POST /api/v1/jobs/:id/cancel - cancels queued or in_progress jobs. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    const { id } = await params;
    await cancelJob(auth.userId, id);
    const view = await fetchJobView(auth.userId, id);
    if (!view) return v1error("not_found", "job not found", 404);
    return v1json(view);
  } catch (e) {
    return v1err(e);
  }
}
