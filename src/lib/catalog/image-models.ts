import type { ModelDef } from "./types";
import { comfyBacked } from "./serialize";

import { IMAGE_GENERATE_MODELS } from "./image/generate";
import { IMAGE_EDIT_MODELS } from "./image/edit";
import { IMAGE_RELIGHT_MODELS } from "./image/relight";
import { IMAGE_ANGLES_MODELS } from "./image/angles";
import { THREED_MODELS } from "./image/threed";

/* Back-compat barrel - each domain file exports one ordered <DOMAIN>_MODELS
   array and this module concatenates them, so adding a model never needs a
   barrel edit. */
export {
  Z_IMAGE_TURBO, CHARACTER, FLUX_SCHNELL,
} from "./image/generate";
export {
  BIREFNET, QWEN_IMAGE_EDIT, SCHNELL_IMG2IMG, SCHNELL_INPAINT, PRODUCT_PLACEMENT, UPSCALER,
} from "./image/edit";

export const IMAGE_MODELS: ModelDef[] = comfyBacked([
  ...IMAGE_GENERATE_MODELS,
  ...IMAGE_EDIT_MODELS,
  ...IMAGE_RELIGHT_MODELS,
  ...IMAGE_ANGLES_MODELS,
  ...THREED_MODELS,
]);
