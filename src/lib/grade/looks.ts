/** The Director's 50 authored colour grades as pure math - no Node imports,
 *  so the browser (Palette's live preview) and the server (.cube files for
 *  ffmpeg) rasterise the exact same transform. */


export interface Grade {
  /** per-channel gain (>1 boosts) */
  g: [number, number, number];
  /** per-channel lift (added black offset, -0.05..0.05) */
  l: [number, number, number];
  /** chroma rotation about the grey axis, degrees */
  h: number;
  /** saturation multiplier */
  s: number;
  /** gamma divisor (v^(1/gm)) - >1 lifts mids, <1 sinks them */
  gm: number;
  /** contrast about the 0.5 pivot */
  c: number;
}

const base = (g: [number, number, number], s: number, h = 0, l: [number, number, number] = [0, 0, 0], gm = 1, c = 1): Grade => ({ g, l, h, s, gm, c });

/* Family shapes - each id gets an authored grade; names drive the look:
 * warm = gain red/green down blue; cool = inverse; mauve/rose = magenta;
 * faded/pastel = lift + low sat; neon = high sat; grey/newsprint = desat. */
const warm = (d: number, s = 1.05, h = 0): Grade => base([1 + d, 1 + d * 0.25, 1 - d], s, h, [d * 0.35, d * 0.1, -d * 0.3]);
const cool = (d: number, s = 1.05, h = 0): Grade => base([1 - d, 1 + d * 0.15, 1 + d], s, h, [-d * 0.3, d * 0.05, d * 0.35]);
const green = (d: number, s = 1.05, h = 0): Grade => base([1 - d * 0.6, 1 + d, 1 - d * 0.5], s, h, [-d * 0.2, d * 0.35, -d * 0.2]);
const rose = (d: number, s = 1.05, h = 0): Grade => base([1 + d, 1 - d * 0.5, 1 + d * 0.6], s, h, [d * 0.35, -d * 0.15, d * 0.25]);
const grey = (s: number, lift = 0.02): Grade => base([1, 1, 1], s, 0, [lift, lift, lift], 1.05);
const faded = (s: number, l: [number, number, number]): Grade => base([1, 1, 1], s, 0, l, 1.15, 0.9);
const neon = (d: number, h: number): Grade => base([1 + d, 1, 1 + d * 0.5], 1.3, h, [0, -0.005, 0.01], 0.95, 1.08);

/** The authored table - one row per COLOR_PALETTES id (asserted complete in
 *  tests; an id with no row refuses, never silently derives). */
