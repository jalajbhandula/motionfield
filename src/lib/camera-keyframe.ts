/** Real camera moves for LTX image-to-video without camera weights: the
 *  first frame is the user's still, the end keyframe is a crop of that same
 *  still that matches where the camera lands, and the keyframe graph
 *  (ltx-vfx-keyframe.json) resolves the clip onto it. LTX then has to move
 *  the camera - it no longer depends on following a prompt.
 *
 *  Only moves that END INSIDE the still are offered: an outward move (dolly
 *  out, pan past the edge) would need invented pixels for its end frame. */
import crypto from "crypto";
import sharp from "sharp";
import { saveBytes } from "@/lib/storage";

import { KEYFRAME_MOVES, endCropRect, type KeyframeMove } from "@/lib/camera/keyframe-moves";
export { KEYFRAME_MOVES, type KeyframeMove };

/** Writes the end keyframe for `move` next to the uploads; returns its /files/ url. */
export async function makeEndKeyframe(stillPath: string, move: KeyframeMove): Promise<string> {
  const img = sharp(stillPath).rotate();
  const meta = await img.metadata();
  const w = meta.autoOrient?.width ?? meta.width!, h = meta.autoOrient?.height ?? meta.height!;
  const buf = await img.extract(endCropRect(w, h, move)).resize(w, h, { kernel: "lanczos3" }).jpeg({ quality: 95 }).toBuffer();
  return saveBytes(`uploads/kf-${crypto.randomUUID()}.jpg`, buf);
}
