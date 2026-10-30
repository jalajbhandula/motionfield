import { NextRequest } from "next/server";
import { json, err, requireApiUser } from "@/lib/api";
import { rotateWebhookSecret } from "@/lib/api/apikeys";

export const runtime = "nodejs";

/** POST - rotate the key's webhook signing secret. The new `ofwh_…` value is
 *  returned exactly once; deliveries signed from the next attempt onward use
 *  it (signatures are computed per attempt, not at enqueue). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    const secret = await rotateWebhookSecret(user.id, id);
    if (!secret) return json({ error: "not found" }, 404);
    return json({ webhook_secret: secret });
  } catch (e) {
    return err(e);
  }
}
