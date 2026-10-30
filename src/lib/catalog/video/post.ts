import type { ModelDef, ParamField } from "../types";
import { COLOR_PALETTES } from "../presets/palettes";
import type { GradeSpec } from "@/lib/grade/palette";
import {
  BEAT_CUT_ASPECTS, BEAT_CUT_ENDPOINT, BEAT_CUT_MAX_CLIPS, BEAT_CUT_MAX_LENGTH, BEAT_CUT_MIN_CLIPS,
  BEAT_CUT_PACES, BEAT_CUT_STYLES, beatCutParamsSchema,
} from "@/lib/beatcut";

/**
 * Palette - colour grade an owned image or video from a Director look, a
 * reference image ("match this look") or a 3-6 colour palette. Exactly one
 * source per job. Runs host-side (the video-post recipe: our LUT → ffmpeg
 * lut3d), no model weights involved.
 */

const HEX_LIST = /^#[0-9a-fA-F]{6}(,#[0-9a-fA-F]{6}){2,5}$/;

const sourceParams: ParamField[] = [
  { name: "look", label: "Look", type: "select", enum: COLOR_PALETTES, group: "grade",
    description: "One of the 50 authored looks (same as Camera Control's colour palettes)." },
  { name: "colors", label: "Palette colours", type: "text", group: "grade", placeholder: "#1d3557,#457b9d,#f1faee",
    description: "3-6 comma-separated #rrggbb colours - darkest tints the shadows, lightest the highlights." },
  { name: "reference_url", label: "Match this look", type: "image", group: "grade",
    description: "An owned reference image - its colour balance and contrast are transferred." },
  { name: "intensity", label: "Intensity", type: "slider", min: 0, max: 1, step: 0.05, default: 0.8 },
];

/** Exactly one grade source; reference stats are measured by the recipe. */
export function paletteSpecFromParams(p: Record<string, unknown>): GradeSpec {
  const look = typeof p.look === "string" && p.look ? p.look : null;
  const colors = typeof p.colors === "string" && p.colors.trim() ? p.colors.replace(/\s+/g, "") : null;
  const ref = typeof p.reference_url === "string" && p.reference_url ? p.reference_url : null;
  if ([look, colors, ref].filter(Boolean).length !== 1) throw new Error("pick exactly one of look, colors or reference_url");
  if (look) {
    if (!(COLOR_PALETTES as readonly string[]).includes(look)) throw new Error(`unknown look "${look}"`);
    return { kind: "look", id: look as (typeof COLOR_PALETTES)[number] };
  }
  if (colors) {
    if (!HEX_LIST.test(colors)) throw new Error("colors must be 3-6 comma-separated #rrggbb values");
    return { kind: "palette", colors: colors.split(",") };
  }
  // placeholder stats - the recipe measures the real ones from both files
  const flat = { mean: [0.5, 0, 0] as [number, number, number], std: [0.2, 0.05, 0.05] as [number, number, number] };
  return { kind: "match", source: flat, reference: flat };
}

function validate(p: Record<string, unknown>): string | null {
  try {
    paletteSpecFromParams(p);
  } catch (e) {
    return (e as Error).message;
  }
  const k = Number(p.intensity ?? 0.8);
  return Number.isFinite(k) && k >= 0 && k <= 1 ? null : "intensity must be 0-1";
}

export const PALETTE_GRADE: ModelDef = {
  id: "palette", label: "Color Grade", vendor: "MotionField", kind: "v2v",
  description: "Grade an image or video from a look, a reference image or a colour palette - our LUT, applied by ffmpeg at full resolution. No model weights.",
  tags: ["grade", "color", "lut", "palette"],
  workflows: [
    {
      id: "grade-image", label: "Grade an image", endpointId: "motionfield/palette/grade-image", kind: "edit",
      params: [{ name: "image_url", label: "Image", type: "image", required: true }, ...sourceParams],
      cost: () => 0.1,
      validate,
      providers: { recipe: { name: "video-post" } },
    },
    {
      id: "grade-video", label: "Grade a video", endpointId: "motionfield/palette/grade-video", kind: "v2v",
      params: [{ name: "video_url", label: "Video", type: "video", required: true, maxSeconds: 120 }, ...sourceParams],
      cost: () => 1,
      validate,
      providers: { recipe: { name: "video-post" } },
    },
  ],
};

/** ReCut · cut to music - several clips edited on a track's beat, with
 *  transitions on bar starts. Host-side (beat-cut recipe), no weights. */
export const BEAT_CUT: ModelDef = {
  id: "beat-cut", label: "Re-edit Video · cut to music", vendor: "MotionField", kind: "v2v",
  description: "Edit several clips to a music track: finds the tempo and bars, cuts on the beat (faster where the track is louder) and adds transitions on bar starts. ffmpeg only, no model weights.",
  tags: ["edit", "music", "beat", "montage"],
  workflows: [
    {
      id: "v1", label: "Cut to music", endpointId: BEAT_CUT_ENDPOINT, kind: "v2v",
      params: [
        { name: "video_urls", label: "Clips", type: "media", required: true, minItems: BEAT_CUT_MIN_CLIPS, maxItems: BEAT_CUT_MAX_CLIPS, accepts: "video/*",
          description: "Used in this order, taking turns; each clip carries on where it left off." },
        { name: "audio_url", label: "Music", type: "audio", required: true, description: "Any track with a clear rhythm, up to 10 minutes." },
        { name: "pace", label: "Cut every", type: "select", enum: BEAT_CUT_PACES, default: "auto",
          description: "auto follows the energy - quick cuts where it's loud, longer holds where it's quiet. Or a fixed number of beats." },
        { name: "style", label: "Transitions", type: "select", enum: BEAT_CUT_STYLES, default: "dynamic",
          description: "dynamic: whips/zooms on loud bar starts, fades on quiet ones · cut: straight cuts · smooth: crossfades · punchy: flash and zoom on bars" },
        { name: "aspect_ratio", label: "Aspect", type: "select", enum: BEAT_CUT_ASPECTS, default: "9:16" },
        { name: "length", label: "Length (s)", type: "slider", min: 5, max: BEAT_CUT_MAX_LENGTH, step: 1, default: 20 },
        { name: "music_start", label: "Start the track at (s)", type: "number", min: 0, max: 600, step: 0.5, default: 0 },
      ],
      cost: () => 0.5,
      validate: (p) => {
        const r = beatCutParamsSchema.safeParse(p);
        return r.success ? null : (r.error.issues[0]?.message ?? "invalid params");
      },
      providers: { recipe: { name: "beat-cut" } },
    },
  ],
};

export const VIDEO_POST_MODELS: ModelDef[] = [PALETTE_GRADE, BEAT_CUT];
