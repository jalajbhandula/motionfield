import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { agentTools, endpointJsonSchema, toolArgsSchema } from "@/lib/agent/tools";
import { modePolicy } from "@/lib/runs/modes";
import { userOffline } from "@/lib/llm/settings";

export const runtime = "nodejs";

const Mode = z.enum(["auto", "offline", "custom"]).optional();

/**
 * GET /api/agent/tools - the caller's tool list. Catalog tools mirror the
 * turn's endpoint allowlist (license opt-in + offline heavy filter applied);
 * builtin tools are the agent/* steps. schedule_create is registered but
 * marked unavailable; web_search only exists once a SearXNG URL is set.
 * Schemas only - no secrets, no provider details.
 */
export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const mode = Mode.safeParse(req.nextUrl.searchParams.get("mode") ?? undefined);
    if (!mode.success) return json({ error: "invalid mode" }, 400);
    const eff = (await userOffline(user.id)) ? "offline" : (mode.data ?? "auto");
    await modePolicy(eff, user.id); // keep the mode parse authoritative
    const tools = await agentTools(eff, user.id);
    return json({
      mode: eff,
      tools: tools.map((t) => ({
        name: t.name,
        endpoint_id: t.endpointId,
        input: t.input,
        output: t.output,
        restricted: t.restricted,
        offered_to_planner: t.planner,
        /** false → a planner reply form, never a run step (ask_user) */
        step: t.step !== false,
        available: t.available,
        description: t.description,
        schema: t.params ? endpointJsonSchema(t.params) : toolArgsSchema(t),
      })),
    });
  } catch (e) {
    return err(e);
  }
}
