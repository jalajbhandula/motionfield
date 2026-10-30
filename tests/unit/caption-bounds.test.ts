import { describe, expect, it } from "vitest";
import { wordsWithinDuration } from "@/lib/captions/timing";
import { toCues } from "@/lib/captions/group";

describe("caption media bounds", () => {
  it("clips a straddling word and excludes cues beyond the real export", () => {
    const words = wordsWithinDuration([
      { text: "catch", start: 25.8, end: 26.2 },
      { text: "the", start: 26.2, end: 26.51 },
      { text: "sky", start: 26.51, end: 27 },
    ], 26.496);
    expect(words).toEqual([
      { text: "catch", start: 25.8, end: 26.2 },
      { text: "the", start: 26.2, end: 26.496 },
    ]);
    for (const cue of toCues(words)) expect(cue.end).toBeLessThanOrEqual(26.496);
  });

  it("bounds negative offsets without changing valid timing or input data", () => {
    const original = [{ text: "hello", start: -0.1, end: 0.4 }, { text: "world", start: 0.5, end: 1 }];
    expect(wordsWithinDuration(original, 2)).toEqual([{ text: "hello", start: 0, end: 0.4 }, original[1]]);
    expect(original[0].start).toBe(-0.1);
    expect(wordsWithinDuration(original, 0)).toEqual([]);
  });
});
