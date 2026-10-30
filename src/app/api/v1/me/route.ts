import { NextRequest } from "next/server";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1error, v1err } from "@/lib/api/v1";
import { sql } from "@/db";

export const runtime = "nodejs";

/** GET /api/v1/me - who this key is: user, plan, credit balance, key label. */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    const [row] = await sql<{
      email: string; plan_id: string | null; credits: number | null;
    }>(
      `SELECT u.email, p.plan_id, p.credits::float AS credits
       FROM "user" u LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [auth.userId]);
    if (!row) return v1error("not_found", "user not found", 404);
    return v1json({
      user_id: auth.userId,
      email: row.email,
      plan: row.plan_id,
      credits: row.credits ?? 0,
      key: { id: auth.keyId, label: auth.keyLabel },
    });
  } catch (e) {
    return v1err(e);
  }
}
