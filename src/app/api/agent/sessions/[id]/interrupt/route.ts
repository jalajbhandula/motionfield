import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { interruptSession } from "@/lib/agent";

export const runtime = "nodejs";

const SessionId = z.string().uuid();

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id: rawId } = await params;
    const pid = SessionId.safeParse(rawId);
    if (!pid.success) return json({ error: "not found" }, 404);
    const session = await interruptSession(user.id, pid.data);
    if (!session) return json({ error: "not found" }, 404);
    return json({ session });
  } catch (e) {
    return err(e);
  }
}
