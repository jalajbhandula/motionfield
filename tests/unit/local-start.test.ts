import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(".");
const dirs: string[] = [];

function fixture(installed: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "motionfield-launch-test-"));
  dirs.push(dir);
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "bin"));
  copyFileSync(join(root, "start.sh"), join(dir, "start.sh"));
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  for (const name of ["migrate", "seed"]) {
    writeFileSync(join(dir, "scripts", `${name}.ts`),
      `console.log("${name}:" + (process.env.PGLITE_DIR || "") + ":" + (process.env.DATABASE_URL || ""));\n`);
  }
  if (installed) {
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "next"), "", { mode: 0o755 });
    writeFileSync(join(dir, "node_modules", ".modules.yaml"), "");
  }
  writeFileSync(join(dir, "bin", "pnpm"),
    '#!/bin/sh\nprintf "pnpm:%s provider:%s\\n" "$*" "${GENERATION_PROVIDER:-}"\n',
    { mode: 0o755 });
  writeFileSync(join(dir, "bin", "npm"), '#!/bin/sh\necho "unexpected npm invocation" >&2\nexit 2\n', { mode: 0o755 });
  writeFileSync(join(dir, "bin", "npx"), '#!/bin/sh\necho "unexpected npx invocation" >&2\nexit 2\n', { mode: 0o755 });
  writeFileSync(join(dir, ".env"), "DATABASE_URL=postgres://motionfield:motionfield@127.0.0.1:5432/motionfield\n");
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` };
  for (const key of ["DATABASE_URL", "PGLITE_DIR", "GENERATION_PROVIDER", "PORT", "MOTIONFIELD_DIST_DIR"]) delete env[key];
  return { dir, env };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("local launcher", () => {
  it("uses the checked-in pnpm lockfile for a fresh installation", () => {
    const { dir, env } = fixture(false);
    const output = execFileSync("sh", ["start.sh"], { cwd: dir, env, encoding: "utf8" });
    expect(output).toContain("pnpm:install --frozen-lockfile");
    expect(output).toContain("pnpm:exec next start -p 3000 provider:mock");
  });

  it("loads database and provider settings while preserving explicit overrides", () => {
    const { dir, env } = fixture(true);
    writeFileSync(join(dir, ".env"), "DATABASE_URL=postgres://motionfield:motionfield@127.0.0.1:5432/custom\nGENERATION_PROVIDER=comfy\n");
    const output = execFileSync("sh", ["start.sh", "--port", "4444"], { cwd: dir, env, encoding: "utf8" });
    expect(output).toContain("migrate::postgres://motionfield:motionfield@127.0.0.1:5432/custom");
    expect(output).toContain("seed::postgres://motionfield:motionfield@127.0.0.1:5432/custom");
    expect(output).toContain("pnpm:exec next start -p 4444 provider:comfy");
    writeFileSync(join(dir, ".env.local"), "DATABASE_URL=postgres://motionfield:motionfield@127.0.0.1:5432/local\nGENERATION_PROVIDER=mock\n");
    const local = execFileSync("sh", ["start.sh"], { cwd: dir, env, encoding: "utf8" });
    expect(local).toContain("migrate::postgres://motionfield:motionfield@127.0.0.1:5432/local");
    expect(local).toContain("seed::postgres://motionfield:motionfield@127.0.0.1:5432/local");
    expect(local).toContain("provider:mock");
    const overridden = execFileSync("sh", ["start.sh", "--provider", "comfy"], { cwd: dir, env, encoding: "utf8" });
    expect(overridden).toContain("provider:comfy");
  });

  it("rebuilds when a stylesheet changes after the previous build", () => {
    const { dir, env } = fixture(true);
    mkdirSync(join(dir, ".next"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, ".next", "BUILD_ID"), "previous build");
    const css = join(dir, "src", "style.css");
    writeFileSync(css, "body { color: white; }");
    const newer = new Date(Date.now() + 2000);
    utimesSync(css, newer, newer);
    const output = execFileSync("sh", ["start.sh"], { cwd: dir, env, encoding: "utf8" });
    expect(output).toContain("pnpm:run build");
  });

  it("checks the configured build directory rather than the default", () => {
    const { dir, env } = fixture(true);
    mkdirSync(join(dir, ".next"));
    writeFileSync(join(dir, ".next", "BUILD_ID"), "default build");
    env.MOTIONFIELD_DIST_DIR = ".next-custom";
    const output = execFileSync("sh", ["start.sh"], { cwd: dir, env, encoding: "utf8" });
    expect(output).toContain("pnpm:run build");
  });
});

describe("database seeding", () => {
  it("seeds the same custom PGlite directory that migrations use", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motionfield-seed-test-"));
    dirs.push(dir);
    mkdirSync(join(dir, "db"));
    symlinkSync(join(root, "db", "migrations"), join(dir, "db", "migrations"));
    const dbDir = join(dir, "custom-db");
    const env = { ...process.env, PGLITE_DIR: dbDir, DATABASE_URL: "" };
    execFileSync(process.execPath, ["--experimental-strip-types", join(root, "scripts", "migrate.ts")], { cwd: dir, env });
    execFileSync(process.execPath, ["--experimental-strip-types", join(root, "scripts", "seed.ts")], { cwd: dir, env });
    execFileSync(process.execPath, ["--experimental-strip-types", join(root, "scripts", "seed.ts")], { cwd: dir, env });
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite(dbDir);
    try {
      const rows = await db.query<{ code: string }>("SELECT code FROM promocodes ORDER BY code");
      expect(rows.rows.map((row) => row.code)).toEqual(["CREATOR500", "TEAMUP", "WELCOME100"]);
    } finally {
      await db.close();
    }
  }, 30_000);
});
