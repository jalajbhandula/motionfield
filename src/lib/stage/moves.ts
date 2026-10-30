import { composeTrajectory, MOVES } from "@/lib/camera/trajectory";
import { TRAJECTORIES } from "@/lib/catalog/presets/trajectories";
import { focalForHFov, type SensorName } from "@/lib/camera/lens";
import { cameraAt, worldOf } from "./sample";
import type { StageCameraNode, StageKey, StageScene, Vec3 } from "./scene";
import { StageOpError } from "./ops";

/**
 * Apply a catalog camera move to a stage camera: composeTrajectory produces
 * per-frame {pos,yaw,pitch,roll,fov} deltas in the base-camera frame - this
 * transplants them into the scene's world frame (base = the camera's pose at
 * t=0) and bakes the result into the node's keys at the scene's fps.
 *
 * Writing keys (not a stored "move" prop) means sampling stays honest: at
 * every t the camera pose comes from the same interpolation the exported
 * trajectory uses. An authored props.path is replaced by the baked keys -
 * a move IS the path afterwards. Long scenes are decimated so the key list
 * stays inside the 256 KB document budget.
 */

const DEG = Math.PI / 180;

/** forward direction for a yaw/pitch pair (+z forward, yaw→+x, pitch→+y) */
function fwd(yaw: number, pitch: number): Vec3 {
  const cy = Math.cos(yaw * DEG), sy = Math.sin(yaw * DEG);
  const cp = Math.cos(pitch * DEG), sp = Math.sin(pitch * DEG);
  return [sy * cp, sp, cy * cp];
}
const norm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function applyMoveToCamera(
  scene: StageScene,
  cameraId: string,
  moveId: string,
  opts: { strength?: number; seed?: number; durationS?: number } = {},
): void {
  if (!MOVES[moveId]) throw new StageOpError(`unknown move "${moveId}"`);
  const cam = scene.nodes.find((n): n is StageCameraNode => n.id === cameraId && n.kind === "camera");
  if (!cam) throw new StageOpError(`camera "${cameraId}" doesn't exist`);

  const base = cameraAt(scene, 0, cameraId) ?? { pos: [0, 0, 0] as Vec3, yaw: 0, pitch: 0, roll: 0, fov: 40, focalMm: cam.props.focalMm };
  const F = fwd(base.yaw, base.pitch);
  // the trajectory's world frame is left-handed-ish (+z forward, x right):
  // right = forward × up gives -x for forward=+z - so right = up × forward? For
  // fwd=+z: up×F = (0,1,0)×(0,0,1) = (1,0,0) = +x ✓
  const R = norm(cross([0, 1, 0], F));
  const U = norm(cross(F, R));

  // subject distance for move scaling: lookAt target, else 4 m
  let distance = 4;
  let anchors: { subject?: Vec3 } | undefined;
  if (cam.props.lookAt) {
    const tgt = worldOf(scene, cam.props.lookAt, 0);
    if (tgt) {
      distance = Math.max(0.5, Math.hypot(tgt.pos[0] - base.pos[0], tgt.pos[1] - base.pos[1], tgt.pos[2] - base.pos[2]));
      anchors = { subject: tgt.pos };
    }
  }

  const { meta } = scene;
  // the move can occupy only the head of the scene - a shorter duration
  // bakes the move over [0, durationS] and the tail holds its end pose
  const moveDur = Math.min(opts.durationS ?? meta.duration, meta.duration);
  const traj = composeTrajectory({
    moves: [moveId],
    strength: opts.strength ?? 1,
    duration: moveDur,
    fps: meta.fps,
    seed: opts.seed ?? 0,
    distance,
    fov: base.fov,
    layer: "scene",
    ...(anchors ? { anchors } : {}),
  });

  // decimate so baked keys stay well inside the 256 KB document budget -
  // ≤ ~600 frames of keys; moves are smooth enough that linear keys recover
  // the same curve between samples
  const step = Math.max(1, Math.ceil(traj.frames.length / 600));
  const keys: StageKey[] = [];
  for (let i = 0; i < traj.frames.length; i += step) {
    const fr = traj.frames[i];
    const t = Math.min(fr.t, meta.duration);
    // frame.pos is in the base-camera frame → world via (R,U,F) basis
    const w: Vec3 = [
      base.pos[0] + R[0] * fr.pos[0] + U[0] * fr.pos[1] + F[0] * fr.pos[2],
      base.pos[1] + R[1] * fr.pos[0] + U[1] * fr.pos[1] + F[1] * fr.pos[2],
      base.pos[2] + R[2] * fr.pos[0] + U[2] * fr.pos[1] + F[2] * fr.pos[2],
    ].map(r4) as Vec3;
    const rot: Vec3 = [r4(base.pitch + fr.pitch), r4(base.yaw + fr.yaw), r4(base.roll + fr.roll)];
    keys.push({ t: r4(t), path: "transform.pos", value: w });
    keys.push({ t: r4(t), path: "transform.rot", value: rot });
    keys.push({
      t: r4(t),
      path: "props.focalMm",
      value: r4(focalForHFov(fr.fov, cam.props.sensor as SensorName)),
    });
  }
  // final frame: at moveDur when the tail holds, else exactly at duration
  const last = traj.frames[traj.frames.length - 1];
  if ((traj.frames.length - 1) % step !== 0 || moveDur < meta.duration) {
    const w: Vec3 = [
      base.pos[0] + R[0] * last.pos[0] + U[0] * last.pos[1] + F[0] * last.pos[2],
      base.pos[1] + R[1] * last.pos[0] + U[1] * last.pos[1] + F[1] * last.pos[2],
      base.pos[2] + R[2] * last.pos[0] + U[2] * last.pos[1] + F[2] * last.pos[2],
    ].map(r4) as Vec3;
    const endRot: Vec3 = [r4(base.pitch + last.pitch), r4(base.yaw + last.yaw), r4(base.roll + last.roll)];
    const endFocal = r4(focalForHFov(last.fov, cam.props.sensor as SensorName));
    const lastT = r4(Math.min(last.t, moveDur));
    keys.push({ t: lastT, path: "transform.pos", value: w });
    keys.push({ t: lastT, path: "transform.rot", value: endRot });
    keys.push({ t: lastT, path: "props.focalMm", value: endFocal });
    if (moveDur < meta.duration) { // hold the end pose to the scene's end
      keys.push({ t: meta.duration, path: "transform.pos", value: w });
      keys.push({ t: meta.duration, path: "transform.rot", value: endRot });
      keys.push({ t: meta.duration, path: "props.focalMm", value: endFocal });
    }
  }

  cam.keys = keys;
  delete cam.props.path; // the baked keys ARE the path now
}

