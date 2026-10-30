import type { ModelDef } from "./types";
import { comfyBacked } from "./serialize";
import { IMAGE_MODELS } from "./image-models";

import { VIDEO_GENERATE_MODELS } from "./video/generate";
import { VIDEO_VFX_MODELS } from "./video/vfx";
import { VIDEO_SWAP_MODELS } from "./video/swap";
import { VIDEO_CAMERA_MODELS } from "./video/camera";
import { VIDEO_POST_MODELS } from "./video/post";
import { EXPLAINER } from "./video/recipes";
import { AUDIO_VOICE_MODELS } from "./audio/voice";
import { AUDIO_MUSIC_MODELS } from "./audio/music";
import { CODE_MOTION_MODELS } from "./code/motion";
import { CODE_STAGE_MODELS } from "./code/stage";
import { CODE_GAMES_MODELS } from "./code/games";

/* Back-compat barrel - each domain file exports one ordered <DOMAIN>_MODELS
   array and this module concatenates them, so adding a model never needs a
   barrel edit. video/recipes.ts is WS2-owned and has no array yet - its
   EXPLAINER entry is aggregated directly below. */
export {
  LTX_VIDEO, WAN_2_1, WAN_2_2, LENS, DIRECTOR,
} from "./video/generate";
export { LTX_VFX } from "./video/vfx";
export { WAN_VACE, WAN_ANIMATE, RE_EDIT, PERSON_SWAP, REFRAME } from "./video/swap";
export { DRAW_TO_VIDEO } from "./video/camera";
export { EXPLAINER } from "./video/recipes";
export { VOICE_STUDIO, LIPSYNC } from "./audio/voice";

export { MOTION_RENDER, MOTION_RENDER_ENDPOINT } from "./code/motion";
export { STAGE_RENDER, STAGE_RENDER_ENDPOINT } from "./code/stage";

export const VIDEO_MODELS: ModelDef[] = comfyBacked([
  ...VIDEO_GENERATE_MODELS,
  ...VIDEO_VFX_MODELS,
  ...VIDEO_SWAP_MODELS,
  ...VIDEO_CAMERA_MODELS,
  ...VIDEO_POST_MODELS,
  EXPLAINER,
]);

/** Audio / avatar models - surfaced in the audio studio. Music/SFX first -
 *  the page opens on a generative tab, not the TTS utility. */
export const AUDIO_MODELS: ModelDef[] = comfyBacked([
  ...AUDIO_MUSIC_MODELS,
  ...AUDIO_VOICE_MODELS,
]);

/** Code-domain models (WS5 renderers/games). */
export const CODE_MODELS: ModelDef[] = comfyBacked([
  ...CODE_MOTION_MODELS,
  ...CODE_STAGE_MODELS,
  ...CODE_GAMES_MODELS,
]);

export const ALL_MODELS: ModelDef[] = [...IMAGE_MODELS, ...VIDEO_MODELS, ...AUDIO_MODELS, ...CODE_MODELS];

export function findModel(id: string) {
  return ALL_MODELS.find((m) => m.id === id);
}

export function findWorkflow(modelId: string, workflowId: string) {
  return findModel(modelId)?.workflows.find((w) => w.id === workflowId);
}

export function findEndpoint(endpointId: string) {
  for (const m of ALL_MODELS)
    for (const w of m.workflows)
      if (w.endpointId === endpointId) return { model: m, workflow: w };
  return null;
}
