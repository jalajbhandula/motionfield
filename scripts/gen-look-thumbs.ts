/** Renders the Color Grade "Looks" thumbnails: each look's real LUT (the same
 *  buildLut/applyLut the live preview and the full-res export use) applied to
 *  one of three photoreal stills from public/examples. Pure CPU, no model.
 *    npx tsx scripts/gen-look-thumbs.ts  →  public/examples/palette/<id>.webp */
import sharp from "sharp";
import path from "node:path";
import fs from "node:fs";
import { COLOR_PALETTES } from "@/lib/catalog/presets/palettes";
import { LUT_EXPORT, applyLut, buildLut } from "@/lib/grade/palette";

const W = 320, H = 214; // 3:2, matches the card
const PUB = path.join(process.cwd(), "public");
const OUT = path.join(PUB, "examples", "palette");
/** bases rotate across the grid so neighbours show the look on different light;
 *  `top` is the crop's vertical anchor (0 = top) for portrait sources */
const LOOK_BASES = [
  { src: "examples/feature/flux2-klein-text-to-image.jpg", top: 0.42 }, // cobbled street, tram, cyclist - daylight
  { src: "examples/feature/flux2-klein-edit.jpg", top: 0.3 },           // neon street at night, wet asphalt
  { src: "examples/inputs/reel-s1.jpg", top: 0.22 },                    // man in mustard jacket, overcast sidewalk
] as const;

async function crop(src: string, top: number): Promise<Buffer> {
  const file = path.join(PUB, src);
  const meta = await sharp(file).metadata();
  const w = meta.width!, h = meta.height!;
  const cw = Math.min(w, Math.round((h * W) / H)), ch = Math.round((cw * H) / W);
  const y = Math.max(0, Math.min(h - ch, Math.round(top * h - ch / 2)));
  const x = Math.round((w - cw) / 2);
  return sharp(file).extract({ left: x, top: y, width: cw, height: ch }).resize(W, H).removeAlpha().ensureAlpha().raw().toBuffer();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const bases = await Promise.all(LOOK_BASES.map((b) => crop(b.src, b.top)));
  for (const [i, id] of COLOR_PALETTES.entries()) {
    const px = new Uint8ClampedArray(bases[i % bases.length]);
    applyLut(px, buildLut({ kind: "look", id }, LUT_EXPORT), 1);
    await sharp(Buffer.from(px.buffer), { raw: { width: W, height: H, channels: 4 } })
      .removeAlpha().webp({ quality: 78 }).toFile(path.join(OUT, `${id}.webp`));
  }
  console.log(`wrote ${COLOR_PALETTES.length} looks to ${path.relative(process.cwd(), OUT)}`);
}

main();
