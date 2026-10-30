import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll } from "vitest";

// Every test file gets its own migrated PGlite dir unless it sets one itself,
// so no test can ever open the developer's ./.data/pglite (which a running
// `next dev` may hold open). Files that set PGLITE_DIR in beforeAll simply
// replace this default; both dirs are removed below.
const isTmpOf = (dir: string) => {
  const abs = resolve(dir);
  return dirname(abs) === resolve(tmpdir()) && basename(abs).startsWith("of-");
};

let defaultDir: string | undefined;
if (!process.env.PGLITE_DIR && !process.env.DATABASE_URL) {
  defaultDir = mkdtempSync(join(tmpdir(), "of-test-"));
  process.env.PGLITE_DIR = defaultDir;
  execFileSync(process.execPath, ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
}

// Many test files point PGLITE_DIR at a fresh mkdtemp dir (~40 MB each).
// Remove it once the file's own hooks have run so repeated suite runs
// don't fill the disk. Registered first, so it runs last ("stack" order).
afterAll(() => {
  for (const dir of new Set([process.env.PGLITE_DIR, defaultDir])) {
    if (dir && isTmpOf(dir)) rmSync(resolve(dir), { recursive: true, force: true });
  }
});
