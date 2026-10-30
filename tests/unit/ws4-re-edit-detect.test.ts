import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildShots, detectCuts, probeVideo, RE_EDIT_WINDOW_MAX_S } from "@/lib/re-edit-ffmpeg";
import { detectVideo } from "@/lib/re-edit";

/**
 * Server-side shot splitting (B3): ffmpeg scene detection → shots of
 * ≥0.4 s → generation windows ≤ 5 s, capped at 24.
 */

process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws4-detect-db-"));

const dir = mkdtempSync(join(tmpdir(), "of-ws4-detect-"));
const src = join(dir, "three-shot.mp4");
const long = join(dir, "long.mp4");
const png = join(dir, "still.png");
const tooLong = join(dir, "too-long.mp4");

beforeAll(() => {
  // black 1.0 s → white 1.5 s → blue 0.5 s @24 fps + a 440 Hz tone -
  // ffmpeg's scene detector is luma-based, so the colours need luma contrast
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "color=black:size=320x180:rate=24:duration=1.0",
    "-f", "lavfi", "-i", "color=white:size=320x180:rate=24:duration=1.5",
    "-f", "lavfi", "-i", "color=blue:size=320x180:rate=24:duration=0.5",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src,
  ]);
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi",
    "-i", "color=purple:size=320x180:rate=24:duration=12",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", long,
  ]);
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi",
    "-i", "color=red:size=64x64:duration=1", "-frames:v", "1", png,
  ]);
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi",
    "-i", "color=green:size=64x36:rate=8:duration=31",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", tooLong,
  ]);
}, 60_000);

describe("probeVideo", () => {
  it("reads duration, fps, dims, audio", async () => {
    const p = await probeVideo(src);
    expect(Math.abs(p.durationSec - 3.0)).toBeLessThan(0.1);
    expect(Math.abs(p.fps - 24)).toBeLessThan(0.01);
    expect(p.width).toBe(320);
    expect(p.height).toBe(180);
    expect(p.hasAudio).toBe(true);
  });
});

describe("server-side shot detection", () => {
  it("splits the 3-shot clip within a frame of the real cuts", async () => {
    const cuts = await detectCuts(src);
    expect(cuts.length).toBe(2);
    const shots = buildShots(cuts, 3.0);
    expect(shots.length).toBe(3);
    const frame = 1 / 24;
    expect(Math.abs(shots[0].end - 1.0)).toBeLessThanOrEqual(frame + 0.01);
    expect(Math.abs(shots[1].end - 2.5)).toBeLessThanOrEqual(frame + 0.01);
    expect(shots[2].end).toBeCloseTo(3.0, 1);
    expect(shots.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(shots.every((s) => s.windows.every((w) => w.end - w.start <= RE_EDIT_WINDOW_MAX_S + 1e-6))).toBe(true);
  });

  it("a 12 s single-colour clip → 1 shot, 3 windows ≤ 5 s sharing the shot index", async () => {
    const cuts = await detectCuts(long);
    const shots = buildShots(cuts, 12.0);
    expect(shots.length).toBe(1);
    expect(shots[0].windows.length).toBe(3);
    for (const w of shots[0].windows) {
      expect(w.end - w.start).toBeLessThanOrEqual(RE_EDIT_WINDOW_MAX_S + 1e-6);
    }
    // windows tile the shot exactly
    expect(shots[0].windows[0].start).toBeCloseTo(0, 3);
    expect(shots[0].windows[2].end).toBeCloseTo(12, 3);
  });

  it("keeps the window count under 24 by merging shots", () => {
    // 26 uniform 1-s cuts would be 26 windows - must collapse to ≤24
    const shots = buildShots(Array.from({ length: 25 }, (_, i) => i + 1), 26);
    const windows = shots.reduce((a, s) => a + s.windows.length, 0);
    expect(windows).toBeLessThanOrEqual(24);
    expect(shots[0].index).toBe(0);
  });
});

describe("detectVideo guards", () => {
  it("a PNG instead of a video → 400, not 500", async () => {
    const err = await detectVideo(png).catch((e) => e);
    expect(err).toMatchObject({ status: 400 });
    // the client-facing message carries no absolute server path -
    // the ffprobe detail (which has it) stays in the server log
    expect(String(err.message)).not.toMatch(/\/(Users|tmp|private|var)\//);
  });

  it("unreadable bytes → 400, not 500", async () => {
    const garbage = join(dir, "garbage.mp4");
    writeFileSync(garbage, "this is not a video file");
    const err = await detectVideo(garbage).catch((e) => e);
    expect(err).toMatchObject({ status: 400 });
    expect(String(err.message)).not.toMatch(/\/(Users|tmp|private|var)\//);
  });

  it("a 31 s source → 400", async () => {
    await expect(detectVideo(tooLong)).rejects.toMatchObject({ status: 400 });
  });
});