export const MOVE_IDS = Object.keys(MOVES);

/* ---------- loose move-name matching (writer drafts, agents) ---------- */

const normMove = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/* Common-language names → catalog ids. Only unambiguous phrases, only ids
 * that exist in MOVES - anything else falls through to null (writer ignores
 * it, ops 400s). */
const MOVE_SYNONYMS: Record<string, string> = {
  pushin: "dolly-in", push: "dolly-in", closer: "dolly-in",
  pullout: "dolly-out", pullback: "dolly-out", away: "dolly-out",
  creepin: "slow-creep-in", creep: "slow-creep-in",
  staticshot: "locked-off", static: "locked-off", still: "locked-off", fixed: "locked-off",
  orbit: "orbit-360", around: "orbit-360",
  boomup: "crane-up", boomdown: "crane-down",
  handheld: "handheld-subtle", shake: "handheld-subtle", shaky: "handheld-subtle",
  follow: "follow-behind", chase: "chase-follow",
  trackleft: "side-track-left", trackright: "side-track-right",
  riseup: "pedestal-up", rise: "overhead-rise",
  lookup: "tilt-up", lookdown: "tilt-down",
  flyover: "drone-flyover", dive: "fpv-dive",
  vertigo: "dolly-zoom-in", dollyzoom: "dolly-zoom-in",
};

/** Free text → catalog move id: exact id, id/label minus separators and
 *  case, a leading speed word stripped ("slow dolly-in" → dolly-in), a
 *  common-language synonym ("push in" → dolly-in), then a unique prefix
 *  match. Labels come from the catalog trajectory presets so a picker name
 *  resolves to the same id. */
export function matchStageMoveId(raw: string): string | null {
  const q = normMove(raw);
  if (!q) return null;
  if (MOVES[q]) return q;
  const strip = q.replace(/^(slow|slowly|gentle|subtle|fast|quick|hard|very|big|tiny|the|a|an)/, "");
  if (strip && MOVES[strip]) return strip;
  const syn = MOVE_SYNONYMS[q] ?? (strip ? MOVE_SYNONYMS[strip] : undefined);
  if (syn && MOVES[syn]) return syn;
  let hit: string | null = null;
  let hits = 0;
  for (const t of TRAJECTORIES) {
    if (normMove(t.id) === q || normMove(t.label) === q || (strip && normMove(t.id) === strip)) {
      if (MOVES[t.id]) return t.id;
    }
  }
  for (const id of MOVE_IDS) {
    const n = normMove(id);
    if (n === q || (q.length >= 5 && n.startsWith(q)) || (strip && n === strip)) { hit = id; hits++; }
  }
  return hits === 1 ? hit : null;
}
