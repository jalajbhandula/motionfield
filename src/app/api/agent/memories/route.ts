import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { createMemory, listMemories, MEMORY_KINDS, MEMORY_LINK_TYPES } from "@/lib/memory";

export const runtime = "nodejs";

/**
 * GET  /api/agent/memories[?project_id=<uuid>] - the caller's own memories
 *      (project-scoped when the query names a project the caller owns).
 * POST /api/agent/memories - create {name, kind?, content, project_id?, links?}.
 *      Name slugifies; a (user, name) duplicate is a 409; a foreign
 *      project_id or link target is a 404 - never a write.
 */

const Link = z.strictObject({
  target_type: z.enum(MEMORY_LINK_TYPES),
  target_id: z.string().uuid(),
});
const MemoryPost = z.strictObject({
  name: z.string().min(1).max(80),
  kind: z.enum(MEMORY_KINDS).optional(),
  content: z.string().min(1).max(4000),
  project_id: z.string().uuid().nullable().optional(),
  links: z.array(Link).max(16).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const pid = req.nextUrl.searchParams.get("project_id");
    if (pid && !z.string().uuid().safeParse(pid).success)
      return json({ error: "bad project_id" }, 400);
    return json({ memories: await listMemories(user.id, pid ?? undefined) });
  } catch (e) {
    return err(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const parsed = MemoryPost.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const b = parsed.data;
    const memory = await createMemory(user.id, {
      name: b.name, kind: b.kind, content: b.content,
      projectId: b.project_id ?? null, links: b.links,
    });
    return json({ memory }, 201);
  } catch (e) {
    return err(e);
  }
}
