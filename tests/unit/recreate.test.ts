import { describe, expect, it } from "vitest";
import { recreateHref } from "../../src/lib/recreate";

describe("Recreate consent boundary", () => {
  it("restores inputs without reusing or mutating the previous consent assertion", () => {
    const params = { prompt: "100% literal %20", image_urls: ["/files/uploads/ref.png"],
      likeness_consent: true, seed: 12345 };
    const url = new URL(recreateHref({ kind: "avatar", modelId: "musetalk", workflow: "lipsync-video", params }), "http://localhost");
    expect(url.pathname).toBe("/ai/video");
    expect(url.searchParams.get("flow")).toBe("lipsync-video");
    expect(JSON.parse(url.searchParams.get("params")!)).toEqual({
      prompt: params.prompt, image_urls: params.image_urls, seed: params.seed,
    });
    expect(params.likeness_consent).toBe(true);
  });
});
