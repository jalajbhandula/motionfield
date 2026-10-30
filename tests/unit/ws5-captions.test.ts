import { describe, expect, it } from "vitest";
import {
  assEscape,
  assTime,
  cueText,
  karaokeText,
  srtTime,
  toAss,
  toCues,
  toSrt,
  toVtt,
  wordsFromScript,
} from "@/lib/captions";
import type { Cue, Word } from "@/lib/captions";
import { hudKeyframes, outputDuration, setptsExpr, sourceTimeAt } from "@/lib/render/ramp";

describe("wordsFromScript", () => {
  it("splits on whitespace, marks estimated, every word positive-length", () => {
    const { words, estimated } = wordsFromScript("one two three", 3);
    expect(estimated).toBe(true);
    expect(words.map((w) => w.text)).toEqual(["one", "two", "three"]);
    for (const w of words) expect(w.end).toBeGreaterThan(w.start);
    // no word starts before the previous ends' weight - no zero-length words
    for (let i = 1; i < words.length; i++) expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].end);
  });

  it("punctuation adds a pause - the word after a period starts later", () => {
    const flat = wordsFromScript("aaa bbb ccc", 3).words;
    const punct = wordsFromScript("aaa. bbb ccc", 3).words;
    expect(punct[1].start).toBeGreaterThan(flat[1].start);
  });

  it("overrun scripts don't collapse to zero-length - words just run past duration", () => {
    const { words } = wordsFromScript("a ".repeat(200).trim(), 1);
    expect(words.length).toBeGreaterThan(0);
    for (const w of words) expect(w.end).toBeGreaterThan(w.start);
  });

  it("empty text or non-positive duration → empty word list", () => {
    expect(wordsFromScript("  ", 3).words).toEqual([]);
    expect(wordsFromScript("hello", 0).words).toEqual([]);
  });
});

describe("toCues", () => {
  const W = (t: string, s: number, e: number): Word => ({ text: t, start: s, end: e });

  it("breaks on a >0.35s silence gap", () => {
    const cues = toCues([W("a", 0, 1), W("b", 1.1, 2), W("c", 3, 4)]);
    expect(cues).toHaveLength(2);
    expect(cues[0].words.map((w) => w.text)).toEqual(["a", "b"]);
    expect(cues[1].words.map((w) => w.text)).toEqual(["c"]);
  });

  it("respects the lines×maxChars character budget", () => {
    const words = Array.from({ length: 8 }, (_, i) => W("word" + i, i * 0.4, i * 0.4 + 0.35));
    const cues = toCues(words, { maxChars: 10, lines: 1 });
    expect(cues.length).toBeGreaterThan(1);
    for (const c of cues) {
      expect(c.words.reduce((a, w) => a + w.text.length + 1, -1)).toBeLessThanOrEqual(10);
    }
  });

  it("splits a cue that would exceed maxCue seconds", () => {
    const cues = toCues([W("a", 0, 2), W("b", 2, 4), W("c", 4, 6)], { maxCue: 3 });
    expect(cues.length).toBeGreaterThanOrEqual(2);
    for (const c of cues) expect(c.end - c.start).toBeLessThanOrEqual(3 + 1e-9);
  });
});

