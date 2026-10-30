import { NextRequest } from "next/server";
import { json, requireApiUser } from "@/lib/api";
import { LLM_TASKS, type TaskKind } from "@/lib/llm/router";
import { deleteTaskRoute, putTaskRoute, RoutePutBody } from "@/lib/llm/settings";
import { llmErr } from "../../route-utils";

export const runtime = "nodejs";

const isTask = (t: string): t is TaskKind => (LLM_TASKS as readonly string[]).includes(t);

export async function PUT(req: NextRequest, { params }: { params: Promise<{ task: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { task } = await params;
    if (!isTask(task)) return json({ error: "unknown task" }, 404);
    const parsed = RoutePutBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid body" }, 400);
    const row = await putTaskRoute(user.id, task, parsed.data);
    return json(row);
  } catch (e) {
    return llmErr(e);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ task: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { task } = await params;
    if (!isTask(task)) return json({ error: "unknown task" }, 404);
    const gone = await deleteTaskRoute(user.id, task);
    if (!gone) return json({ error: "not found" }, 404);
    return json({ ok: true });
  } catch (e) {
    return llmErr(e);
  }
}
