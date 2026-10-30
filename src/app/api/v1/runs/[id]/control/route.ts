import { NextRequest } from "next/server";
import { z } from "zod";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err, v1error } from "@/lib/api/v1";
import { readBodyCapped, runViewV1 } from "@/lib/api/runs-v1";
import { controlRun, getRunView } from "@/lib/runs";

export const runtime = "nodejs";

const Control = z.object({
  action: z.enum(["pause", "resume", "stop"]),
});

/**
 * POST /api/v1/runs/:id/control { action: pause | resume | stop } -
 * the engine's control verbs, idempotent per action. An invalid transition
 * (resume a running run, pause a stopped one) is a JobError(409) → conflict.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    const { id } = await params;
    const parsed = z.string().uuid().safeParse(id);
    if (!parsed.success) return v1error("not_found", "run not found", 404);

    // same streaming cap as the create route - req.json() would read unbounded
    const raw = await readBodyCapped(req, 1024 * 1024);
    if (raw === "too_large") return v1error("payload_too_large", "request body too large (1MB max)", 413);
    if (raw === "unreadable")
      return v1error("bad_request", 'body must be JSON: { "action": "pause" | "resume" | "stop" }', 400);
    let jsonBody: unknown = null;
    try { jsonBody = JSON.parse(raw.text); } catch { /* invalid JSON → schema fails below */ }
    const body = Control.safeParse(jsonBody);
    if (!body.success)
      return v1error("bad_request", 'body must be JSON: { "action": "pause" | "resume" | "stop" }', 400);

    const ok = await controlRun(auth.userId, parsed.data, body.data.action);
    if (!ok) return v1error("not_found", "run not found", 404);
    const view = await getRunView(auth.userId, parsed.data);
    if (!view) return v1error("not_found", "run not found", 404);
    return v1json(await runViewV1(view));
  } catch (e) {
    return v1err(e);
  }
}
