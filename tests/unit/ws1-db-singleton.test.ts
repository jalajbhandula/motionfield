import { describe, it, expect, vi, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getDb, sql, schema } from "@/db";

// PGlite setup can exceed the default 10s hook timeout on a busy machine.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

beforeAll(() => {
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws1-dbsingle-"));
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
});

describe("getDb singleton", () => {
  it("dedupes concurrent first calls onto one instance", async () => {
    const [a, b, c] = await Promise.all([getDb(), getDb(), getDb()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("a row written through sql() is visible to db.select()", async () => {
    await sql(`INSERT INTO "user" (id, name, email, email_verified)
               VALUES ('u-singleton','sg','sg@test.dev',true)`);
    const db = await getDb();
    const rows = await db.select().from(schema.user).where(eq(schema.user.id, "u-singleton"));
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("sg@test.dev");
  });
});
