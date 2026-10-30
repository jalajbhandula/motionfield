import { NextRequest } from "next/server";
import { z } from "zod";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err, v1error } from "@/lib/api/v1";
import { readBodyCapped, runViewV1 } from "@/lib/api/runs-v1";
import { editStep, getRunView, StaleRevError } from "@/lib/runs";

export const runtime = "nodejs";

const StepEdit = z.object({
  /** optimistic concurrency - the rev the caller last saw on this step */
  rev: z.number().int().min(0),
  title: z.string().min(1).max(160).optional(),
  /** merged onto the stored params - revalidated as a whole */
  params: z.record(z.string(), z.unknown()).optional(),
}).refine((b) => b.title !== undefined || b.params !== undefined,
  { message: "send title and/or params alongside rev" });

/**
 * PATCH /api/v1/runs/:id/steps/:stepId { rev, title?, params? } -
 * edit one step's spec. A stale rev answers 409 stale_revision carrying the
 * head rev so the client can refresh and retry; a live-run edit is the
 * engine's own 409.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; stepId: string }> }) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    const { id, stepId } = await params;
    const pid = z.string().uuid().safeParse(id);
    if (!pid.success) return v1error("not_found", "run not found", 404);
    const sid = z.string().min(1).max(40).safeParse(stepId);
    if (!sid.success) return v1error("not_found", "step not found", 404);

    // same streaming cap as the create route - req.json() would read unbounded
    const raw = await readBodyCapped(req, 1024 * 1024);
    if (raw === "too_large") return v1error("payload_too_large", "request body too large (1MB max)", 413);
    if (raw === "unreadable")
      return v1error("bad_request", 'body must be JSON: { "rev": 0, "title"?: …, "params"?: … }', 400);
    let jsonBody: unknown = null;
    try { jsonBody = JSON.parse(raw.text); } catch { /* invalid JSON → schema fails below */ }
    const body = StepEdit.safeParse(jsonBody);
    if (!body.success)
      return v1error("bad_request",
        body.error.issues[0]?.message ?? 'body must be JSON: { "rev": 0, "title"?: …, "params"?: … }',
        400);

    const out = await editStep(auth.userId, pid.data, sid.data, {
      rev: body.data.rev, title: body.data.title, params: body.data.params,
    });
    if (!out) return v1error("not_found", "step not found", 404);
    const view = await getRunView(auth.userId, pid.data);
    if (!view) return v1error("not_found", "run not found", 404);
    return v1json(await runViewV1(view));
  } catch (e) {
    if (e instanceof StaleRevError)
      return v1json({ error: { code: "stale_revision", message: e.message, head_rev: e.rev } }, 409);
    return v1err(e);
  }
}
