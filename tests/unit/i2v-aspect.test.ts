import { describe, expect, it, vi } from "vitest";
vi.mock("@/db", () => ({ getDb: vi.fn(), sql: vi.fn(), tx: vi.fn(), schema: {} }));
import { nearestAspect } from "@/lib/jobs";
import { placeholders } from "@/lib/generation/comfy";

describe("i2v follows the first frame", () => {
  it("maps photo sizes to the nearest supported ratio", () => {
    expect(nearestAspect(576 / 1024)).toBe("9:16");
    expect(nearestAspect(768 / 1024)).toBe("3:4");
    expect(nearestAspect(1024 / 1024)).toBe("1:1");
    expect(nearestAspect(1920 / 1080)).toBe("16:9");
  });
  it("480p names the short side for portrait clips", () => {
    const m = placeholders({ jobId: "00000000-0000-0000-0000-000000000000", params: { aspect_ratio: "9:16", resolution: "480p" }, workflow: { params: [], providers: {} } } as never);
    expect([m.WIDTH, m.HEIGHT]).toEqual(["480", "864"]);
  });
});
