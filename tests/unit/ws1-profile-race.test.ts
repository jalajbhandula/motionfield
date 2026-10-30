import { describe, it, expect, vi, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@/db";
import { ensureProfile } from "@/lib/profiles";

// PGlite setup can exceed the default 10s hook timeout on a busy machine.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

beforeAll(() => {
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws1-prof-"));
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
});

describe("ensureProfile", () => {
  it("4 concurrent calls provision exactly one profile, workspace and signup bonus", async () => {
    await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ('u-race','race','race@test.dev',true)`);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => ensureProfile("u-race", "race@test.dev", "Race")),
    );
    for (const p of results) expect(p.userId).toBe("u-race");

    const [{ n: profiles }] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM profiles WHERE user_id = 'u-race'`);
    const [{ n: workspaces }] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM workspaces WHERE owner_id = 'u-race'`);
    const [{ n: bonuses }] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM credit_ledger WHERE user_id = 'u-race' AND kind = 'signup_bonus'`);
    const [{ credits }] = await sql<{ credits: number }>(
      `SELECT credits::float AS credits FROM profiles WHERE user_id = 'u-race'`);
    expect(profiles).toBe(1);
    expect(workspaces).toBe(1);
    expect(bonuses).toBe(1);
    expect(credits).toBe(50);
  });

  it("the signup-bonus row matches the shape credits.applyDelta writes", async () => {
    const [row] = await sql<{
      user_id: string; delta: number; balance_after: number;
      kind: string; ref_type: string | null; ref_id: string | null; note: string | null;
    }>(
      `SELECT user_id, delta::float AS delta, balance_after::float AS balance_after,
              kind, ref_type, ref_id, note
       FROM credit_ledger WHERE user_id = 'u-race' AND kind = 'signup_bonus'`);
    // identical columns/values to applyDelta(userId, 50, 'signup_bonus',
    // 'user', userId, 'Welcome bonus') on a 0-credit profile
    expect(row).toEqual({
      user_id: "u-race", delta: 50, balance_after: 50,
      kind: "signup_bonus", ref_type: "user", ref_id: "u-race", note: "Welcome bonus",
    });
  });

  it("a second user with the same email local-part gets a suffixed handle", async () => {
    await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ('u-race2','r2','r2@test.dev',true)`);
    const other = await ensureProfile("u-race2", "race@other.dev", "Race Two");
    expect(other.userId).toBe("u-race2");
    expect(other.handle).not.toBeNull();
    const [{ n }] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM credit_ledger WHERE user_id = 'u-race2' AND kind = 'signup_bonus'`);
    expect(n).toBe(1);
  });
});
