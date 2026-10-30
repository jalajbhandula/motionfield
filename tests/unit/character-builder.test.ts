import { describe, expect, it } from "vitest";
import {
  CANDIDATE_ENDPOINT, IDENTITY_SHOTS, MAX_SET, CHARACTER_STYLES, SHOT_ENDPOINT,
  candidatePrompt, refName, shotPrompt, styleOf,
} from "@/lib/character-builder";
import { findEndpoint } from "@/lib/catalog/video-models";

describe("character builder", () => {
  it("uses real local endpoints that take what we send", () => {
    const cand = findEndpoint(CANDIDATE_ENDPOINT)!;
    expect(cand.workflow.params.map((p) => p.name)).toEqual(expect.arrayContaining(["prompt", "aspect_ratio", "batch_size", "steps", "seed"]));
    expect(cand.workflow.params.find((p) => p.name === "batch_size")?.enum).toContain(4);
    const shot = findEndpoint(SHOT_ENDPOINT)!;
    expect(shot.workflow.params.map((p) => p.name)).toEqual(expect.arrayContaining(["prompt", "image_url", "steps", "seed"]));
  });

  it("the set fits in one ref with the anchor", () => {
    expect(IDENTITY_SHOTS.length + 1).toBeLessThanOrEqual(MAX_SET);
    expect(new Set(IDENTITY_SHOTS.map((s) => s.id)).size).toBe(IDENTITY_SHOTS.length);
  });

  it("candidate prompt carries description, style and outfit", () => {
    const p = candidatePrompt({ description: "  a woman with copper hair\n and freckles ", style: "anime", outfit: "a yellow raincoat" });
    expect(p).toMatch(/^Anime illustration, character portrait of a woman with copper hair and freckles, wearing a yellow raincoat\./);
    expect(p).toMatch(/facing the camera/);
    expect(candidatePrompt({ description: "x", style: "nope" })).toMatch(/^Studio portrait photograph/);
  });

  it("shot prompts lock identity; outfit only where the body shows", () => {
    const d = { description: "a man", style: "cinematic", outfit: "a navy peacoat" };
    for (const s of IDENTITY_SHOTS) {
      const p = shotPrompt(d, s);
      expect(p).toMatch(/^The same person as in the reference image - identical face/);
      expect(p).toMatch(/film grain/);
      expect(p.includes("navy peacoat")).toBe(!!s.needsOutfit);
    }
    expect(shotPrompt({ description: "a", style: "photo" }, IDENTITY_SHOTS.find((s) => s.id === "full-body")!)).toMatch(/outfit that suits them/);
  });

  it("names slug like the refs API", () => {
    expect(refName("Rosa Vale!")).toBe("rosa-vale");
    expect(refName("  ")).toBe("");
    expect(styleOf("3d").label).toBe("3D character");
    expect(CHARACTER_STYLES.length).toBeGreaterThanOrEqual(4);
  });
});
