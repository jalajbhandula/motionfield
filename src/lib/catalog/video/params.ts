import type { ParamField } from "../types";

/** Shared param-field factories for the video/avatar endpoint definitions. */

export const prompt = (req = true): ParamField => ({
  name: "prompt", label: "Prompt", type: "prompt", required: req,
  placeholder: "Describe your video… Use @ to reference uploaded media.",
});
export const dur = (vals: number[], def = 5): ParamField => ({ name: "duration", label: "Duration", type: "select", default: def, enum: vals });
export const arVideo: ParamField = { name: "aspect_ratio", label: "Ratio", type: "select", default: "16:9", enum: ["16:9", "9:16", "1:1"] };
export const resV = (opts: string[] = ["480p", "720p", "1080p"], def = "720p"): ParamField => ({ name: "resolution", label: "Resolution", type: "select", default: def, enum: opts });
export const audioBool: ParamField = { name: "generate_audio", label: "Generate audio", type: "boolean", default: true };
export const negP: ParamField = { name: "negative_prompt", label: "Negative prompt", type: "text", default: "", placeholder: "blur, distortion, low quality" };
export const fps: ParamField = { name: "fps", label: "FPS", type: "select", default: 25, enum: [24, 25] };
export const steps = (def = 20): ParamField => ({ name: "steps", label: "Sampler steps", type: "integer", default: def, min: 2, max: 50, description: "Fewer = faster drafts" });
/** finishing pass toggle - RealESRGAN 2× + RIFE 2× fps (workflows/video-finish.json);
 *  declared on video finals so the server default (on) applies even to pages
 *  that don't render the toggle. Drafts send draft:true and skip it. */
export const finish: ParamField = {
  name: "finish", label: "Finish: 2× sharper + smoother", type: "boolean", default: true, group: "Finish",
  description: "Runs a 2× RealESRGAN upscale + 2× RIFE frame-interpolation pass on the final video, then a light sharpen/grain - extra GPU time; the un-finished render is kept too.",
};
export const firstFrame: ParamField = { name: "image_url", label: "First frame", type: "image", required: true, accepts: "image/*" };
export const camMove: ParamField = {
  name: "camera_movement", label: "Camera movement", type: "select", group: "Camera",
  enum: ["static-shot", "dolly-in", "dolly-out", "dolly-zoom", "truck-left", "truck-right", "pan-left", "pan-right", "tilt-up", "tilt-down", "crane-up", "crane-down", "pedestal-up", "pedestal-down", "side-tracking", "tracking", "arc-left", "arc-right", "drone-orbit", "aerial-pullback", "frozen-orbit", "whip-pan", "rack-focus", "crush-zoom", "slow-zoom-in", "slow-zoom-out", "handheld", "body-mount", "robot-arm", "pov", "helicopter-shot"],
};

/** cost helpers */
export const per5s = (table: Record<string, number>) => (p: Record<string, unknown>) =>
  (table[String(p.resolution ?? "720p")] ?? 5) * ((Number(p.duration) || 5) / 5);

export const vaceSource: ParamField = { name: "video_url", label: "Source video (≥4s, ≤30s)", type: "video", required: true, minSeconds: 4, maxSeconds: 30 };
