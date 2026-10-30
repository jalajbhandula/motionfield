import { NextRequest } from "next/server";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err, v1error } from "@/lib/api/v1";
import { fetchJobView } from "@/lib/api/jobview";

export const runtime = "nodejs";

/** GET /api/v1/jobs/:id - job state for the key owner only. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    const { id } = await params;
    const view = await fetchJobView(auth.userId, id);
    if (!view) return v1error("not_found", "job not found", 404);
    return v1json(view);
  } catch (e) {
    return v1err(e);
  }
}
