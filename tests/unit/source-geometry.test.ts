import { describe, expect, it } from "vitest";
import { sourceGeometry } from "@/lib/jobs";
import { DRAW_TO_VIDEO } from "@/lib/catalog/video/camera";
import * as swap from "@/lib/catalog/video/swap";

describe("sourceGeometry", () => {
  it("never asks for more frames than a short clip has (the grey-tail bug)", () => {
    // 49 frames @16 fps ≈ 3.06 s: the old default asked VACE for 129
    const g = sourceGeometry({ width: 1280, height: 720, durationSec: 3.06 });
    expect(g.frames).toBeLessThanOrEqual(49);
    expect(g).toEqual({ width: 832, height: 464, frames: 48 });
  });
  it("keeps portrait aspect and caps long clips", () => {
    expect(sourceGeometry({ width: 720, height: 1280, durationSec: 30 })).toEqual({ width: 464, height: 832, frames: 81 });
  });
  it("does not upscale small sources", () => {
    expect(sourceGeometry({ width: 480, height: 272, durationSec: 2 })).toEqual({ width: 480, height: 272, frames: 32 });
  });
  it("draw-to-video opts in on its source clip", () => {
    expect(DRAW_TO_VIDEO.workflows[0].sourceGeometry?.param).toBe("video_url");
  });
  it("VACE object/character swap follow the clip (portrait stays portrait)", () => {
    const wfs = Object.values(swap).flatMap((m) => (m as { workflows?: { endpointId: string; sourceGeometry?: unknown }[] }).workflows ?? []);
    for (const ep of ["motionfield/wan-vace/object-swap", "motionfield/wan-vace/character-swap", "motionfield/wan-animate/character-swap"])
      expect(wfs.find((w) => w.endpointId === ep)?.sourceGeometry).toEqual({ param: "video_url", maxFrames: 129 });
    expect(sourceGeometry({ width: 480, height: 832, durationSec: 5.06 }, 832, 129)).toEqual({ width: 480, height: 832, frames: 80 });
  });
});
