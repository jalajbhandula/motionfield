/**
 * scripts/license-audit.ts - the graph/catalog scan + restricted-default lint.
 * Fixture trees under tests/fixtures/license-audit/ exercise each finding
 * class in isolation; the repo tree itself must pass --allow-known V2,V3,V4.
 */
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "fs";
import path from "path";

// each test shells out to `npx tsx scripts/license-audit.ts` - 5-12s under
// parallel-suite load, well past the default 5s test timeout.
vi.setConfig({ testTimeout: 60_000 });

const FX = path.join(process.cwd(), "tests/fixtures/license-audit");

function audit(root: string, allow: string[] = [], extra: string[] = []): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", "scripts/license-audit.ts",
      ...(extra.length ? extra : ["--root", root]),
      ...(allow.length ? ["--allow-known", allow.join(",")] : [])],
      { encoding: "utf8", cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    return { code: 0, out };
  } catch (e) {
    const ex = e as { status?: number; stdout?: string; stderr?: string };
    return { code: ex.status ?? 1, out: `${ex.stdout ?? ""}\n${ex.stderr ?? ""}` };
  }
}

describe("license audit", () => {
  it("the repo tree is clean under --allow-known V2,V3,V4 (the defaults swap lands elsewhere)", { timeout: 60_000 }, () => {
    const r = audit(".", ["V2", "V3", "V4"]);
    expect(r.code, r.out.slice(-2000)).toBe(0);
  });

  it("--check diffs the generated artifacts in memory and writes nothing", { timeout: 60_000 }, async () => {
    // a plain or --check run must not touch tracked files - docs/LICENSES.md
    // is only rewritten by --write. --check fails when any generated artifact
    // (licenses.generated.ts, docs/LICENSES.md, models/manifest.json) is stale.
    const doc = path.join(process.cwd(), "docs", "LICENSES.md");
    const before = await fs.readFile(doc, "utf8");
    const r = audit(".", ["V2", "V3", "V4"], ["--check"]);
    expect(r.code, r.out.slice(-2000)).toBe(0);
    expect(await fs.readFile(doc, "utf8")).toBe(before);
  });

  it("clean fixture: V2/V3/V4 findings only - green with allow-known", { timeout: 60_000 }, () => {
    const r = audit(path.join(FX, "clean"), ["V2", "V3", "V4"]);
    expect(r.code, r.out.slice(-1500)).toBe(0);
    const bare = audit(path.join(FX, "clean"));
    expect(bare.code).toBe(1);
    expect(bare.out).toContain("skill default references restricted endpoint");
  });

  it("API/partner node in a graph → V1 (never allow-listed)", { timeout: 60_000 }, () => {
    const r = audit(path.join(FX, "api-node"), ["V2", "V3", "V4"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('"UNETLoader" is an API/partner node'); // api_node flag
    expect(r.out).toContain('"KSampler" is an API/partner node');   // comfy_api_nodes.* python_module
  });

  it("banned weight filename → V1", { timeout: 60_000 }, () => {
    const r = audit(path.join(FX, "banned-weight"), ["V2", "V3", "V4"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("79999_iter.pth");
  });

  it("weight with no table entry → V1", { timeout: 60_000 }, () => {
    const r = audit(path.join(FX, "unlisted-weight"), ["V2", "V3", "V4"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("mystery-weights.safetensors");
    expect(r.out).toContain("WEIGHT_LICENSES");
  });

  it("a lone V2 finding passes only when V2 is allowed", { timeout: 60_000 }, () => {
    const dir = path.join(FX, "v2");
    expect(audit(dir).code).toBe(1);
    expect(audit(dir, ["V2"]).code).toBe(0);
    expect(audit(dir, ["V3"]).code).toBe(1);
  });

  it("a registered recipe without a RECIPE_LICENSES entry → V1", { timeout: 60_000 }, () => {
    const r = audit(path.join(FX, "recipe-no-license"));
    expect(r.code).toBe(1);
    expect(r.out).toContain('recipe "secret-recipe" has no RECIPE_LICENSES entry');
  });

  it("--source-check: clean fixture tree passes and writes the evidence JSON", { timeout: 60_000 }, async () => {
    const out = path.join(await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "of-srcchk-")), "evidence.json");
    const r = execFileSync(
      "npx", ["tsx", "scripts/license-audit.ts", "--source-check",
        "--source-root", path.join(FX, "source-clean"), "--out", out],
      { encoding: "utf8", cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
    );
    expect(r).toContain("clean");
    const ev = JSON.parse(await fs.readFile(out, "utf8"));
    expect(ev.check).toBe("trellis2-nvdiffrast");
    expect(ev.clean).toBe(true);
    expect(ev.hits).toEqual([]);
    expect(ev.filesScanned.length).toBeGreaterThan(0);
    expect(ev.glbExportPath).toContain("nodes_save_3d");
  });

  it("--source-check: nvdiffrast/dynamic-import hits fail non-zero and name the file", { timeout: 60_000 }, () => {
    const out = path.join(process.env.TMPDIR ?? "/tmp", `of-srcchk-dirty-${Date.now()}.json`);
    try {
      execFileSync(
        "npx", ["tsx", "scripts/license-audit.ts", "--source-check",
          "--source-root", path.join(FX, "source-dirty"), "--out", out],
        { encoding: "utf8", cwd: process.cwd(), stdio: "pipe", timeout: 60_000 },
      );
      expect.unreachable("dirty fixture must fail");
    } catch (e) {
      const ex = e as { status?: number; stdout?: string; stderr?: string };
      expect(ex.status).toBe(1);
      expect(`${ex.stdout}\n${ex.stderr}`).toContain("raster.py");
      expect(`${ex.stdout}\n${ex.stderr}`).toContain("nodes_trellis2.py");
    }
  });
});