describe("ASS/SRT/VTT serializers", () => {
  const cues: Cue[] = [
    { start: 0.5, end: 2.0, words: [{ text: "Hello", start: 0.5, end: 1.2 }, { text: "world", start: 1.2, end: 2.0 }] },
    { start: 3, end: 4, words: [{ text: "again", start: 3, end: 4 }] },
  ];

  it("assTime / srtTime format correctly", () => {
    expect(assTime(3661.234)).toBe("1:01:01.23");
    expect(srtTime(3661.234)).toBe("01:01:01,234");
    expect(srtTime(3661.234, ".")).toBe("01:01:01.234");
  });

  it("karaoke {\\k} centiseconds are cumulative - the last tag ends exactly at cue.end", () => {
    const text = karaokeText(cues[0], { uppercase: false } as never);
    const ks = [...text.matchAll(/\{\\k(\d+)\}/g)].map((m) => Number(m[1]));
    expect(ks).toHaveLength(2);
    // each \k tag is the cs until the next boundary - cumulative, no drift
    expect(ks[0]).toBe(Math.round((1.2 - 0.5) * 100));   // 70 cs to next word
    expect(ks[1]).toBe(Math.round((2.0 - 1.2) * 100));   // 80 cs to cue end
    expect(ks[0] + ks[1]).toBe(Math.round((2.0 - 0.5) * 100));
  });

  it("toAss emits a complete document: header, style, dialogue lines", () => {
    const doc = toAss(cues, { uppercase: true });
    expect(doc).toContain("[Script Info]");
    expect(doc).toContain("Style: Default");
    expect(doc).toContain("Dialogue: 0,0:00:00.50,0:00:02.00");
    expect(doc).toContain("HELLO");
    expect(doc.match(/Dialogue:/g)).toHaveLength(2);
  });

  it("toSrt numbers blocks and uses comma timestamps; toVtt leads with WEBVTT", () => {
    const srt = toSrt(cues);
    expect(srt).toMatch(/^1\n00:00:00,500 --> 00:00:02,000/);
    expect(srt).toContain("2\n00:00:03,000 --> 00:00:04,000");
    const vtt = toVtt(cues);
    expect(vtt).toMatch(/^WEBVTT/);
    expect(vtt).toContain("00:00:00.500 --> 00:00:02.000");
  });

  it("assEscape protects ASS syntax chars", () => {
    expect(assEscape("a{b}c\\d\ne")).toBe("a\\{b\\}c\\\\d\\Ne");
  });

  it("cueText wraps at maxChars honoring the line limit", () => {
    const cue: Cue = { start: 0, end: 5, words: ["aaaaaaaa", "bbbbbbbb", "cccccccc"].map((t, i) => ({ text: t, start: i, end: i + 1 })) };
    const two = cueText(cue, { maxChars: 12, lines: 2, uppercase: false } as never);
    expect(two.split("\n")).toHaveLength(2);
    const one = cueText(cue, { maxChars: 12, lines: 1, uppercase: false } as never);
    expect(one.split("\n")).toHaveLength(1); // overflow stays on the single line
  });
});

describe("speed curve (ramp)", () => {
  it("sourceTimeAt: constant 2× plays 4 source seconds by output 2s", () => {
    const c = [{ t: 0, speed: 2 }];
    expect(sourceTimeAt(c, 2)).toBeCloseTo(4, 10);
    expect(sourceTimeAt(c, 0.5)).toBeCloseTo(1, 10);
  });

  it("outputDuration inverts: 6 source seconds at 2× → 3 output seconds", () => {
    expect(outputDuration([{ t: 0, speed: 2 }], 6)).toBeCloseTo(3, 10);
    // below 1× slows down: 2 source seconds at 0.5× → 4 output seconds
    expect(outputDuration([{ t: 0, speed: 0.5 }], 2)).toBeCloseTo(4, 10);
  });

  it("ramping speed integrates - speed 0.1→2.9 over 2s covers ~3 source seconds", () => {
    const c = [{ t: 0, speed: 0.1 }, { t: 2, speed: 2.9 }];
    // trapezoid: (0.1+2.9)/2 × 2 = 3 source seconds
    expect(sourceTimeAt(c, 2)).toBeCloseTo(3, 6);
    // sourceTimeAt and outputDuration are inverses
    expect(outputDuration(c, 3)).toBeCloseTo(2, 6);
  });

  it("setptsExpr: single constant → PTS/v; multi-point → nested if() ladder", () => {
    expect(setptsExpr([{ t: 0, speed: 2 }])).toBe("PTS/2");
    const expr = setptsExpr([{ t: 0, speed: 2 }, { t: 1, speed: 2 }, { t: 2, speed: 1 }]);
    expect(expr).toContain("if(");
    expect(expr).toContain("between(PTS*TB");
    expect(expr.endsWith("/TB")).toBe(true);
  });

  it("hudKeyframes emits one props.value knot per curve point, clamped to max", () => {
    const kfs = hudKeyframes([{ t: 0, speed: 2 }, { t: 1, speed: 9 }], 5);
    expect(kfs).toHaveLength(2);
    expect(kfs[0]).toMatchObject({ t: 0, path: "props.value", value: 2, ease: "linear" });
    expect(kfs[1].value).toBe(5); // 9 clamps to the dial max
  });
});
