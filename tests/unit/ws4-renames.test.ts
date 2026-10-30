import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { APPS } from "@/lib/catalog/presets/apps";
import { EFFECT_PRESETS } from "@/lib/catalog/presets/effects";
import { STYLE_PRESETS } from "@/lib/catalog/presets/styles";
import { NAV_ENTRIES } from "@/lib/nav";
import { IMAGE_MODELS } from "@/lib/catalog/image-models";
import { RE_EDIT, RE_EDIT_FLOWS, RESTYLE_PRESET_IDS } from "@/lib/catalog/video/swap";

const ROOT = path.join(__dirname, "..", "..");
const flat = NAV_ENTRIES.flatMap((e) => [e, ...(e.children ?? [])]);
const imageParamNames = new Set(
  IMAGE_MODELS.flatMap((m) => m.workflows.flatMap((w) => w.params.map((p) => p.name))));

describe("ws4 renames", () => {
  it("product-ads + campaigns exist; the old routes are gone", () => {
    expect(existsSync(path.join(ROOT, "src/app/product-ads/page.tsx"))).toBe(true);
    expect(existsSync(path.join(ROOT, "src/app/campaigns/page.tsx"))).toBe(true);
    expect(existsSync(path.join(ROOT, "src/app/ads-studio"))).toBe(false);
    expect(existsSync(path.join(ROOT, "src/app/marketing-studio"))).toBe(false);
    // no owned link still points at the old routes
    expect(APPS.some((a) => a.href.includes("ads-studio") || a.href.includes("marketing-studio"))).toBe(false);
    expect(flat.some((e) => e.href.includes("ads-studio") || e.href.includes("marketing-studio"))).toBe(false);
  });

  it("app tiles carry the renamed slugs and the removed one", () => {
    const ids = APPS.map((a) => a.slug);
    for (const id of ["lead-swap", "outfit-try-on", "skin-retouch", "sparkle-sticker", "plush-toy", "making-of-stills", "url-to-ad"])
      expect(ids).toContain(id);
    const urlToAd = APPS.find((a) => a.slug === "url-to-ad")!;
    expect(urlToAd.href).toBe("/product-ads");
  });

  it("effect tiles carry the renamed ids", () => {
    const ids = EFFECT_PRESETS.map((p) => p.id);
    for (const id of ["torn-paper", "world-keeps-moving", "floor-glide", "heat-blink", "liquify", "paper-ride"])
      expect(ids).toContain(id);
  });

  it("image params expose only what the graphs consume", () => {
    // ws4 s3b removed the dead controls - persona/strength/auto-prompt never
    // reached a graph input, so offering them was dishonest
    for (const dead of ["persona_id", "persona_strength", "look_strength", "auto_prompt", "image_reference_url"])
      expect(imageParamNames.has(dead)).toBe(false);
    // look_id stays declared - the UI lists only verified look presets
    expect(imageParamNames.has("look_id")).toBe(true);
    expect(STYLE_PRESETS.every((p) => (p.apply as Record<string, unknown>).look_id === p.id)).toBe(true);
  });

  it("re-edit entry: steps declared with no default (blank = the flow graph's own), preset_id enums only the RESTYLE ids", () => {
    const wf = RE_EDIT.workflows[0];
    expect(wf.params.map((p) => p.name)).toEqual(
      expect.arrayContaining(["video_url", "flow", "image_urls", "instructions", "preset_id", "resolution", "steps", "windows"]));
    const steps = wf.params.find((p) => p.name === "steps");
    expect(steps?.type).toBe("integer");
    // no declared default - filling one would override each flow graph's own
    expect(steps?.default).toBeUndefined();
    const preset = wf.params.find((p) => p.name === "preset_id");
    expect(preset?.enum).toEqual([...RESTYLE_PRESET_IDS]);
    // every advertised restyle preset exists in the effect catalog
    expect(RESTYLE_PRESET_IDS.every((id) => EFFECT_PRESETS.some((p) => p.id === id))).toBe(true);
    expect(RE_EDIT_FLOWS).toEqual(["character-swap", "motion-transfer", "restyle"]);
  });

  it("[OF-0905] nav: six top-level entries; tools under Studio tools; api+mcp merged", () => {
    const top = NAV_ENTRIES.filter((e) => e.ready);
    expect(top.map((e) => e.label)).toEqual(["Image", "Video", "Audio", "Studio tools", "AI Assistant", "Developers"]);
    const studio = NAV_ENTRIES.find((e) => e.label === "Studio tools")!;
    const kids = studio.children!.map((c) => c.label);
    for (const l of ["Edit Video", "Remove Background", "Camera Control", "Image Editor", "Canvas", "Product Ads", "Campaign Kit", "Effects", "Game Builder"])
      expect(kids).toContain(l);
    for (const l of ["Re-edit Video", "Character Studio", "Visual Effects", "New Camera Move", "Motion Graphics"])
      expect(kids).not.toContain(l);
    const hrefs = studio.children!.filter((c) => c.ready).map((c) => c.href);
    expect(hrefs).toEqual(expect.arrayContaining(["/object-swap", "/restyle"]));
    const api = NAV_ENTRIES.find((e) => e.label === "Developers")!;
    expect(api.href).toBe("/mcp");
    expect(api.children!.map((c) => c.href)).toContain("/docs/api");
  });
});
