import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { forgetMemory, getMemory, updateMemory, MEMORY_KINDS, MEMORY_LINK_TYPES } from "@/lib/memory";

export const runtime = "nodejs";

/**
 * /api/agent/memories/:id - the caller's own memory only; every path 404s a
 * foreign row (no read, no write, no existence leak).
 *   GET    → the memory with its links
 *   PATCH  → {name?, kind?, content?} - renamed names slugify + re-check
 *   DELETE → hard forget (links cascade)
 */

const Id = z.string().uuid();
const MemoryPatch = z.strictObject({
  name: z.string().min(1).max(80).optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
  content: z.string().min(1).max(4000).optional(),
  /** wholesale link replacement - every target ownership-checked first */
  links: z.array(z.strictObject({
    target_type: z.enum(MEMORY_LINK_TYPES),
    target_id: z.string().uuid(),
  })).max(16).optional(),
});

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const id = Id.safeParse((await params).id);
    if (!id.success) return json({ error: "not found" }, 404);
    const memory = await getMemory(user.id, id.data);
    if (!memory) return json({ error: "not found" }, 404);
    return json({ memory });
  } catch (e) {
    return err(e);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const id = Id.safeParse((await params).id);
    if (!id.success) return json({ error: "not found" }, 404);
    const parsed = MemoryPatch.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const memory = await updateMemory(user.id, id.data, parsed.data);
    return json({ memory });
  } catch (e) {
    return err(e);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const id = Id.safeParse((await params).id);
    if (!id.success) return json({ error: "not found" }, 404);
    const gone = await forgetMemory(user.id, { id: id.data });
    if (!gone) return json({ error: "not found" }, 404);
    return json({ forgot: gone.name });
  } catch (e) {
    return err(e);
  }
}
