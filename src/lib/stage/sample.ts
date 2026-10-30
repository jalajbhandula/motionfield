import { hFov, type SensorName } from "@/lib/camera/lens";
import { EASING } from "@/lib/render/runtime";
import type { CameraPath, StageNode, StageScene, Vec3 } from "./scene";

/**
 * Time-sampled pose of the stage document. `sampleScene` gives every node's
 * local TRS at t (base transform overridden per-path by its keys); world
 * transforms compose through the parent chain; `cameraAt` resolves the
 * render camera's pose - position from its Catmull-Rom path when present,
 * orientation from lookAt > path-tangent > transform.rot.
 *
 * Pure math - no three.js - so routes, tests, and the editor share it.
 */

/* ---------- easing (same table the spec renderer uses) ---------- */
const ease = (name: string | undefined, u: number) => EASING[(name as keyof typeof EASING) ?? "linear"](u);

type V3 = [number, number, number];
const vAdd = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vMul = (a: V3, b: V3): V3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const vSub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vLen = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const vNorm = (a: V3): V3 => { const l = vLen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const vCross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
const vDot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/* ---------- quaternions [x,y,z,w] ---------- */
type Quat = [number, number, number, number];
const qMul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qRotV = (q: Quat, v: V3): V3 => {
  // v + 2·q.xyz × (q.xyz × v + q.w·v)
  const [x, y, z, w] = q;
  const cx = y * v[2] - z * v[1] + w * v[0];
  const cy = z * v[0] - x * v[2] + w * v[1];
  const cz = x * v[1] - y * v[0] + w * v[2];
  return [v[0] + 2 * (y * cz - z * cy), v[1] + 2 * (z * cx - x * cz), v[2] + 2 * (x * cy - y * cx)];
};

/** XYZ euler (three.js order: R = Rx·Ry·Rz), degrees → quaternion */
function quatFromEulerDeg(rot: V3): Quat {
  const [rx, ry, rz] = rot.map((d) => (d * Math.PI) / 360) as V3; // half-angles
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry), Math.cos(rz), Math.sin(rz)];
  // qx ⊗ qy ⊗ qz - matches three.js Quaternion.setFromEuler('XYZ')
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

/** camera orientation: rot is [pitch, yaw, roll] in the trajectory frame
 *  (+z forward, yaw right+, pitch up+, roll cw+) →
 *  R = Ry(yaw) · Rx(-pitch) · Rz(-roll) */
export function quatFromCameraDeg(pyr: V3): Quat {
  const yaw = (pyr[1] * Math.PI) / 180, pitch = (pyr[0] * Math.PI) / 180, roll = (pyr[2] * Math.PI) / 180;
  const qy: Quat = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
  const qx: Quat = [Math.sin(-pitch / 2), 0, 0, Math.cos(-pitch / 2)];
  const qz: Quat = [0, 0, Math.sin(-roll / 2), Math.cos(-roll / 2)];
  return qMul(qMul(qy, qx), qz);
}

/* ---------- keyframe tracks ---------- */

function lerpColor(a: string, b: string, u: number): string {
  const pa = [0, 2, 4].map((i) => parseInt(a.slice(1 + i, 3 + i), 16));
  const pb = [0, 2, 4].map((i) => parseInt(b.slice(1 + i, 3 + i), 16));
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * u).toString(16).padStart(2, "0")).join("");
}

export function keyValue(node: StageNode, path: string, t: number): number | V3 | string | undefined {
  const track = (node.keys ?? []).filter((k) => k.path === path).sort((a, b) => a.t - b.t);
  if (!track.length) return undefined;
  if (t <= track[0].t) return track[0].value;
  const last = track[track.length - 1];
  if (t >= last.t) return last.value;
  for (let i = 1; i < track.length; i++) {
    const k1 = track[i];
    if (t > k1.t) continue;
    const k0 = track[i - 1];
    const u = ease(k1.ease, (t - k0.t) / (k1.t - k0.t));
    const a = k0.value, b = k1.value;
    if (typeof a === "number" && typeof b === "number") return a + (b - a) * u;
    if (Array.isArray(a) && Array.isArray(b)) {
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    }
    if (typeof a === "string" && typeof b === "string") return lerpColor(a, b, u);
    return u < 1 ? a : b;
  }
  return last.value;
}

export interface SampledNode { pos: V3; rot: V3; scale: V3 }

/** local TRS at t - base transform overridden by any keyed track */
export function sampleNodeLocal(node: StageNode, t: number): SampledNode {
  const pos = keyValue(node, "transform.pos", t);
  const rot = keyValue(node, "transform.rot", t);
  const scale = keyValue(node, "transform.scale", t);
  return {
    pos: (Array.isArray(pos) ? pos : node.transform.pos) as V3,
    rot: (Array.isArray(rot) ? rot : node.transform.rot) as V3,
    scale: (Array.isArray(scale) ? scale : node.transform.scale) as V3,
  };
}

/** keyed scalar prop (e.g. props.focalMm, props.intensity) at t */
export function sampleProp(node: StageNode, name: string, t: number): number | V3 | string | undefined {
  return keyValue(node, `props.${name}`, t);
}

