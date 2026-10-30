import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleWindows, buildShots, probeVideo, type ProbeInfo } from "@/lib/re-edit-ffmpeg";

/**
 * Assembly invariants (B5): one output file that preserves shot order,
 * exact timing, the source's aspect + fps, and the original soundtrack -
 * even when the window outputs come back with the wrong lengths.
 */

const dir = mkdtempSync(join(tmpdir(), "of-ws4-assemble-"));
const src = join(dir, "src.mp4");
const out = join(dir, "out.mp4");
let probe: ProbeInfo;
let spans: { start: number; end: number }[];

const ffprobeJson = (file: string) => JSON.parse(execFileSync("ffprobe", [
  "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
]).toString());

const frameAt = (file: string, t: number): Buffer =>
  execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(t), "-i", file,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { maxBuffer: 64 * 1024 * 1024 });

// dominant channel of the frame centre
const dominant = (buf: Buffer, w: number, h: number) => {
  const i = ((h >> 1) * w + (w >> 1)) * 3;
  const [r, g, b] = [buf[i], buf[i + 1], buf[i + 2]];
  return r > g && r > b ? "r" : g > b ? "g" : "b";
};

beforeAll(async () => {
  // source: red 1.0 / green 1.5 / blue 0.5 @24fps + 440 Hz tone
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "color=red:size=320x180:rate=24:duration=1.0",
    "-f", "lavfi", "-i", "color=green:size=320x180:rate=24:duration=1.5",
    "-f", "lavfi", "-i", "color=blue:size=320x180:rate=24:duration=0.5",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src,
  ]);
  // fake window outputs - WRONG lengths on purpose (17 / 25 / 9 frames @16fps),
  // in distinct hues so we can verify order lands on the right timeline slots
  const colors = ["0x8B0000", "0x006400", "0x00008B"]; // dark red/green/blue
  const frames = [17, 25, 9];
  spans = [{ start: 0, end: 1.0 }, { start: 1.0, end: 2.5 }, { start: 2.5, end: 3.0 }];
  probe = await probeVideo(src);
  const wins = frames.map((n, i) => {
    const f = join(dir, `win-${i}.mp4`);
    execFileSync("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi",
      "-i", `color=${colors[i]}:size=320x180:rate=16:duration=${n / 16}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", f,
    ]);
    return { file: f, span: spans[i] };
  });
  await assembleWindows(wins, probe, out);
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("assembled file", () => {
  it("keeps the source fps, size and duration (±1 frame)", () => {
    const meta = ffprobeJson(out);
    const v = meta.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    expect(v.width).toBe(320);
    expect(v.height).toBe(180);
    const [rn, rd] = v.avg_frame_rate.split("/").map(Number);
    expect(Math.abs(rn / rd - 24)).toBeLessThan(0.01);
    const dur = Number(meta.format.duration);
    expect(Math.abs(dur - 3.0)).toBeLessThanOrEqual(1 / 24 + 0.05);
  });

  it("keeps the original soundtrack", () => {
    const meta = ffprobeJson(out);
    expect(meta.streams.some((s: { codec_type: string }) => s.codec_type === "audio")).toBe(true);
  });

  it("shows the window outputs in shot order on the right timeline slots", () => {
    // mid-shot times: 0.5 s → window 1 (dark red), 1.75 s → window 2, 2.75 s → window 3
    expect(dominant(frameAt(out, 0.5), 320, 180)).toBe("r");
    expect(dominant(frameAt(out, 1.75), 320, 180)).toBe("g");
    expect(dominant(frameAt(out, 2.75), 320, 180)).toBe("b");
  });

  it("conformed each window to its exact frame count", async () => {
    const counted = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-count_frames", "-select_streams", "v:0",
      "-show_entries", "stream=nb_read_frames", "-print_format", "json", out,
    ]).toString());
    expect(Number(counted.streams[0].nb_read_frames)).toBe(72); // 24 + 36 + 12 at 24 fps
  });
});
