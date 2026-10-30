import type { RelightSetup } from "./light";

/**
 * Browser port of comfy-nodes/motionfield_nodes/core/relight.py - shades a
 * photo with a normal map so the lights can be dragged live. Keep the two in
 * step (formulas are documented in the Python module).
 */

const toLin = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; toLin[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const toSrgb = (c: number) => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
  return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
};
function hexLin(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [toLin[(n >> 16) & 255], toLin[(n >> 8) & 255], toLin[n & 255]];
}

export function lightDir(az: number, el: number): [number, number, number] {
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

/** Large-scale luminance at 64 px wide, blurred, bilinear back up, mean 1. */
function illumination(lin: Float32Array, w: number, h: number): Float32Array {
  const sw = 64, sh = Math.max(1, Math.round((h * sw) / w));
  const small = new Float32Array(sw * sh);
  const cnt = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / w));
      const o = (y * w + x) * 3;
      small[sy * sw + sx] += 0.2126 * lin[o] + 0.7152 * lin[o + 1] + 0.0722 * lin[o + 2];
      cnt[sy * sw + sx]++;
    }
  }
  for (let i = 0; i < small.length; i++) small[i] /= Math.max(1, cnt[i]);
  // gaussian σ=2, radius 6 (separable, edge clamp) - same kernel as relight.py
  const R = 6;
  const k = Array.from({ length: 2 * R + 1 }, (_, i) => Math.exp(-((i - R) ** 2) / 8));
  const ks = k.reduce((a, b) => a + b, 0);
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(small.length);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let s = 0; for (let i = -R; i <= R; i++) s += k[i + R] * small[y * sw + Math.min(sw - 1, Math.max(0, x + i))];
    tmp[y * sw + x] = s;
  }
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let s = 0; for (let i = -R; i <= R; i++) s += k[i + R] * tmp[Math.min(sh - 1, Math.max(0, y + i)) * sw + x];
    small[y * sw + x] = s;
  }
  const big = new Float32Array(w * h);
  let mean = 0;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / h - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / w - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const v = (small[y0 * sw + x0] * (1 - tx) + small[y0 * sw + x1] * tx) * (1 - ty)
        + (small[y1 * sw + x0] * (1 - tx) + small[y1 * sw + x1] * tx) * ty;
      big[y * w + x] = v; mean += v;
    }
  }
  mean = Math.max(mean / (w * h), 1e-6);
  for (let i = 0; i < big.length; i++) big[i] /= mean;
  return big;
}

export type Prepared = { w: number; h: number; lin: Float32Array; illum: Float32Array; normals: Float32Array };

/** Decode photo + normal-map pixels once; shading then reruns per light move. */
export function prepare(photo: ImageData, normalMap: ImageData): Prepared {
  const { width: w, height: h } = photo;
  const lin = new Float32Array(w * h * 3);
  for (let i = 0, o = 0; i < w * h; i++, o += 3) {
    lin[o] = toLin[photo.data[i * 4]]; lin[o + 1] = toLin[photo.data[i * 4 + 1]]; lin[o + 2] = toLin[photo.data[i * 4 + 2]];
  }
  const normals = new Float32Array(w * h * 3);
  for (let i = 0, o = 0; i < w * h; i++, o += 3) {
    let x = (normalMap.data[i * 4] / 255) * 2 - 1, y = (normalMap.data[i * 4 + 1] / 255) * 2 - 1, z = (normalMap.data[i * 4 + 2] / 255) * 2 - 1;
    const len = Math.hypot(x, y, z) || 1;
    x /= len; y /= len; z /= len;
    normals[o] = x; normals[o + 1] = y; normals[o + 2] = z;
  }
  return { w, h, lin, illum: illumination(lin, w, h), normals };
}

/** Shade into `out` (RGBA, same size). */
export function relightInto(p: Prepared, s: RelightSetup, out: ImageData): void {
  const k = Math.min(1, Math.max(0, s.strength));
  const amb = hexLin(s.ambientColor).map((c) => c * s.ambient);
  const ls = s.lights.map((l) => {
    const d = lightDir(l.az, l.el);
    const dxy = Math.hypot(d[0], d[1]) || 1e-6;
    return { d, dxy, rgb: hexLin(l.color), power: l.power, soft: l.soft, back: Math.max(0, -d[2]) };
  });
  const expo = 0.6 * k;
  const { w, h, lin, illum, normals } = p;
  for (let i = 0, o = 0; i < w * h; i++, o += 3) {
    const nx = normals[o], ny = normals[o + 1], nz = normals[o + 2];
    let sr = amb[0], sg = amb[1], sb = amb[2];
    const nzc = nz < 0 ? 0 : nz > 1 ? 1 : nz;
    const nxy = Math.hypot(nx, ny) || 1e-6;
    for (const l of ls) {
      const ndl = nx * l.d[0] + ny * l.d[1] + nz * l.d[2];
      let diffuse = (ndl + l.soft) / (1 + l.soft);
      diffuse = diffuse < 0 ? 0 : diffuse > 1 ? 1 : diffuse;
      let side = (nx * l.d[0] + ny * l.d[1]) / (nxy * l.dxy);
      side = side < 0 ? 0 : side > 1 ? 1 : side;
      const facing = 1 + (side - 1) * Math.min(1, l.dxy);
      const rim = l.back * (1 - nzc) * (1 - nzc) * facing;
      const e = l.power * (diffuse + 0.8 * rim);
      sr += e * l.rgb[0]; sg += e * l.rgb[1]; sb += e * l.rgb[2];
    }
    const div = Math.pow(Math.max(illum[i], 0.05), expo);
    const shadeR = 1 - k + k * sr, shadeG = 1 - k + k * sg, shadeB = 1 - k + k * sb;
    let r = (lin[o] / div) * shadeR, g = (lin[o + 1] / div) * shadeG, b = (lin[o + 2] / div) * shadeB;
    if (r > 0.8) { const v = r - 0.8; r = 0.8 + v / (1 + v / 0.2); }
    if (g > 0.8) { const v = g - 0.8; g = 0.8 + v / (1 + v / 0.2); }
    if (b > 0.8) { const v = b - 0.8; b = 0.8 + v / (1 + v / 0.2); }
    out.data[i * 4] = toSrgb(r); out.data[i * 4 + 1] = toSrgb(g); out.data[i * 4 + 2] = toSrgb(b); out.data[i * 4 + 3] = 255;
  }
}
