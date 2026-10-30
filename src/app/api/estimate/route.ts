import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { estimateJob } from "@/lib/api/estimate";
import { getAuth } from "@/lib/auth";

export const runtime = "nodejs";

/** POST - credit + USD estimate before submission. Session optional; signed-in
 *  callers get plan-aware pricing (unlimited models, etc.). */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const endpointId = String(body.endpoint_id ?? body.endpointId ?? "");
    if (!endpointId) return json({ error: "missing endpoint_id" }, 400);

    const auth = await getAuth();
    const s = await auth.api.getSession({ headers: req.headers }).catch(() => null);
    return json(await estimateJob(s?.user?.id ?? null, endpointId, body.params ?? {}));
  } catch (e) {
    return err(e);
  }
}
