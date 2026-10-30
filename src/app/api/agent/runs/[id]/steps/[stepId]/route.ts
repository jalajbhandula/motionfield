import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { editStep, getRunView, StaleRevError } from "@/lib/runs";

export const runtime = "nodejs";

const RUN_ID = z.string().uuid();
const STEP_ID = z.string().min(1).max(40);

/** The edit body: params merge onto the stored spec, `rev` is optimistic
 *  concurrency (stale → 409 {rev}), title replaces. endpoint_id is the
 *  Custom model pick (same output kind; media inputs auto-wire to $step
 *  deps) and effort the Custom effort select - the whole edited plan
 *  replays through validatePlan either way. */
const EditBody = z.object({
  params: z.record(z.string(), z.unknown()).optional(),
  rev: z.number().int().min(0),
  title: z.string().min(1).max(160).optional(),
  endpoint_id: z.string().min(1).max(160).optional(),
  effort: z.enum(["draft", "standard", "high"]).optional(),
}).refine(
  (b) => b.params !== undefined || b.title !== undefined
    || b.endpoint_id !== undefined || b.effort !== undefined,
  { message: "nothing to edit" },
);

/** POST /api/agent/runs/:id/steps/:stepId - edit a step's spec and re-run it
 *  plus its transitive descendants. Prior specs/outputs land in
 *  run_step_revisions (earlier versions); the step's rev bumps.
 *  404 unknown run/step (or not the caller's), 409 live run / running step /
 *  stale rev ({error, rev}), 422 the edited plan fails validation.
 *  Returns the refreshed run view. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; stepId: string }> },
) {
  try {
    const { user } = await requireApiUser(req);
    const { id, stepId } = await params;
    const rid = RUN_ID.safeParse(id);
    const sid = STEP_ID.safeParse(stepId);
    if (!rid.success || !sid.success) return json({ error: "not found" }, 404);
    const parsed = EditBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const out = await editStep(user.id, rid.data, sid.data, parsed.data);
    if (!out) return json({ error: "not found" }, 404);
    return json({ run: await getRunView(user.id, rid.data), step_id: sid.data, rev: out.rev });
  } catch (e) {
    // a stale rev carries the current rev back so the client refreshes
    // rather than retrying blind
    if (e instanceof StaleRevError) return json({ error: e.message, rev: e.rev }, 409);
    return err(e);
  }
}
