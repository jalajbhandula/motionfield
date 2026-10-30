import { describe, expect, it } from "vitest";
import {
  DUB_ENDPOINT, DUB_LANGUAGES, MAX_TEMPO, baseVoice, dubSrt, fitPlan, languageOf, medianPitch,
  segmentWords, translationMessages,
} from "@/lib/dub";
import { findEndpoint } from "@/lib/catalog/video-models";
import { RECIPES } from "@/lib/generation/recipes";
import { RECIPE_LICENSES } from "@/lib/catalog/licenses";

const W = (text: string, start: number, end: number) => ({ text, start, end });
const tone = (hz: number, rate = 16000, sec = 1) =>
  Float32Array.from({ length: rate * sec }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate) + 0.2 * Math.sin((4 * Math.PI * hz * i) / rate));

describe("dub - planning", () => {
  it("splits words on pauses and sentence ends, joins punctuation", () => {
    const segs = segmentWords([
      W("Hello", 0, 0.4), W("there", 0.45, 0.8), W(",", 0.8, 0.82), W("friend.", 0.9, 1.6),
      W("This", 1.7, 1.9), W("is", 1.95, 2.0), W("next", 2.1, 2.4),
      W("After", 3.5, 3.8), W("the", 3.85, 3.9), W("pause", 3.95, 4.4),
    ]);
    expect(segs.map((s) => s.text)).toEqual(["Hello there, friend.", "This is next", "After the pause"]);
    expect(segs[2]).toMatchObject({ start: 3.5, end: 4.4 });
  });

  it("long monologues break before 9 s", () => {
    const words = Array.from({ length: 40 }, (_, i) => W(`w${i}`, i * 0.4, i * 0.4 + 0.35));
    const segs = segmentWords(words);
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) expect(s.end - s.start).toBeLessThanOrEqual(9);
  });

  it("pitch: lower and higher voices, silence", () => {
    expect(medianPitch(tone(120), 16000)).toBeGreaterThan(110);
    expect(medianPitch(tone(120), 16000)).toBeLessThan(130);
    expect(medianPitch(tone(230), 16000)).toBeGreaterThan(215);
    expect(medianPitch(new Float32Array(16000), 16000)).toBe(0);
    const es = languageOf("es")!;
    expect(baseVoice(es, "auto", 120)).toBe("em_alex");
    expect(baseVoice(es, "auto", 230)).toBe("ef_dora");
    expect(baseVoice(es, "auto", 0)).toBe("ef_dora");
    expect(baseVoice(es, "male", 300)).toBe("em_alex");
  });

  it("fit: short lines keep their start, long lines speed up, overflow pushes the next line", () => {
    const segs = [{ start: 0, end: 2, text: "a" }, { start: 2.5, end: 4, text: "b" }, { start: 4.2, end: 6, text: "c" }];
    const plan = fitPlan(segs, [1.5, 3, 1], 8);
    expect(plan[0]).toMatchObject({ start: 0, tempo: 1, length: 1.5 });
    expect(plan[1].tempo).toBe(MAX_TEMPO);
    expect(plan[1].start).toBe(2.5);
    expect(plan[2].start).toBeGreaterThan(4.2); // line b still ran over its slot
    expect(plan[2].start).toBeCloseTo(2.5 + 3 / MAX_TEMPO + 0.08, 2);
  });

  it("translation prompt numbers every line and names the language", () => {
    const m = translationMessages(["Hi.", "Bye."], languageOf("ja")!);
    expect(m[0].content).toMatch(/into Japanese/);
    expect(m[1].content).toBe("1. Hi.\n2. Bye.");
  });

  it("srt follows the placement timing", () => {
    expect(dubSrt(["Hola", "Adiós"], [{ start: 0.5, tempo: 1, length: 1.25 }, { start: 61, tempo: 1, length: 2 }]))
      .toBe("1\n00:00:00,500 --> 00:00:01,750\nHola\n\n2\n00:01:01,000 --> 00:01:03,000\nAdiós\n");
  });
});

describe("dub - catalog", () => {
  const ep = findEndpoint(DUB_ENDPOINT)!;
  const ok = { video_url: "/files/uploads/x.mp4", language: "es", likeness_consent: true };

  it("is a recipe job with an open licence", () => {
    expect(ep.workflow.providers.recipe?.name).toBe("dub");
    expect(RECIPES.dub).toBeTypeOf("function");
    expect(RECIPE_LICENSES.dub.class).toBe("open");
    expect(DUB_LANGUAGES.map((l) => l.id)).toEqual(ep.workflow.params.find((p) => p.name === "language")?.enum);
  });

  it("validate: consent first, then language and volume", () => {
    expect(ep.workflow.validate!(ok)).toBeNull();
    expect(ep.workflow.validate!({ ...ok, likeness_consent: false })).toBe("likeness consent required");
    expect(ep.workflow.validate!({ ...ok, language: "de" })).toMatch(/language/);
    expect(ep.workflow.validate!({ ...ok, original_volume: 0.9 })).toMatch(/original_volume/);
  });
});
