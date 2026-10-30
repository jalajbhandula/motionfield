import { NextRequest } from "next/server";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err } from "@/lib/api/v1";
import { SKILLS } from "@/lib/catalog/skills";

export const runtime = "nodejs";

/** GET /api/v1/skills - the catalog's skill pipelines. */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    return v1json({
      skills: SKILLS.map((s) => ({ slug: s.id, name: s.name, description: s.blurb })),
    });
  } catch (e) {
    return v1err(e);
  }
}
