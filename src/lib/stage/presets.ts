import { cameraAnglesFromQuat, worldOf } from "./sample";
import type { StageCameraNode, StageNode, StageScene, Vec3 } from "./scene";
import { StageOpError } from "./ops";

/**
 * Camera placement presets - subject-bound framings a picker or an agent
 * can stamp onto any camera node. An offset is expressed in the SUBJECT's
 * own frame (+z = the way the subject faces, +x = its right, +y = up), so
 * the same preset lands correctly no matter which way a figure has been
 * turned. The aim point defaults to chest height; the camera also takes
 * props.lookAt = the subject, so it keeps aiming at it when the subject
 * moves later. `follow` additionally parents the camera to the subject -
 * its offset then rides along with the subject's motion (position AND
 * aim follow; the base rot stays zeroed and lookAt does the pointing).
 */

export interface CameraPreset {
  id: string;
  label: string;
  /** metres in the subject frame: x = subject's right, y = up, z = in FRONT */
  offset: Vec3;
  /** aim point in the subject frame (defaults to chest, [0, 1.4, 0]) */
  aimLocal?: Vec3;
  focalMm: number;
  /** extra roll, degrees (dutch framings) */
  roll?: number;
  note: string;
}

export const CAMERA_PRESETS: readonly CameraPreset[] = [
  { id: "wide-establishing", label: "Wide establishing", offset: [4.5, 2.2, 9], focalMm: 24, note: "full figure plus the world around it" },
  { id: "medium", label: "Medium", offset: [0.8, 1.55, 4.2], focalMm: 40, note: "waist-up, the default dialogue frame" },
  { id: "close-up", label: "Close-up", offset: [0.35, 1.6, 1.6], focalMm: 65, aimLocal: [0, 1.5, 0], note: "head and shoulders" },
  { id: "over-the-shoulder", label: "Over the shoulder", offset: [-1.0, 1.75, -1.6], focalMm: 50, aimLocal: [0, 1.4, 4], note: "past the subject toward what it faces" },
  { id: "low-angle", label: "Low angle", offset: [0, 0.45, 3.2], focalMm: 32, aimLocal: [0, 1.5, 0], note: "looking up - heroic read" },
  { id: "high-angle", label: "High angle", offset: [1.2, 4.5, 3.0], focalMm: 35, aimLocal: [0, 0.9, 0], note: "looking down on the subject" },
  { id: "birds-eye", label: "Bird's-eye", offset: [0.3, 8.5, 0.6], focalMm: 24, aimLocal: [0, 0.5, 0], note: "straight-down plan view of the blocking" },
  { id: "profile-left", label: "Profile (left)", offset: [-3.8, 1.5, 0], focalMm: 50, aimLocal: [0, 1.3, 0], note: "the subject's left side" },
  { id: "profile-right", label: "Profile (right)", offset: [3.8, 1.5, 0], focalMm: 50, aimLocal: [0, 1.3, 0], note: "the subject's right side" },
  { id: "three-quarter", label: "Three-quarter front", offset: [2.6, 1.9, 3.6], focalMm: 45, aimLocal: [0, 1.3, 0], note: "the classic ¾ frame" },
  { id: "dutch-tilt", label: "Dutch tilt", offset: [0, 1.5, 4.0], focalMm: 40, aimLocal: [0, 1.3, 0], roll: 12, note: "level frame, canted horizon" },
];
export const CAMERA_PRESET_IDS = CAMERA_PRESETS.map((p) => p.id);

const DEG = Math.PI / 180;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const rotY = (v: Vec3, yawDeg: number): Vec3 => {
  const s = Math.sin(yawDeg * DEG), c = Math.cos(yawDeg * DEG);
  return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
};

/** content nodes a preset can be bound to (lights and cameras excluded) */
export function presetSubjects(scene: StageScene): StageNode[] {
  return scene.nodes.filter((n) => n.kind === "mannequin" || n.kind === "primitive" || n.kind === "model");
}

