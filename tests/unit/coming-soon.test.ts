import { describe, it, expect, afterEach } from "vitest";
import { COMING_SOON, comingSoonReason } from "@/lib/catalog/coming-soon";
import { ALL_MODELS } from "@/lib/catalog/video-models";

describe("coming-soon gate", () => {
  const prev = process.env.OF_ENABLE_UNVERIFIED;
  afterEach(() => { process.env.OF_ENABLE_UNVERIFIED = prev; });
  it("every gated id is a real endpoint", () => {
    const ids = new Set(ALL_MODELS.flatMap((m) => m.workflows.map((w) => w.endpointId)));
    for (const id of Object.keys(COMING_SOON)) expect(ids.has(id), id).toBe(true);
  });
  it("gates by default and lifts with OF_ENABLE_UNVERIFIED=1", () => {
    const id = Object.keys(COMING_SOON)[0];
    delete process.env.OF_ENABLE_UNVERIFIED;
    expect(comingSoonReason(id)).toBe(COMING_SOON[id]);
    expect(comingSoonReason(id)).toBeTruthy();
    process.env.OF_ENABLE_UNVERIFIED = "1";
    expect(comingSoonReason(id)).toBeUndefined();
  });
});
