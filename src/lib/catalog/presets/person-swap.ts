/** PersonSwap lane look presets - s5b's 20 restyle specs. Each is a real
 *  depth-controlled v2v restyle on motionfield/wan-vace/restyle: the id is a
 *  selectable preset_id, the promptFragment is the style text that lands in
 *  the job prompt. They join the shared effect registries (the barrel
 *  re-exports this module, and the registry getters return live arrays) so
 *  RESTYLE_PRESET_IDS, specById and findPreset all see them - and every one
 *  still needs a verified record before specVisible lets the grid offer it.
 */

import type { PresetDef } from "../types";
import { EFFECT_PRESETS, EFFECT_SPECS, type EffectSpec } from "./effects";
import { posterFor } from "./poster";

const VACE_RESTYLE = "motionfield/wan-vace/restyle";

const rs = (id: string, label: string, description: string, credits = 49, promptFragment = description): EffectSpec => ({
  id, label, description, catalog: "effect", collection: "restyle",
  inputs: ["video", "prompt"],
  mechanism: { kind: "restyle", endpoint: VACE_RESTYLE, control: "depth" },
  tier: "local",
  verify: { checker: "vision", question: `does the clip look like this - ${description}`, fixture: "clip-2s.mp4" },
  promptFragment,
  credits,
  modelHint: "wan-vace",
});

export const PERSON_SWAP_RESTYLE_SPECS: EffectSpec[] = [
  rs("wet-neon", "Wet Neon", "Rain-slick night streets re-lit in cyan and magenta neon, hard contrast, wet reflections."),
  rs("ink-wash", "Ink Wash", "Sumi-e ink wash - soft bleeds, paper texture, brush-stroke edges in monochrome."),
  rs("paper-craft", "Paper Craft", "Layered cut-paper diorama - flat cardstock shapes with soft drop shadows."),
  rs("watercolor-field", "Watercolor Field", "Loose plein-air watercolor - blooms, granulation and visible paper grain."),
  // the verified prompt keeps its original bytes (mechanism hash in preset-verify.json)
  rs("cel-shade", "Cel Shade", "Bold cel-shaded anime look - flat color regions with clean inked outlines.", 49, "Bold cel-shaded anime look — flat color regions with clean inked outlines."),
  rs("copper-etch", "Copper Etch", "Engraved copperplate - dense cross-hatching and warm sepia ink on paper."),
  rs("pixel-poster", "Pixel Poster", "Chunky pixel-art poster - limited palette, dithered gradients, crisp edges."),
  rs("pastel-film", "Pastel Film", "Soft 70s film stock - pastel palette, gentle halation, fine grain."),
  rs("charcoal-figure", "Charcoal Figure", "Smudged charcoal and graphite sketch - rough strokes on toned paper."),
  rs("vapor-haze", "Vapor Haze", "Dreamy vaporwave haze - pink and teal gradients, soft glow, film burn."),
  rs("riso-print", "Riso Print", "Two-color risograph - misregistered inks, halftone texture, warm paper."),
  rs("oil-glaze", "Oil Glaze", "Glazed oil painting - deep color, impasto highlights, gallery lighting."),
  rs("blueprint-plan", "Blueprint Plan", "Cyanotype blueprint - white linework and annotations on deep blue."),
  rs("mosaic-tile", "Mosaic Tile", "Byzantine mosaic - tessellated color tiles with grout lines and gilt."),
  rs("ink-bloom", "Ink Bloom", "Alcohol-ink bloom - fluid color washes spreading into soft tendrils."),
  rs("silver-halide", "Silver Halide", "Classic black-and-white darkroom print - rich blacks, silver grain."),
  rs("clay-stop", "Clay Stop", "Stop-motion clay look - thumb-printed surfaces, warm practical light."),
  rs("thermal-scan", "Thermal Scan", "False-color thermal imaging - heat palette on cooled surroundings."),
  rs("grain-noir", "Grain Noir", "Hard-boiled film noir - heavy grain, venetian shadows, deep contrast."),
  rs("sunbleached", "Sunbleached", "Faded summer print - bleached highlights, warm cast, soft focus."),
];

EFFECT_SPECS.push(...PERSON_SWAP_RESTYLE_SPECS);

const hue = (id: string) => Math.abs([...id].reduce((a, c) => a + c.charCodeAt(0), 0)) % 360;
const PERSON_SWAP_RESTYLE_PRESETS: PresetDef[] = PERSON_SWAP_RESTYLE_SPECS.map((s) => ({
  id: s.id,
  title: s.label,
  description: s.description ?? "",
  kind: "effect",
  category: "vfx",
  apply: s.apply ?? {},
  inputRequired: "video",
  credits: s.credits,
  promptFragment: s.promptFragment,
  modelHint: s.modelHint,
  posterHue: hue(s.id),
  poster: posterFor("effect", s.id),
}));
EFFECT_PRESETS.push(...PERSON_SWAP_RESTYLE_PRESETS);
