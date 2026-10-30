import { describe, expect, it } from "vitest";
import {
  ANALYSIS_RATE, BEAT_CUT_ENDPOINT, analyseBeats, beatCutParamsSchema, cutPoints, framePlan, planEdit, type BeatGrid,
} from "@/lib/beatcut";
import { findEndpoint } from "@/lib/catalog/video-models";
import { RECIPES } from "@/lib/generation/recipes";
import { RECIPE_LICENSES } from "@/lib/catalog/licenses";

/** a drum pattern: a low kick on every 4th beat (from `barAt`), a higher hit on the rest */
function drums(bpm: number, secs: number, barAt = 1, offset = 0.3) {
  const r = ANALYSIS_RATE, n = Math.round(secs * r), x = new Float32Array(n), p = 60 / bpm;
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (let k = 0, t = offset; t < secs; k++, t += p) {
    const a = Math.round(t * r), kick = k % 4 === barAt;
    for (let i = 0; i < r * 0.12 && a + i < n; i++) {
      const env = Math.exp(-i / (r * 0.03));
      x[a + i] += (kick ? 0.9 : 0.35) * env * Math.sin((2 * Math.PI * (kick ? 60 : 200) * i) / r) + 0.08 * env * noise();
    }
  }
  for (let i = 0; i < n; i++) x[i] += 0.01 * noise();
  return x;
}

/** a steady grid without audio, for planning */
const grid = (bpm: number, secs: number, energy: (k: number) => number = () => 0.5, barPhase = 0): BeatGrid => {
  const p = 60 / bpm, beats: number[] = [];
  for (let t = 0.25; t < secs; t += p) beats.push(Math.round(t * 1000) / 1000);
  return { bpm, beats, barPhase, energy: beats.map((_, k) => energy(k)), duration: secs };
};

describe("beat cut - analysis", () => {
  it.each([90, 120, 150])("finds %i BPM, evenly spaced beats and the bar start", (bpm) => {
    const g = analyseBeats(drums(bpm, 24));
    expect(Math.abs(g.bpm - bpm) / bpm).toBeLessThan(0.01);
    const gaps = g.beats.slice(1).map((b, i) => b - g.beats[i]);
    for (const d of gaps) expect(Math.abs(d - 60 / bpm)).toBeLessThan(0.02);
    expect(g.beats[0]).toBeGreaterThan(0.2); // no phantom beat before the music
    expect(g.barPhase).toBe(1);
    expect(g.energy).toHaveLength(g.beats.length);
  });
});

describe("beat cut - planning", () => {
  it("cuts on beats at a fixed pace, from 0 to the length", () => {
    const g = grid(120, 40);
    for (const pace of ["1", "2", "4"] as const) {
      const pts = cutPoints(g, { pace, length: 12, start: 0 });
      expect(pts[0]).toBe(0);
      expect(pts[pts.length - 1]).toBe(12);
      for (const t of pts.slice(1, -1)) expect(g.beats.some((b) => Math.abs(b - t) < 1e-6)).toBe(true);
      const inner = pts.slice(1, -1);
      for (let i = 1; i < inner.length; i++) expect(inner[i] - inner[i - 1]).toBeCloseTo(0.5 * Number(pace), 2);
    }
  });

  it("auto pace cuts faster where the track is loud", () => {
    const g = grid(120, 60, (k) => (k < 40 ? 0.1 : 0.95));
    const pts = cutPoints(g, { pace: "auto", length: 40, start: 0 });
    const quiet = pts.filter((t) => t > 2 && t < 18), loud = pts.filter((t) => t > 24 && t < 38);
    expect(loud.length / 14).toBeGreaterThan((quiet.length / 16) * 2);
  });

  it("plans clips in turn with transitions that fit both shots", () => {
    const g = grid(128, 60, (k) => (k % 16 < 8 ? 0.9 : 0.4));
    const clips = [{ duration: 6 }, { duration: 1 }, { duration: 9 }];
    for (const style of ["dynamic", "cut", "smooth", "punchy"] as const) {
      const plan = planEdit(g, clips, { pace: "auto", style, length: 20, start: 3 });
      expect(plan[0]).toMatchObject({ start: 0, transition: "cut", dur: 0 });
      expect(plan[plan.length - 1].end).toBe(20);
      plan.forEach((c, i) => {
        if (i > 0) {
          expect(c.clip).not.toBe(plan[i - 1].clip);
          expect(c.start).toBe(plan[i - 1].end);
          expect(c.dur).toBeLessThanOrEqual((plan[i - 1].end - plan[i - 1].start) / 2 + 1e-6);
        }
        expect(c.dur).toBeLessThanOrEqual((c.end - c.start) / 2 + 1e-6);
        expect(c.srcIn).toBeGreaterThanOrEqual(c.dur / 2 - 1e-6);
        if (c.clip === 1 && c.end - c.start > 0.7) expect(c.loops).toBe(true);
      });
      if (style === "cut") expect(plan.every((c) => c.transition === "cut")).toBe(true);
      if (style === "smooth") expect(plan.slice(1).every((c) => c.transition === "fade")).toBe(true);
    }
  });

  it("joins in whole frames that stay on the beat", () => {
    const g = grid(128, 60, () => 0.9);
    const plan = planEdit(g, [{ duration: 10 }, { duration: 10 }], { pace: "2", style: "dynamic", length: 15, start: 0 });
    const shots = framePlan(plan);
    // the running output length after each join is F(i+1) + tail(i)
    let total = shots[0].frames;
    for (let i = 1; i < shots.length; i++) {
      const s = shots[i];
      if (s.xfade > 0) {
        expect(Math.round(s.offset * 30)).toBe(Math.round(plan[i].start * 30) - s.head);
        expect(total).toBeGreaterThanOrEqual(Math.round(s.offset * 30) + s.head * 2);
        total = Math.round(s.offset * 30) + s.frames;
      } else total += s.frames;
      expect(total).toBe(Math.round(plan[i].end * 30) + s.tail);
    }
    expect(total).toBe(Math.round(15 * 30));
  });

  it("validates params and is wired as an open, host-side recipe", () => {
    expect(beatCutParamsSchema.safeParse({ video_urls: ["/files/a.mp4"], audio_url: "/files/m.mp3" }).success).toBe(false);
    const ok = beatCutParamsSchema.parse({ video_urls: ["/files/a.mp4", "/files/b.mp4"], audio_url: "/files/m.mp3" });
    expect(ok).toMatchObject({ pace: "auto", style: "dynamic", aspect_ratio: "9:16", length: 20, music_start: 0 });
    const wf = findEndpoint(BEAT_CUT_ENDPOINT)?.workflow;
    expect(wf?.providers.recipe?.name).toBe("beat-cut");
    expect(wf?.validate?.({ video_urls: ["/files/a.mp4", "/files/b.mp4"], audio_url: "/files/m.mp3" })).toBeNull();
    expect(typeof RECIPES["beat-cut"]).toBe("function");
    expect(RECIPE_LICENSES["beat-cut"].class).toBe("open");
  });
});
