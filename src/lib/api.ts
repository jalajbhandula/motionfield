import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/auth";
import { ensureProfile } from "@/lib/profiles";
import { JobError } from "@/lib/jobs";
import { InsufficientCredits } from "@/lib/credits";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Path ids land in uuid columns - a malformed id must 404, not let PG
 *  raise an invalid-syntax error and 500 the route. */
export function isUuid(v: string) { return UUID_RE.test(v); }

export function err(e: unknown): NextResponse {
  if (e instanceof JobError) return json({ error: e.message }, e.status);
  if (e instanceof InsufficientCredits)
    return json({ error: e.message, needed: e.needed, have: e.have }, 402);
  const msg = e instanceof Error ? e.message : String(e);
  const status = msg === "unauthorized" ? 401 : 500;
  if (status === 500) console.error(e);
  return json({ error: status === 401 ? "unauthorized" : "internal error" }, status);
}

export async function apiUser(req: NextRequest) {
  const auth = await getAuth();
  const s = await auth.api.getSession({ headers: req.headers });
  if (!s?.user) return null;
  const profile = await ensureProfile(s.user.id, s.user.email, s.user.name);
  return { user: s.user, profile, session: s.session };
}

export async function requireApiUser(req: NextRequest) {
  const ctx = await apiUser(req);
  if (!ctx) throw new JobError("unauthorized", 401);
  return ctx;
}
