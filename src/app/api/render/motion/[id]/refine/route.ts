import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { parseSceneSpec } from "@/lib/render/spec";
import { refineMotionSpec, NeedsLlm, writerReady } from "@/lib/render/generate";
import { brandContextSchema } from "@/lib/render/brand";

export const runtime = "nodejs";

const bodySchema = z.strictObject({
  instruction: z.string().min(1).max(500),
});

const NEEDS_LLM_BODY = {
  code: "NEEDS_LLM",
  error: "spec-writing LLM isn't configured (set LLM_* or pick a provider in Settings)",
} as const;

/**
 * POST /api/render/motion/:id/refine - LLM-edits an existing spec and stores
 * the result as a NEW row (parent_id = the refined spec). Keeps the
 * original's frame, fps, duration, seed, and brand context.
 *
 * LLM availability is checked before any DB or network work - a request that
 * can't possibly run answers fast. The stored `brand` column is reused, so a
 * refine never re-fetches the source site. One 5-minute budget signal covers
 * the call.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await ctx.params;
    if (!z.uuid().safeParse(id).success) return json({ error: "not found" }, 404);
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "bad body" }, 400);
    const { instruction } = parsed.data;

    // before any DB/network work: can this user's writer route even run?
    if (!(await writerReady(user.id))) return json(NEEDS_LLM_BODY, 503);
    const budget = AbortSignal.any([req.signal, AbortSignal.timeout(300_000)]);

    const db = await getDb();
    const [row] = await db.select().from(schema.renderSpecs)
      .where(eq(schema.renderSpecs.id, id)).limit(1);
    if (!row || row.userId !== user.id) return json({ error: "not found" }, 404);

    let spec;
    try {
      spec = parseSceneSpec(row.spec);
    } catch {
      return json({ error: "stored spec is invalid" }, 500);
    }

    // the row carries the brand context captured at generate time - no
    // re-fetch. It's untrusted stored jsonb: parse, never cast.
    const brandParsed = brandContextSchema.safeParse(row.brand);
    const brand = brandParsed.success ? brandParsed.data : undefined;

    let next;
    try {
      next = await refineMotionSpec(spec, instruction, { brand, signal: budget, userId: user.id });
    } catch (e) {
      if (e instanceof NeedsLlm) return json(NEEDS_LLM_BODY, 503);
      return json({ error: e instanceof Error ? e.message : "refine failed" }, 502);
    }

    const [out] = await db.insert(schema.renderSpecs).values({
      userId: user.id, spec: next, title: row.title, prompt: row.prompt,
      sourceUrl: row.sourceUrl, brand: row.brand ?? null, parentId: row.id,
    }).returning({ id: schema.renderSpecs.id });
    return json({ id: out.id, spec: next }, 201);
  } catch (e) {
    return err(e);
  }
}
