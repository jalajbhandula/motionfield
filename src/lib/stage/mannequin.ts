import type * as THREE_T from "three";
import type { MannequinPose } from "./scene";

/**
 * Jointed mannequin - a procedurally built figure (no GLB, no third-party
 * rig). Every named joint maps one-to-one onto an OpenPose BODY_18 keypoint the
 * headless pose pass projects (j_* names are stable across poses):
 *
 *   j_nose → 0 nose · j_head(origin) → 1 neck · j_upperArmR/L → 2/5 shoulders
 *   j_forearmR/L → 3/6 elbows · j_handR/L → 4/7 wrists
 *   j_thighR/L → 8/11 hips · j_shinR/L → 9/12 knees · j_footR/L → 10/13 ankles
 *   j_eyeR/L → 14/15 · j_earR/L → 16/17
 *
 * A pose is our own joint-rotation data: per-segment [rx,ry,rz] degrees
 * applied to each segment's pivot, plus an optional pelvis offset. The
 * figure stands `height` metres tall, feet at local y=0, facing +z.
 */

type Three = typeof THREE_T;

type SegId =
  | "hips" | "spine" | "chest" | "head"
  | "upperArmL" | "forearmL" | "upperArmR" | "forearmR"
  | "thighL" | "shinL" | "thighR" | "shinR";

type V3 = [number, number, number];
type JointAngles = Partial<Record<SegId, V3>>;

export interface PoseDef {
  /** joint rotations in degrees - each segment's own XYZ euler pivot */
  j: JointAngles;
  /** pelvis offset as a fraction of figure height (sit/kneel/lie drop,
   *  jump raises); 0 = standing */
  hipDrop?: number;
}

/* Sign conventions (figure faces +z): on hanging segments (arms, legs)
 * rx<0 swings the limb forward, rx>0 backward; rz swings laterally -
 * for left-side limbs rz>0 moves inward across the body, for right-side
 * limbs rz<0 does. On upward segments (spine, head) rx>0 tips forward,
 * ry>0 turns toward the figure's left. */

