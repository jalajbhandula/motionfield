import { NextRequest } from "next/server";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1error, v1err } from "@/lib/api/v1";
import { skillById } from "@/lib/catalog/skills";
import { skillMd } from "@/lib/api/skill-md";

export const runtime = "nodejs";

/** GET /api/v1/skills/:slug - one skill plus its generated SKILL.md text. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    const { slug } = await params;
    const skill = skillById(slug);
    if (!skill) return v1error("not_found", `no skill ${slug}`, 404);
    return v1json({
      slug: skill.id,
      name: skill.name,
      description: skill.blurb,
      skill_md: skillMd(skill),
    });
  } catch (e) {
    return v1err(e);
  }
}