export interface WorldPose { pos: V3; quat: Quat; scale: V3 }

const NO_IDS: ReadonlySet<string> = new Set();

/** True when `id` sits somewhere under `ancestor` - the ancestor id appears
 *  on id's own parent chain. Camera lookAts use this to refuse aiming into
 *  the camera's own subtree: the aim would feed back into the very
 *  composition it resolves. */
function inSubtree(byId: Map<string, StageNode>, id: string, ancestor: string): boolean {
  const seen = new Set<string>();
  let cur = byId.get(id)?.parent;
  while (cur) {
    if (cur === ancestor) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = byId.get(cur)?.parent;
  }
  return false;
}

/** re-aim the running quat at yaw/pitch keeping whatever roll it holds -
 *  shared by the path-tangent and lookAt overrides below */
function aimQuat(quat: Quat, yawDeg: number, pitchDeg: number): Quat {
  const { roll } = cameraAnglesFromQuat(quat);
  return quatFromCameraDeg([pitchDeg, yawDeg, roll]);
}

/** the lift a camera's lookAt adds above the target's world origin -
 *  origins sit at feet/bases, not at the subject. A mannequin's origin is
 *  its floor contact; aiming there pitches the camera at the ground and
 *  crowds the figure into the frame top. ~0.78×figure height lands on the
 *  chest - a proper medium frame. */
function aimLift(n: StageNode, worldScaleY: number): number {
  return n.kind === "mannequin" ? n.props.height * worldScaleY * 0.78 : 0;
}

/** per-top-level-call camera-aim state: `memo` holds each camera's effective
 *  pose the FIRST time this call resolves it (chains share cameras when
 *  lookAts cross-reference, so without it nested camera chains re-resolve
 *  exponentially); `aiming` holds the cameras whose lookAt is currently
 *  resolving - a camera reached again while in there contributes its
 *  un-aimed (keyed/path) pose, which is what breaks an aim cycle. */
interface AimCtx {
  memo: Map<string, WorldPose>;
  aiming: Set<string>;
}

