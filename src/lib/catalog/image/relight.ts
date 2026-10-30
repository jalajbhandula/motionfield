import type { ModelDef } from "../types";
import { lightingPrompt, relightSetupSchema, type RelightSetup } from "@/lib/relight/light";

/**
 * Relight - move and recolour the light in a photo.
 *   normals  DA3 depth → our normal map; the /relight page shades the photo
 *            live in the browser while you drag lights on the dome
 *   render   our light guide (OF_Relight) + a FLUX.2 klein 4B harmonise pass
 *            that keeps the subject and adopts the guide's light
 */

/** job params → validated setup (lights arrive as a JSON string param) */
export function relightSetupFromParams(p: Record<string, unknown>): RelightSetup {
  let lights: unknown = p.lights;
  if (typeof lights === "string") {
    try { lights = JSON.parse(lights); } catch { throw new Error("lights must be a JSON list of {az, el, color, power, soft}"); }
  }
  const parsed = relightSetupSchema.safeParse({
    lights,
    ambient: p.ambient === undefined ? 0.35 : Number(p.ambient),
    ambientColor: typeof p.ambient_color === "string" && p.ambient_color ? p.ambient_color : "#ffffff",
    strength: p.strength === undefined ? 0.85 : Number(p.strength),
  });
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new Error(`${i?.path.join(".") || "lights"}: ${i?.message ?? "invalid"}`);
  }
  return parsed.data;
}

const image = { name: "image_url", label: "Photo", type: "image" as const, required: true };

export const RELIGHT: ModelDef = {
  id: "relight", label: "Relight", vendor: "MotionField + FLUX.2 klein", kind: "edit",
  description: "Place up to three lights around your subject, pick a colour and softness, and relight the photo - identity and framing stay.",
  tags: ["relight", "lighting", "edit"],
  workflows: [
    {
      id: "normals", label: "Read the shape (normal map)", endpointId: "motionfield/relight/normals", kind: "edit",
      params: [image],
      cost: () => 0.1,
      providers: { comfy: { workflow: "relight-normals.json" } },
    },
    {
      id: "render", label: "Relight", endpointId: "motionfield/relight/render", kind: "edit",
      params: [
        image,
        { name: "lights", label: "Lights", type: "text", required: true,
          description: 'JSON list (1-3) of {az 0-359, el -30-90, color "#rrggbb", power 0-3, soft 0-1}' },
        { name: "ambient", label: "Ambient", type: "slider", min: 0, max: 2, step: 0.05, default: 0.35 },
        { name: "ambient_color", label: "Ambient colour", type: "text", default: "#ffffff" },
        { name: "strength", label: "Strength", type: "slider", min: 0, max: 1, step: 0.05, default: 0.85 },
        { name: "prompt", label: "Extra direction", type: "textarea", description: "Optional - added to the lighting instruction." },
        { name: "steps", label: "Steps", type: "integer", min: 1, max: 12, default: 4 },
        { name: "seed", label: "Seed", type: "integer", min: 0, max: 2147483647 },
      ],
      cost: () => 1,
      validate: (p) => {
        try { relightSetupFromParams(p); return null; } catch (e) { return (e as Error).message; }
      },
      providers: {
        comfy: {
          workflow: "relight-klein.json",
          map: (p) => {
            const s = relightSetupFromParams(p);
            const extra = typeof p.prompt === "string" && p.prompt.trim() ? ` ${p.prompt.trim().slice(0, 400)}` : "";
            return {
              LIGHTS: JSON.stringify(s.lights),
              AMBIENT: String(s.ambient),
              AMBIENT_COLOR: s.ambientColor,
              STRENGTH: String(s.strength),
              PROMPT: lightingPrompt(s) + extra,
              STEPS: String(p.steps ?? 4),
            };
          },
        },
      },
    },
  ],
};

/** Ordered catalog contribution of this file - barrels concatenate these. */
export const IMAGE_RELIGHT_MODELS: ModelDef[] = [RELIGHT];
