import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { sql } from "@/db";
import { resolveOwnedMedia } from "@/lib/media-owned";
import { JobError } from "@/lib/jobs";

export const runtime = "nodejs";

/**
 * Refs - named, reusable @references built from the caller's own images.
 * POST creates one (name is a per-user slug; a duplicate is a 409); every
 * image url is ownership-checked. GET lists the caller's refs, optionally
 * filtered by ?category=. Rows written before the rename keep working:
 * "location" reads as "environment", "persona" as "character".
 */
const REF_CATEGORIES = ["character", "environment", "prop"] as const;
const REF_KINDS = ["person", "outfit", "prop", "place"] as const;
const LEGACY_CATEGORY: Record<string, (typeof REF_CATEGORIES)[number]> = {
  location: "environment",
  persona: "character",
};
/** stored category → the one the API reports */
const readCategory = (c: unknown): string => {
  const s = String(c ?? "");
  return LEGACY_CATEGORY[s] ?? ((REF_CATEGORIES as readonly string[]).includes(s) ? s : "character");
};
/** api category → every stored value that maps back to it */
const writeCandidates = (c: string) =>
  [c, ...Object.entries(LEGACY_CATEGORY).filter(([, v]) => v === c).map(([k]) => k)];

const CreateRef = z.object({
  name: z.string().min(1).max(80),
  category: z.enum(REF_CATEGORIES).default("character"),
  kind: z.enum(REF_KINDS).optional(),
  description: z.string().max(500).optional(),
  images: z.array(z.string().min(1).max(4096)).min(1).max(10),
  likeness_consent: z.boolean().optional(),
});

const slugify = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

type RefRow = {
  id: string; user_id: string; name: string; category: string; kind: string | null;
  description: string | null; images: unknown; created_at: unknown;
};
const refView = (r: RefRow) => ({
  id: r.id,
  name: r.name,
  category: readCategory(r.category),
  kind: r.kind ?? null,
  description: r.description,
  images: Array.isArray(r.images) ? r.images : [],
  created_at: r.created_at,
});

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const parsed = CreateRef.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    const b = parsed.data;
    const name = slugify(b.name);
    if (!name) throw new JobError("ref name required", 400);
    // person refs carry a likeness - the caller must assert the right to use
    // it (docs/POLICY.md); object/place refs don't need the box
    if ((b.kind === "person" || b.category === "character") && b.likeness_consent !== true)
      return json({ error: "likeness consent required" }, 400);
    // every image must be the caller's own /files url - 400/404 surface as-is
    for (const u of b.images) await resolveOwnedMedia(user.id, u);
    let row: RefRow;
    try {
      [row] = await sql<RefRow>(
        `INSERT INTO elements (user_id, name, category, kind, description, images)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *`,
        [user.id, name, b.category, b.kind ?? null, b.description ?? null, JSON.stringify(b.images)]);
    } catch (e) {
      if ((e as { code?: string })?.code === "23505")
        throw new JobError(`a ref named @${name} already exists`, 409);
      throw e;
    }
    return json({ ref: refView(row) }, 201);
  } catch (e) {
    return err(e);
  }
}

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const raw = req.nextUrl.searchParams.get("category");
    const parsedCategory = z.enum(REF_CATEGORIES).nullish().safeParse(raw);
    if (!parsedCategory.success) return json({ error: `unknown category "${raw}"` }, 400);
    const category = parsedCategory.data ?? null;
    const rows = category
      ? await sql<RefRow>(
          `SELECT * FROM elements WHERE user_id = $1 AND category = ANY($2::text[]) ORDER BY created_at DESC LIMIT 100`,
          [user.id, writeCandidates(category)])
      : await sql<RefRow>(
          `SELECT * FROM elements WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
          [user.id]);
    return json({ refs: rows.map(refView) });
  } catch (e) {
    return err(e);
  }
}
