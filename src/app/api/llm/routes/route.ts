import { NextRequest } from "next/server";
import { json, requireApiUser } from "@/lib/api";
import { LLM_TASKS, SUGGESTED_ROUTE } from "@/lib/llm/router";
import { listTaskRoutes } from "@/lib/llm/settings";
import { llmErr } from "../route-utils";

export const runtime = "nodejs";

/** Per-task route map for Settings → Models & LLMs. */
export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const rows = await listTaskRoutes(user.id);
    const routes: Record<string, { providerId: string; model: string; wire: string | null } | null> =
      Object.fromEntries(LLM_TASKS.map((t) => [t, null]));
    for (const r of rows) {
      if (r.task in routes) routes[r.task] = { providerId: r.providerId, model: r.model, wire: r.wire };
    }
    return json({ tasks: LLM_TASKS, routes, suggested: SUGGESTED_ROUTE });
  } catch (e) {
    return llmErr(e);
  }
}
