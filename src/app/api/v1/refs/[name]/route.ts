import { NextRequest } from "next/server";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err, v1error } from "@/lib/api/v1";
import { getRefV1, slugify } from "@/lib/api/refs-v1";

export const runtime = "nodejs";

/**
 * GET /api/v1/refs/{name} - one of the caller's refs by slug name. Missing
 * or another user's ref both answer 404 (no existence leak).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    const { name } = await params;
    const ref = await getRefV1(auth.userId, slugify(name));
    if (!ref) return v1error("not_found", `no ref named @${name}`, 404);
    return v1json({ ref });
  } catch (e) {
    return v1err(e);
  }
}
