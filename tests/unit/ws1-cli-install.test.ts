import { describe, it, expect, vi, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * [OF-0820] scripts/install-cli.sh installs the CLI into a $PREFIX without any
 * external dependencies - the only package is the in-repo packages/cli.
 */
describe("[OF-0820] install-cli.sh", () => {
  const prefix = mkdtempSync(join(tmpdir(), "of-cli-prefix-"));
  afterAll(() => rmSync(prefix, { recursive: true, force: true }));

  it("links packages/cli into $PREFIX/bin and the binary runs", () => {
    execFileSync("scripts/install-cli.sh", [], {
      env: { ...process.env, PREFIX: prefix },
      stdio: "pipe",
    });

    const bin = join(prefix, "bin", "motionfield");
    expect(existsSync(bin)).toBe(true);

    // the prefix root must stay clean - `npm link <folder>` used to create
    // $PREFIX/node_modules/{motionfield-cli,.bin,.package-lock.json}
    expect(existsSync(join(prefix, "node_modules"))).toBe(false);

    const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "packages/cli/package.json"), "utf8"));
    expect(version).toBe(`motionfield ${pkg.version}`);

    const help = execFileSync(bin, ["--help"], { encoding: "utf8" });
    expect(help).toContain("generate");

    // the installed package has zero runtime dependencies
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