function worldOfInner(
  scene: StageScene, byId: Map<string, StageNode>, id: string, t: number,
  resolving: ReadonlySet<string>, ctx: AimCtx,
): WorldPose | null {
  if (resolving.has(id)) return null;
  let pos: V3 = [0, 0, 0], quat: Quat = [0, 0, 0, 1], scale: V3 = [1, 1, 1];
  // walk root→leaf so each parent applies its frame to the accumulated child
  const chain: StageNode[] = [];
  let cur: StageNode | undefined = byId.get(id);
  const guard = new Set<string>();
  while (cur) {
    if (guard.has(cur.id)) break;
    guard.add(cur.id);
    chain.unshift(cur);
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  if (!chain.length || chain[chain.length - 1].id !== id) return null;
  const next = new Set(resolving);
  next.add(id);
  for (const n of chain) {
    const known = n.kind === "camera" ? ctx.memo.get(n.id) : undefined;
    if (known) {
      pos = known.pos; quat = known.quat; scale = known.scale;
      continue;
    }
    const l = sampleNodeLocal(n, t);
    const lq = n.kind === "camera" ? quatFromCameraDeg(l.rot) : quatFromEulerDeg(l.rot);
    pos = vAdd(pos, qRotV(quat, vMul(scale, l.pos)));
    quat = qMul(quat, lq);
    scale = vMul(scale, l.scale);
    if (n.kind !== "camera") continue;
    if (n.props.path) {
      pos = pathPos(n.props.path, t);
      const f = pathTangent(n.props.path, t);
      quat = aimQuat(quat,
        Math.atan2(f[0], f[2]) * 180 / Math.PI,
        Math.atan2(f[1], Math.hypot(f[0], f[2])) * 180 / Math.PI);
    }
    if (ctx.aiming.has(n.id)) continue; // aim cycle - keyed/path pose stands
    ctx.aiming.add(n.id);
    const look = n.props.lookAt;
    if (look && look !== n.id && !next.has(look) && !inSubtree(byId, look, n.id)) {
      const target = worldOfInner(scene, byId, look, t, next, ctx);
      if (target) {
        const tn = byId.get(look);
        const lift = tn ? aimLift(tn, target.scale[1]) : 0;
        const d = vSub([target.pos[0], target.pos[1] + lift, target.pos[2]], pos);
        quat = aimQuat(quat,
          Math.atan2(d[0], d[2]) * 180 / Math.PI,
          Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180 / Math.PI);
      }
    }
    ctx.memo.set(n.id, { pos, quat, scale });
    ctx.aiming.delete(n.id);
  }
  return { pos, quat, scale };
}

/** world transform of `id` at t - parent chain composed as pos+quat+scale.
 *  A camera in the chain contributes its EFFECTIVE pose - path position and
 *  tangent aim, then lookAt aim - because a camera's children hang under
 *  what the shot actually does, not under its raw keyed transform. A lookAt
 *  that points into the camera's own subtree is ignored (the target's world
 *  position is exactly what this call is composing). Each camera's effective
 *  pose is resolved at most once per call (memo) and a camera re-reached
 *  while its own aim is resolving contributes its un-aimed pose - so
 *  cross-aimed camera chains stay linear instead of exponential. */
export function worldOf(
  scene: StageScene, id: string, t: number,
  resolving: ReadonlySet<string> = NO_IDS,
): WorldPose | null {
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  return worldOfInner(scene, byId, id, t, resolving, { memo: new Map(), aiming: new Set() });
}

/** yaw/pitch/roll (trajectory frame) back out of a camera quaternion */
export function cameraAnglesFromQuat(q: Quat): { yaw: number; pitch: number; roll: number } {
  const f = qRotV(q, [0, 0, 1]);
  const yaw = Math.atan2(f[0], f[2]) * 180 / Math.PI;
  const pitch = Math.atan2(f[1], Math.hypot(f[0], f[2])) * 180 / Math.PI;
  // residual roll: actual up vs the roll-free up at this yaw/pitch
  const q0 = quatFromCameraDeg([pitch, yaw, 0]);
  const u0 = qRotV(q0, [0, 1, 0]);
  const u = qRotV(q, [0, 1, 0]);
  const mag = Math.acos(Math.min(1, Math.max(-1, vDot(u0, u)))) * 180 / Math.PI;
  const sign = vDot(vCross(u, u0), f) >= 0 ? 1 : -1;
  return { yaw, pitch, roll: sign * mag };
}

/* ---------- Catmull-Rom path ---------- */

/** uniform-parameterisation CR through the control points; interpolates the
 *  knots exactly (control points lie on the path) */
export function catmullRom(points: V3[], u: number, i: number): V3 {
  const p1 = points[i], p2 = points[i + 1];
  const p0 = points[i - 1] ?? p1, p3 = points[i + 2] ?? p2;
  const u2 = u * u, u3 = u2 * u;
  const out = [0, 0, 0] as V3;
  for (let c = 0; c < 3; c++) {
    out[c] = 0.5 * (
      2 * p1[c]
      + (-p0[c] + p2[c]) * u
      + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * u2
      + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * u3
    );
  }
  return out;
}

/** position on a timed path at t - clamped to the end knots */
export function pathPos(path: CameraPath, t: number): V3 {
  const { points, times } = path;
  if (t <= times[0]) return [...points[0]];
  const n = points.length;
  if (t >= times[n - 1]) return [...points[n - 1]];
  let i = 0;
  while (i < n - 2 && t > times[i + 1]) i++;
  const u = (t - times[i]) / (times[i + 1] - times[i]);
  return catmullRom(points as V3[], u, i);
}

/** spline direction at t (finite difference - cheap and stable at knots) */
function pathTangent(path: CameraPath, t: number): V3 {
  const dt = Math.max(1e-3, (path.times[path.times.length - 1] - path.times[0]) / 1000);
  const a = pathPos(path, Math.max(path.times[0], t - dt));
  const b = pathPos(path, Math.min(path.times[path.times.length - 1], t + dt));
  return vNorm(vSub(b, a));
}

/* ---------- camera pose ---------- */

export interface CameraPose {
  pos: V3;
  yaw: number;
  pitch: number;
  roll: number;
  fov: number;      // horizontal degrees (trajectory convention)
  focalMm: number;
}

/**
 * The camera's pose at t - worldOf's effective-pose composition read back
 * as angles, so the render view, the gizmo and /inspect can never disagree:
 *   position:    props.path (world-space CR) > keyed/base transform (through parents)
 *   orientation: lookAt node > path tangent > keyed/base rot
 *   fov:         props.focalMm (keyable) through hFov()
 * A lookAt into the camera's own subtree is ignored (worldOf's rule - the
 * viewport draws under the same one).
 */
export function cameraAt(scene: StageScene, t: number, cameraId?: string): CameraPose | null {
  const cam = cameraId
    ? scene.nodes.find((n) => n.id === cameraId && n.kind === "camera")
    : scene.nodes.find((n): n is Extract<StageNode, { kind: "camera" }> => n.kind === "camera" && n.props.isRender)
      ?? scene.nodes.find((n): n is Extract<StageNode, { kind: "camera" }> => n.kind === "camera");
  if (!cam || cam.kind !== "camera") return null;

  const w = worldOf(scene, cam.id, t);
  if (!w) return null;
  const { yaw, pitch, roll } = cameraAnglesFromQuat(w.quat);
  const focalMm = Number(sampleProp(cam, "focalMm", t) ?? cam.props.focalMm);
  return { pos: w.pos, yaw, pitch, roll, fov: hFov(focalMm, cam.props.sensor as SensorName), focalMm };
}

/** every node's local TRS at t (what the editor inspector/timeline shows) */
export function sampleScene(scene: StageScene, t: number): Record<string, SampledNode> {
  const out: Record<string, SampledNode> = {};
  for (const n of scene.nodes) out[n.id] = sampleNodeLocal(n, t);
  return out;
}
