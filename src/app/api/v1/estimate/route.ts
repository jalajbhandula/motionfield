import { NextRequest } from "next/server";
import { z } from "zod";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err, v1error } from "@/lib/api/v1";
import { estimateJob } from "@/lib/api/estimate";

export const runtime = "nodejs";

const EstimateReq = z.object({
  endpoint: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});

/** POST /api/v1/estimate { endpoint, params } - credit + USD cost preview. */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    const parsed = EstimateReq.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return v1error("bad_request", "body must be JSON: { endpoint, params? }", 400);
    return v1json(await estimateJob(auth.userId, parsed.data.endpoint, parsed.data.params));
  } catch (e) {
    return v1err(e);
  }
}
