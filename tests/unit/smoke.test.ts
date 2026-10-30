import { describe, expect, it } from "vitest";
import { VIDEO_MODELS, findEndpoint } from "@/lib/catalog/video-models";

describe("catalog alias smoke", () => {
  it("imports the video model catalog via the @ alias", () => {
    expect(VIDEO_MODELS.length).toBeGreaterThan(0);
    expect(VIDEO_MODELS[0]).toHaveProperty("id");
  });

  it("findEndpoint resolves a catalog endpoint", () => {
    const ep = VIDEO_MODELS.flatMap((m) => m.workflows).find((w) => w.endpointId);
    expect(ep).toBeDefined();
    expect(findEndpoint(ep!.endpointId!)).not.toBeNull();
  });
});
