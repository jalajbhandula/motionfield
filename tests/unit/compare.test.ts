import { describe, expect, it } from "vitest";
import { IMAGE_MODELS } from "@/lib/catalog/image-models";
import { VIDEO_MODELS } from "@/lib/catalog/video-models";
import { COMPARE_MODES, commonAspects, compareCandidates, compareParams, type CompareMode } from "@/lib/compare";

const ALL = [...IMAGE_MODELS, ...VIDEO_MODELS];

describe("compare · candidates", () => {
  it("text → image offers the local text-to-image models", () => {
    const ids = compareCandidates(ALL, "image").map((c) => c.id);
    expect(ids).toContain("motionfield/z-image-turbo/text-to-image");
    expect(ids).toContain("motionfield/flux2-klein/text-to-image");
    // needs reference images - not a text-only workflow
    expect(ids).not.toContain("motionfield/character/generate");
  });

  it("every mode has at least two candidates and each one's required inputs are covered", () => {
    for (const mode of Object.keys(COMPARE_MODES) as CompareMode[]) {
      const cs = compareCandidates(ALL, mode);
      expect(cs.length, mode).toBeGreaterThanOrEqual(2);
      const inputs: readonly string[] = COMPARE_MODES[mode].inputs;
      for (const c of cs) {
        const wf = ALL.flatMap((m) => m.workflows).find((w) => w.endpointId === c.id)!;
        for (const p of wf.params.filter((x) => x.required)) expect(inputs, `${c.id} needs ${p.name}`).toContain(p.name);
      }
    }
  });

  it("text → video excludes image-to-video workflows", () => {
    const cs = compareCandidates(ALL, "video");
    expect(cs.every((c) => !c.accepts.includes("image_url") || c.id === "motionfield/director/generate")).toBe(true);
  });
});

describe("compare · shared params", () => {
  const c = { accepts: ["prompt", "seed", "aspect_ratio"], aspects: ["1:1", "16:9"] };
  it("sends only what a workflow accepts", () => {
    expect(compareParams(c, { prompt: "p", image_url: "/files/x.png", seed: 7, aspect_ratio: "16:9" }))
      .toEqual({ prompt: "p", seed: 7, aspect_ratio: "16:9" });
    expect(compareParams({ accepts: ["prompt"], aspects: [] }, { prompt: "p", seed: 7, aspect_ratio: "16:9" })).toEqual({ prompt: "p" });
    expect(compareParams(c, { prompt: "p", aspect_ratio: "21:9" })).toEqual({ prompt: "p" });
  });

  it("offers only aspects every aspect-capable pick supports", () => {
    expect(commonAspects([{ aspects: ["1:1", "16:9", "9:16"] }, { aspects: ["16:9", "1:1"] }, { aspects: [] }])).toEqual(["1:1", "16:9"]);
    expect(commonAspects([{ aspects: [] }])).toEqual([]);
  });
});
