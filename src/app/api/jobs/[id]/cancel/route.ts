import { NextRequest } from "next/server";
import { json, err, requireApiUser } from "@/lib/api";
import { cancelJob } from "@/lib/jobs";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const job = await cancelJob(user.id, (await params).id);
    return json({ job });
  } catch (e) {
    return err(e);
  }
}
