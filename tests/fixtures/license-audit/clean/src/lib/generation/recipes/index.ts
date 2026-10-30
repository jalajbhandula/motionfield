import type { RecipeFn } from "../recipe";
export const RECIPES: Record<string, RecipeFn> = {
  explainer: async () => { throw new Error("x"); },
  "motion-render": async () => { throw new Error("x"); },
};
