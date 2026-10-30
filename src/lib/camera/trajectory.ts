/** Camera trajectory engine - the shared spec for MotionField camera moves.
 *
 *  A keyframe is { t, pos:[x,y,z], yaw, pitch, roll, fov } (fov = horizontal
 *  degrees). A move is a pure function of (strength 0.25-2.0, duration s,
 *  fps, seed) producing per-frame deltas; a stack of 1-3 moves adds position
 *  and angle deltas in the base camera frame and multiplies FOV ratios.
 *
 *  Per-move extras:
 *   - target ("eyes"|"mouth"|"head"|"subject"): re-aim yaw/pitch at that
 *     anchor every frame (anchors move with the subject path when given).
 *     Aimed moves contribute position only - their own yaw/pitch deltas are
 *     dropped; moves without a target still add theirs on top of the aim.
 *   - layer ("scene"|"subject_locked"): a subject_locked move anchors the
 *     camera to the subject's frame via `mount` (its delta is expressed in
 *     subject-local axes; the subject's own motion comes from `subjectAt`).
 *   - post ("lens"|"shutter"|"time_sample"): tags the post filter the
 *     trajectory wants downstream (postArg carries its parameters).
 *
 *  World frame: metres, +x right, +y up, +z forward. The base camera sits at
 *  the origin looking down +z with the subject at (0,0,distance). yaw>0 turns
 *  right, pitch>0 looks up, roll>0 rolls clockwise (top of frame to the right).
 *  Handheld noise is seeded and deterministic (mulberry32 + sum of sines).
 *
 *  Mirrored exactly by comfy-nodes/motionfield_nodes/core/camera_trajectory.py -
 *  tests pin TS↔Python agreement at 1e-6.
 */
import { z } from "zod";

export const TRAJECTORY_TARGETS = ["eyes", "mouth", "head", "subject"] as const;
export const TRAJECTORY_LAYERS = ["scene", "subject_locked"] as const;
export const TRAJECTORY_POSTS = ["lens", "shutter", "time_sample"] as const;
export const SUBJECT_CLASSES = ["person", "product", "landscape", "vehicle"] as const;

export type TrajectoryTarget = (typeof TRAJECTORY_TARGETS)[number];
export type TrajectoryLayer = (typeof TRAJECTORY_LAYERS)[number];
export type TrajectoryPost = (typeof TRAJECTORY_POSTS)[number];
export type SubjectClass = (typeof SUBJECT_CLASSES)[number];
export type Vec3 = [number, number, number];

