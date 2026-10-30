import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { createSession, listSessions } from "@/lib/agent";

export const runtime = "nodejs";

const CreateSessionSchema = z.object({
  title: z.string().max(200).optional(),
  // uuid-checked before the row lookup - a garbage project id is a 400,
  // never a driver error surfacing as a 500
  project_id: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  mode: z.enum(["auto", "offline", "custom"]).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const parsed = CreateSessionSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: "invalid body" }, 400);
    const body = parsed.data;
    const session = await createSession(user.id, {
      title: body.title, projectId: body.project_id ?? body.projectId, mode: body.mode,
    });
    return json({ session }, 201);
  } catch (e) {
    return err(e);
  }
}

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    return json({ sessions: await listSessions(user.id) });
  } catch (e) {
    return err(e);
  }
}
