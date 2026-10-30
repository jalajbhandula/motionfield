import { NextRequest } from "next/server";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err } from "@/lib/api/v1";
import { listV1Models } from "@/lib/api/models";

export const runtime = "nodejs";

/** GET /api/v1/models - every callable catalog endpoint with its input schema,
 *  license class + components, and a default-param credit estimate. */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    return v1json({ models: await listV1Models(auth.userId) });
  } catch (e) {
    return v1err(e);
  }
}
