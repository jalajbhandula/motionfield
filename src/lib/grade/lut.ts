/** Deterministic .cube LUT builder for the Director's 50 color palettes.
 *
 *  Each palette id maps to an authored grade {gain, lift, gamma, sat, hue}
 *  rasterised onto a 33³ identity grid - the same id always produces a
 *  byte-identical file, so the generated LUT doubles as evidence (sha256).
 *
 *  Transform per (r,g,b) grid point:
 *    1. lift + gain * v ^ (1/gamma)   per channel
 *    2. hue rotation about the grey axis
 *    3. saturation blend around Rec.709 luma
 *    4. contrast about the 0.5 pivot
 *  Values are emitted at 6 decimals - ffmpeg's lut3d reads them verbatim.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { COLOR_PALETTES } from "@/lib/catalog/presets/palettes";
import { PALETTE_GRADES, gradePoint } from "./looks";

export { PALETTE_GRADES };

export const LUT_SIZE = 33;

/** The exact .cube text for a palette id - deterministic; unknown ids throw. */
export function cubeFor(id: string): string {
  const gr = PALETTE_GRADES[id];
  if (!gr) throw new Error(`unknown palette "${id}"`);
  const n = LUT_SIZE - 1;
  const lines: string[] = [
    `TITLE "of-${id}"`,
    `DOMAIN_MIN 0.0 0.0 0.0`,
    `DOMAIN_MAX 1.0 1.0 1.0`,
    `LUT_3D_SIZE ${LUT_SIZE}`,
  ];
  // .cube order: red varies fastest, blue slowest (ffmpeg's lut3d reads it
  // that way - b-fastest swaps red and blue in every graded frame)
  for (let bi = 0; bi <= n; bi++)
    for (let gi = 0; gi <= n; gi++)
      for (let ri = 0; ri <= n; ri++) {
        const [r, g, b] = gradePoint(ri / n, gi / n, bi / n, gr);
        lines.push(`${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`);
      }
  return lines.join("\n") + "\n";
}

/** sha256 of the .cube for an id - the evidence hash smokes report. */
export function lutSha(id: string): string {
  return createHash("sha256").update(cubeFor(id)).digest("hex");
}

/** Write (or reuse) the .cube under a stable tmp path - content-addressed by
 *  its sha so a cache hit is guaranteed byte-identical. */
export async function lutPathFor(id: string): Promise<string> {
  const text = cubeFor(id);
  const sha = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const dir = path.join(os.tmpdir(), "of-luts");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `of-${id}-${sha}.cube`);
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, text);
  }
  return file;
}

/** All 50 catalog palette ids have a grade - checked by tests; the lookup
 *  itself refuses unknown ids rather than deriving silently. */
export const PALETTE_IDS: readonly string[] = COLOR_PALETTES;
