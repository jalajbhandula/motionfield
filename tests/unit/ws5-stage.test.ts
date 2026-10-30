import { describe, expect, it } from "vitest";
import { KeyframeSchema } from "@/lib/camera/trajectory";
import { hFov } from "@/lib/camera/lens";
import {
  emptyScene, makeNode, newNodeId, stageSceneSchema, type StageScene,
} from "@/lib/stage/scene";
import { applyOps } from "@/lib/stage/ops";
import { cameraAt, pathPos, sampleNodeLocal, worldOf } from "@/lib/stage/sample";
import { applyMoveToCamera, matchStageMoveId } from "@/lib/stage/moves";
import { exportCameraPath } from "@/lib/stage/export-path";
import { inspectScene } from "@/lib/stage/inspect";
import { applyCameraPreset, CAMERA_PRESETS, overviewCameraPose } from "@/lib/stage/presets";
import {
  STAGE_RENDER_FPS, STAGE_OVERLAP, STAGE_MAX_WINDOWS, stageRenderSize,
  stageFrameCount, stageWindows, joinedFrames, visibleObjects,
  composeRenderPrompt, depthRange,
} from "@/lib/stage/render-plan";

const ids = (s: StageScene) => new Set(s.nodes.map((n) => n.id));

describe("stage scene schema", () => {
  it("accepts the empty scene", () => {
    const s = emptyScene({ title: "test" });
    expect(s.meta.duration).toBe(15);
    expect(s.nodes.filter((n) => n.kind === "camera" && n.props.isRender)).toHaveLength(1);
  });

  it("rejects duplicate ids, parent cycles, zero/two render cameras", () => {
    const s = emptyScene();
    const dup = JSON.parse(JSON.stringify(s)) as StageScene;
    dup.nodes.push({ ...dup.nodes[0] });
    expect(() => stageSceneSchema.parse(dup)).toThrow(/duplicate/);

    const cyc = JSON.parse(JSON.stringify(s)) as StageScene;
    cyc.nodes[0].parent = cyc.nodes[0].id;
    expect(() => stageSceneSchema.parse(cyc)).toThrow(/itself|cycle/);

    const noCam = JSON.parse(JSON.stringify(s)) as StageScene;
    (noCam.nodes.find((n) => n.kind === "camera") as never as { props: { isRender: boolean } }).props.isRender = false;
    expect(() => stageSceneSchema.parse(noCam)).toThrow(/isRender/);

    const twoCam = JSON.parse(JSON.stringify(s)) as StageScene;
    twoCam.nodes.push(makeNode("camera", { id: "cam_b", props: { isRender: true } }));
    expect(() => stageSceneSchema.parse(twoCam)).toThrow(/isRender/);
  });

  it("rejects >300 nodes and non-/files model srcs", () => {
    const s = emptyScene();
    for (let i = 0; i < 301; i++) s.nodes.push(makeNode("primitive", { id: `x${i}` }));
    expect(() => stageSceneSchema.parse(s)).toThrow();

    const m = emptyScene();
    m.nodes.push(makeNode("model", { id: "mdl", props: { src: "https://evil.test/x.glb" } }));
    expect(() => stageSceneSchema.parse(m)).toThrow();
    m.nodes.pop();
    m.nodes.push(makeNode("model", { id: "mdl", props: { src: "/files/uploads/x.glb" } }));
    expect(stageSceneSchema.parse(m)).toBeTruthy();
  });

  it("rejects key paths outside the whitelist", () => {
    const s = emptyScene();
    s.nodes[0].keys = [{ t: 0, path: "props.__proto__", value: 1 }];
    expect(() => stageSceneSchema.parse(s)).toThrow();
    s.nodes[0].keys = [{ t: 0, path: "props.focalMm", value: 35 }];
    expect(() => stageSceneSchema.parse(s)).toThrow(/not an animatable/); // ground plane can't key focal
  });
});

