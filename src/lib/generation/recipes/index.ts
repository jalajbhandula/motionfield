import type { RecipeFn } from "../recipe";
import { explainerRecipe } from "./explainer";
import { dubRecipe } from "./dub";
import { personSwapRecipe } from "./person-swap";
import { reEditAssembleRecipe } from "./re-edit-assemble";
import { motionRenderRecipe } from "./motion-render";
import { stageRenderRecipe } from "./stage-render";
import { gameBuildRecipe } from "./game-build";
import { audioMixRecipe } from "./audio-mix";
import { videoPostRecipe } from "./video-post";
import { beatCutRecipe } from "./beat-cut";

/**
 * Single recipe registry - the recipe provider resolves
 * `workflow.providers.recipe.name` against this map. Stubs throw
 * "not implemented" when run; owning workstreams replace them.
 */
export const RECIPES: Record<string, RecipeFn> = {
  explainer: explainerRecipe,
  dub: dubRecipe,
  "person-swap": personSwapRecipe,
  "re-edit-assemble": reEditAssembleRecipe,
  "motion-render": motionRenderRecipe,
  "stage-render": stageRenderRecipe,
  "game-build": gameBuildRecipe,
  "audio-mix": audioMixRecipe,
  "video-post": videoPostRecipe,
  "beat-cut": beatCutRecipe,
};
