import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectDiff, effectSampleFrames, meanAbsDiff,
  EFFECT_DIFF_MIN, EFFECT_DIFF_IMAGE_SKIP,
} from "@/lib/catalog/video/vfx-diff";
import { VFX_PRESETS, vfxPresetHash, vfxPresetVerified } from "@/lib/catalog/presets/vfx-lab";

/* s11 - the effect-presence check behind every "verified" vfx record.
 *  Fixture-based (lavfi), no GPU: a plate re-render must measure under
 *  EFFECT_DIFF_MIN and an unmistakable transform far over it - the same
 *  separation the real artifacts showed (cosmetic ~4-8 vs landed ~40+). */

let dir: string;
let plate = "", cosmetic = "", negated = "", still = "", stillOut = "", stillSame = "";

const ff = (args: string[]) =>
  execFileSync("ffmpeg", ["-y", "-nostdin", "-v", "error", ...args]);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "of-vfx-diff-"));
  plate = join(dir, "plate.mp4");       // the torture plate's shape: 17 f @8
  cosmetic = join(dir, "cosmetic.mp4"); // plate re-rendered - a re-encode
  negated = join(dir, "negated.mp4");   // same span, unmistakably transformed
  still = join(dir, "still.png");
  stillOut = join(dir, "still-out.mp4");
  stillSame = join(dir, "still-same.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=8:duration=2.125",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", plate]);
  ff(["-i", plate, "-vf", "scale=320:180,fps=24", "-c:v", "libx264", "-crf", "28",
    "-pix_fmt", "yuv420p", cosmetic]);
  ff(["-i", plate, "-vf", "scale=320:180,fps=24,negate", "-c:v", "libx264", "-crf", "20",
    "-pix_fmt", "yuv420p", negated]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:duration=0.1", "-frames:v", "1", still]);
  ff(["-loop", "1", "-t", "2.2", "-i", still, "-vf", "fps=24,negate",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", stillOut]);
  ff(["-loop", "1", "-t", "2.2", "-i", still, "-vf", "fps=24",
    "-c:v", "libx264", "-crf", "30", "-pix_fmt", "yuv420p", stillSame]);
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("effectSampleFrames - the mid span", () => {
  it("skips the pinned HOLD head and never samples the tail frame", () => {
    const idx = effectSampleFrames(49, 9);
    expect(idx).toHaveLength(6);
    expect(Math.min(...idx)).toBeGreaterThanOrEqual(9);
    expect(Math.max(...idx)).toBeLessThanOrEqual(47); // frame 48 is pinned
  });
  it("hold 0 starts at frame 0; still runs skip their anchor head", () => {
    expect(Math.min(...effectSampleFrames(33, 0))).toBe(0);
    expect(Math.max(...effectSampleFrames(33, 0))).toBeLessThanOrEqual(31);
    expect(Math.min(...effectSampleFrames(65, EFFECT_DIFF_IMAGE_SKIP))).toBeGreaterThanOrEqual(9);
  });
  it("degenerate clips still return something countable", () => {
    expect(effectSampleFrames(17, 9).every((n) => n >= 9 && n <= 15)).toBe(true);
  });
});

describe("meanAbsDiff", () => {
  it("exact planes → 0, inverted planes → 255, empty/mismatched → NaN", () => {
    const a = Buffer.from([10, 200, 0, 255]);
    expect(meanAbsDiff(a, Buffer.from([10, 200, 0, 255]))).toBe(0);
    expect(meanAbsDiff(a, Buffer.from([245, 55, 255, 0]))).toBe(222.5);
    expect(meanAbsDiff(Buffer.alloc(4), Buffer.alloc(4, 255))).toBe(255);
    expect(meanAbsDiff(a, Buffer.alloc(0))).toBeNaN();
    expect(meanAbsDiff(a, Buffer.from([1, 2]))).toBeNaN();
  });
});

describe("effectDiff - measured on lavfi fixtures", () => {
  it("a plate re-render stays under the floor (the s10 bug would stamp weak)", () => {
    const d = effectDiff({ outFile: cosmetic, outFrames: 49, outFps: 24,
      plateFile: plate, plateIsStill: false, skipHead: 9 });
    expect(d.frames[0]).toBeGreaterThanOrEqual(9);
    expect(d.mean).toBeGreaterThanOrEqual(0);
    expect(d.mean).toBeLessThan(EFFECT_DIFF_MIN);
  });
  it("an unmistakable transform lands far over the floor", () => {
    const d = effectDiff({ outFile: negated, outFrames: 49, outFps: 24,
      plateFile: plate, plateIsStill: false, skipHead: 9 });
    expect(d.mean).toBeGreaterThan(EFFECT_DIFF_MIN);
    expect(d.min).toBeGreaterThan(EFFECT_DIFF_MIN);
  });
  it("still plates: every sample diffs the still, head skip applies", () => {
    const d = effectDiff({ outFile: stillOut, outFrames: 49, outFps: 24,
      plateFile: still, plateIsStill: true });
    expect(d.frames[0]).toBeGreaterThanOrEqual(EFFECT_DIFF_IMAGE_SKIP);
    expect(d.mean).toBeGreaterThan(EFFECT_DIFF_MIN);
    const same = effectDiff({ outFile: stillSame, outFrames: 49, outFps: 24,
      plateFile: still, plateIsStill: true });
    expect(same.mean).toBeLessThan(EFFECT_DIFF_MIN);
  });
});

describe("the gate - a weak record can never satisfy vfxPresetVerified", () => {
  it("weak + correct hash → not offerable; only verified passes", () => {
    const p = VFX_PRESETS[0];
    const hash = vfxPresetHash(p);
    const metric = { mean: 80, min: 60, frames: [0], per_frame: [80] };
    expect(vfxPresetVerified(p.id, { [p.id]: { mechanism_hash: hash, status: "weak" } })).toBe(false);
    expect(vfxPresetVerified(p.id, { [p.id]: { mechanism_hash: hash, status: "failed" } })).toBe(false);
    expect(vfxPresetVerified(p.id, { [p.id]: { mechanism_hash: hash, status: "pending" } })).toBe(false);
    expect(vfxPresetVerified(p.id, { [p.id]: { mechanism_hash: hash, status: "verified", effect_diff: metric } })).toBe(true);
  });
  it("a pre-s11 verified stamp without the metric is not offerable either", () => {
    const p = VFX_PRESETS[0];
    expect(vfxPresetVerified(p.id, { [p.id]: { mechanism_hash: vfxPresetHash(p), status: "verified" } })).toBe(false);
  });
});
