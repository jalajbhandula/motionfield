/**
 * models/manifest.json - generated weight/component inventory with licenses.
 * Shape checks + coherence with the license tables; byte sizes come from the
 * committed HF cache (models/hf-sizes.json) so tests never assert them.
 */
import { describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { WEIGHT_LICENSES, RECIPE_LICENSES } from "@/lib/catalog/licenses";
import type { Manifest } from "../../scripts/gen-manifest";

async function readManifest(): Promise<Manifest> {
  return JSON.parse(await fs.readFile(path.join(process.cwd(), "models", "manifest.json"), "utf8")) as Manifest;
}

describe("models/manifest.json", () => {
  it("exists and is well-formed", async () => {
    const m = await readManifest();
    expect(m.version).toBe("of-licenses-v1");
    // the tracked file must not carry a machine-local path or install state
    expect("models_dir" in m).toBe(false);
    expect(JSON.stringify(m)).not.toMatch(/\/Users\/|^[A-Z]:\\|\/home\//);
    for (const r of m.weights) expect("installed" in r, r.name).toBe(false);
    expect(m.totals.count).toBe(m.weights.length);
    expect(m.totals.bytes).toBe(m.weights.reduce((s, r) => s + (r.bytes ?? 0), 0));
    const names = m.weights.map((w) => w.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("carries a recipes array mirroring RECIPE_LICENSES", async () => {
    const m = await readManifest();
    expect(m.recipes.map((r) => r.name).sort()).toEqual(Object.keys(RECIPE_LICENSES).sort());
    for (const r of m.recipes) expect(r.class).toBe(RECIPE_LICENSES[r.name].class);
  });

  it("every WEIGHT_LICENSES entry has a manifest row carrying the same license data", async () => {
    const m = await readManifest();
    const byName = new Map(m.weights.map((r) => [r.name, r]));
    for (const [name, e] of Object.entries(WEIGHT_LICENSES)) {
      const row = byName.get(name);
      expect(row, name).toBeDefined();
      expect(row?.license).toBe(e.license);
      expect(row?.class).toBe(e.class);
      expect(row?.url).toBe(e.url);
    }
  });

  it("every row has a source URL and a valid class", async () => {
    const m = await readManifest();
    const classes = new Set(["open", "restricted", "banned", "banned-known"]);
    for (const r of m.weights) {
      expect(classes.has(r.class), `${r.name}: ${r.class}`).toBe(true);
      // unlisted placeholders (recipe stubs) have no URL until they ship;
      // in-repo components cite the repo's LICENSE file
      expect(r.url?.startsWith("http") || r.license === "unlisted" || r.url === "LICENSE", r.name).toBe(true);
      expect(Array.isArray(r.workflows)).toBe(true);
    }
  });

  it("non-open rows mirror the license table exactly", async () => {
    const m = await readManifest();
    for (const [name, e] of Object.entries(WEIGHT_LICENSES).filter(([, x]) => x.class !== "open"))
      expect(m.weights.find((r) => r.name === name)?.class, name).toBe(e.class);
    // every non-open row is either a declared weight or a recipe/component attribution
    for (const r of m.weights.filter((x) => x.class !== "open"))
      expect(Object.hasOwn(WEIGHT_LICENSES, r.name) || r.name.includes("recipe") || r.url.startsWith("http"), r.name).toBe(true);
    expect(m.weights.find((r) => r.name === "ltx-video-2b-v0.9.5.safetensors")?.class).toBe("restricted");
    // the face-parse BiSeNet row is gone entirely, and no banned-known row
    // is reachable - controlnet_aux stays declared as a class fallback for
    // override graphs, but no shipped workflow uses it (empty workflows:)
    expect(m.weights.find((r) => r.name === "face-parse BiSeNet 79999_iter.pth")).toBeUndefined();
    for (const r of m.weights.filter((x) => x.class === "banned-known"))
      expect(r.workflows, r.name).toEqual([]);
  });
});
