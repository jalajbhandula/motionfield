import { z } from "zod";
import type { elements } from "@/db/schema";

/**
 * Named @refs - the caller's own elements table rows (user-scoped reads only).
 * A ref's images fill media params; an unknown or foreign name never
 * resolves - the planner asks instead of guessing.
 */

export type RefRow = typeof elements.$inferSelect;

export interface ResolvedRef {
  name: string;
  category: string;
  images: string[];
  description: string | null;
}

const shape = (r: Pick<RefRow, "name" | "category" | "images" | "description">): ResolvedRef => ({
  name: r.name,
  category: r.category,
  images: z.array(z.string()).catch([]).parse(r.images ?? []),
  description: r.description ?? null,
});

/** "@name" tokens in a brief - the slug the refs API writes ([a-z0-9-], ≤80). */
const REF_RE = /@([a-z0-9][a-z0-9-]{0,79})/gi;

export function refNamesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(REF_RE)) out.add(m[1].toLowerCase());
  return [...out];
}

/** The caller's refs, in name order - the refs_list tool's payload. */
export async function listRefs(userId: string): Promise<ResolvedRef[]> {
  const { getDb, schema } = await import("@/db");
  const { eq, asc } = await import("drizzle-orm");
  const db = await getDb();
  const rows = await db.select().from(schema.elements)
    .where(eq(schema.elements.userId, userId)).orderBy(asc(schema.elements.name));
  return rows.map(shape);
}

/** One ref by (caller, name) - null when missing or not the caller's. */
export async function refByName(userId: string, name: string): Promise<ResolvedRef | null> {
  const { getDb, schema } = await import("@/db");
  const { and, eq } = await import("drizzle-orm");
  const db = await getDb();
  const [row] = await db.select().from(schema.elements)
    .where(and(eq(schema.elements.userId, userId), eq(schema.elements.name, name))).limit(1);
  return row ? shape(row) : null;
}

/** Resolve the @names in a brief against the caller's own refs. Missing
 *  names come back separately - the planner asks ("no ref named @x"),
 *  never invents. */
export async function resolveRefsInText(
  userId: string,
  text: string,
): Promise<{ refs: ResolvedRef[]; missing: string[] }> {
  const names = refNamesIn(text);
  if (!names.length) return { refs: [], missing: [] };
  const { getDb, schema } = await import("@/db");
  const { and, eq, inArray } = await import("drizzle-orm");
  const db = await getDb();
  const rows = await db.select().from(schema.elements)
    .where(and(eq(schema.elements.userId, userId), inArray(schema.elements.name, names)));
  const byName = new Map<string, ResolvedRef>(rows.map((r: RefRow) => [r.name.toLowerCase(), shape(r)]));
  return {
    refs: names.flatMap((n) => { const r = byName.get(n); return r ? [r] : []; }),
    missing: names.filter((n) => !byName.has(n)),
  };
}
