import { NextRequest } from "next/server";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err } from "@/lib/api/v1";
import { V1_CAPABILITIES } from "@/lib/api/capabilities";

export const runtime = "nodejs";

/** GET /api/v1/capabilities - static feature registry; clients gate optional
 *  command groups on the listed strings. */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    return v1json({ capabilities: [...V1_CAPABILITIES] });
  } catch (e) {
    return v1err(e);
  }
}
