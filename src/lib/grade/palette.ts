import { z } from "zod";
import { COLOR_PALETTES } from "@/lib/catalog/presets/palettes";
import { PALETTE_GRADES, clamp01, gradePoint } from "./looks";

/**
 * Palette - every grade is one 3D LUT, built the same way in the browser
 * (live preview on a canvas) and on the server (a .cube for ffmpeg on
 * video). Three sources:
 *   look - one of the Director's 50 authored grades
 *   match - "match this look": the reference's OKLab mean/spread mapped
 *             onto the source's (a Reinhard-style transfer, spread clamped)
 *   palette - 3-6 colours: hue/chroma follow the palette along lightness
 *             (darkest colour tints shadows, lightest tints highlights)
 * Intensity blends the LUT with identity. Pure math, no DOM or Node APIs.
 */

export const LUT_PREVIEW = 17;
export const LUT_EXPORT = 33;

/** rows red-fastest, like a .cube file: index = r + g·n + b·n² */
export type Lut = { size: number; data: Float32Array };

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const stat = z.number().finite().min(-2).max(2);
export const labStatsSchema = z.strictObject({
  mean: z.tuple([stat, stat, stat]),
  std: z.tuple([stat, stat, stat]),
});
export type LabStats = z.infer<typeof labStatsSchema>;

export const gradeSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("look"), id: z.enum(COLOR_PALETTES) }),
  z.strictObject({ kind: z.literal("match"), source: labStatsSchema, reference: labStatsSchema }),
  z.strictObject({ kind: z.literal("palette"), colors: z.array(hex).min(3).max(6) }),
]);
export type GradeSpec = z.infer<typeof gradeSpecSchema>;

/* ---------- colour space: sRGB ⇄ OKLab ---------- */

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055);

