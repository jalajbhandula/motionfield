import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { setSessionTodo } from "@/lib/agent";

export const runtime = "nodejs";

/**
 * PATCH /api/agent/sessions/[id] - the only writable ctx slice is the todo
 * checklist: the agent's plan writes it, the run's todo step refreshes it,
 * and the page ticks items from here. Planner picks and modes still move
 * through POST messages.
 */
const PatchSchema = z.object({
  todo: z.object({
    items: z.array(z.object({ text: z.string().max(200), done: z.boolean() })).max(50),
  }),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: "invalid body" }, 400);
    await setSessionTodo(user.id, id, parsed.data.todo.items);
    return json({ ok: true });
  } catch (e) {
    return err(e);
  }
}
