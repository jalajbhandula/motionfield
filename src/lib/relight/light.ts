import { z } from "zod";

/**
 * Relight - lights on a dome around the subject plus an ambient fill. The
 * same numbers drive three things: the live browser preview (shade.ts),
 * OF_Relight's light guide (comfy-nodes/motionfield_nodes/core/relight.py) and
 * the klein harmonise prompt (lightingPrompt below).
 *
 *   az  0 = from the camera side, 90 = frame right, 180 = behind, 270 = frame left
 *   el  0 = horizon, 90 = overhead (down to -30 for under-lighting)
 */

export const MAX_LIGHTS = 3;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a #rrggbb colour");

export const relightLightSchema = z.strictObject({
  az: z.number().min(0).max(359.99),
  el: z.number().min(-30).max(90),
  color: hex,
  /** 0-3 */
  power: z.number().min(0).max(3),
  /** 0 hard … 1 very soft */
  soft: z.number().min(0).max(1),
});
export type RelightLight = z.infer<typeof relightLightSchema>;

export const relightSetupSchema = z.strictObject({
  lights: z.array(relightLightSchema).min(1).max(MAX_LIGHTS),
  ambient: z.number().min(0).max(2),
  ambientColor: hex,
  /** how far the guide departs from the photo's own light, 0-1 */
  strength: z.number().min(0).max(1),
});
export type RelightSetup = z.infer<typeof relightSetupSchema>;

export type RelightPreset = { id: string; label: string; hint: string; setup: RelightSetup };

const L = (az: number, el: number, color: string, power: number, soft: number): RelightLight => ({ az, el, color, power, soft });

/** Our own preset set - named for what they look like. */
export const RELIGHT_PRESETS: RelightPreset[] = [
  { id: "golden-hour", label: "Golden hour", hint: "low warm sun from the side, soft blue fill",
    setup: { lights: [L(290, 12, "#ffb469", 1.5, 0.35)], ambient: 0.35, ambientColor: "#9fb4d9", strength: 0.85 } },
  { id: "studio-key", label: "Studio key", hint: "45° soft key, gentle fill",
    setup: { lights: [L(315, 35, "#fff4e8", 1.2, 0.55), L(60, 15, "#e8f0ff", 0.35, 0.8)], ambient: 0.3, ambientColor: "#ffffff", strength: 0.8 } },
  { id: "rembrandt", label: "Rembrandt", hint: "high side key, deep shadow side",
    setup: { lights: [L(300, 45, "#fff0dc", 1.5, 0.25)], ambient: 0.12, ambientColor: "#ffffff", strength: 0.9 } },
  { id: "rim", label: "Rim light", hint: "bright edge from behind, dark front",
    setup: { lights: [L(180, 20, "#ffffff", 1.8, 0.1), L(0, 10, "#cfd8ff", 0.3, 0.9)], ambient: 0.18, ambientColor: "#ffffff", strength: 0.9 } },
  { id: "neon", label: "Neon split", hint: "magenta left, cyan right",
    setup: { lights: [L(270, 10, "#ff2fb4", 1.4, 0.3), L(90, 10, "#22e3ff", 1.4, 0.3)], ambient: 0.12, ambientColor: "#1b1430", strength: 0.9 } },
  { id: "overhead", label: "Overhead", hint: "top-down light, shadowed eyes",
    setup: { lights: [L(0, 85, "#fffaf0", 1.5, 0.3)], ambient: 0.2, ambientColor: "#ffffff", strength: 0.85 } },
  { id: "candle", label: "Candlelight", hint: "low, warm, close, flickery",
    setup: { lights: [L(30, -5, "#ff9d3c", 1.6, 0.5)], ambient: 0.1, ambientColor: "#2a1a10", strength: 0.9 } },
  { id: "moonlight", label: "Moonlight", hint: "cool high light, dim blue night",
    setup: { lights: [L(60, 50, "#a8c4ff", 1.0, 0.4)], ambient: 0.15, ambientColor: "#1c2a4a", strength: 0.9 } },
  { id: "window", label: "Window light", hint: "big soft daylight from one side",
    setup: { lights: [L(80, 20, "#f4f8ff", 1.3, 0.85)], ambient: 0.3, ambientColor: "#e8ecf2", strength: 0.8 } },
  { id: "sunset-back", label: "Sunset backlight", hint: "orange halo from behind, warm fill",
    setup: { lights: [L(170, 8, "#ff8a3d", 1.7, 0.25), L(10, 10, "#ffd2b0", 0.4, 0.8)], ambient: 0.25, ambientColor: "#6d5a7a", strength: 0.9 } },
];

export const DEFAULT_SETUP = RELIGHT_PRESETS[0].setup;

function where(az: number, el: number): string {
  if (el >= 70) return "directly overhead";
  const side = az < 30 || az >= 330 ? "the front" : az < 150 ? "the right" : az < 210 ? "behind" : "the left";
  if (el < 0) return side === "behind" ? "from below, behind the subject" : side === "the front" ? "from below in front" : `from below on ${side}`;
  const height = el < 20 ? "low" : el < 50 ? "at a 45° angle" : "high above";
  return side === "behind" ? `${height === "low" ? "low " : ""}behind the subject` : `${height} from ${side}`;
}

const HUES: [number, string][] = [
  [12, "red"], [34, "warm orange"], [55, "golden"], [75, "yellow"], [160, "green"],
  [195, "cyan"], [250, "cool blue"], [285, "violet"], [345, "magenta"], [360, "red"],
];

/** Plain-words colour by hue/saturation - near-greys read as (warm/cool) white. */
export function colourWord(hexColor: string): string {
  const n = parseInt(hexColor.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  const sat = max ? d / max : 0;
  const hue = d === 0 ? 0 : max === r ? (60 * ((g - b) / d) + 360) % 360 : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  if (sat < 0.12) return max > 190 ? "white" : "neutral";
  if (sat < 0.33) return hue < 75 || hue >= 330 ? "warm white" : hue >= 170 && hue < 260 ? "cool white" : "softly tinted";
  return HUES.find(([lim]) => hue < lim)![1];
}

/** The harmonise instruction klein gets alongside the guide image. */
export function lightingPrompt(s: RelightSetup): string {
  const parts = s.lights.map((l, i) => {
    const kind = l.az >= 150 && l.az <= 210 ? "rim light" : i === 0 ? "key light" : "fill light";
    const quality = l.soft > 0.6 ? "soft" : l.soft < 0.25 ? "hard" : "";
    return `a ${[quality, colourWord(l.color)].filter(Boolean).join(" ")} ${kind} ${where(l.az, l.el)}`;
  });
  const mood = s.ambient < 0.2 ? "dark, moody surroundings with deep shadows" : s.ambient > 0.5 ? "bright, airy fill" : "natural fill";
  return `Relight this photo with ${parts.join(", ")} and ${mood}, exactly as in the first reference. ` +
    "Keep the same person or subject, pose, framing, background and every detail from the second reference; " +
    "only the lighting changes - realistic light falloff, shadows and highlights, photographic quality.";
}