export const POSES: Record<MannequinPose, PoseDef> = {
  "stand": { j: {} },
  "stand-relaxed": {
    j: {
      hips: [0, 0, 4], spine: [0, 0, -3], head: [4, 10, 0],
      upperArmL: [0, 0, 4], upperArmR: [0, 0, -4],
      thighL: [0, 0, 3],
    },
  },
  "walk": {
    j: {
      thighL: [-22, 0, 0], shinL: [10, 0, 0], thighR: [16, 0, 0], shinR: [30, 0, 0],
      upperArmL: [18, 0, 6], upperArmR: [-18, 0, -6], forearmL: [-14, 0, 0], forearmR: [-30, 0, 0],
    },
  },
  // heel-strike/toe-off contact phase - both legs extended
  "walk-contact": {
    j: {
      thighL: [-30, 0, 0], shinL: [4, 0, 0], thighR: [24, 0, 0], shinR: [14, 0, 0],
      upperArmL: [22, 0, 6], upperArmR: [-24, 0, -6], forearmL: [-12, 0, 0], forearmR: [-24, 0, 0],
      spine: [0, -6, 0], hips: [0, 4, 0],
    },
  },
  // passing phase - the swing leg flexes under the body
  "walk-passing": {
    j: {
      thighL: [-8, 0, 0], shinL: [58, 0, 0], thighR: [6, 0, 0], shinR: [8, 0, 0],
      upperArmL: [8, 0, 6], upperArmR: [-10, 0, -6], forearmL: [-18, 0, 0], forearmR: [-26, 0, 0],
      spine: [0, -4, 0],
    },
  },
  "run": {
    j: {
      spine: [14, 0, 0],
      thighL: [-46, 0, 0], shinL: [18, 0, 0], thighR: [34, 0, 0], shinR: [66, 0, 0],
      upperArmL: [40, 0, 10], upperArmR: [-44, 0, -10], forearmL: [-60, 0, 0], forearmR: [-80, 0, 0],
    },
  },
  "point": {
    j: {
      upperArmR: [-88, 0, -8], forearmR: [-4, 0, 0],
      upperArmL: [10, 0, 8], spine: [0, -8, 0],
    },
  },
  "wave": {
    j: {
      upperArmR: [-158, 0, -18], forearmR: [-18, 0, -12],
      upperArmL: [8, 0, 10], spine: [0, 0, -4], head: [0, 8, 4],
    },
  },
  "arms-crossed": {
    j: {
      upperArmL: [-38, 0, 30], forearmL: [-78, 24, 0],
      upperArmR: [-38, 0, -30], forearmR: [-78, -24, 0],
    },
  },
  "look-back": {
    j: {
      head: [0, 58, 0], spine: [0, 18, 0], chest: [0, 8, 0],
      upperArmR: [14, 0, -10], upperArmL: [-8, 0, 8],
    },
  },
  "sit": {
    hipDrop: 0.10,
    j: {
      thighL: [-86, 0, 0], shinL: [84, 0, 0], thighR: [-86, 0, 0], shinR: [84, 0, 0],
      upperArmL: [-20, 0, 6], upperArmR: [-20, 0, -6], forearmL: [-50, 0, 0], forearmR: [-50, 0, 0],
    },
  },
  // on the floor, legs stretched out in front, hands propped behind
  "sit-floor": {
    hipDrop: 0.42,
    j: {
      thighL: [-82, 0, 4], shinL: [8, 0, 0], thighR: [-82, 0, -4], shinR: [8, 0, 0],
      spine: [-6, 0, 0], upperArmL: [30, 0, 12], upperArmR: [30, 0, -12],
      forearmL: [-14, 0, 0], forearmR: [-14, 0, 0],
    },
  },
  // both knees on the ground, torso upright
  "kneel": {
    hipDrop: 0.27,
    j: {
      thighL: [10, 0, 0], shinL: [96, 0, 0], thighR: [10, 0, 0], shinR: [96, 0, 0],
      upperArmL: [-14, 0, 8], upperArmR: [-14, 0, -8], forearmL: [-42, 0, 0], forearmR: [-42, 0, 0],
    },
  },
  "crouch": {
    hipDrop: 0.30,
    j: {
      thighL: [-96, 0, 4], shinL: [96, 0, 0], thighR: [-96, 0, -4], shinR: [96, 0, 0],
      spine: [28, 0, 0], head: [-12, 0, 0],
      upperArmL: [-46, 0, 10], upperArmR: [-46, 0, -10], forearmL: [-34, 0, 0], forearmR: [-34, 0, 0],
    },
  },
  // flat on the back - the whole pelvis group pitches 90°, feet +z, head −z
  "lie-down": {
    hipDrop: 0.45,
    j: {
      hips: [-88, 0, 0], spine: [-4, 0, 0],
      thighL: [6, 0, 0], shinL: [4, 0, 0], thighR: [6, 0, 0], shinR: [4, 0, 0],
      upperArmL: [8, 0, 14], upperArmR: [8, 0, -14], head: [8, 0, 0],
    },
  },
  "fight-stance": {
    j: {
      thighL: [-8, 0, 16], shinL: [14, 0, 0], thighR: [-4, 0, -16], shinR: [10, 0, 0],
      spine: [8, -12, 0], chest: [0, -8, 0],
      upperArmL: [-58, 0, 22], forearmL: [-92, 0, 0],
      upperArmR: [-48, 0, -18], forearmR: [-96, 0, 0],
    },
  },
  "bow": {
    j: {
      spine: [52, 0, 0], head: [18, 0, 0], hips: [6, 0, 0],
      upperArmL: [-24, 0, 8], upperArmR: [-24, 0, -8], forearmL: [-26, 0, 0], forearmR: [-26, 0, 0],
    },
  },
  // arms cradled in front of the chest, holding something
  "carry": {
    j: {
      upperArmL: [-52, 0, 14], forearmL: [-74, 18, 0],
      upperArmR: [-52, 0, -14], forearmR: [-74, -18, 0],
      spine: [-4, 0, 0],
    },
  },
  // leaning into a forward shove
  "push": {
    j: {
      spine: [22, 0, 0], hips: [6, 0, 0],
      upperArmL: [-78, 0, 6], forearmL: [-14, 0, 0],
      upperArmR: [-78, 0, -6], forearmR: [-14, 0, 0],
      thighL: [-24, 0, 0], shinL: [26, 0, 0], thighR: [18, 0, 0], shinR: [10, 0, 0],
    },
  },
  // hand to chin, elbow raised - the thinking figure
  "think": {
    j: {
      head: [12, 0, 8], spine: [4, 0, 2],
      upperArmR: [-46, 0, -24], forearmR: [-108, -16, 0],
      upperArmL: [-30, 0, 26], forearmL: [-80, 20, 0],
    },
  },
  // one arm stretched straight overhead
  "reach-up": {
    j: {
      upperArmR: [-164, 0, -6], forearmR: [-8, 0, 0],
      upperArmL: [12, 0, 10], spine: [0, 0, -6], head: [-10, 0, 0],
      thighL: [0, 0, 4],
    },
  },
  // both arms up in a V
  "cheer": {
    j: {
      upperArmL: [-152, 0, 16], forearmL: [-10, 0, 0],
      upperArmR: [-152, 0, -16], forearmR: [-10, 0, 0],
      spine: [-6, 0, 0], head: [-8, 0, 0],
    },
  },
  // fist to the sky, feet planted wide
  "superhero": {
    j: {
      upperArmR: [-172, 0, -8], forearmR: [-6, 0, 0],
      upperArmL: [26, 0, 18], forearmL: [-18, 0, 0],
      thighL: [0, 0, 14], thighR: [0, 0, -14],
      spine: [-6, 0, 0], chest: [0, -4, 0], head: [-8, 0, 0],
    },
  },
  // weight on one leg, one arm high, the other sweeping out
  "dance": {
    j: {
      hips: [0, 0, 8], spine: [0, 0, -6], head: [0, 0, -6],
      upperArmL: [-138, 0, 18], forearmL: [-22, 0, 0],
      upperArmR: [-38, 0, -48], forearmR: [-10, 0, 0],
      thighL: [0, 0, 10], shinL: [8, 0, 0], thighR: [-66, 0, -8], shinR: [78, 0, 0],
    },
  },
  // mid-air tuck - pelvis lifts, knees pulled up, arms thrown up
  "jump": {
    hipDrop: -0.12,
    j: {
      thighL: [-58, 0, 4], shinL: [70, 0, 0], thighR: [-52, 0, -4], shinR: [64, 0, 0],
      upperArmL: [-140, 0, 14], upperArmR: [-140, 0, -14],
      spine: [-6, 0, 0], head: [-6, 0, 0],
    },
  },
  // alternating arms overhead, one knee raised - on a wall/ladder
  "climb": {
    j: {
      upperArmL: [-152, 0, 8], forearmL: [-18, 0, 0],
      upperArmR: [-118, 0, -8], forearmR: [-44, 0, 0],
      thighL: [-88, 0, 4], shinL: [92, 0, 0], thighR: [8, 0, -6], shinR: [14, 0, 0],
      spine: [10, 0, 0], head: [-14, 0, 0],
    },
  },
};

