import { getAuth } from "@/lib/auth";
import { getDb, sql, tx, schema } from "@/db";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";

const SIGNUP_BONUS = 50;

function isPgError(e: unknown, code: string): boolean {
  return (e as { code?: string })?.code === code;
}

/**
 * Provision profile + personal workspace + owner membership + signup bonus.
 * Race-safe: the profile insert is a single ON CONFLICT DO NOTHING - only the
 * call that wins it creates the workspace row, the owner membership and the
 * signup_bonus ledger entry, all in that same transaction; every other call
 * returns the winner's row. A handle collision retries with a suffixed handle.
 */
async function ensureProfileInner(userId: string, email: string, name?: string | null) {
  const db = await getDb();
  const existing = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, userId)).limit(1);
  if (existing.length) return existing[0];

  const base = (email?.split("@")[0] || "user").replace(/[^a-z0-9._-]/gi, "").toLowerCase() || "user";
  for (let i = 0; i < 20; i++) {
    const handle = i === 0 ? base : `${base}${Math.floor(Math.random() * 9000 + 1000)}`;
    let won: boolean;
    try {
      won = await tx(async (q) => {
        const inserted = await q(
          `INSERT INTO profiles (user_id, handle, display_name) VALUES ($1,$2,$3)
           ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
          [userId, handle, name || base]);
        if (!inserted.length) return false;
        const ws = await q(
          `INSERT INTO workspaces (name, owner_id) VALUES ($1,$2) RETURNING id`,
          [`${base}'s workspace`, userId]);
        if (ws.length) {
          await q(
            `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')
             ON CONFLICT DO NOTHING`,
            [ws[0].id, userId]);
        }
        const [{ credits }] = await q(
          `SELECT credits::float AS credits FROM profiles WHERE user_id = $1 FOR UPDATE`, [userId]);
        const next = Number(credits) + SIGNUP_BONUS;
        await q(`UPDATE profiles SET credits = $2, updated_at = now() WHERE user_id = $1`, [userId, next]);
        // Deliberately mirrors the insert inside credits.applyDelta - same
        // column list (user_id, delta, balance_after, kind, ref_type, ref_id,
        // note). If applyDelta's row shape changes, change this one in
        // lockstep or ledger reads will see two shapes.
        await q(
          `INSERT INTO credit_ledger (user_id, delta, balance_after, kind, ref_type, ref_id, note)
           VALUES ($1,$2,$3,'signup_bonus','user',$4,'Welcome bonus')`,
          [userId, SIGNUP_BONUS, next, userId]);
        return true;
      });
    } catch (e) {
      // unique violation on profiles.handle - pick a suffixed handle and retry
      if (isPgError(e, "23505")) continue;
      throw e;
    }
    if (won) {
      return (await db.select().from(schema.profiles).where(eq(schema.profiles.userId, userId)).limit(1))[0];
    }
    // Another call won the insert - its transaction may still be finishing the
    // workspace/ledger writes, but the profile row is committed and visible.
    const [row] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, userId)).limit(1);
    if (row) return row;
  }
  const [row] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, userId)).limit(1);
  if (row) return row;
  throw new Error("ensureProfile: could not allocate a unique handle");
}

export async function ensureProfile(userId: string, email: string, name?: string | null) {
  // The auth after-hook can run before the just-inserted `user` row is visible
  // to this connection - a 23503 FK violation is transient, so retry briefly.
  for (let attempt = 1; ; attempt++) {
    try {
      return await ensureProfileInner(userId, email, name);
    } catch (e) {
      if (!isPgError(e, "23503") || attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 80 * attempt));
    }
  }
}

export async function getSession() {
  const auth = await getAuth();
  return auth.api.getSession({ headers: await headers() });
}

export async function getSessionUser() {
  const s = await getSession();
  if (!s?.user) return null;
  const db = await getDb();
  const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, s.user.id)).limit(1);
  return { user: s.user, profile: profile ?? null, session: s.session };
}

export async function requireUser() {
  const s = await getSessionUser();
  if (!s) throw new AuthError();
  return s;
}

export class AuthError extends Error {
  constructor() { super("unauthorized"); }
}

/** Handle for public profile pages: @handle */
export async function getPublicProfile(handle: string) {
  const rows = await sql<{
    user_id: string; handle: string; display_name: string | null; bio: string | null;
    avatar_url: string | null; created_at: string;
  }>(
    `SELECT p.user_id, p.handle, p.display_name, p.bio, p.avatar_url, p.created_at
     FROM profiles p WHERE p.handle = $1`, [handle]);
  return rows[0] ?? null;
}