export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lr = toLin(r), lg = toLin(g), lb = toLin(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clamp01(toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp01(toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp01(toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

export function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0")).join("");
}

/* ---------- image statistics ---------- */

/** OKLab mean/std over RGBA bytes, sampling ≤ ~40k pixels; transparent pixels skipped. */
export function labStats(rgba: Uint8ClampedArray | Uint8Array): LabStats {
  const px = rgba.length / 4;
  const step = Math.max(1, Math.floor(px / 40_000));
  const sum = [0, 0, 0], sq = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < px; i += step) {
    const o = i * 4;
    if (rgba[o + 3] < 16) continue;
    const lab = rgbToLab(rgba[o] / 255, rgba[o + 1] / 255, rgba[o + 2] / 255);
    for (let k = 0; k < 3; k++) { sum[k] += lab[k]; sq[k] += lab[k] * lab[k]; }
    n++;
  }
  if (!n) return { mean: [0.5, 0, 0], std: [0.2, 0.05, 0.05] };
  const mean = sum.map((s) => s / n) as [number, number, number];
  const std = sq.map((s, k) => Math.sqrt(Math.max(s / n - mean[k] * mean[k], 1e-6))) as [number, number, number];
  return { mean, std };
}

/** k dominant colours (tiny k-means in OKLab) - "extract a palette from this image". */
export function dominantColors(rgba: Uint8ClampedArray | Uint8Array, k = 5): string[] {
  const px = rgba.length / 4;
  const step = Math.max(1, Math.floor(px / 6000));
  const pts: [number, number, number][] = [];
  for (let i = 0; i < px; i += step) {
    const o = i * 4;
    if (rgba[o + 3] < 16) continue;
    pts.push(rgbToLab(rgba[o] / 255, rgba[o + 1] / 255, rgba[o + 2] / 255));
  }
  if (pts.length < k) return [];
  // deterministic seeding: spread along lightness
  const sorted = [...pts].sort((a, b) => a[0] - b[0]);
  let centers = Array.from({ length: k }, (_, i) => sorted[Math.floor(((i + 0.5) / k) * sorted.length)]);
  const counts = new Array(k).fill(0);
  for (let iter = 0; iter < 12; iter++) {
    const acc = centers.map(() => [0, 0, 0]);
    counts.fill(0);
    for (const p of pts) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (p[0] - centers[c][0]) ** 2 + (p[1] - centers[c][1]) ** 2 + (p[2] - centers[c][2]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      counts[best]++;
      for (let j = 0; j < 3; j++) acc[best][j] += p[j];
    }
    centers = centers.map((c, i) => (counts[i] ? (acc[i].map((v) => v / counts[i]) as [number, number, number]) : c));
  }
  return centers
    .map((c, i) => ({ c, n: counts[i] }))
    .filter((x) => x.n > 0)
    .sort((a, b) => a.c[0] - b.c[0])
    .map(({ c }) => rgbToHex(...labToRgb(c[0], c[1], c[2])));
}

/* ---------- LUT builders ---------- */

type PointFn = (r: number, g: number, b: number) => [number, number, number];

function raster(size: number, f: PointFn): Lut {
  const n = size - 1;
  const data = new Float32Array(size * size * size * 3);
  let o = 0;
  for (let bi = 0; bi < size; bi++)
    for (let gi = 0; gi < size; gi++)
      for (let ri = 0; ri < size; ri++) {
        const v = f(ri / n, gi / n, bi / n);
        data[o++] = v[0]; data[o++] = v[1]; data[o++] = v[2];
      }
  return { size, data };
}

function lookFn(id: string): PointFn {
  const gr = PALETTE_GRADES[id];
  if (!gr) throw new Error(`unknown look "${id}"`);
  return (r, g, b) => gradePoint(r, g, b, gr);
}

function matchFn(src: LabStats, ref: LabStats): PointFn {
  // spread ratios clamped so a flat source can't explode; lightness moves
  // gentler than colour so exposure stays believable
  const ratio = (k: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, ref.std[k] / Math.max(src.std[k], 1e-3)));
  const rL = ratio(0, 0.7, 1.4), rA = ratio(1, 0.4, 2.5), rB = ratio(2, 0.4, 2.5);
  return (r, g, b) => {
    const [L, A, B] = rgbToLab(r, g, b);
    const L2 = L + 0.75 * ((L - src.mean[0]) * rL + ref.mean[0] - L);
    const A2 = (A - src.mean[1]) * rA + ref.mean[1];
    const B2 = (B - src.mean[2]) * rB + ref.mean[2];
    return labToRgb(L2, A2, B2);
  };
}

function paletteFn(colors: string[]): PointFn {
  const stops = colors.map((c) => rgbToLab(...hexToRgb(c))).sort((x, y) => x[0] - y[0]);
  const lo = stops[0][0], hi = stops[stops.length - 1][0];
  return (r, g, b) => {
    const [L, A, B] = rgbToLab(r, g, b);
    // position along the palette's lightness ramp (whole tonal range used)
    const t = Math.min(1, Math.max(0, L)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(t));
    const f = t - i;
    const ta = stops[i][1] + (stops[i + 1][1] - stops[i][1]) * f;
    const tb = stops[i][2] + (stops[i + 1][2] - stops[i][2]) * f;
    // keep some of the pixel's own colour so skin and sky stay readable
    const keep = 0.4;
    const L2 = L + 0.25 * ((lo + (hi - lo) * Math.min(1, Math.max(0, L))) - L);
    return labToRgb(L2, A * keep + ta * (1 - keep), B * keep + tb * (1 - keep));
  };
}

export function buildLut(spec: GradeSpec, size = LUT_PREVIEW): Lut {
  switch (spec.kind) {
    case "look": return raster(size, lookFn(spec.id));
    case "match": return raster(size, matchFn(spec.source, spec.reference));
    case "palette": return raster(size, paletteFn(spec.colors));
  }
}

/** Bake intensity into the table (lerp toward identity) - used for .cube export. */
export function withIntensity(lut: Lut, k: number): Lut {
  const t = clamp01(k);
  if (t === 1) return lut;
  const n = lut.size - 1;
  const data = new Float32Array(lut.data.length);
  let o = 0;
  for (let bi = 0; bi < lut.size; bi++)
    for (let gi = 0; gi < lut.size; gi++)
      for (let ri = 0; ri < lut.size; ri++) {
        const id = [ri / n, gi / n, bi / n];
        for (let c = 0; c < 3; c++, o++) data[o] = id[c] + (lut.data[o] - id[c]) * t;
      }
  return { size: lut.size, data };
}

/** Grade RGBA bytes in place: trilinear LUT lookup, blended by intensity. */
export function applyLut(rgba: Uint8ClampedArray, lut: Lut, intensity = 1): void {
  const s = lut.size, n = s - 1, d = lut.data, k = clamp01(intensity);
  const s2 = s * s;
  for (let o = 0; o < rgba.length; o += 4) {
    const r = rgba[o] / 255, g = rgba[o + 1] / 255, b = rgba[o + 2] / 255;
    const fr = r * n, fg = g * n, fb = b * n;
    const r0 = Math.min(n - 1, fr | 0), g0 = Math.min(n - 1, fg | 0), b0 = Math.min(n - 1, fb | 0);
    const dr = fr - r0, dg = fg - g0, db = fb - b0;
    const i000 = (r0 + g0 * s + b0 * s2) * 3;
    const i100 = i000 + 3, i010 = i000 + s * 3, i110 = i010 + 3;
    const i001 = i000 + s2 * 3, i101 = i001 + 3, i011 = i001 + s * 3, i111 = i011 + 3;
    for (let c = 0; c < 3; c++) {
      const c00 = d[i000 + c] + (d[i100 + c] - d[i000 + c]) * dr;
      const c10 = d[i010 + c] + (d[i110 + c] - d[i010 + c]) * dr;
      const c01 = d[i001 + c] + (d[i101 + c] - d[i001 + c]) * dr;
      const c11 = d[i011 + c] + (d[i111 + c] - d[i011 + c]) * dr;
      const c0 = c00 + (c10 - c00) * dg;
      const c1 = c01 + (c11 - c01) * dg;
      const v = c0 + (c1 - c0) * db;
      const src = c === 0 ? r : c === 1 ? g : b;
      rgba[o + c] = Math.round((src + (v - src) * k) * 255);
    }
  }
}

/** .cube text (red-fastest rows - what ffmpeg's lut3d and editors read). */
export function toCube(lut: Lut, title: string): string {
  const lines = [
    `TITLE "${title.replace(/["\n\r]/g, "").slice(0, 60)}"`,
    "DOMAIN_MIN 0.0 0.0 0.0",
    "DOMAIN_MAX 1.0 1.0 1.0",
    `LUT_3D_SIZE ${lut.size}`,
  ];
  for (let o = 0; o < lut.data.length; o += 3)
    lines.push(`${lut.data[o].toFixed(6)} ${lut.data[o + 1].toFixed(6)} ${lut.data[o + 2].toFixed(6)}`);
  return lines.join("\n") + "\n";
}

export function gradeTitle(spec: GradeSpec): string {
  if (spec.kind === "look") return spec.id;
  if (spec.kind === "match") return "match-reference";
  return `palette-${spec.colors.map((c) => c.slice(1)).join("-")}`;
}