/** proportion table (fractions of height) - stocky enough to read at block scale */
function proportions(h: number) {
  const hipY = 0.53 * h, chestY = 0.70 * h, neckY = 0.82 * h, shoulderY = 0.78 * h;
  const shoulderX = 0.105 * h, hipX = 0.048 * h;
  return { hipY, chestY, neckY, shoulderY, shoulderX, hipX, headR: 0.075 * h };
}

function capsule(T: Three, r: number, len: number, mat: THREE_T.Material) {
  const m = new T.Mesh(new T.CapsuleGeometry(r, len, 4, 10), mat);
  m.castShadow = true;
  return m;
}

/** a limb segment: capsule hanging from a pivot that a pose rotates.
 *  dir=-1 hangs downward (arms/legs), dir=+1 stacks upward (spine/head). */
function limb(T: Three, pivot: V3, r: number, len: number, rot: V3, mat: THREE_T.Material, dir = -1) {
  const g = new T.Group();
  g.position.set(...pivot);
  g.rotation.set(rot[0] * Math.PI / 180, rot[1] * Math.PI / 180, rot[2] * Math.PI / 180);
  const m = capsule(T, r, len, mat);
  m.position.y = dir * (len / 2 + r * 0.5);
  g.add(m);
  return g;
}

/** the small joint ball that makes the articulation read in the blockout -
 *  dropped at a pivot group's origin (shoulder, elbow, knee, …) */
function jointBall(T: Three, r: number, mat: THREE_T.Material) {
  const m = new T.Mesh(new T.SphereGeometry(r, 10, 8), mat);
  m.castShadow = true;
  return m;
}

