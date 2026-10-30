/**
 * Re-shoot security rows (the endpoint's param gate runs before charge):
 *  - video_url is strictly an owned /files/ ref - external urls, bare
 *    filenames and traversal never reach the graph
 *  - probe-derived timing fields (frames/fps/duration/dims) are required and
 *    bounded - a hand-built submit can't silently break the frame-exact claim
 *  - moves stay inside the video-capable pose-path set - hidden, unknown,
 *    stills-only and rig-mode ids are refused
 */
import { describe, expect, it } from "vitest";
import { findEndpoint } from "@/lib/catalog/video-models";
import { RESHOOT_TRAJECTORY_IDS } from "@/lib/catalog/video/camera";

const wf = findEndpoint("motionfield/reshoot/video")!.workflow;
const ok = {
  video_url: "/files/uploads/clip.mp4",
  frames: 49, fps: 24, duration: 2, width: 480, height: 272,
};
const gate = (p: Record<string, unknown>) => wf.validate?.({ ...p }) ?? null;

describe("reshoot param gate", () => {
  it("video_url: only owned /files/ refs - external, bare names and traversal refused", () => {
    expect(gate({ ...ok, video_url: "https://example.com/x.mp4" })).toMatch(/files/);
    expect(gate({ ...ok, video_url: "clip.mp4" })).toMatch(/files/);
    expect(gate({ ...ok, video_url: "/files/../a.mp4" })).toMatch(/traversal/);
    expect(gate({ ...ok, video_url: "/files/uploads/%2e%2e/x.mp4" })).toMatch(/traversal/);
    expect(gate({ ...ok, video_url: "/files/uploads/clip.mp4" })).toBeNull();
  });

  it("probe fields required + bounded; a good payload normalises the stack", () => {
    for (const drop of ["frames", "fps", "duration", "width", "height"])
      expect(gate({ ...ok, [drop]: undefined })).not.toBeNull();
    expect(gate({ ...ok, frames: 99999 })).toMatch(/frames/);
    expect(gate({ ...ok, frames: 300 })).toMatch(/local/);            // over the local budget (81)
    expect(gate({ ...ok, frames: 82 })).toMatch(/local/);             // one frame over still refuses
    expect(gate({ ...ok, frames: 300, backend: "cloud" })).toBeNull(); // cloud takes it
    expect(gate({ ...ok, frames: 500, backend: "cloud" })).toMatch(/frames/); // over the hard cap
    // >60 fps is a hard refusal - VHS's force_rate tops out there
    expect(gate({ ...ok, fps: 120 })).toMatch(/fps.*1\.\.60/);
    expect(gate({ ...ok, fps: 60 })).toBeNull();
    // a working size past the 832×480 Wan box is refused on both backends
    expect(gate({ ...ok, width: 1920, height: 1088 })).toMatch(/832×480/);
    expect(gate({ ...ok, width: 1920, height: 1088, backend: "cloud" })).toMatch(/832×480/);
    expect(gate({ ...ok, width: 832, height: 480 })).toBeNull();
    expect(gate({ ...ok, width: 482 })).toMatch(/width/);
    const p = { ...ok, moves: "pan-left+tilt-up" };
    expect(gate(p)).toBeNull();
  });

  it("moves: video-capable pose-path ids only", () => {
    expect(gate({ ...ok, moves: "frozen-moment-arc" })).toMatch(/stills/);
    expect(gate({ ...ok, moves: "not-a-move" })).toMatch(/unknown/);
    expect(gate({ ...ok, moves: "a+b+c+d" })).toMatch(/1-3/);
    expect(RESHOOT_TRAJECTORY_IDS.length).toBeGreaterThan(10);
    expect(RESHOOT_TRAJECTORY_IDS).not.toContain("frozen-moment-arc");
  });
});
