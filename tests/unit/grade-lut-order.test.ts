import { describe, expect, it } from "vitest";
import { LUT_SIZE, cubeFor } from "@/lib/grade/lut";
import { COLOR_PALETTES } from "@/lib/catalog/presets/palettes";

/** .cube rows run red-fastest (what ffmpeg's lut3d reads). Writing blue-fastest
 *  silently swaps red and blue in every graded frame - pure red came out blue. */
function entry(cube: string, r: number, g: number, b: number): number[] {
  const rows = cube.trim().split("\n").filter((l) => /^[\d.]+ [\d.]+ [\d.]+$/.test(l));
  expect(rows).toHaveLength(LUT_SIZE ** 3);
  return rows[r + g * LUT_SIZE + b * LUT_SIZE * LUT_SIZE].split(" ").map(Number);
}

describe("grade · .cube axis order", () => {
  const n = LUT_SIZE - 1;
  it.each(COLOR_PALETTES.filter((id) => !/grey|newsprint/.test(id)))("%s keeps primaries on their own channel", (id) => {
    const cube = cubeFor(id);
    const red = entry(cube, n, 0, 0);
    const blue = entry(cube, 0, 0, n);
    expect(red[0]).toBeGreaterThan(red[2]);
    expect(blue[2]).toBeGreaterThan(blue[0]);
  });
});
