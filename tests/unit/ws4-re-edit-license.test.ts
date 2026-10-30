import { describe, it, expect } from "vitest";
import { RE_EDIT, WAN_VACE } from "@/lib/catalog/video/swap";
import { RE_EDIT_ENDPOINT } from "@/lib/re-edit";
import { endpointLicenseFor, RECIPE_LICENSES } from "@/lib/catalog/licenses";

/**
 * ReCut is a recipe endpoint - it ships no Comfy graph of its own. Its
 * license must resolve through RECIPE_LICENSES (the merge of the three VACE
 * flow graphs it drives), never the "no license info" fallback.
 */
describe("re-edit license source", () => {
  it("resolves via the re-edit-assemble recipe, and it is open", () => {
    const wf = RE_EDIT.workflows[0];
    expect(wf.endpointId).toBe(RE_EDIT_ENDPOINT);
    expect(wf.providers.recipe?.name).toBe("re-edit-assemble");
    expect(wf.providers.comfy?.workflow).toBeUndefined();

    const lic = endpointLicenseFor(wf);
    expect(lic).toBe(RECIPE_LICENSES["re-edit-assemble"]);
    expect(lic.class).toBe("open");
    // built from the VACE flow graphs, not an "unlisted" stub
    expect(lic.components.length).toBeGreaterThan(0);
    expect(lic.components.every((c) => c.class !== "restricted" && c.class !== "banned")).toBe(true);
  });

  it("wan-vace character-swap is recipe-backed (person-swap) and resolves open", () => {
    const wf = WAN_VACE.workflows.find((w) => w.id === "character-swap")!;
    // the masked person pipeline - the full-frame vace swap graph is gone
    expect(wf.providers.recipe?.name).toBe("person-swap");
    expect(wf.providers.comfy?.workflow).toBeUndefined();

    const lic = endpointLicenseFor(wf);
    expect(lic).toBe(RECIPE_LICENSES["person-swap"]);
    expect(lic.class).toBe("open");
    // the recipe license covers the person pass + the ref cut-out the
    // char-swap path runs (matte preflight and the person-swap env graphs are
    // person-swap's own - re-edit merges person+refcut+the two vace flow graphs)
    const names = lic.components.map((c) => c.name);
    expect(names).toContain("birefnet.safetensors");
  });
});
