import { tx } from "@/db";
import type { LedgerKind } from "@/db/schema";

export class InsufficientCredits extends Error {
  needed: number;
  have: number;
  constructor(needed: number, have: number) {
    super(`insufficient credits: need ${needed}, have ${have}`);
    this.needed = needed; this.have = have;
  }
}

/**
 * Transactionally apply a credit delta. Locks the profile row so concurrent
 * requests serialize. Throws InsufficientCredits when spending below zero.
 */
async function applyDelta(
  userId: string,
  delta: number,
  kind: LedgerKind,
  refType?: string | null,
  refId?: string | null,
  note?: string | null,
) {
  return tx(async (q) => {
    const rows = await q(
      `SELECT credits::float AS credits FROM profiles WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (!rows.length) throw new Error("profile missing");
    const balance = Number(rows[0].credits);
    const next = balance + delta;
    if (next < -1e-9) throw new InsufficientCredits(-delta, balance);
    await q(`UPDATE profiles SET credits = $2, updated_at = now() WHERE user_id = $1`, [userId, next]);
    await q(
      `INSERT INTO credit_ledger (user_id, delta, balance_after, kind, ref_type, ref_id, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [userId, delta, next, kind, refType ?? null, refId ?? null, note ?? null],
    );
    return next;
  });
}

export function chargeCredits(userId: string, amount: number, refType: string, refId: string, note?: string) {
  return applyDelta(userId, -amount, "spend", refType, refId, note);
}

export function refundCredits(userId: string, amount: number, refType: string, refId: string, note?: string) {
  return applyDelta(userId, amount, "refund", refType, refId, note);
}

export function grantCredits(userId: string, amount: number, kind: LedgerKind, refType?: string | null, refId?: string | null, note?: string) {
  return applyDelta(userId, amount, kind, refType ?? null, refId ?? null, note ?? null);
}

export async function getBalance(userId: string): Promise<number> {
  const { sql } = await import("@/db");
  const rows = await sql<{ credits: number }>(
    `SELECT credits::float AS credits FROM profiles WHERE user_id = $1`, [userId]);
  return Number(rows[0]?.credits ?? 0);
}
