/**
 * Trajectory library - schema coverage, composition semantics, determinism,
 * FOV/dolly-zoom math, auto-move, plus the TS side of the golden fixture
 * (the Python mirror recomputes the same cases in
 * comfy-nodes/tests/test_camera_trajectory.py).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { MOVES, AUTO_MOVE, composeTrajectory, TrajectorySpecSchema, type ComposeInput } from "@/lib/camera/trajectory";
import { TRAJECTORIES, TRAJECTORY_IDS, TRAJECTORY, MOTION_PRESETS, presetTrajectories, presetGroup, trajectoryOf, CORE_TRAJECTORY_IDS, RIG_TRAJECTORY_IDS, isCoreTrajectory, honestNote } from "@/lib/catalog/presets/trajectories";
import { camMove } from "@/lib/catalog/video/params";
import { dollyZoomFov, hFov, focalForHFov } from "@/lib/camera/lens";

const spec = (over: Partial<ComposeInput> = {}): ComposeInput => ({
  moves: ["dolly-in"], duration: 2, fps: 24, seed: 7, distance: 3, fov: 40, ...over,
});

describe("[OF-0139] 83-entry catalog", () => {
  it("every TRAJECTORIES row has a pose recipe, and every recipe is catalogued", () => {
    expect(TRAJECTORY_IDS.length).toBe(83);
    expect(new Set(TRAJECTORY_IDS).size).toBe(83);
    expect(Object.keys(MOVES).sort()).toEqual([...TRAJECTORY_IDS].sort());
    for (const t of TRAJECTORIES) {
      expect(t.group, t.id).toBeTruthy();
      expect(t.label.length, t.id).toBeGreaterThan(1);
      expect(t.inputs.length, t.id).toBeGreaterThan(0);
    }
  });

  it("every id composes to duration×fps+1 finite frames", () => {
    for (const id of TRAJECTORY_IDS) {
      const t = composeTrajectory(spec({ moves: [id], subjectClass: "product" }));
      expect(t.frames.length, id).toBe(49);
      for (const f of t.frames)
        for (const v of [...f.pos, f.yaw, f.pitch, f.roll, f.fov])
          expect(Number.isFinite(v), `${id}: ${JSON.stringify(f)}`).toBe(true);
    }
  });

  it("81 ids are visible - exactly cabin-jolt and two-stage-push are hidden", () => {
    expect(TRAJECTORIES.filter((t) => !t.hidden).length).toBe(81);
    expect([...TRAJECTORIES.filter((t) => t.hidden).map((t) => t.id)].sort())
      .toEqual(["cabin-jolt", "two-stage-push"]);
  });

  it("honest notes exist where the model must invent content", () => {
    for (const id of ["orbit-360", "turntable-180", "turntable-360", "frozen-moment-arc", "hyperlapse"]) {
      expect(TRAJECTORY.get(id)?.honest_note, id).toBeTruthy();
      expect(honestNote(id, "image"), id).toBeTruthy();
    }
    // footage carries its own time - generated-time notes drop on video;
    // the unseen side is still invented regardless of input kind
    expect(honestNote("hyperlapse", "video")).toBeUndefined();
    expect(honestNote("timelapse-studio", "video")).toBeUndefined();
    expect(honestNote("orbit-360", "video")).toBeTruthy();
  });

  it("[OF-0136] core/rig split matches the run.py verification record", () => {
    const verify = JSON.parse(
      readFileSync(path.resolve("tests/fixtures/trajectory-verify.json"), "utf-8"),
    );
    const split = verify.extras?.core_rig_split;
    expect(split?.pass, "run.py core_rig_split extra").toBe(true);
    expect(split?.value?.core).toEqual([...CORE_TRAJECTORY_IDS]);
    expect(split?.value?.rig).toEqual([...RIG_TRAJECTORY_IDS]);
    // visible, disjoint, exhaustive
    const visible = new Set(TRAJECTORIES.filter((t) => !t.hidden).map((t) => t.id));
    expect(CORE_TRAJECTORY_IDS.length + RIG_TRAJECTORY_IDS.length).toBe(visible.size);
    for (const id of CORE_TRAJECTORY_IDS) expect(isCoreTrajectory(id), id).toBe(true);
    for (const id of RIG_TRAJECTORY_IDS) expect(isCoreTrajectory(id), id).toBe(false);
  });
});

describe("motion presets carry trajectory stacks", () => {
  it("the preset ids match the frozen trunk list", () => {
    expect(MOTION_PRESETS.map((p) => p.id)).toEqual([
      "snap-zoom-in", "snap-zoom-out", "pull-back-to-planet", "dive-from-orbit",
      "dolly-in", "dolly-out", "dolly-zoom", "360-orbit", "frozen-orbit",
      "arc-left", "arc-right", "pan-left", "pan-right", "tilt-up", "tilt-down",
      "crane-up", "crane-down", "pedestal-up", "pedestal-down",
      "truck-left", "truck-right", "tracking", "side-tracking",
      "handheld", "whip-pan", "rack-focus", "body-mount", "robot-arm", "pov",
      "helicopter", "drone-orbit", "slow-zoom-in", "slow-zoom-out", "static",
      "fpv-dive", "low-angle-hero", "overhead-topdown", "shoulder-follow",
      "barrel-roll", "rising-reveal",
    ]);
  });

  it("every motion preset stack resolves to catalog ids", () => {
    for (const p of MOTION_PRESETS)
      for (const id of presetTrajectories(p)) expect(TRAJECTORY.has(id), `${p.id}: ${id}`).toBe(true);
  });

  it("every apply.camera_movement is a camMove enum value", () => {
    const allowed = new Set(camMove.enum);
    for (const p of MOTION_PRESETS)
      expect(allowed.has(p.apply.camera_movement as string), p.id).toBe(true);
  });

  it("every motion preset carries an executable stack (pov maps to object-pov)", () => {
    expect(MOTION_PRESETS.filter((p) => presetTrajectories(p).length === 0).map((p) => p.id))
      .toEqual([]);
    expect(presetTrajectories(MOTION_PRESETS.find((p) => p.id === "pov")!)).toEqual(["object-pov"]);
  });

  it("[OF-0141] every stack label resolves - the output card joins them with ' + '", () => {
    for (const p of MOTION_PRESETS)
      for (const id of presetTrajectories(p))
        expect(trajectoryOf(id)?.label, `${p.id}: ${id}`).toBeTruthy();
  });

  it("[OF-0138] presetGroup files every preset under the group of its first stack id", () => {
    // the picker's group headers come from the trajectory catalog, not a
    // separate preset taxonomy, so a preset lands under its first stack id
    for (const p of MOTION_PRESETS) {
      const ids = presetTrajectories(p);
      expect(presetGroup(p), p.id).toBe(ids.length ? trajectoryOf(ids[0])!.group : "basic");
    }
    expect(presetGroup(MOTION_PRESETS.find((p) => p.id === "360-orbit")!)).toBe("cinematic");
    expect(presetGroup(MOTION_PRESETS.find((p) => p.id === "whip-pan")!)).toBe("transition");
    expect(presetGroup(MOTION_PRESETS.find((p) => p.id === "static")!)).toBe("basic");
  });
});

describe("schema", () => {
  it("moves is 1-3 entries; strength bounded", () => {
    expect(() => composeTrajectory(spec({ moves: [] }))).toThrow();
    expect(() => composeTrajectory(spec({ moves: ["a", "b", "c", "d"] }))).toThrow();
    expect(() => composeTrajectory(spec({ strength: 0.1 }))).toThrow();
    expect(() => composeTrajectory(spec({ strength: 3 }))).toThrow();
    expect(() => composeTrajectory(spec({ moves: ["nope"] }))).toThrow(/unknown trajectory/);
  });
});

describe("composition", () => {
  const base = spec();

  it("[OF-0143] stacks add position deltas and multiply fov ratios", () => {
    const push = composeTrajectory({ ...base, moves: ["dolly-in"] });
    const zoom = composeTrajectory({ ...base, moves: ["zoom-in"] });
    const both = composeTrajectory({ ...base, moves: ["dolly-in", "zoom-in"] });
    for (let i = 0; i < push.frames.length; i++) {
      expect(both.frames[i].pos[2]).toBeCloseTo(push.frames[i].pos[2], 9);
      expect(both.frames[i].fov).toBeCloseTo(zoom.frames[i].fov, 9);
    }
  });

  it("[OF-0143] an aimed move's stack keeps untargeted angle deltas", () => {
    // crane-up aims at the subject; tilt-down must still drop the frame -
    // before the fix the aim replaced every stacked angle and the tilt vanished
    const crane = composeTrajectory({ ...base, moves: ["crane-up"] });
    const tilt = composeTrajectory({ ...base, moves: ["tilt-down"] });
    const both = composeTrajectory({ ...base, moves: ["crane-up", "tilt-down"] });
    for (let i = 0; i < crane.frames.length; i++)
      expect(Math.abs(both.frames[i].pitch - (crane.frames[i].pitch + tilt.frames[i].pitch))).toBeLessThanOrEqual(1e-9);
  });

  it("[OF-0143] aimed stacks keep untargeted noise (handheld under an orbit)", () => {
    const arc = composeTrajectory({ ...base, moves: ["arc-left-45"], seed: 9 });
    const both = composeTrajectory({ ...base, moves: ["arc-left-45", "handheld-subtle"], seed: 9 });
    const dy = Math.abs(both.frames.at(-1)!.yaw - arc.frames.at(-1)!.yaw)
      + Math.abs(both.frames.at(-1)!.pitch - arc.frames.at(-1)!.pitch);
    expect(dy).toBeGreaterThan(1e-6);
  });

  it("strength scales the move", () => {
    const full = composeTrajectory({ ...base, strength: 1 });
    const half = composeTrajectory({ ...base, strength: 0.5 });
    expect(half.frames.at(-1)!.pos[2]).toBeCloseTo(full.frames.at(-1)!.pos[2] / 2, 9);
  });

  it("seeds: same seed → identical, different → differs", () => {
    const a = composeTrajectory(spec({ moves: ["handheld-run"], seed: 42 }));
    const b = composeTrajectory(spec({ moves: ["handheld-run"], seed: 42 }));
    const c = composeTrajectory(spec({ moves: ["handheld-run"], seed: 43 }));
    expect(a.frames).toEqual(b.frames);
    expect(a.frames).not.toEqual(c.frames);
  });

  it("[OF-0218] locked-off is the identity move", () => {
    for (const f of composeTrajectory(spec({ moves: ["locked-off"] })).frames) {
      expect(f.pos).toEqual([0, 0, 0]);
      expect(f.yaw).toBe(0); expect(f.pitch).toBe(0); expect(f.roll).toBe(0);
      expect(f.fov).toBe(40);
    }
  });
});

describe("fov & lens", () => {
  it("zoom-in narrows fov without moving the camera", () => {
    const t = composeTrajectory(spec({ moves: ["zoom-in"] }));
    expect(t.frames.at(-1)!.fov).toBeLessThan(t.frames[0].fov * 0.8);
    expect(t.frames.at(-1)!.pos).toEqual([0, 0, 0]);
  });

  it("dolly-zoom holds subject size: dist·tan(fov/2) stays constant", () => {
    const D = 4;
    const t = composeTrajectory(spec({ moves: ["dolly-zoom-in"], distance: D }));
    const k = D * Math.tan((t.frames[0].fov * Math.PI / 180) / 2);
    for (const f of t.frames) {
      const dist = D - f.pos[2];
      expect(dist * Math.tan((f.fov * Math.PI / 180) / 2)).toBeCloseTo(k, 6);
    }
  });

  it("lens math: 50mm on super35 ≈ 27.95° hfov; focal round-trips", () => {
    expect(hFov(50, "super35")).toBeCloseTo(27.95, 1);
    expect(hFov(focalForHFov(40, "super35"), "super35")).toBeCloseTo(40, 9);
    expect(dollyZoomFov(4, 2, 40)).toBeCloseTo(2 * Math.atan(Math.tan(20 * Math.PI / 180) * 2) * 180 / Math.PI, 9);
  });
});

describe("[OF-0179] auto-move", () => {
  it("resolves deterministically per subject class", () => {
    for (const [cls, id] of Object.entries(AUTO_MOVE)) {
      const t = composeTrajectory(spec({ moves: ["auto-move"], subjectClass: cls as ComposeInput["subjectClass"] }));
      expect(t.moves).toEqual([id]);
    }
    expect(() => composeTrajectory(spec({ moves: ["auto-move"], subjectClass: "fish" as never }))).toThrow();
  });
});

describe("subject-locked moves", () => {
  it("camera rides the subject - aim anchor stays put in frame space", () => {
    const subj = (t: number) => ({ pos: [2 * t, 0, 3] as [number, number, number], yaw: 180 });
    const t = composeTrajectory(spec({ moves: ["body-mount"], subjectAt: subj }));
    // mount [0,0.02,0.45] sits in front of the subject; shake δ ≤ 0.008
    expect(t.frames.at(-1)!.pos[0]).toBeCloseTo(2 * t.frames.at(-1)!.t, 1);
    expect(t.frames.at(-1)!.pos[2]).toBeCloseTo(3 - 0.45, 1); // rotated 180° → -z
    expect(t.layer).toBe("subject_locked");
  });
});

describe("schema parse", () => {
  it("TrajectorySpecSchema normalizes and validates", () => {
    expect(TrajectorySpecSchema.parse({ moves: ["dolly-in"], duration: 1, fps: 24 }).strength).toBe(1);
    expect(TrajectorySpecSchema.safeParse({ moves: [], duration: 1, fps: 24 }).success).toBe(false);
  });
});

describe("golden fixture (TS side)", () => {
  it("the committed fixture still matches this engine", () => {
    const golden = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/trajectory-golden.json"), "utf8")) as {
      cases: { spec: ComposeInput; result: ReturnType<typeof composeTrajectory> }[];
    };
    expect(golden.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of golden.cases)
      expect(composeTrajectory(c.spec)).toEqual(c.result);
  });
});
