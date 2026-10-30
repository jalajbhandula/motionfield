/** Camera moves expressible as an end keyframe cropped from the first
 *  frame (pure - safe for the client catalog; the sharp side lives in
 *  lib/camera-keyframe). Only moves that END INSIDE the still are listed:
 *  an outward move would need invented pixels for its end frame. */
export const KEYFRAME_MOVES = {
  "dolly-in": { zoom: 1.45, dx: 0, dy: 0, phrase: "the camera dollies in smoothly toward the subject" },
  "dolly-in-left": { zoom: 1.35, dx: -0.8, dy: 0, phrase: "the camera pushes in while drifting left" },
  "dolly-in-right": { zoom: 1.35, dx: 0.8, dy: 0, phrase: "the camera pushes in while drifting right" },
  "tilt-up": { zoom: 1.3, dx: 0, dy: -0.8, phrase: "the camera pushes in and tilts up" },
  "tilt-down": { zoom: 1.3, dx: 0, dy: 0.8, phrase: "the camera pushes in and tilts down" },
} as const;
export type KeyframeMove = keyof typeof KEYFRAME_MOVES;
export const KEYFRAME_MOVE_IDS = Object.keys(KEYFRAME_MOVES) as KeyframeMove[];

/** Crop rect (integer px) of a w×h still for a move's end frame. dx/dy in
 *  [-1, 1] slide the crop from centre to the edge. */
export function endCropRect(w: number, h: number, move: KeyframeMove) {
  const m = KEYFRAME_MOVES[move];
  const cw = Math.round(w / m.zoom), ch = Math.round(h / m.zoom);
  const left = Math.round(((w - cw) / 2) * (1 + m.dx));
  const top = Math.round(((h - ch) / 2) * (1 + m.dy));
  return {
    left: Math.min(Math.max(0, left), w - cw), top: Math.min(Math.max(0, top), h - ch),
    width: cw, height: ch,
  };
}