export const PALETTE_GRADES: Record<string, Grade> = {
  "cinema-amber": warm(0.09, 1.1, 4),                                         // teal-orange cinema look
  "dry-amber": warm(0.12, 0.95, 2),                                           // strong amber, muted contrast
  "golden-hour": warm(0.1, 1.1, 10),                                          // golden hillside
  "holiday-warm": warm(0.08, 1.12, 10),                                       // bright warmth
  "hot-push": warm(0.11, 1.08, 6, ),                                          // hot asphalt - strong warm push
  "muted-amber": warm(0.08, 0.95, -6),                                        // muted amber
  "ochre-mids": warm(0.07, 0.98, 8),                                          // amber-heavy mids
  "orange-punch": warm(0.12, 1.12, 8),                                        // horizon line orange
  "saffron": warm(0.11, 1.08, 12),                                            // saffron walls - deep warm
  "streetlamp-orange": warm(0.13, 1.05, -4),                                  // sodium-vapour orange, green drop
  "sunset-burn": warm(0.13, 1.15, 10),                                        // strong warm push
  "warm-haze": warm(0.06, 0.96, 0, ),                                         // slight warm haze
  "warm-neutral": warm(0.07, 1.0, 4),                                         // open-road warm neutral
  "blush-lift": rose(0.05, 0.92, 6),                                          // powdery pink lift
  "dark-magenta": rose(0.06, 0.95, -12),                                      // nocturne - dark magenta silk
  "faded-rose": rose(0.05, 0.88, -6),                                         // faded wallpaper rose
  "mauve-drift": rose(0.06, 0.95, -8),                                        // mauve dusk - magenta drift, muted
  "pink-saturate": rose(0.07, 1.25, 10),                                      // candy colours, saturated pink
  "skin-warmth": rose(0.03, 1.05, 0, ),                                       // skin-tone satin - gentle warm-magenta
  "green-lift": green(0.08, 1.08, -6),                                        // deep emerald, lifted shadows
  "green-on-warm": green(0.08, 1.1, -14),                                     // diner fluorescents - green on warm
  "humid-green": green(0.06, 1.15, 4),                                        // humid monsoon - saturated green warmth
  "olive-mute": green(0.06, 0.92, 12),                                        // olive fields - muted green
  "phosphor": green(0.1, 1.12, 10),                                           // phosphor green cast
  "tube-light-green": green(0.07, 0.95, -10),                                 // fluoro night - sickly green on cool
  "aqua-saturate": cool(0.07, 1.2, 12),                                       // turquoise warmth, saturated
  "cool-cast": cool(0.08, 1.0, -4),                                           // cool blue cast
  "cool-muted": cool(0.08, 0.9, -2),                                          // night-shift cool, muted
  "deep-blue": cool(0.12, 1.15, -10),                                         // deep abyssal blue glow
  "hard-blue": cool(0.09, 0.92, -6),                                          // hard steel blue
  "late-cool": cool(0.07, 0.9, 8, ),                                          // late-night cool, low sat
  "midnight-desat": cool(0.1, 0.85, -6),                                      // midnight - dark desat blue
  "neon-pop": neon(0.05, 14),                                                 // saturated neon on rain-dark ground
  "broadcast-grey": grey(0.78, 0.018),                                        // broadcast-safe muted grey
  "mono-grey": grey(0.55, 0.03),                                              // near-monochrome print look
  "overcast-grey": grey(0.7, 0.022),                                          // washed greys, low sat
  "soft-grey": grey(0.65, 0.025),                                             // hushed, near-muted grey
  "stone-grey": grey(0.72, 0.028),                                            // cool stone greys, desaturated
  "chalk-fade": faded(0.78, [0.03, 0.028, 0.02]),                             // chalky lift, desaturated
  "cool-wash": faded(0.8, [0.015, 0.02, 0.028]),                              // haze - cool lift, washed out
  "diffused-day": faded(0.85, [0.025, 0.025, 0.022]),                         // diffused daylight, soft lift
  "dust-fade": faded(0.85, [0.03, 0.02, 0.005]),                              // dusty dry bed - warm chalky lift
  "pastel-lift": faded(1.1, [0.02, 0.015, 0.02]),                             // pastel - light saturated lift
  "alarm-red": base([1.12, 0.9, 0.88], 1.1, -4, [0.02, -0.005, -0.01], 0.92, 1.1), // alarm red
  "hyper-color": base([1.06, 1.04, 1.06], 1.45, 0, [0, 0, 0], 0.95, 1.06),    // hyper-saturated dream
  "low-contrast-day": base([1.02, 1.02, 1.02], 0.92, 0, [0.01, 0.01, 0.01], 1.1, 0.85), // flat, slightly lifted, low contrast
  "night-street": base([0.94, 0.97, 1.05], 0.88, -4, [0.005, 0.008, 0.015], 0.9, 1.12), // dark wet asphalt
  "orange-black": base([1.1, 1.02, 0.88], 1.18, 6, [0.02, 0.01, -0.015]),     // orange push with deep blacks
  "punch-color": base([1.1, 0.98, 1.05], 1.35, 8, [0.01, 0, 0.01], 0.95, 1.1), // punchy, saturated
  "red-key": base([1.14, 0.92, 0.9], 1.12, 0, [0.02, -0.01, -0.01], 0.95, 1.05), // stage crimson
};

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** One graded channel value. */
function applyGrade(v: number, i: 0 | 1 | 2, gr: Grade): number {
  const x = gr.l[i] + gr.g[i] * Math.pow(Math.max(v, 0), 1 / gr.gm);
  return x;
}

/** Rotate (r,g,b) about the grey axis by `deg`. */
function hueRotate([r, g, b]: [number, number, number], deg: number): [number, number, number] {
  if (!deg) return [r, g, b];
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const u = 1 / Math.sqrt(3);
  const m00 = cos + u * u * (1 - cos), m01 = u * (u * (1 - cos) - u * sin), m02 = u * (u * (1 - cos) + u * sin);
  const m10 = u * (u * (1 - cos) + u * sin), m11 = cos + u * u * (1 - cos), m12 = u * (u * (1 - cos) - u * sin);
  const m20 = u * (u * (1 - cos) - u * sin), m21 = u * (u * (1 - cos) + u * sin), m22 = cos + u * u * (1 - cos);
  return [
    m00 * r + m01 * g + m02 * b,
    m10 * r + m11 * g + m12 * b,
    m20 * r + m21 * g + m22 * b,
  ];
}

/** Full grade on a grid point. */
export function gradePoint(r: number, g: number, b: number, gr: Grade): [number, number, number] {
  let v: [number, number, number] = [
    applyGrade(r, 0, gr),
    applyGrade(g, 1, gr),
    applyGrade(b, 2, gr),
  ];
  v = hueRotate(v, gr.h);
  const luma = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  v = v.map((x) => luma + gr.s * (x - luma)) as [number, number, number];
  v = v.map((x) => 0.5 + (x - 0.5) * gr.c) as [number, number, number];
  return [clamp01(v[0]), clamp01(v[1]), clamp01(v[2])];
}
