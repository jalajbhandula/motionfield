/** Seed: demo promocodes + a starter element set. Idempotent. */
import { existsSync, mkdirSync, readFileSync } from "node:fs";

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

async function main() {
  const url = process.env.DATABASE_URL;
  let query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>;
  if (url) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url });
    query = async (q, p) => pool.query(q, p as any[]);
  } else if (process.env.PGLITE_DIR?.trim()) {
    const dir = process.env.PGLITE_DIR.trim();
    mkdirSync(dir, { recursive: true });
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite(dir);
    query = async (q, p) => db.query(q, p as any[]);
  } else {
    throw new Error("DATABASE_URL is not set. Start Postgres with: docker compose up -d db");
  }
  const promos: [string, number, string | null][] = [
    ["WELCOME100", 100, null],
    ["CREATOR500", 500, null],
    ["TEAMUP", 0, "pro"],
  ];
  for (const [code, credits, planId] of promos) {
    await query(
      `INSERT INTO promocodes (code, credits, plan_id) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING`,
      [code, credits, planId]);
  }
  console.log("seeded promocodes:", promos.map((p) => p[0]).join(", "));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
