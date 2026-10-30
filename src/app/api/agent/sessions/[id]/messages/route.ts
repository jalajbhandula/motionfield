import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { getMessages, getSession, liveSessionJobs, postUserMessage, tickSession, type Attachment } from "@/lib/agent";
import { listSessionRuns } from "@/lib/runs";

export const runtime = "nodejs";

const SessionId = z.string().uuid();

const BodySchema = z.object({
  text: z.string().max(8000).optional(),
  content: z.object({ text: z.string().max(8000).optional() }).optional(),
  attachments: z.array(z.unknown()).max(8).optional(),
  /** per-message mode override - the page sends the current mode every turn */
  mode: z.enum(["auto", "offline", "custom"]).optional(),
  /** per-message approval gate - plans run only after an explicit approve */
  ask_first: z.boolean().optional(),
  /** explicit project binding for the produced run - owner-checked before
   *  any write (a foreign id answers 404 with zero writes) */
  project_id: z.string().uuid().nullable().optional(),
  /** save the brief without a planner turn (skill runs submit their own plan) */
  record_only: z.boolean().optional(),
  /** planner picker: "builtin" or "<providerId>:<model>" - sticks for the session */
  planner: z.string().max(200).optional(),
});

function normalizeAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => (typeof a === "string" ? { url: a } : a))
    .filter((a): a is Attachment => Boolean(a && typeof (a as Attachment).url === "string"));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id: rawId } = await params;
    const pid = SessionId.safeParse(rawId);
    if (!pid.success) return json({ error: "not found" }, 404);
    const id = pid.data;
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid body" }, 400);
    const body = parsed.data;
    const text = String(body.text ?? body.content?.text ?? "");
    if (!text.trim()) return json({ error: "message text required" }, 400);
    const message = await postUserMessage(user.id, id, text, normalizeAttachments(body.attachments), body.mode, body.ask_first, { plan: !body.record_only, planner: body.planner, projectId: body.project_id ?? null });
    return json({ message }, 201);
  } catch (e) {
    return err(e);
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id: rawId } = await params;
    const pid = SessionId.safeParse(rawId);
    if (!pid.success) return json({ error: "not found" }, 404);
    const id = pid.data;
    const session = await getSession(user.id, id);
    if (!session) return json({ error: "not found" }, 404);
    await tickSession(id).catch(() => {});
    const after = req.nextUrl.searchParams.get("after");
    const [messages, jobs, fresh, runs] = await Promise.all([
      getMessages(id, after ? Number(after) : undefined),
      liveSessionJobs(id),
      getSession(user.id, id),
      listSessionRuns(id),
    ]);
    return json({ session: fresh, messages, jobs, runs });
  } catch (e) {
    return err(e);
  }
}
