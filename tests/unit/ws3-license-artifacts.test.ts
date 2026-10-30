/**
 * Artifact freshness - checkArtifacts() rebuilds the generated license map,
 * docs/LICENSES.md and models/manifest.json in memory and diffs against the
 * committed files. Nothing is written; a stale artifact is reported, not fixed.
 */
import { describe, expect, it } from "vitest";
import { checkArtifacts, licensesDocText } from "../../scripts/license-audit";
import { WORKFLOW_LICENSES } from "@/lib/catalog/licenses.generated";
import { promises as fs } from "fs";
import path from "path";

describe("license artifacts", () => {
  it("committed artifacts are fresh", async () => {
    const { ok, stale } = await checkArtifacts();
    expect(stale).toEqual([]);
    expect(ok).toBe(true);
  });

  it("the doc text changes when the license map changes - staleness is detectable", async () => {
    const committed = await fs.readFile(path.join(process.cwd(), "docs", "LICENSES.md"), "utf8");
    expect(committed).toBe(licensesDocText());
    // the doc is a pure function of the maps - a new restricted entry must appear
    const probe = { class: "restricted" as const, components: [{ name: "probe-model.safetensors", license: "Test-Only", class: "restricted" as const, url: "https://example.com" }] };
    (WORKFLOW_LICENSES as Record<string, typeof probe>)["__probe.json"] = probe;
    try {
      const mutated = licensesDocText();
      expect(mutated).not.toBe(committed);
      expect(mutated).toContain("probe-model.safetensors");
      expect(mutated).toContain("__probe.json");
    } finally {
      delete (WORKFLOW_LICENSES as Record<string, typeof probe>)["__probe.json"];
    }
  });
});
