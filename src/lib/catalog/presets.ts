import type { PresetDef } from "./types";

/* Back-compat barrel - presets live in ./presets/*. Each preset file exports
   its own ordered array (MOTION_PRESETS, EFFECT_PRESETS, STYLE_PRESETS, …);
   this module re-exports them and concatenates ALL_PRESETS, so adding a preset
   never needs a barrel edit. */
export * from "./presets/trajectories";
export * from "./presets/director";
export * from "./presets/palettes";
export * from "./presets/effects";
export * from "./presets/styles";
export * from "./presets/apps";
export * from "./presets/person-swap";

import { MOTION_PRESETS } from "./presets/trajectories";
import { EFFECT_PRESETS } from "./presets/effects";
import { STYLE_PRESETS } from "./presets/styles";

export const MIXED_MEDIA_PRESETS: PresetDef[] = [];

export function findPreset(kind: PresetDef["kind"], id: string) {
  const all = kind === "motion" ? MOTION_PRESETS : kind === "effect" ? EFFECT_PRESETS : kind === "mixed-media" ? MIXED_MEDIA_PRESETS : STYLE_PRESETS;
  return all.find((p) => p.id === id);
}

export const ALL_PRESETS = [...MOTION_PRESETS, ...EFFECT_PRESETS, ...STYLE_PRESETS, ...MIXED_MEDIA_PRESETS];
