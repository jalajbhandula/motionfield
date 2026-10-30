import type { RecipeFn } from "../recipe";
export const RECIPES: Record<string, RecipeFn> = {
  "secret-recipe": async () => { throw new Error("x"); },
};
