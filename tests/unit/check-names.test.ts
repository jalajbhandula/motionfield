import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../scripts/check-names.mjs");
const TERM = "zzqxydenied";
const dirs: string[] = [];

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "of-names-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}
const gitAdd = (dir: string, ...files: string[]) => execFileSync("git", ["add", ...files], { cwd: dir });
const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex");

function run(dir: string, extra: string[] = []) {
  try {
    const out = execFileSync("node", [SCRIPT, ...extra], {
      cwd: dir,
      env: { ...process.env, OF_DENYLIST: join(dir, "deny.txt") },
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status as number, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("check-names", () => {
  it("exits 2 when the denylist is missing", () => {
    const dir = repo();
    const code = (() => {
      try {
        execFileSync("node", [SCRIPT], { cwd: dir, env: { ...process.env, OF_DENYLIST: join(dir, "nope.txt") } });
        return 0;
      } catch (e: any) {
        return e.status;
      }
    })();
    expect(code).toBe(2);
  });

  it("detects a whole-word hit and reports path:line + term index only", () => {
    const dir = repo();
    writeFileSync(join(dir, "deny.txt"), `# comment\n${TERM}\n`);
    writeFileSync(join(dir, "bad.txt"), `line one\nprefix ${TERM} suffix\n`);
    writeFileSync(join(dir, "ok.txt"), `contains ${TERM}ology which is not whole-word\n`);
    gitAdd(dir, "bad.txt", "ok.txt");
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("bad.txt:2");
    expect(r.out).toContain("term#0");
    expect(r.out).not.toContain(TERM);
    expect(r.out).not.toContain("ok.txt");
  });

  it("honors @allow-in for the listed path only", () => {
    const dir = repo();
    writeFileSync(join(dir, "deny.txt"), `${TERM}\n@allow-in=allowed.txt ${TERM}\n`);
    writeFileSync(join(dir, "allowed.txt"), `this ${TERM} is fine here\n`);
    writeFileSync(join(dir, "notallowed.txt"), `but this ${TERM} is not\n`);
    gitAdd(dir, "allowed.txt", "notallowed.txt");
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("notallowed.txt:1");
    expect(r.out).not.toContain("FAIL allowed.txt");
  });

  it("baseline entries downgrade hits to WARN and are stored as hashes", () => {
    const dir = repo();
    writeFileSync(join(dir, "deny.txt"), `${TERM}\n`);
    writeFileSync(join(dir, "bad.txt"), `the ${TERM} appears\n`);
    gitAdd(dir, "bad.txt");
    // generate the baseline
    run(dir, ["--write-baseline", "base.txt"]);
    const base = readFileSync(join(dir, "base.txt"), "utf8");
    expect(base).toContain(`bad.txt\t${sha1(TERM)}`);
    expect(base).not.toContain(`the ${TERM}`);
    // re-scan with the baseline: warn only
    const r = run(dir, ["--baseline", "base.txt"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("WARN bad.txt:1");
    // a new hit elsewhere still fails
    writeFileSync(join(dir, "fresh.txt"), `another ${TERM}\n`);
    gitAdd(dir, "fresh.txt");
    const r2 = run(dir, ["--baseline", "base.txt"]);
    expect(r2.code).toBe(1);
    expect(r2.out).toContain("FAIL fresh.txt:1");
  });
});
