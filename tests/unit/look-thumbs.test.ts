import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { COLOR_PALETTES } from "@/lib/catalog/presets/palettes";

// Color Grade's Looks grid shows these before a source is picked - a missing
// file would render an empty box. Regenerate: npx tsx scripts/gen-look-thumbs.ts
describe("look thumbnails", () => {
  it("every look has a small pre-rendered webp", () => {
    for (const id of COLOR_PALETTES) {
      const f = path.join(process.cwd(), "public/examples/palette", `${id}.webp`);
      expect(fs.existsSync(f), id).toBe(true);
      expect(fs.statSync(f).size, id).toBeLessThan(40_000);
    }
  });
});