describe("stage ops", () => {
  it("add/update/remove round-trip a node", () => {
    const s = emptyScene();
    const next = applyOps(s, [
      { op: "add", node: { kind: "primitive", name: "Crate", props: { shape: "box", size: [2, 1, 1], color: "#885522" } } },
    ]);
    expect(next.nodes.length).toBe(s.nodes.length + 1);
    const crate = next.nodes.find((n) => n.name === "Crate")!;
    const moved = applyOps(next, [{ op: "update", id: crate.id, path: "transform.pos", value: [1, 2, 3] }]);
    expect(moved.nodes.find((n) => n.id === crate.id)!.transform.pos).toEqual([1, 2, 3]);
    const gone = applyOps(moved, [{ op: "remove", id: crate.id }]);
    expect(gone.nodes.find((n) => n.id === crate.id)).toBeUndefined();
  });

  it("a bad op leaves the scene unchanged (atomic failure)", () => {
    const s = emptyScene();
    const before = JSON.stringify(s);
    expect(() => applyOps(s, [
      { op: "update", id: "ground", path: "name", value: "x" },
      { op: "remove", id: "cam_main" }, // last render camera → invalid scene
    ])).toThrow();
    expect(JSON.stringify(s)).toBe(before);
  });

  it("set_camera_path validates times", () => {
    const s = emptyScene();
    const next = applyOps(s, [{
      op: "set_camera_path", id: "cam_main",
      path: { points: [[0, 2, 8], [4, 2, 8]], times: [0, 5] },
    }]);
    const cam = next.nodes.find((n) => n.id === "cam_main")!;
    expect(cam.kind === "camera" && cam.props.path?.points).toHaveLength(2);
    expect(() => applyOps(s, [{
      op: "set_camera_path", id: "cam_main",
      path: { points: [[0, 0, 0], [1, 1, 1]], times: [0] },
    }])).toThrow();
  });
});

describe("sampling", () => {
  it("interpolates a keyed position halfway at mid-time", () => {
    const s = emptyScene();
    const box = makeNode("primitive", { id: "box1" });
    box.keys = [
      { t: 0, path: "transform.pos", value: [0, 0, 0] },
      { t: 2, path: "transform.pos", value: [4, 0, 0] },
    ];
    s.nodes.push(box);
    stageSceneSchema.parse(s);
    const mid = sampleNodeLocal(box, 1);
    expect(mid.pos[0]).toBeCloseTo(2, 5);
  });

  it("world transform composes parent chains", () => {
    const s = emptyScene();
    const parent = makeNode("primitive", { id: "par", transform: { pos: [2, 0, 0], rot: [0, 0, 0], scale: [2, 2, 2] } });
    const child = makeNode("primitive", { id: "kid", parent: "par", transform: { pos: [1, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] } });
    s.nodes.push(parent, child);
    stageSceneSchema.parse(s);
    const w = worldOf(s, "kid", 0)!;
    expect(w.pos[0]).toBeCloseTo(4, 5); // 2 + 2*1
  });

  it("catmull-rom passes through every control point", () => {
    const path = { points: [[0, 1, 8], [2, 1, 4], [4, 1, 0]] as [number, number, number][], times: [0, 2, 4] };
    for (let i = 0; i < 3; i++) {
      const p = pathPos(path, [0, 2, 4][i]);
      expect(p[0]).toBeCloseTo(path.points[i][0], 5);
      expect(p[2]).toBeCloseTo(path.points[i][2], 5);
    }
  });

  it("lookAt aims the camera; focal keys drive fov", () => {
    const s = emptyScene();
    const tgt = makeNode("primitive", { id: "tgt", transform: { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] } });
    s.nodes.push(tgt);
    const cam = s.nodes.find((n) => n.id === "cam_main")!;
    expect(cam.kind).toBe("camera");
    if (cam.kind !== "camera") throw new Error("unreachable");
    cam.props.lookAt = "tgt";
    cam.transform.pos = [0, 0, 10];
    const pose = cameraAt(s, 0)!;
    expect(pose.yaw).toBeCloseTo(180, 0); // facing -z back toward origin
    expect(pose.fov).toBeCloseTo(hFov(35, "full_frame"), 3);
    cam.keys = [
      { t: 0, path: "props.focalMm", value: 24 },
      { t: 2, path: "props.focalMm", value: 85 },
    ];
    const zoomed = cameraAt(s, 2)!;
    expect(zoomed.fov).toBeCloseTo(hFov(85, "full_frame"), 3);
  });
});

