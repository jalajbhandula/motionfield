import * as schema from "./schema";

// Singletons anchor on `process` (shared across every module context in one
// Node process) rather than globalThis - dev HMR re-evaluates modules, and
// without a cached in-flight promise concurrent first calls would each open
// their own PGlite on the same datadir (silent split-brain: each caller keeps
// the instance it was handed, so writes on one are invisible to the other).
const g = process as unknown as { __ofDb?: any; __ofDbPromise?: Promise<any>; __ofEngine?: "pg" | "pglite" | null };

/**
 * Database engine selection:
 * - DATABASE_URL set  -> node-postgres (Docker Postgres)
 * - PGLITE_DIR set    -> the in-process database the test suite isolates with
 * - otherwise         -> refuse, so a dev run cannot open a second database
 */
export async function getDb() {
  if (g.__ofDb) return g.__ofDb;
  // In-flight dedup: without this, concurrent first calls each open their own
  // PGlite on the same datadir - a silent split-brain (each caller keeps the
  // instance it was handed, so writes on one are invisible to the other).
  g.__ofDbPromise ??= (async () => {
    const url = process.env.DATABASE_URL?.trim();
    if (url) {
      const { Pool } = await import("pg");
      const { drizzle } = await import("drizzle-orm/node-postgres");
      const pool = new Pool({ connectionString: url, max: 10 });
      g.__ofDb = drizzle(pool, { schema });
      g.__ofEngine = "pg";
    } else if (process.env.PGLITE_DIR?.trim()) {
      const { mkdirSync } = await import("node:fs");
      const dir = process.env.PGLITE_DIR.trim();
      mkdirSync(dir, { recursive: true });
      const { PGlite } = await import("@electric-sql/pglite");
      const { drizzle } = await import("drizzle-orm/pglite");
      const client = new PGlite(dir);
      g.__ofDb = drizzle(client, { schema });
      g.__ofEngine = "pglite";
    } else {
      throw new Error("DATABASE_URL is not set. Start Postgres with: docker compose up -d db");
    }
    return g.__ofDb;
  })().catch((e) => {
    // A failed init must not be cached forever - the next call retries.
    g.__ofDbPromise = undefined;
    throw e;
  });
  return g.__ofDbPromise;
}

export function dbEngine() {
  return g.__ofEngine ?? null;
}

/** Execute raw SQL (migrations, advisory/SKIP-LOCKED queue ops). */
export async function sql<T = any>(query: string, params: unknown[] = []) {
  const db = await getDb();
  const isPg = g.__ofEngine === "pg";
  if (isPg) {
    const client = (db as any).$client as import("pg").Pool;
    const res = await client.query(query, params as any[]);
    return res.rows as T[];
  }
  const client = (db as any).$client as import("@electric-sql/pglite").PGlite;
  const res = await client.query(query, params as any[]);
  return res.rows as T[];
}

/** Run a function inside a transaction; works for both engines. */
export async function tx<T>(fn: (q: (query: string, params?: unknown[]) => Promise<any[]>) => Promise<T>): Promise<T> {
  const db = await getDb();
  if (g.__ofEngine === "pg") {
    const pool = (db as any).$client as import("pg").Pool;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const q = async (query: string, params: unknown[] = []) =>
        (await client.query(query, params as any[])).rows;
      const out = await fn(q);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  const client = (db as any).$client as import("@electric-sql/pglite").PGlite;
  return client.transaction(async (t) => {
    const q = async (query: string, params: unknown[] = []) =>
      (await t.query(query, params as any[])).rows;
    return fn(q);
  });
}

export { schema };
