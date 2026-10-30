import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { memoryGraph } from "@/lib/memory";

export const runtime = "nodejs";

/** GET /api/agent/memories/graph[?project_id=<uuid>] - nodes (memories +
 *  resolved job/upload/ref targets) and edges for the caller's own rows. */
export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const pid = req.nextUrl.searchParams.get("project_id");
    if (pid && !z.string().uuid().safeParse(pid).success)
      return json({ error: "bad project_id" }, 400);
    return json(await memoryGraph(user.id, pid ?? undefined));
  } catch (e) {
    return err(e);
  }
}