describe("moves + path export", () => {
  it("applying a MOVES id rewrites the render camera's keys and changes the export", () => {
    const s = emptyScene();
    const before = exportCameraPath(s);
    applyMoveToCamera(s, "cam_main", "dolly-in");
    const cam = s.nodes.find((n) => n.id === "cam_main")!;
    expect((cam.keys ?? []).length).toBeGreaterThan(10);
    const after = exportCameraPath(s);
    expect(JSON.stringify(after.frames)).not.toBe(JSON.stringify(before.frames));
  });

  it("exports duration*fps+1 keyframes that all pass KeyframeSchema", () => {
    const s = emptyScene({ duration: 5, fps: 24 });
    const out = exportCameraPath(s);
    expect(out.layer).toBe("scene");
    expect(out.frames).toHaveLength(5 * 24 + 1);
    for (const f of out.frames) expect(KeyframeSchema.parse(f)).toBeTruthy();
    // times strictly increasing, all within duration
    out.frames.forEach((f, i) => {
      if (i) expect(f.t).toBeGreaterThan(out.frames[i - 1].t);
      expect(f.t).toBeLessThanOrEqual(5.0001);
    });
  });
});

describe("render plan", () => {
  it("480p-class sizes are all divisible by 16 and track the scene aspect", () => {
    expect(stageRenderSize("16:9")).toEqual({ w: 832, h: 480 });
    expect(stageRenderSize("9:16")).toEqual({ w: 480, h: 832 });
    for (const a of ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const) {
      const { w, h } = stageRenderSize(a);
      expect(w % 16).toBe(0);
      expect(h % 16).toBe(0);
      expect(Math.max(w, h)).toBeGreaterThanOrEqual(480);
      expect(Math.min(w, h)).toBeLessThanOrEqual(832);
    }
  });

  it("frame counts are always 4n+1 at 16 fps, min 5", () => {
    for (const d of [0.25, 1, 2.4, 3, 9.5, 9.5625]) {
      const f = stageFrameCount(d);
      expect((f - 1) % 4).toBe(0);
      expect(f).toBeGreaterThanOrEqual(5);
      expect((f - 1) / STAGE_RENDER_FPS).toBeCloseTo(d, 0);
    }
    expect(stageFrameCount(1)).toBe(17);
    expect(stageFrameCount(6)).toBe(97);
  });

  it("windowing - one window ≤81, two with the 8-frame continuation, >2 rejected", () => {
    expect(stageWindows(17)).toEqual([{ len: 17, overlap: 0 }]);
    expect(stageWindows(81)).toEqual([{ len: 81, overlap: 0 }]);
    // two windows are balanced: the per-window latent count bounds wall time
    // and VAE decode peak - 97 frames → [53, 53], not a maximal [81, 25]
    expect(stageWindows(97)).toEqual([{ len: 53, overlap: 0 }, { len: 53, overlap: STAGE_OVERLAP }]);
    for (const w of stageWindows(97)) expect(w.len).toBeLessThanOrEqual(81);
    const cap = stageWindows(153);
    expect(cap).toHaveLength(STAGE_MAX_WINDOWS);
    expect(cap[1].len).toBe(81);
    expect(joinedFrames(cap)).toBeGreaterThanOrEqual(153);
    // the 400-frame request - beyond the local ceiling, never silently clipped
    expect(stageWindows(400)).toEqual([]);
    expect(stageWindows(155)).toEqual([]);
  });

  it("composed prompt carries only frustum-visible objects, hero-first, ≤800 chars", () => {
    const s = emptyScene({ duration: 5 });
    // a named box dead-center in the camera's view, and one far behind it
    s.nodes.push(makeNode("primitive", {
      id: "hero", name: "Hero Cube", prompt: "a glowing cube",
      transform: { pos: [0, 0.5, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { shape: "box", size: [1, 1, 1], color: "#3366aa" },
    }));
    s.nodes.push(makeNode("primitive", {
      id: "behind", name: "Backdrop", prompt: "should never appear",
      transform: { pos: [0, 0.5, 50], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { shape: "box", size: [1, 1, 1], color: "#3366aa" },
    }));
    const { w, h } = stageRenderSize(s.meta.aspect);
    const vis = visibleObjects(s, 0, 33, w, h).map((v) => v.node.id);
    expect(vis).toContain("hero");
    expect(vis).not.toContain("behind");
    const { text, objects } = composeRenderPrompt(s, "test scene", 0, 33, w, h);
    expect(text).toContain("test scene");
    expect(text).toContain("Hero Cube: a glowing cube");
    expect(text).not.toContain("should never appear");
    expect(objects.length).toBeGreaterThan(0);
  });

  it("depthRange brackets the visible content for the whole range", () => {
    const s = emptyScene({ duration: 5 });
    s.nodes.push(makeNode("primitive", {
      id: "cube", transform: { pos: [0, 0.5, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { shape: "box", size: [1, 1, 1], color: "#3366aa" },
    }));
    const d = depthRange(s, 0, 33);
    expect(d.near).toBeGreaterThan(0);
    expect(d.far).toBeGreaterThan(d.near);
  });

  it("a crowded scene sheds tail items with clean separators, hero kept", () => {
    const s = emptyScene({ duration: 3 });
    for (let i = 0; i < 40; i++) s.nodes.push(makeNode("primitive", {
      id: `box${i}`, name: `Box ${i}`, prompt: "a weathered wooden crate with rope handles and stencilled numbers",
      transform: { pos: [(i % 8) - 3.5, 0.5, -2 - Math.floor(i / 8)], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { shape: "box", size: [1, 1, 1], color: "#886644" },
    }));
    const { w, h } = stageRenderSize(s.meta.aspect);
    const { text, objects } = composeRenderPrompt(s, "a dusty warehouse at noon", 0, 33, w, h);
    expect(text.length).toBeLessThanOrEqual(800);
    expect(text).toMatch(/^a dusty warehouse at noon\. Scene: /);
    expect(text).not.toMatch(/[^ .;:]Scene:/);
    expect(text).toMatch(/\. Only: .*no cuts$/);
    expect(objects.length).toBeGreaterThan(0);
    expect(objects.length).toBeLessThan(40);
    for (const name of objects) expect(text).toContain(name);
  });

  it("structured prompt ends with the prohibitions clause and stays under the cap", () => {
    const s = emptyScene({ duration: 5 });
    s.nodes.push(makeNode("mannequin", {
      id: "walker", name: "Walker",
      transform: { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { pose: "walk", height: 1.75 },
    }));
    const { w, h } = stageRenderSize(s.meta.aspect);
    const { text } = composeRenderPrompt(s, "a courier crosses the plaza", 0, 49, w, h);
    expect(text.length).toBeLessThanOrEqual(800);
    expect(text).toContain("no text");
    expect(text).toContain("no cuts");
    expect(text).toMatch(/Scene: /);
    expect(text).toMatch(/Shot: /);
  });
});

describe("move name matching", () => {
  it("resolves common language, labels, speed prefixes, and rejects junk", () => {
    expect(matchStageMoveId("push in")).toBe("dolly-in");
    expect(matchStageMoveId("Push-In")).toBe("dolly-in");
    expect(matchStageMoveId("pull back")).toBe("dolly-out");
    expect(matchStageMoveId("zoom in")).toBe("zoom-in");
    expect(matchStageMoveId("slow dolly in")).toBe("dolly-in");
    expect(matchStageMoveId("Dolly In")).toBe("dolly-in");
    expect(matchStageMoveId("handheld")).toBe("handheld-subtle");
    expect(matchStageMoveId("boom up")).toBe("crane-up");
    expect(matchStageMoveId("not a real move")).toBeNull();
    expect(matchStageMoveId("")).toBeNull();
  });
});

describe("applyMoveToCamera duration", () => {
  it("a shortened move ends at durationS and holds through the scene tail", () => {
    const s = emptyScene({ duration: 6 });
    const camId = s.nodes.find((n) => n.kind === "camera" && n.props.isRender)!.id;
    applyMoveToCamera(s, camId, "dolly-in", { durationS: 1 });
    const cam = s.nodes.find((n) => n.id === camId)!;
    const moveKeys = cam.keys!.filter((k) => k.path === "transform.pos" && k.t <= 1);
    expect(moveKeys.length).toBeGreaterThan(2);
    // every key past the move end sits at the final pose - a hold, not drift
    const last = moveKeys[moveKeys.length - 1].value as number[];
    const tails = cam.keys!.filter((k) => k.path === "transform.pos" && k.t > 1);
    expect(tails.length).toBeGreaterThan(0);
    for (const k of tails) expect(k.value).toEqual(last);
    const p0 = cameraAt(s, 1, camId)!.pos;
    const p1 = cameraAt(s, 5.9, camId)!.pos;
    expect(p1).toEqual(p0);
  });
});

describe("camera presets", () => {
  it("ships at least eight subject-bound framings plus the bird's-eye", () => {
    expect(CAMERA_PRESETS.length).toBeGreaterThanOrEqual(8);
    expect(CAMERA_PRESETS.map((p) => p.id)).toContain("birds-eye");
    for (const p of CAMERA_PRESETS) {
      expect(p.offset.length).toBe(3);
      expect(p.focalMm).toBeGreaterThan(0);
    }
  });

  it("stamps an aimed camera: offset lands in the subject frame, lookAt binds", () => {
    const s = emptyScene({ duration: 5 });
    s.nodes.push(makeNode("mannequin", {
      id: "subject", transform: { pos: [2, 0, -1], rot: [0, 90, 0], scale: [1, 1, 1] },
      props: { pose: "stand", height: 1.75 },
    }));
    const camId = s.nodes.find((n) => n.kind === "camera" && n.props.isRender)!.id;
    applyCameraPreset(s, camId, "subject", "medium");
    const cam = s.nodes.find((n) => n.id === camId)!;
    expect(cam.kind === "camera" && cam.props.lookAt === "subject").toBe(true);
    // subject faces +z after the 90° yaw… its "front" is world +x; the medium
    // offset is mostly in front, so the camera should sit to the +x side
    const w = worldOf(s, "subject", 0)!;
    const rel = cam.transform.pos.map((v, i) => v - w.pos[i]);
    expect(rel[0]).toBeGreaterThan(2.5); // ~4.2m ahead on the facing axis
    expect(Math.abs(rel[2])).toBeLessThan(1.5);
  });

  it("follow parents the camera so the offset rides the subject", () => {
    const s = emptyScene({ duration: 5 });
    s.nodes.push(makeNode("primitive", {
      id: "crate", transform: { pos: [1, 0.4, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { shape: "box", size: [0.8, 0.8, 0.8], color: "#aa8855" },
    }));
    const camId = s.nodes.find((n) => n.kind === "camera" && n.props.isRender)!.id;
    applyCameraPreset(s, camId, "crate", "close-up", { follow: true });
    const cam = s.nodes.find((n) => n.id === camId)!;
    expect(cam.parent).toBe("crate");
    // local pos is the raw preset offset - parenting does the world placement
    expect(cam.transform.pos[2]).toBeCloseTo(1.6, 1);
  });

  it("overviewCameraPose parks above the content, pitched straight down", () => {
    const s = emptyScene({ duration: 5 });
    s.nodes.push(makeNode("primitive", {
      id: "crate", transform: { pos: [3, 0.4, -2], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { shape: "box", size: [0.8, 0.8, 0.8], color: "#aa8855" },
    }));
    const o = overviewCameraPose(s);
    expect(o.pos[1]).toBeGreaterThan(3);
    expect(o.rot[0]).toBeLessThan(-80); // looking down
    expect(o.focalMm).toBeLessThanOrEqual(24);
  });
});

describe("inspect problems - branches ops can't reach", () => {
  it("flags a scene with no render camera (legacy/corrupt docs)", () => {
    const s = emptyScene({ duration: 5 });
    for (const n of s.nodes) if (n.kind === "camera") n.props.isRender = false;
    const r = inspectScene(s, 0, "problems");
    if (r.view !== "problems") throw new Error("wrong view");
    expect(r.problems.map((p) => p.code)).toContain("no-render-camera");
  });

  it("flags an empty scene and an unlit scene", () => {
    const s = emptyScene({ duration: 5 });
    s.nodes = [];
    const r = inspectScene(s, 0, "problems");
    if (r.view !== "problems") throw new Error("wrong view");
    expect(r.problems.map((p) => p.code)).toContain("empty-scene");

    const s2 = emptyScene({ duration: 5 });
    s2.env.ambient = 0;
    s2.env.sun.intensity = 0;
    for (const n of s2.nodes) if (n.kind === "light") n.props.intensity = 0;
    const r2 = inspectScene(s2, 0, "problems");
    if (r2.view !== "problems") throw new Error("wrong view");
    expect(r2.problems.map((p) => p.code)).toContain("unlit-scene");
  });

  it("flags zero scales, keys past duration, overlaps, unsorted path times", () => {
    const s = emptyScene({ duration: 5 });
    s.nodes.push(makeNode("primitive", {
      id: "flat", transform: { pos: [0, 0.5, 0], rot: [0, 0, 0], scale: [1, 0, 1] },
      props: { shape: "box", size: [1, 1, 1], color: "#3366aa" },
      keys: [{ t: 9, path: "transform.pos", value: [0, 0.5, 0] }],
    }));
    s.nodes.push(makeNode("primitive", {
      id: "twinA", transform: { pos: [5, 0.5, 5], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { shape: "box", size: [1, 1, 1], color: "#3366aa" },
    }));
    s.nodes.push(makeNode("primitive", {
      id: "twinB", transform: { pos: [5, 0.5, 5], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { shape: "box", size: [1, 1, 1], color: "#3366aa" },
    }));
    const cam = s.nodes.find((n) => n.kind === "camera" && n.props.isRender)!;
    if (cam.kind !== "camera") throw new Error("not a camera");
    cam.props.path = { points: [[0, 1, 5], [0, 1, 3]], times: [3, 1] };
    const r = inspectScene(s, 0, "problems");
    if (r.view !== "problems") throw new Error("wrong view");
    const codes = r.problems.map((p) => p.code);
    expect(codes).toContain("zero-scale");
    expect(codes).toContain("key-past-duration");
    expect(codes).toContain("overlapping-origin");
    expect(codes).toContain("path-times-unsorted");
  });

  it("flags an under-framed subject and lets a well-framed one pass", () => {
    const s = emptyScene({ duration: 5 });
    // the default cam sits ~5m back - a mannequin 40m away is a speck
    s.nodes.push(makeNode("mannequin", {
      id: "far-fig", transform: { pos: [0, 0, -40], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { pose: "stand" },
    }));
    const r = inspectScene(s, 0, "problems");
    if (r.view !== "problems") throw new Error("wrong view");
    const codes = r.problems.map((p) => p.code);
    expect(codes).toContain("subject-underframed");

    // a figure the render cam is lookAt-bound to at ~5m reads as a proper
    // medium shot (the cam aims at its chest) - no framing problems
    const s2 = emptyScene({ duration: 5 });
    const cam2 = s2.nodes.find((n) => n.kind === "camera" && n.props.isRender)!;
    s2.nodes.push(makeNode("mannequin", {
      id: "mid-fig",
      transform: { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { pose: "stand" },
    }));
    if (cam2.kind !== "camera") throw new Error("not a camera");
    cam2.props.lookAt = "mid-fig";
    const r2 = inspectScene(s2, 0, "problems");
    if (r2.view !== "problems") throw new Error("wrong view");
    const codes2 = r2.problems.map((p) => p.code);
    expect(codes2).not.toContain("subject-underframed");
    expect(codes2).not.toContain("subject-off-center");
  });

  it("shots view lists helper cameras after the render camera", () => {
    const s = emptyScene({ duration: 5 });
    s.nodes.push(makeNode("camera", {
      id: "helper", name: "Layout cam",
      transform: { pos: [0, 6, 0], rot: [-89, 0, 0], scale: [1, 1, 1] },
      props: { focalMm: 20 },
    }));
    const r = inspectScene(s, 0, "shots");
    if (r.view !== "shots") throw new Error("wrong view");
    expect(r.cameras.length).toBe(2);
    expect(r.cameras[0].isRender).toBe(true);
    expect(r.cameras[1].id).toBe("helper");
    expect(r.cameras[1].shots.length).toBeGreaterThan(0);
  });
});
