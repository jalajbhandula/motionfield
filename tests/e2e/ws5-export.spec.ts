import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("[OF-0499] exporter turns the fixture spec into a valid mp4", async () => {
  test.setTimeout(240_000);
  const base = `http://localhost:${process.env.PORT || "3100"}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), "of-export-test-"));
  const out = path.join(dir, "out.mp4");
  try {
    execFileSync(process.execPath, [
      "--experimental-strip-types", "scripts/render/export.ts",
      "--spec", "tests/fixtures/ws5-launch.json",
      "--out", out,
      "--base", base,
    ], { stdio: "inherit", env: { ...process.env }, timeout: 200_000 });

    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-count_frames",
      "-show_entries", "stream=codec_name,width,height,nb_read_frames",
      "-show_entries", "format=duration", "-of", "json", out,
    ]).toString());
    const st = probe.streams[0];
    console.log("ffprobe:", JSON.stringify({ codec: st.codec_name, w: st.width, h: st.height, frames: st.nb_read_frames, dur: probe.format.duration }));
    expect(st.codec_name).toBe("h264");
    expect(st.width).toBe(1280);
    expect(st.height).toBe(720);
    expect(Math.abs(Number(st.nb_read_frames) - 48)).toBeLessThanOrEqual(1);
    expect(Math.abs(Number(probe.format.duration) - 2.0)).toBeLessThanOrEqual(0.05);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