export const KeyframeSchema = z.strictObject({
  /** seconds */
  t: z.number(),
  /** camera position, metres */
  pos: z.tuple([z.number(), z.number(), z.number()]),
  /** degrees - yaw right+, pitch up+, roll clockwise+ */
  yaw: z.number(),
  pitch: z.number(),
  roll: z.number(),
  /** horizontal field of view, degrees */
  fov: z.number().positive().max(170),
  /** focus distance in metres - set by focus pulls */
  focus: z.number().positive().optional(),
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const TrajectorySpecSchema = z.strictObject({
  /** one move id or a stack of 2-3 */
  moves: z.array(z.string()).min(1).max(3),
  strength: z.number().min(0.25).max(2).default(1),
  /** seconds */
  duration: z.number().positive().max(120),
  /** frames per second */
  fps: z.number().positive().max(240),
  seed: z.number().int().nonnegative().default(0),
  /** metres from camera to the subject at t=0 */
  distance: z.number().positive().max(1e3).default(4),
  /** base horizontal fov, degrees */
  fov: z.number().positive().max(170).default(40),
  subjectClass: z.enum(SUBJECT_CLASSES).optional(),
  /** overrides - "auto" keeps the move's own setting */
  target: z.enum(["auto", ...TRAJECTORY_TARGETS]).default("auto"),
  layer: z.enum(["auto", ...TRAJECTORY_LAYERS]).default("auto"),
  post: z.enum(["auto", "none", ...TRAJECTORY_POSTS]).default("auto"),
});
export type TrajectorySpec = z.input<typeof TrajectorySpecSchema>;

export interface SubjectPose { pos: Vec3; yaw: number }

export interface Trajectory {
  /** the executed move ids (auto-move resolves through AUTO_MOVE) */
  moves: string[];
  frames: Keyframe[];
  layer: TrajectoryLayer;
  target?: TrajectoryTarget;
  post?: TrajectoryPost;
  postArg?: Record<string, number | string>;
}

/* ------------------------------------------------------------------ */
/* deterministic noise - mulberry32 + weighted sum of sines            */
/* (camera_trajectory.py mirrors this bit-for-bit)                     */
/* ------------------------------------------------------------------ */

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    const t = s;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth periodic noise in [-1,1]: a weighted sum of sinusoids whose
 *  frequencies/phases come from the seed. Same seed → same function. */
export function makeNoise(seed: number, freqScale = 1, octaves = 4): (u: number) => number {
  const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const comp = Array.from({ length: octaves }, (_, i) => ({
    f: (i + 1) * freqScale * (0.9 + rnd() * 0.4),
    p: rnd() * Math.PI * 2,
    a: 1 / (i + 1),
  }));
  const norm = comp.reduce((s, c) => s + c.a, 0);
  return (u: number) => comp.reduce((s, c) => s + c.a * Math.sin(2 * Math.PI * c.f * u + c.p), 0) / norm;
}

/* ------------------------------------------------------------------ */
/* move definitions                                                    */
/* ------------------------------------------------------------------ */

/** Per-frame contribution of a move - expressed in the base camera frame
 *  (scene layer) or the subject frame (subject_locked layer). */
export interface Delta {
  pos: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  /** multiplies onto the base fov */
  fovRatio: number;
  /** absolute fov (dolly-zoom) - wins over fovRatio when set */
  fovAbs?: number;
  /** focus distance in metres (focus pulls) */
  focus?: number;
}

export interface MoveCtx {
  strength: number;
  /** subject distance in metres (base) */
  distance: number;
  /** base horizontal fov, degrees */
  fov: number;
  fps: number;
  duration: number;
  /** frame count (last u is exactly 1) */
  frames: number;
  seed: number;
}

export interface MoveDef {
  id: string;
  fn: (u: number, c: MoveCtx) => Delta;
  target?: TrajectoryTarget;
  layer?: TrajectoryLayer;
  post?: TrajectoryPost;
  postArg?: Record<string, number | string>;
  /** subject_locked attach point in the subject's local frame (+z = facing) */
  mount?: Vec3;
  /** orbit-path move - executes but reads weakly on the pose-only endpoint
   *  (the model can't fill what the swing uncovers, so the background stays
   *  near-static). Set by orbitMove(), checked by isOrbitMove(). */
  orbit?: boolean;
}

const D0 = (): Delta => ({ pos: [0, 0, 0], yaw: 0, pitch: 0, roll: 0, fovRatio: 1 });

/* envelopes */
const lin = (u: number) => u;
const s3 = (u: number) => u * u * (3 - 2 * u);           // smoothstep
const s5 = (u: number) => u * u * u * (6 * u * u - 15 * u + 10); // smootherstep - fast middle, soft ends (whip)
const eo = (u: number) => 1 - (1 - u) * (1 - u) * (1 - u); // ease-out - snap at start
const ei = (u: number) => u * u * u;                     // ease-in - lands hard at the end

const orbit = (u: number, c: MoveCtx, thetaDeg: number, env = lin): Delta => {
  const th = (thetaDeg * env(u) * Math.PI) / 180;
  const D = c.distance;
  const d = D0();
  d.pos = [-D * Math.sin(th), 0, D - D * Math.cos(th)];
  return d;
};

/** Recipes whose path is built on orbit() belong inside this wrapper - the
 *  tag rides on the MoveDef so a future orbit recipe inherits it with the
 *  helper, never by hand. */
const orbitMove = (def: MoveDef): MoveDef => ({ ...def, orbit: true });

const shove = (u: number, c: MoveCtx, depth: number, env = s3): Delta => {
  const d = D0();
  d.pos[2] = depth * c.distance * c.strength * env(u);
  return d;
};

const shake = (u: number, c: MoveCtx, posAmp: number, angAmp: number, freq = 1, slot = 0): Delta => {
  const n1 = makeNoise(c.seed + slot * 101 + 1, freq);
  const n2 = makeNoise(c.seed + slot * 101 + 2, freq);
  const n3 = makeNoise(c.seed + slot * 101 + 3, freq);
  const n4 = makeNoise(c.seed + slot * 101 + 4, freq);
  const n5 = makeNoise(c.seed + slot * 101 + 5, freq);
  const n6 = makeNoise(c.seed + slot * 101 + 6, freq);
  const d = D0();
  const p = posAmp * c.distance * c.strength;
  d.pos = [p * n1(u), p * n2(u), p * n3(u)];
  d.yaw = angAmp * c.strength * n4(u);
  d.pitch = angAmp * c.strength * n5(u);
  d.roll = 0.6 * angAmp * c.strength * n6(u);
  return d;
};

/** d·tan(fov/2) held constant - the subject keeps its size while the
 *  background stretches/squeezes. z is the camera's +z travel. */
const dollyZoom = (u: number, c: MoveCtx, into: boolean): Delta => {
  const travel = 0.5 * c.distance * c.strength * s3(u);
  const z = into ? travel : -travel;
  const dist = Math.max(c.distance - z, c.distance * 0.1);
  const d = D0();
  d.pos[2] = z;
  d.fovAbs = (2 * Math.atan(Math.tan((c.fov * Math.PI) / 360) * (c.distance / dist)) * 180) / Math.PI;
  return d;
};

export const MOVES: Record<string, MoveDef> = {
  /* ------------------------------------------------ base 50 -------- */
  "locked-off": { id: "locked-off", fn: () => D0() },
  "dolly-in": { id: "dolly-in", fn: (u, c) => shove(u, c, 0.4) },
  "dolly-out": { id: "dolly-out", fn: (u, c) => shove(u, c, -0.4) },
  "slow-creep-in": { id: "slow-creep-in", fn: (u, c) => shove(u, c, 0.15, lin) },
  "pull-back-reveal": {
    id: "pull-back-reveal", fn: (u, c) => {
      const d = shove(u, c, -0.35);
      d.pos[1] = 0.12 * c.distance * c.strength * s3(u);
      d.pitch = -3 * c.strength * s3(u);
      return d;
    },
  },
  "truck-left": { id: "truck-left", fn: (u, c) => ({ ...D0(), pos: [-0.25 * c.distance * c.strength * s3(u), 0, 0] }) },
  "truck-right": { id: "truck-right", fn: (u, c) => ({ ...D0(), pos: [0.25 * c.distance * c.strength * s3(u), 0, 0] }) },
  "pedestal-up": { id: "pedestal-up", fn: (u, c) => ({ ...D0(), pos: [0, 0.3 * c.distance * c.strength * s3(u), 0] }) },
  "pedestal-down": { id: "pedestal-down", fn: (u, c) => ({ ...D0(), pos: [0, -0.3 * c.distance * c.strength * s3(u), 0] }) },
  "pan-left": { id: "pan-left", fn: (u, c) => ({ ...D0(), yaw: -12 * c.strength * s3(u) }) },
  "pan-right": { id: "pan-right", fn: (u, c) => ({ ...D0(), yaw: 12 * c.strength * s3(u) }) },
  "tilt-up": { id: "tilt-up", fn: (u, c) => ({ ...D0(), pitch: 10 * c.strength * s3(u) }) },
  "tilt-down": { id: "tilt-down", fn: (u, c) => ({ ...D0(), pitch: -10 * c.strength * s3(u) }) },
  "dutch-roll-cw": { id: "dutch-roll-cw", fn: (u, c) => ({ ...D0(), roll: 8 * c.strength * s3(u) }) },
  "dutch-roll-ccw": { id: "dutch-roll-ccw", fn: (u, c) => ({ ...D0(), roll: -8 * c.strength * s3(u) }) },
  "zoom-in": { id: "zoom-in", fn: (u, c) => ({ ...D0(), fovRatio: 1 / (1 + 0.6 * c.strength * s3(u)) }) },
  "zoom-out": { id: "zoom-out", fn: (u, c) => ({ ...D0(), fovRatio: 1 + 0.6 * c.strength * s3(u) }) },
  "crash-zoom-in": { id: "crash-zoom-in", fn: (u, c) => ({ ...D0(), fovRatio: 1 / (1 + 1.4 * c.strength * u * u * u * u) }) },
  "crash-zoom-out": { id: "crash-zoom-out", fn: (u, c) => ({ ...D0(), fovRatio: 1 + 1.4 * c.strength * u * u * u * u }) },
  "dolly-zoom-in": { id: "dolly-zoom-in", fn: (u, c) => dollyZoom(u, c, true) },
  "dolly-zoom-out": { id: "dolly-zoom-out", fn: (u, c) => dollyZoom(u, c, false) },
  "arc-left-45": orbitMove({ id: "arc-left-45", target: "subject", fn: (u, c) => orbit(u, c, 45 * c.strength, s3) }),
  "arc-right-45": orbitMove({ id: "arc-right-45", target: "subject", fn: (u, c) => orbit(u, c, -45 * c.strength, s3) }),
  "orbit-360": orbitMove({ id: "orbit-360", target: "subject", fn: (u, c) => orbit(u, c, 360) }),
  "turntable-180": orbitMove({ id: "turntable-180", target: "subject", fn: (u, c) => orbit(u, c, 180 * c.strength, s3) }),
  "crane-up": {
    id: "crane-up", target: "subject",
    fn: (u, c) => ({ ...D0(), pos: [0, 0.35 * c.distance * c.strength * s3(u), 0.1 * c.distance * c.strength * s3(u)] }),
  },
  "crane-down": {
    id: "crane-down", target: "subject",
    fn: (u, c) => ({ ...D0(), pos: [0, 0.35 * c.distance * c.strength * (1 - s3(u)), 0.1 * c.distance * c.strength * s3(u)] }),
  },
  "jib-over-foreground": {
    id: "jib-over-foreground", target: "subject",
    fn: (u, c) => {
      const d = D0();
      d.pos = [0, 0.25 * c.distance * c.strength * Math.sin(Math.PI * u), 0.3 * c.distance * c.strength * lin(u)];
      d.pitch = -6 * c.strength * Math.sin(Math.PI * u);
      return d;
    },
  },
  "overhead-rise": { id: "overhead-rise", target: "subject", fn: (u, c) => ({ ...D0(), pos: [0, 0.5 * c.distance * c.strength * lin(u), 0] }) },
  "overhead-drop": { id: "overhead-drop", target: "subject", fn: (u, c) => ({ ...D0(), pos: [0, 0.5 * c.distance * c.strength * (1 - lin(u)), 0] }) },
  "whip-pan-left": { id: "whip-pan-left", fn: (u, c) => ({ ...D0(), yaw: -90 * c.strength * s5(u) }) },
  "whip-pan-right": { id: "whip-pan-right", fn: (u, c) => ({ ...D0(), yaw: 90 * c.strength * s5(u) }) },
  "handheld-subtle": { id: "handheld-subtle", fn: (u, c) => shake(u, c, 0.012, 0.6, 1, 1) },
  "handheld-run": { id: "handheld-run", fn: (u, c) => shake(u, c, 0.06, 2.2, 3, 2) },
  "follow-behind": { id: "follow-behind", fn: (u, c) => shove(u, c, 0.8, lin) },
  "lead-backward": { id: "lead-backward", fn: (u, c) => shove(u, c, -0.8, lin) },
  "side-track-left": { id: "side-track-left", fn: (u, c) => ({ ...D0(), pos: [-0.5 * c.distance * c.strength * lin(u), 0, 0] }) },
  "side-track-right": { id: "side-track-right", fn: (u, c) => ({ ...D0(), pos: [0.5 * c.distance * c.strength * lin(u), 0, 0] }) },
  "fpv-dive": {
    id: "fpv-dive",
    fn: (u, c) => {
      const d = shove(u, c, 0.9, ei);
      d.pos[1] = -0.3 * c.distance * c.strength * ei(u);
      d.pitch = -15 * c.strength * ei(u);
      return d;
    },
  },
  "fpv-rise": {
    id: "fpv-rise",
    fn: (u, c) => {
      const d = shove(u, c, 0.9, ei);
      d.pos[1] = 0.3 * c.distance * c.strength * ei(u);
      d.pitch = 10 * c.strength * ei(u);
      return d;
    },
  },
  "drone-flyover": {
    id: "drone-flyover",
    fn: (u, c) => {
      const d = shove(u, c, 0.9, lin);
      d.pos[1] = 0.35 * c.distance * c.strength * s3(u);
      d.pitch = -50 * c.strength * lin(u);
      return d;
    },
  },
  "spiral-up": orbitMove({
    id: "spiral-up", target: "subject",
    fn: (u, c) => {
      const d = orbit(u, c, 150, s3);
      d.pos[1] = 0.25 * c.distance * c.strength * lin(u);
      return d;
    },
  }),
  "corkscrew-down": orbitMove({
    id: "corkscrew-down", target: "subject",
    fn: (u, c) => {
      const d = orbit(u, c, -150, s3);
      d.pos[1] = -0.25 * c.distance * c.strength * lin(u);
      d.roll = 12 * c.strength * Math.sin(4 * Math.PI * u);
      return d;
    },
  }),
  "low-angle-push": {
    id: "low-angle-push",
    fn: (u, c) => {
      const d = shove(u, c, 0.45);
      d.pos[1] = -0.18 * c.distance * c.strength * (1 - lin(u));
      d.pitch = 10 * c.strength * (1 - lin(u));
      return d;
    },
  },
  "high-angle-pull": {
    id: "high-angle-pull",
    fn: (u, c) => {
      const d = shove(u, c, -0.35);
      d.pos[1] = 0.2 * c.distance * c.strength * (1 - lin(u));
      d.pitch = -12 * c.strength * (1 - lin(u));
      return d;
    },
  },
  "parallax-slide": {
    id: "parallax-slide", target: "subject",
    fn: (u, c) => ({ ...D0(), pos: [0.35 * c.distance * c.strength * lin(u), 0, 0] }),
  },
  "snap-tilt-down": { id: "snap-tilt-down", fn: (u, c) => ({ ...D0(), pitch: -40 * c.strength * eo(u) }) },
  "impact-shake": {
    id: "impact-shake",
    fn: (u, c) => {
      const rnd = mulberry32((c.seed ^ 0x51ab00) >>> 0);
      const ph = rnd() * Math.PI * 2;
      const env = Math.exp(-3 * u);
      const d = D0();
      d.yaw = 4 * c.strength * env * Math.sin(6 * Math.PI * u + ph);
      d.pitch = 3 * c.strength * env * Math.sin(5.4 * Math.PI * u);
      d.roll = 2.5 * c.strength * env * Math.sin(4.2 * Math.PI * u + ph);
      d.pos[1] = 0.008 * c.distance * c.strength * env * Math.sin(5 * Math.PI * u);
      return d;
    },
  },
  "frozen-moment-arc": orbitMove({ id: "frozen-moment-arc", target: "subject", post: "time_sample", fn: (u, c) => orbit(u, c, 60 * c.strength, s3) }),
  "rack-focus-near-to-far": {
    id: "rack-focus-near-to-far", post: "lens", postArg: { lens: "focus_pull" },
    fn: (u, c) => ({ ...D0(), focus: 0.9 + (1.8 * c.distance - 0.9) * s3(u) }),
  },
  /* ------------------------------------------------ new 33 -------- */
  "auto-move": { id: "auto-move", fn: () => D0() }, // resolved through AUTO_MOVE before dispatch
  "eye-push": { id: "eye-push", target: "eyes", fn: (u, c) => shove(u, c, 0.45) },
  "mouth-push": { id: "mouth-push", target: "mouth", fn: (u, c) => shove(u, c, 0.5) },
  "mouth-snap-zoom": {
    id: "mouth-snap-zoom", target: "mouth",
    fn: (u, c) => {
      const d = shove(u, c, 0.3);
      d.fovRatio = 1 / (1 + 0.9 * c.strength * u * u * u * u);
      return d;
    },
  },
  "head-lock-follow": {
    id: "head-lock-follow", layer: "subject_locked", target: "head", mount: [0, 0.14, 0.9],
    fn: (u, c) => shake(u, c, 0.004, 0.25, 2, 3),
  },
  "motion-control-sweep": orbitMove({ id: "motion-control-sweep", target: "subject", fn: (u, c) => orbit(u, c, 95 * c.strength, s3) }),
  "body-mount": {
    id: "body-mount", layer: "subject_locked", target: "subject", mount: [0, 0.02, 0.45],
    fn: (u, c) => shake(u, c, 0.002, 0.1, 6, 4),
  },
  "car-mount": {
    id: "car-mount", layer: "subject_locked", target: "subject", mount: [0, -0.15, 0.65],
    fn: (u, c) => shake(u, c, 0.005, 0.4, 9, 5),
  },
  "chase-follow": {
    id: "chase-follow",
    fn: (u, c) => {
      const d = shove(u, c, 0.9, lin);
      d.pos[0] = 0.08 * c.distance * c.strength * Math.sin(2 * Math.PI * u);
      d.yaw = 3 * c.strength * Math.sin(2 * Math.PI * u + 0.6);
      return d;
    },
  },
  "ground-rush": {
    id: "ground-rush",
    fn: (u, c) => {
      const d = shove(u, c, 1.3, (u) => Math.pow(u, 1.5));
      d.pos[1] = -0.25 * c.distance * c.strength;
      d.pitch = -8 * c.strength * lin(u);
      return d;
    },
  },
  "making-of-pullback": {
    id: "making-of-pullback",
    fn: (u, c) => {
      const d = shove(u, c, -0.55, lin);
      const n = shake(u, c, 0.006, 0.5, 1.2, 8); // handheld-band wobble over the drift
      d.pos[1] = 0.3 * c.distance * c.strength * lin(u) + n.pos[1];
      d.pos[0] += n.pos[0]; d.pos[2] += n.pos[2];
      d.yaw = 12 * c.strength * lin(u) + n.yaw;
      d.pitch = n.pitch; d.roll = n.roll;
      return d;
    },
  },
  "cabin-jolt": {
    id: "cabin-jolt",
    fn: (u, c) => {
      const rnd = mulberry32((c.seed ^ 0xc4b1a) >>> 0);
      const ph = rnd() * Math.PI * 2;
      let a = 0;
      for (const b of [0.3, 0.65, 0.9]) a += Math.exp(-14 * Math.abs(u - b)) * Math.sin(28 * Math.PI * u + ph);
      const d = D0();
      d.yaw = 3 * c.strength * a;
      d.pitch = 2 * c.strength * a;
      d.pos[1] = 0.01 * c.distance * c.strength * a;
      return d;
    },
  },
  "two-stage-push": {
    id: "two-stage-push",
    fn: (u, c) => {
      const D = c.distance * c.strength;
      const z = u < 0.45 ? 0.12 * D * (u / 0.45) : 0.12 * D + 0.38 * D * s3((u - 0.45) / 0.55);
      const d = D0();
      d.pos[2] = z;
      return d;
    },
  },
  "overhead-crane-pass": {
    id: "overhead-crane-pass",
    fn: (u, c) => {
      const d = shove(u, c, 1.1, lin);
      d.pos[1] = 0.45 * c.distance * c.strength * lin(u);
      d.pitch = -80 * c.strength * Math.sin(Math.PI * u);
      return d;
    },
  },
  "fisheye-lens": {
    id: "fisheye-lens", post: "lens", postArg: { lens: "fisheye", k: 0.5 },
    fn: (u, c) => ({ ...D0(), pos: [0.05 * c.distance * c.strength * lin(u), 0, 0] }),
  },
  "shutter-drag": {
    id: "shutter-drag", post: "shutter", postArg: { exposure: 0.55 },
    fn: (u, c) => {
      const d = D0();
      d.yaw = 8 * c.strength * lin(u);
      d.pos[0] = 0.04 * c.distance * c.strength * lin(u);
      return d;
    },
  },
  "fly-through-transition": { id: "fly-through-transition", fn: (u, c) => shove(u, c, 1.35, (u) => Math.pow(u, 1.4)) },
  "beauty-arc": orbitMove({
    id: "beauty-arc", target: "subject",
    fn: (u, c) => {
      const d = orbit(u, c, 25 * c.strength, s3);
      d.pos[1] = 0.06 * c.distance * c.strength * lin(u);
      d.fovRatio = 1 / (1 + 0.12 * c.strength * lin(u));
      return d;
    },
  }),
  "tilt-rise": {
    id: "tilt-rise",
    fn: (u, c) => ({ ...D0(), pos: [0, 0.22 * c.distance * c.strength * s3(u), 0], pitch: 14 * c.strength * lin(u) }),
  },
  "jib-up": {
    id: "jib-up", target: "subject",
    fn: (u, c) => ({ ...D0(), pos: [0.12 * c.distance * c.strength * s3(u), 0.3 * c.distance * c.strength * s3(u), 0.08 * c.distance * c.strength * s3(u)] }),
  },
  "jib-down": {
    id: "jib-down", target: "subject",
    fn: (u, c) => ({ ...D0(), pos: [0.12 * c.distance * c.strength * s3(u), 0.3 * c.distance * c.strength * (1 - s3(u)), 0.08 * c.distance * c.strength * s3(u)] }),
  },
  "turntable-360": orbitMove({ id: "turntable-360", target: "subject", fn: (u, c) => orbit(u, c, 360 * c.strength, s3) }),
  "object-pov": {
    id: "object-pov",
    fn: (u, c) => {
      const d = shove(u, c, 1.0, s3);
      d.pos[1] = 0.05 * lin(u);
      d.yaw = 20 * c.strength * Math.sin(4 * Math.PI * u) * u;
      d.pitch = -5 * c.strength * u;
      return d;
    },
  },
  "pass-through-in": { id: "pass-through-in", fn: (u, c) => shove(u, c, 1.4, lin) },
  "pass-through-out": { id: "pass-through-out", fn: (u, c) => shove(u, c, 1.4, (u) => 1 - lin(u)) },
  "dolly-in-max": { id: "dolly-in-max", fn: (u, c) => shove(u, c, 0.8, s3) },
  "dolly-out-max": { id: "dolly-out-max", fn: (u, c) => shove(u, c, -1.2, s3) },
  "hyperlapse": {
    id: "hyperlapse", post: "time_sample",
    fn: (u, c) => {
      const d = shove(u, c, 0.7, lin);
      d.pos[0] = 0.1 * c.distance * c.strength * Math.sin(4 * Math.PI * u);
      return d;
    },
  },
  "timelapse-studio": { id: "timelapse-studio", post: "time_sample", fn: () => D0() },
  "timelapse-crowd": {
    id: "timelapse-crowd", post: "time_sample",
    fn: (u, c) => {
      const d = shove(u, c, 0.12, lin);
      d.yaw = 2 * c.strength * lin(u);
      return d;
    },
  },
  "timelapse-landscape": {
    id: "timelapse-landscape", post: "time_sample",
    fn: (u, c) => ({ ...D0(), yaw: 4 * c.strength * lin(u) }),
  },
  "jitter-shake": { id: "jitter-shake", fn: (u, c) => shake(u, c, 0.008, 2.8, 8, 6) },
  "zoom-pulse": {
    id: "zoom-pulse",
    fn: (u, c) => ({ ...D0(), fovRatio: 1 / (1 + 0.18 * c.strength * (0.5 - 0.5 * Math.cos(6 * Math.PI * u))) }),
  },
};

/* ------------------------------------------------------------------ */
/* auto-move: deterministic subject-class → move id table              */
/* ------------------------------------------------------------------ */

export const AUTO_MOVE: Record<SubjectClass, string> = {
  person: "eye-push",
  product: "turntable-180",
  landscape: "drone-flyover",
  vehicle: "side-track-left",
};

/* ------------------------------------------------------------------ */
/* subject frame helpers                                               */
/* ------------------------------------------------------------------ */

const DEG2 = Math.PI / 180;

/** subject-local anchor points (subject faces +z locally; world default has
 *  it at (0,0,distance) yaw 180 - facing back at the camera). */
const ANCHOR_LOCAL: Record<TrajectoryTarget, Vec3> = {
  eyes: [0, 0.08, 0.08],
  mouth: [0, 0.02, 0.08],
  head: [0, 0.14, 0.04],
  subject: [0, 0, 0],
};

/** world position of a local offset when the subject is at (pos, yawDeg). */
function subjToWorld(subj: SubjectPose, local: Vec3): Vec3 {
  const s = Math.sin(subj.yaw * DEG2), co = Math.cos(subj.yaw * DEG2);
  return [
    subj.pos[0] + co * local[0] + s * local[2],
    subj.pos[1] + local[1],
    subj.pos[2] - s * local[0] + co * local[2],
  ];
}

function aimAt(pos: Vec3, target: Vec3): { yaw: number; pitch: number } {
  const dx = target[0] - pos[0], dy = target[1] - pos[1], dz = target[2] - pos[2];
  return { yaw: Math.atan2(dx, dz) / DEG2, pitch: Math.atan2(dy, Math.hypot(dx, dz)) / DEG2 };
}

/* ------------------------------------------------------------------ */
/* composition                                                         */
/* ------------------------------------------------------------------ */

/** Expand a stack: "auto-move" resolves through AUTO_MOVE (subjectClass
 *  selects the row). Unknown ids throw. */
export function resolveMoves(moves: readonly string[], subjectClass: SubjectClass = "person"): string[] {
  const out: string[] = [];
  for (const id of moves) {
    const resolved = id === "auto-move" ? AUTO_MOVE[subjectClass] : id;
    if (!Object.hasOwn(MOVES, resolved)) throw new Error(`unknown trajectory "${id}"`);
    out.push(resolved);
  }
  return out;
}

/** Moves that cross the subject plane. The pose-only camera rig re-renders one
 *  side of the scene - past the plane the camera looks at content that was
 *  never photographed, which needs the rig extensions (object-pov lands on the
 *  plane itself). Mirrored in comfy-nodes .../core/camera_trajectory.py. */
export const PLANE_CROSSING_IDS: ReadonlySet<string> = new Set([
  "pass-through-in", "pass-through-out", "fly-through-transition", "object-pov",
]);

/** A recipe is rig-mode when it is subject-locked, aims at a facial anchor
 *  (eyes/mouth/head), carries a post tag, or crosses the subject plane. The
 *  pose-only image-to-video camera path executes none of those - they stay
 *  available for the rig-mode extension lane. */
export function isRigMove(id: string): boolean {
  const d = MOVES[id];
  if (!d) return false;
  return d.layer === "subject_locked"
    || (d.target !== undefined && d.target !== "subject")
    || d.post !== undefined
    || PLANE_CROSSING_IDS.has(id);
}

/** Orbit-path recipes - tagged by orbitMove() where the recipe is defined.
 *  They run on the executing endpoint but the visible motion stays weak, so
 *  pickers flag their rows "partial" instead of selling a full orbit. */
export function isOrbitMove(id: string): boolean {
  return MOVES[id]?.orbit === true;
}

export interface ComposeInput {
  moves: readonly string[];
  strength?: number;
  duration: number;
  fps: number;
  seed?: number;
  distance?: number;
  fov?: number;
  subjectClass?: SubjectClass;
  /** subject world pose at time t - drives subject_locked layers and
   *  moving anchors. Default: static at (0,0,distance) facing -z (yaw 180). */
  subjectAt?: (t: number) => SubjectPose;
  /** static anchor overrides (world coordinates) */
  anchors?: Partial<Record<TrajectoryTarget, Vec3>>;
  /** overrides - undefined/"auto" keeps each move's own setting */
  target?: TrajectoryTarget | "auto";
  layer?: TrajectoryLayer | "auto";
  post?: TrajectoryPost | "none" | "auto";
}

export function composeTrajectory(input: ComposeInput): Trajectory {
  // strict schema - pass only spec fields (subjectAt/anchors aren't zod-typed)
  const spec = TrajectorySpecSchema.parse({
    moves: [...input.moves], strength: input.strength, duration: input.duration,
    fps: input.fps, seed: input.seed, distance: input.distance, fov: input.fov,
    subjectClass: input.subjectClass, target: input.target, layer: input.layer, post: input.post,
  });
  const ids = resolveMoves(spec.moves, spec.subjectClass ?? "person");
  const c: MoveCtx = {
    strength: spec.strength, distance: spec.distance, fov: spec.fov,
    fps: spec.fps, duration: spec.duration, seed: spec.seed,
    frames: Math.max(2, Math.round(spec.duration * spec.fps) + 1),
  };
  const defs = ids.map((id) => MOVES[id]);
  const subjectAt = input.subjectAt ?? ((() => ({ pos: [0, 0, spec.distance] as Vec3, yaw: 180 })) as (t: number) => SubjectPose);

  const target = (input.target && input.target !== "auto" ? input.target : undefined)
    ?? [...defs].reverse().find((d) => d.target)?.target;
  const lock = input.layer === "subject_locked" ? defs[defs.length - 1]
    : input.layer === "scene" ? undefined
      : [...defs].reverse().find((d) => d.layer === "subject_locked");
  const post = input.post && input.post !== "auto" ? (input.post === "none" ? undefined : input.post)
    : [...defs].reverse().find((d) => d.post)?.post;
  const postArg = [...defs].reverse().find((d) => d.postArg)?.postArg;

  const frames: Keyframe[] = [];
  for (let i = 0; i < c.frames; i++) {
    const u = c.frames === 1 ? 0 : i / (c.frames - 1);
    const t = i / c.fps;
    const subj = subjectAt(t);

    let px = 0, py = 0, pz = 0;
    let yaw = 0, pitch = 0, roll = 0, fovRatio = 1, fovAbs: number | undefined, focus: number | undefined;
    for (const d of defs) {
      const dl = d.fn(u, c);
      if (d === lock) continue; // the locked move's pose is subject-frame absolute, applied below
      px += dl.pos[0]; py += dl.pos[1]; pz += dl.pos[2];
      if (!d.target) { yaw += dl.yaw; pitch += dl.pitch; } // aimed moves' angle deltas are covered by the aim below
      roll += dl.roll;
      fovRatio *= dl.fovRatio;
      if (dl.fovAbs !== undefined) fovAbs = dl.fovAbs;
      if (dl.focus !== undefined) focus = dl.focus;
    }

    let pos: Vec3;
    if (lock) {
      const dl = lock.fn(u, c);
      // default mount keeps the camera at its base position, subject-locked
      const mount = lock.mount ?? ([0, 0, spec.distance] as Vec3);
      const anchor = subjToWorld(subj, [mount[0] + dl.pos[0], mount[1] + dl.pos[1], mount[2] + dl.pos[2]]);
      pos = [anchor[0] + px, anchor[1] + py, anchor[2] + pz];
      // a lock with no aim of its own follows the subject's base heading only
      // when nothing else aims the camera - stacked with an aimed move it
      // contributes deltas alone, else the subject's yaw is counted twice
      if (!lock.target) {
        if (!target) { yaw += subj.yaw + 180; }
        yaw += dl.yaw; pitch += dl.pitch;
      }
      roll += dl.roll;
      fovRatio *= dl.fovRatio;
      if (dl.fovAbs !== undefined) fovAbs = dl.fovAbs;
      if (dl.focus !== undefined) focus = dl.focus;
    } else {
      pos = [px, py, pz];
    }

    if (target) {
      const anchor = input.anchors?.[target]
        ?? subjToWorld(subj, ANCHOR_LOCAL[target]);
      const a = aimAt(pos, anchor);
      yaw += a.yaw;
      pitch += a.pitch;
    }

    const frame: Keyframe = {
      t, pos,
      yaw: ((yaw + 180) % 360 + 360) % 360 - 180,
      pitch, roll,
      fov: (fovAbs ?? spec.fov) * fovRatio,
      ...(focus !== undefined ? { focus } : {}),
    };
    frames.push(frame);
  }

  return {
    moves: ids, frames,
    layer: lock ? "subject_locked" : "scene",
    ...(target ? { target } : {}),
    ...(post ? { post, ...(postArg ? { postArg } : {}) } : {}),
  };
}
