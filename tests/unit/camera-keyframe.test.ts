import { describe, it, expect } from "vitest";
import { endCropRect, KEYFRAME_MOVE_IDS } from "@/lib/camera/keyframe-moves";

describe("camera keyframe crops", () => {
  it("every move ends inside the still at the still's aspect", () => {
    for (const m of KEYFRAME_MOVE_IDS) for (const [w, h] of [[1280, 720], [720, 1280], [1024, 1024]]) {
      const r = endCropRect(w, h, m);
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.top).toBeGreaterThanOrEqual(0);
      expect(r.left + r.width).toBeLessThanOrEqual(w);
      expect(r.top + r.height).toBeLessThanOrEqual(h);
      expect(Math.abs(r.width / r.height - w / h)).toBeLessThan(0.01);
      expect(r.width).toBeLessThan(w);
    }
  });
  it("directional moves land on their side", () => {
    expect(endCropRect(1280, 720, "dolly-in-left").left).toBeLessThan(endCropRect(1280, 720, "dolly-in").left);
    expect(endCropRect(1280, 720, "dolly-in-right").left).toBeGreaterThan(endCropRect(1280, 720, "dolly-in").left);
    expect(endCropRect(1280, 720, "tilt-up").top).toBeLessThan(endCropRect(1280, 720, "tilt-down").top);
  });
});
