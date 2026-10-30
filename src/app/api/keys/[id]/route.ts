import { NextRequest } from "next/server";
import { json, err, requireApiUser } from "@/lib/api";
import { revokeApiKey } from "@/lib/api/apikeys";

export const runtime = "nodejs";

/** DELETE - revoke one of the caller's keys (takes effect immediately). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    const revoked = await revokeApiKey(user.id, id);
    if (!revoked) return json({ error: "not found" }, 404);
    return json({ ok: true, revoked: id });
  } catch (e) {
    return err(e);
  }
}
