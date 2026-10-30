import { NextRequest } from "next/server";
import { json, requireApiUser } from "@/lib/api";
import {
  deleteProviderRow,
  getProviderRow,
  ProviderPutBody,
  putProviderRow,
} from "@/lib/llm/settings";
import { llmErr } from "../../route-utils";

export const runtime = "nodejs";

/** Per-user provider row: {providerId, baseUrl, wire, hasKey, updatedAt}.
 *  The API key itself can be written but never read back. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    const row = await getProviderRow(user.id, id);
    if (!row) return json({ error: "not found" }, 404);
    return json(row);
  } catch (e) {
    return llmErr(e);
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    const parsed = ProviderPutBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid body" }, 400);
    const row = await putProviderRow(user.id, id, parsed.data);
    return json(row);
  } catch (e) {
    return llmErr(e);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    const gone = await deleteProviderRow(user.id, id);
    if (!gone) return json({ error: "not found" }, 404);
    return json({ ok: true });
  } catch (e) {
    return llmErr(e);
  }
}
