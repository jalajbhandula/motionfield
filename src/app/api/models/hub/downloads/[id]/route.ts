import { NextRequest } from "next/server";
import { z } from "zod";
import { json } from "@/lib/api";
import { hubErr, hubUser } from "@/lib/model-hub/gate";
import { cancelDownload } from "@/lib/model-hub/downloads";

export const runtime = "nodejs";

/** Cancel one of the caller's downloads - the .part file is kept so a later
 *  POST resumes it. A malformed or another user's id reads as 404. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    // cancel is a local op - Offline still runs it
    const user = await hubUser(req, { offlineOk: true });
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) return json({ error: "not found" }, 404);
    return json({ download: await cancelDownload(user.id, id) });
  } catch (e) {
    return hubErr(e);
  }
}
