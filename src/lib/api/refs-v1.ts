import { z } from "zod";
import { sql } from "@/db";
import { resolveOwnedMedia } from "@/lib/media-owned";
import { JobError } from "@/lib/jobs";

/**
 * Refs - named, reusable @references built from the caller's own images.
 * One shared rule-set: the v1 surface (src/app/api/v1/refs) calls these
 * helpers, and the session-scoped app route (src/app/api/refs, WS4) adopts
 * the same file so both surfaces enforce identical rules.
 *
 * A ref is a row in `elements` keyed (user_id, name):
 * - name is a per-user slug - anything else in the request slugifies to the
 *   [a-z0-9-] ≤80 form the @ref parser reads;
 * - images are caller-owned /files urls only - resolveOwnedMedia answers a
 *   400 for external urls and a 404 for urls the user doesn't own (no
 *   existence leak to other users' files);
 * - person/character refs carry a likeness - likeness_consent:true is
 *   required up front (docs/POLICY.md);
 * - a duplicate (user, name) is a 409.
 * Rows written before the rename keep working: "location" reads as
 * "environment", "persona" as "character".
 */

export const REF_CATEGORIES = ["character", "environment", "prop"] as const;
export const REF_KINDS = ["person", "outfit", "prop", "place"] as const;
const LEGACY_CATEGORY: Record<string, (typeof REF_CATEGORIES)[number]> = {
  location: "environment",
  persona: "character",
};

/** stored category → the one the API reports */
export const readCategory = (c: unknown): string => {
  const s = String(c ?? "");
  return LEGACY_CATEGORY[s] ?? ((REF_CATEGORIES as readonly string[]).includes(s) ? s : "character");
};
/** api category → every stored value that maps back to it */
export const writeCandidates = (c: string) =>
  [c, ...Object.entries(LEGACY_CATEGORY).filter(([, v]) => v === c).map(([k]) => k)];

export const CreateRef = z.object({
  name: z.string().min(1).max(80),
  category: z.enum(REF_CATEGORIES).default("character"),
  kind: z.enum(REF_KINDS).optional(),
  description: z.string().max(500).optional(),
  images: z.array(z.string().min(1).max(4096)).min(1).max(10),
  likeness_consent: z.boolean().optional(),
});
export type CreateRefBody = z.infer<typeof CreateRef>;

export const slugify = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

/** ?category= - a bad value is a 400 carrying the offending string. */
export function parseCategory(raw: string | null): string | null {
  const parsed = z.enum(REF_CATEGORIES).nullish().safeParse(raw);
  if (!parsed.success) throw new JobError(`unknown category "${raw}"`, 400);
  return parsed.data ?? null;
}

export interface RefRow {
  id: string; user_id: string; name: string; category: string; kind: string | null;
  description: string | null; images: unknown; created_at: unknown;
}

export const refView = (r: RefRow) => ({
  id: r.id,
  name: r.name,
  category: readCategory(r.category),
  kind: r.kind ?? null,
  description: r.description,
  images: Array.isArray(r.images) ? r.images : [],
  created_at: r.created_at,
});

/** The caller's refs, newest first; ?category narrows by stored-or-legacy. */
export async function listRefsV1(userId: string, category: string | null) {
  const rows = category
    ? await sql<RefRow>(
        `SELECT * FROM elements WHERE user_id = $1 AND category = ANY($2::text[]) ORDER BY created_at DESC LIMIT 100`,
        [userId, writeCandidates(category)])
    : await sql<RefRow>(
        `SELECT * FROM elements WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [userId]);
  return rows.map(refView);
}

/** One ref by (caller, slug-name) - null when missing or not the caller's. */
export async function getRefV1(userId: string, name: string) {
  const rows = await sql<RefRow>(
    `SELECT * FROM elements WHERE user_id = $1 AND name = $2 LIMIT 1`, [userId, name]);
  return rows[0] ? refView(rows[0]) : null;
}

/** Create a ref for `userId` from an already-zod-parsed body. */
export async function createRefV1(userId: string, b: CreateRefBody) {
  const name = slugify(b.name);
  if (!name) throw new JobError("ref name required", 400);
  // person refs carry a likeness - the caller must assert the right to use
  // it (docs/POLICY.md); object/place refs don't need the box
  if ((b.kind === "person" || b.category === "character") && b.likeness_consent !== true)
    throw new JobError("likeness consent required", 400);
  // every image must be the caller's own /files url - 400/404 surface as-is
  for (const u of b.images) await resolveOwnedMedia(userId, u);
  let row: RefRow;
  try {
    [row] = await sql<RefRow>(
      `INSERT INTO elements (user_id, name, category, kind, description, images)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *`,
      [userId, name, b.category, b.kind ?? null, b.description ?? null, JSON.stringify(b.images)]);
  } catch (e) {
    if ((e as { code?: string })?.code === "23505")
      throw new JobError(`a ref named @${name} already exists`, 409);
    throw e;
  }
  return refView(row);
}
