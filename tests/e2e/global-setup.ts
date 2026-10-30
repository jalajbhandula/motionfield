import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/** Apply db/migrations/*.sql to the test database before the dev server starts. */
export default function globalSetup() {
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    stdio: "inherit",
    env: {
      ...process.env,
      PGLITE_DIR: process.env.PGLITE_DIR || path.join(tmpdir(), "motionfield-e2e-pglite"),
      DATABASE_URL: "",
    },
  });
}
