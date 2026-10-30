import type { PresetDef } from "../types";
import { registerCatalog, type PresetSpec } from "./schema";

/* ============ Character look presets ============
 *  Look presets select a visual identity on image jobs. Today they are only
 *  prompt fragments on plain t2i - the look never reaches a graph input -
 *  so every entry is hidden until a real look executor (LoRA/adapter or a
 *  post-grade pass) exists. The declared mechanism records what an honest
 *  executor would run; specs stay in the registry so verification tooling
 *  can see them coming.
 *
 *  The legacy PresetDef array is derived from the specs so findPreset and
 *  resolveParams keep resolving ids (the API gate rejects them as hidden). */

export interface StyleSpec extends PresetSpec {
  promptFragment?: string;
}

const hue = (id: string) => Math.abs([...id].reduce((a, c) => a + c.charCodeAt(0), 0)) % 360;

const LOOK_HIDDEN = { reason: "needs a mechanism - looks are prompt-fragment only on t2i today; a LoRA/post-grade executor is pending" };

const look = (id: string, label: string, description: string, fragment = ""): StyleSpec => ({
  id, label, description, catalog: "style", collection: "looks",
  inputs: ["prompt"],
  mechanism: { kind: "lora", weights: `looks/${id}.safetensors` },
  apply: { look_id: id },
  tier: "local",
  verify: { checker: "vision", question: `does the image have this look - ${label}?`, fixture: "portrait.png" },
  promptFragment: fragment,
  hidden: LOOK_HIDDEN,
});

export const STYLE_SPECS: StyleSpec[] = [
  look("general", "General", "Balanced default look - faithful to your prompt."),
  look("editorial", "Editorial", "Clean magazine-grade light and composed framing.", "editorial magazine photography, clean studio light, composed framing"),
  look("35mm-film", "35mm Film", "Analog grain, gentle halation, honest color.", "shot on 35mm film, analog grain, gentle halation, honest color"),
  look("instant-film", "Instant Film", "Warm instant-print look with soft edges.", "instant film photo, warm tones, soft edges, retro print feel"),
  look("neon-noir", "Neon Noir", "Hard shadows under saturated neon color.", "neon-lit night, hard shadows, saturated color, cinematic noir"),
  look("golden-hour", "Golden Hour", "Low sun, long shadows, warm skin.", "golden hour light, low sun, long warm shadows"),
  look("studio-beauty", "Studio Beauty", "Beauty-dish light on a seamless backdrop.", "beauty-dish studio lighting, seamless backdrop, clean skin tones"),
  look("brutalist", "Brutalist", "Raw concrete, hard flash, stark geometry.", "brutalist concrete setting, hard flash, stark geometry"),
  look("dreamscape", "Dreamscape", "Haze, bloom and impossible softness.", "hazy dreamlike atmosphere, soft bloom, ethereal light"),
  look("chrome-glitch", "Chrome Glitch", "Chrome sheen, glitch edges, oversaturated gloss.", "chrome and glitch aesthetic, oversaturated gloss, digital distortion"),
  look("film-noir", "Film Noir", "High-contrast black and white, hardboiled mood.", "black and white film noir, hard contrast, venetian blind shadows"),
  look("vhs", "VHS", "Tracking noise and chroma bleed, camcorder-era texture.", "VHS camcorder footage, tracking noise, chroma bleed, late-80s home video"),
  look("archival", "Archival", "Faded documentary realism.", "faded archival footage, documentary realism, aged color print"),
  look("couture", "Couture", "High-fashion studio sheen.", "high-fashion editorial, couture styling, polished studio light"),
  look("symmetry", "Symmetry", "Dead-center composition over pastel sets.", "perfectly centered symmetrical composition, pastel color palette"),
  look("midnight", "Midnight", "Underexposed blue-hour mood.", "blue hour, underexposed night mood, deep shadows"),
];

registerCatalog("style", () => STYLE_SPECS);

export const STYLE_PRESETS: PresetDef[] = STYLE_SPECS.map((s) => ({
  id: s.id,
  title: s.label,
  description: s.description ?? "",
  kind: "style",
  category: "character",
  apply: { ...s.apply },
  promptFragment: s.promptFragment,
  inputRequired: "none",
  posterHue: hue(s.id),
}));
