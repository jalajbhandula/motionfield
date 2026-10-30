import { NextRequest } from "next/server";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err, v1error } from "@/lib/api/v1";
import { readBodyCapped } from "@/lib/api/runs-v1";
import { CreateRef, createRefV1, listRefsV1, parseCategory } from "@/lib/api/refs-v1";

export const runtime = "nodejs";

/** 10 image urls of ≤4KB each can't exceed this - a smaller cap than jobs. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * GET /api/v1/refs?category= - the caller's refs, newest first.
 * POST /api/v1/refs - create one; the name slugifies to the @ref form.
 * Both owner-scoped: nothing in another user's rows ever appears.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    const category = parseCategory(req.nextUrl.searchParams.get("category"));
    return v1json({ refs: await listRefsV1(auth.userId, category) });
  } catch (e) {
    return v1err(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    const raw = await readBodyCapped(req, MAX_BODY_BYTES);
    if (raw === "too_large")
      return v1error("payload_too_large", "request body too large (64KB max)", 413);
    if (raw === "unreadable")
      return v1error("bad_request", "body must be JSON: { name, category?, kind?, description?, images, likeness_consent? }", 400);
    let body: unknown = null;
    try { body = JSON.parse(raw.text); } catch { /* handled below */ }
    const parsed = CreateRef.safeParse(body);
    if (!parsed.success)
      return v1error("bad_request", parsed.error.issues[0]?.message ?? "bad request", 400);
    const ref = await createRefV1(auth.userId, parsed.data);
    return v1json({ ref }, 201);
  } catch (e) {
    return v1err(e);
  }
}