function findCam(scene: StageScene, id: string): StageCameraNode {
  const n = scene.nodes.find((x): x is StageCameraNode => x.id === id && x.kind === "camera");
  if (!n) throw new StageOpError(`camera "${id}" doesn't exist`);
  return n;
}

/**
 * Stamp `presetId` onto camera `cameraId` bound to `subjectId`.
 * Mutates `scene` (callers pass a clone). The camera ends up aimed at the
 * subject's aim point with lookAt set; with `follow` the camera parents to
 * the subject so its offset and aim both track the subject's motion.
 */
export function applyCameraPreset(
  scene: StageScene, cameraId: string, subjectId: string, presetId: string,
  opts: { follow?: boolean } = {},
): void {
  const preset = CAMERA_PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new StageOpError(`unknown camera preset "${presetId}"`);
  const cam = findCam(scene, cameraId);
  const subject = scene.nodes.find((n) => n.id === subjectId);
  if (!subject) throw new StageOpError(`subject "${subjectId}" doesn't exist`);
  if (subject.kind === "camera" || subject.kind === "light")
    throw new StageOpError(`"${subjectId}" is a ${subject.kind} - presets bind to scene content`);

  const w = worldOf(scene, subjectId, 0);
  if (!w) throw new StageOpError(`subject "${subjectId}" has no world transform`);
  const yaw = cameraAnglesFromQuat(w.quat).yaw; // subject facing, degrees
  const aim = preset.aimLocal ?? [0, 1.4, 0];
  const pos: Vec3 = w.pos.map((v, i) => v + rotY(preset.offset, yaw)[i]) as Vec3;
  const aimW: Vec3 = w.pos.map((v, i) => v + rotY(aim, yaw)[i]) as Vec3;

  const d: Vec3 = [aimW[0] - pos[0], aimW[1] - pos[1], aimW[2] - pos[2]];
  const aimYaw = Math.atan2(d[0], d[2]) / DEG;
  const aimPitch = Math.atan2(d[1], Math.hypot(d[0], d[2])) / DEG;

  if (opts.follow) {
    if (cam.id === subjectId) throw new StageOpError("a camera can't follow itself");
    cam.parent = subject.id;
    cam.transform.pos = preset.offset.map(r4) as Vec3;
    cam.transform.rot = [0, 0, preset.roll ?? 0];
  } else {
    delete cam.parent;
    cam.transform.pos = pos.map(r4) as Vec3;
    // world→local aim yaw compensates nothing - camera rot is a trajectory-
    // frame [pitch,yaw,roll]; a root-parented camera uses it outright
    cam.transform.rot = [r4(aimPitch), r4(aimYaw), preset.roll ?? 0];
  }
  cam.props.lookAt = subject.id;
  cam.props.focalMm = preset.focalMm;
}

/**
 * The bird's-eye overview helper - a non-render camera parked above the
 * scene's content, pointing straight down for layout checks. It is never
 * marked isRender (the editor's "Layout camera" button creates/updates it).
 * Returns the fields the caller stamps onto a camera node.
 */
export function overviewCameraPose(scene: StageScene): { pos: Vec3; rot: Vec3; focalMm: number } {
  let min: Vec3 = [-4, 0, -4], max: Vec3 = [4, 2, 4];
  let seen = false;
  for (const n of scene.nodes) {
    if (n.kind === "camera" || n.kind === "light") continue;
    const w = worldOf(scene, n.id, 0);
    if (!w) continue;
    seen = true;
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], w.pos[c] - 1.5);
      max[c] = Math.max(max[c], w.pos[c] + 1.5);
    }
  }
  void seen;
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  const span = Math.max(max[0] - min[0], max[2] - min[2], 4);
  return {
    pos: [r4(cx), r4(Math.max(max[1] + 3, span * 1.4)), r4(cz + 0.01)],
    rot: [-89, 0, 0],
    focalMm: 20,
  };
}
