/* Idempotent migration runner: applies db/migrations/*.sql in order,
   tracked in the _migrations table. Works against DATABASE_URL (pg)
   or the test directory in PGLITE_DIR. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Load .env only when the caller did not already choose a database.
// Tests set PGLITE_DIR themselves and must not inherit the developer's Postgres.
function loadEnvIfUnset() {
  if (process.env.DATABASE_URL?.trim() || process.env.PGLITE_DIR?.trim()) return;
  for (const path of [".env.local", ".env"]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}
loadEnvIfUnset();

function splitStatements(sqlText: string): string[] {
  // Split on semicolons at end of line; our migrations contain no $$ bodies.
  return sqlText
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function main() {
  const url = process.env.DATABASE_URL;
  let query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>;
  if (url) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url });
    query = async (q, p) => pool.query(q, p as any[]);
  } else if (process.env.PGLITE_DIR?.trim()) {
    const { mkdirSync } = await import("node:fs");
    const dir = process.env.PGLITE_DIR.trim();
    mkdirSync(dir, { recursive: true });
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite(dir);
    query = async (q, p) => db.query(q, p as any[]);
  } else {
    throw new Error("DATABASE_URL is not set. Start Postgres with: docker compose up -d db");
  }

  await query(`CREATE TABLE IF NOT EXISTS _migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const dir = join(process.cwd(), "db/migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const { rows } = await query("SELECT name FROM _migrations WHERE name = $1", [f]);
    if (rows.length) { console.log(`skip  ${f}`); continue; }
    console.log(`apply ${f}`);
    const stmts = splitStatements(readFileSync(join(dir, f), "utf8"));
    await query("BEGIN");
    try {
      for (const s of stmts) await query(s);
      await query("INSERT INTO _migrations (name) VALUES ($1)", [f]);
      await query("COMMIT");
    } catch (e) {
      await query("ROLLBACK");
      throw e;
    }
  }
  console.log("migrations complete");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