export function buildMannequin(T: Three, pose: MannequinPose, height: number): THREE_T.Object3D {
  const p = proportions(height);
  const def = POSES[pose] ?? POSES.stand;
  const angles = def.j;
  const A = (id: SegId): V3 => angles[id] ?? [0, 0, 0];

  const mat = new T.MeshStandardMaterial({ color: "#9aa4b5", roughness: 0.85, metalness: 0.05 });
  const jmat = new T.MeshStandardMaterial({ color: "#6f7889", roughness: 0.7, metalness: 0.1 });
  const root = new T.Group();
  root.name = "mannequin";

  // joints carry j_* names - the headless pose pass finds them with
  // getObjectByName and projects their world positions into OpenPose-style
  // keypoints (the names are stable regardless of the pose)
  const hips = new T.Group();
  hips.name = "j_hips";
  const hipY = p.hipY - (def.hipDrop ?? 0) * height;
  hips.position.set(0, hipY, 0);
  hips.rotation.set(...(A("hips").map((d) => d * Math.PI / 180) as V3));
  root.add(hips);

  // pelvis
  const pelvis = new T.Mesh(new T.SphereGeometry(0.09 * height, 12, 10), mat);
  pelvis.scale.set(1.25, 0.8, 0.9);
  pelvis.castShadow = true;
  hips.add(pelvis);

  // torso chain - spine and chest stack upward from the pelvis
  const spineLen = p.chestY - p.hipY;
  const spine = limb(T, [0, 0, 0], 0.075 * height, spineLen, A("spine"), mat, 1);
  spine.name = "j_spine";
  hips.add(spine);
  const chestLen = p.neckY - p.chestY;
  const chest = limb(T, [0, spineLen, 0], 0.085 * height, chestLen, A("chest"), mat, 1);
  chest.name = "j_chest";
  spine.add(chest);

  // head - the group origin is the neck joint; j_nose/j_eye*/j_ear* are
  // face anchors the pose pass reads as OpenPose head keypoints
  const headG = new T.Group();
  headG.name = "j_head";
  headG.position.set(0, chestLen, 0);
  headG.rotation.set(...(A("head").map((d) => d * Math.PI / 180) as V3));
  const head = new T.Mesh(new T.SphereGeometry(p.headR, 14, 12), mat);
  head.name = "j_skull";
  head.position.y = p.headR * 1.15;
  head.scale.set(0.9, 1.15, 0.95);
  head.castShadow = true;
  headG.add(head);
  const anchor = (name: string, at: V3) => {
    const o = new T.Object3D();
    o.name = name;
    o.position.set(...at);
    headG.add(o);
  };
  anchor("j_nose", [0, p.headR * 1.2, p.headR * 1.1]);
  anchor("j_eyeL", [-p.headR * 0.4, p.headR * 1.35, p.headR * 0.85]);
  anchor("j_eyeR", [p.headR * 0.4, p.headR * 1.35, p.headR * 0.85]);
  anchor("j_earL", [-p.headR * 0.95, p.headR * 1.3, 0]);
  anchor("j_earR", [p.headR * 0.95, p.headR * 1.3, 0]);
  const neck = capsule(T, 0.028 * height, 0.04 * height, mat);
  neck.position.y = 0.01 * height;
  headG.add(neck);
  chest.add(headG);

  // arms - a joint ball at each pivot so the articulation reads in the blockout
  for (const side of [-1, 1] as const) {
    const s = side < 0 ? "L" : "R";
    const upper = limb(T,
      [side * p.shoulderX, p.shoulderY - p.chestY, 0],
      0.032 * height, 0.17 * height, A(`upperArm${s}` as SegId), mat);
    upper.name = `j_upperArm${s}`;
    upper.add(jointBall(T, 0.035 * height, jmat)); // shoulder
    chest.add(upper);
    const fore = limb(T, [0, -0.20 * height, 0], 0.026 * height, 0.16 * height, A(`forearm${s}` as SegId), mat);
    fore.name = `j_forearm${s}`;
    fore.add(jointBall(T, 0.03 * height, jmat)); // elbow
    upper.add(fore);
    const hand = new T.Mesh(new T.SphereGeometry(0.032 * height, 10, 8), mat);
    hand.name = `j_hand${s}`;
    hand.position.y = -0.20 * height;
    hand.castShadow = true;
    fore.add(hand);
  }

  // legs
  for (const side of [-1, 1] as const) {
    const s = side < 0 ? "L" : "R";
    const thigh = limb(T,
      [side * p.hipX, -0.02 * height, 0],
      0.048 * height, 0.24 * height, A(`thigh${s}` as SegId), mat);
    thigh.name = `j_thigh${s}`;
    thigh.add(jointBall(T, 0.045 * height, jmat)); // hip
    hips.add(thigh);
    const shin = limb(T, [0, -0.27 * height, 0], 0.037 * height, 0.23 * height, A(`shin${s}` as SegId), mat);
    shin.name = `j_shin${s}`;
    shin.add(jointBall(T, 0.04 * height, jmat)); // knee
    thigh.add(shin);
    const foot = new T.Mesh(new T.BoxGeometry(0.075 * height, 0.035 * height, 0.13 * height), mat);
    foot.name = `j_foot${s}`;
    foot.position.set(0, -0.255 * height, 0.03 * height);
    foot.castShadow = true;
    shin.add(foot);
  }

  return root;
}
