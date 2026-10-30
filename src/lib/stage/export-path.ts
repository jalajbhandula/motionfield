import { KeyframeSchema, type Keyframe } from "@/lib/camera/trajectory";
import { cameraAt } from "./sample";
import { StageOpError } from "./ops";
import type { StageScene } from "./scene";

/**
 * Export the render camera's path as a Trajectory-shaped keyframe list:
 * {moves: [], layer: "scene", frames} with round(duration×fps)+1 samples -
 * every frame individually validated against the engine's KeyframeSchema so
 * s5's render side consumes the same contract.
 */
export function exportCameraPath(scene: StageScene): { moves: string[]; layer: "scene"; frames: Keyframe[] } {
  const { duration, fps } = scene.meta;
  const count = Math.round(duration * fps) + 1;
  const frames: Keyframe[] = [];
  for (let i = 0; i < count; i++) {
    const t = Math.min(i / fps, duration);
    const pose = cameraAt(scene, t);
    if (!pose) throw new StageOpError("scene has no render camera");
    frames.push(KeyframeSchema.parse({
      t: Math.round(t * 1e4) / 1e4,
      pos: pose.pos.map((v) => Math.round(v * 1e6) / 1e6),
      yaw: Math.round(pose.yaw * 1e4) / 1e4,
      pitch: Math.round(pose.pitch * 1e4) / 1e4,
      roll: Math.round(pose.roll * 1e4) / 1e4,
      fov: Math.min(170, Math.max(1e-3, pose.fov)),
    }));
  }
  return { moves: [], layer: "scene", frames };
}
