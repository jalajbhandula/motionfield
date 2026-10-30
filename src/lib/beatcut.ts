import { z } from "zod";

/**
 * Cut to music - find the beat of a track and plan an edit of several clips
 * that cuts on it. Pure and shared: the studio previews the plan in the
 * browser, the beat-cut recipe recomputes it from the same inputs and
 * renders it with ffmpeg (src/lib/generation/recipes/beat-cut.ts).
 *
 *   mono samples → spectral-flux onset envelope (+ a low band for kicks)
 *   → tempo by weighted autocorrelation → beats by dynamic programming
 *   → bar phase from the kick band → per-beat energy
 *   → cut points every 1-8 beats (faster where the track is louder)
 *   → a transition per cut from the chosen style
 */

export const BEAT_CUT_ENDPOINT = "motionfield/re-edit/beat-cut";
export const ANALYSIS_RATE = 22050;
const FRAME = 1024;
const HOP = 256;
/** onset envelope frames per second */
export const ENV_FPS = ANALYSIS_RATE / HOP;

export const BEAT_CUT_PACES = ["auto", "1", "2", "4", "8"] as const;
export type BeatCutPace = (typeof BEAT_CUT_PACES)[number];
export const BEAT_CUT_STYLES = ["dynamic", "cut", "smooth", "punchy"] as const;
export type BeatCutStyle = (typeof BEAT_CUT_STYLES)[number];
export const BEAT_CUT_ASPECTS = ["9:16", "1:1", "16:9"] as const;
export const BEAT_CUT_MIN_CLIPS = 2;
export const BEAT_CUT_MAX_CLIPS = 12;
export const BEAT_CUT_MAX_LENGTH = 60;

/** xfade names; "cut" is a straight join */
export const TRANSITIONS = ["cut", "fade", "fadeblack", "fadewhite", "smoothleft", "smoothright", "zoomin", "hblur"] as const;
export type Transition = (typeof TRANSITIONS)[number];
export const TRANSITION_LABEL: Record<Transition, string> = {
  cut: "Cut", fade: "Crossfade", fadeblack: "Dip to black", fadewhite: "Flash",
  smoothleft: "Whip left", smoothright: "Whip right", zoomin: "Zoom", hblur: "Blur",
};

export const beatCutParamsSchema = z.object({
  video_urls: z.array(z.string().min(1)).min(BEAT_CUT_MIN_CLIPS, `add at least ${BEAT_CUT_MIN_CLIPS} clips`).max(BEAT_CUT_MAX_CLIPS, `up to ${BEAT_CUT_MAX_CLIPS} clips`),
  audio_url: z.string().min(1, "add a music track"),
  pace: z.enum(BEAT_CUT_PACES).default("auto"),
  style: z.enum(BEAT_CUT_STYLES).default("dynamic"),
  aspect_ratio: z.enum(BEAT_CUT_ASPECTS).default("9:16"),
  length: z.coerce.number().min(5).max(BEAT_CUT_MAX_LENGTH).default(20),
  music_start: z.coerce.number().min(0).max(600).default(0),
});
export type BeatCutParams = z.infer<typeof beatCutParamsSchema>;

export type BeatGrid = {
  bpm: number;
  /** beat times, seconds from the start of the track */
  beats: number[];
  /** index into beats of the first bar start (0-3) */
  barPhase: number;
  /** loudness per beat, 0-1 across this track */
  energy: number[];
  duration: number;
};

/* ---------- analysis ---------- */

/** in-place radix-2 FFT (re/im of length 2^k) */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Onset strength per hop: rectified rise in log-magnitude spectrum over the
 *  full band (to ~8 kHz), and in linear magnitude under ~120 Hz - the kick,
 *  which marks bar starts and must not be flattened by the log. */
export function onsetEnvelope(samples: Float32Array, rate = ANALYSIS_RATE): { env: Float64Array; low: Float64Array } {
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const env = new Float64Array(frames), low = new Float64Array(frames);
  const hann = new Float64Array(FRAME).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  const top = Math.min(FRAME / 2, Math.round((8000 * FRAME) / rate)), kick = Math.max(2, Math.round((120 * FRAME) / rate));
  let prev = new Float64Array(top), prevLin = new Float64Array(kick + 1);
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    for (let i = 0; i < FRAME; i++) { re[i] = samples[o + i] * hann[i]; im[i] = 0; }
    fft(re, im);
    const cur = new Float64Array(top);
    let flux = 0, lowFlux = 0;
    for (let k = 1; k < top; k++) {
      const mag = Math.hypot(re[k], im[k]);
      cur[k] = Math.log1p(100 * mag);
      const d = cur[k] - prev[k];
      if (d > 0) flux += d;
      if (k <= kick) { if (mag > prevLin[k]) lowFlux += mag - prevLin[k]; prevLin[k] = mag; }
    }
    // the first frame rises from nothing - not an onset
    if (f > 0) { env[f] = flux; low[f] = lowFlux; }
    prev = cur;
  }
  return { env: normalise(env), low: normalise(low) };
}

/** subtract a ~0.4 s running mean, rectify, scale to unit std */
function normalise(x: Float64Array): Float64Array {
  const w = Math.round(ENV_FPS * 0.2), out = new Float64Array(x.length);
  let sum = 0;
  const pre = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) pre[i + 1] = pre[i] + x[i];
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - w), b = Math.min(x.length, i + w + 1);
    out[i] = Math.max(0, x[i] - (pre[b] - pre[a]) / (b - a));
    sum += out[i] * out[i];
  }
  const sd = Math.sqrt(sum / Math.max(1, x.length)) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= sd;
  return out;
}

/** Tempo period (envelope frames) by autocorrelation, weighted toward
 *  ~120 BPM so a half- or double-time reading only wins when clearly stronger. */
export function tempoPeriod(env: Float64Array): number {
  const minLag = Math.floor((ENV_FPS * 60) / 200), maxLag = Math.ceil((ENV_FPS * 60) / 60);
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    ac[lag] = s / Math.max(1, env.length - lag);
  }
  let best = 0, bestLag = Math.round((ENV_FPS * 60) / 120);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (ENV_FPS * 60) / lag;
    const w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    if (ac[lag] * w > best) { best = ac[lag] * w; bestLag = lag; }
  }
  // parabolic peak refinement for a sub-frame period
  const a = ac[bestLag - 1], b = ac[bestLag], c = ac[bestLag + 1], den = a - 2 * b + c;
  return den < 0 ? bestLag + (0.5 * (a - c)) / den : bestLag;
}

/** Beat frames: the path through the envelope that lands on strong onsets
 *  while keeping spacing close to the tempo period (DP + backtrack). */
export function trackBeats(env: Float64Array, period: number, tightness = 800): number[] {
  const n = env.length;
  if (!n || !(period > 1)) return [];
  // smooth onsets at beat scale so near-misses still score
  const sigma = period / 32, half = Math.ceil(3 * sigma), local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < n) s += env[j] * Math.exp(-0.5 * (k / sigma) ** 2);
    }
    local[i] = s;
  }
  const score = new Float64Array(n), back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(period * 2);
  for (let i = 0; i < n; i++) {
    let best = -Infinity, arg = -1;
    for (let j = i - hi; j <= i - lo; j++) {
      if (j < 0) continue;
      const v = score[j] - tightness * Math.log((i - j) / period) ** 2;
      if (v > best) { best = v; arg = j; }
    }
    score[i] = local[i] + (arg >= 0 ? Math.max(0, best) : 0);
    back[i] = arg >= 0 && best > 0 ? arg : -1;
  }
  // end on the best-scoring frame in the last period
  let end = n - 1;
  for (let i = Math.max(0, n - Math.ceil(period)); i < n; i++) if (score[i] > score[end]) end = i;
  const beats: number[] = [];
  for (let i = end; i >= 0; i = back[i]) beats.push(i);
  beats.reverse();
  // drop silent beats at either end (intro/outro before the groove)
  const rms = Math.sqrt(local.reduce((s, v) => s + v * v, 0) / n);
  let a = 0, b = beats.length;
  while (a < b && local[beats[a]] < 0.5 * rms) a++;
  while (b > a && local[beats[b - 1]] < 0.5 * rms) b--;
  return beats.slice(a, b);
}

/** Whole analysis of a mono track. */
export function analyseBeats(samples: Float32Array, rate = ANALYSIS_RATE): BeatGrid {
  const duration = samples.length / rate;
  const { env, low } = onsetEnvelope(samples, rate);
  const period = tempoPeriod(env);
  // kicks land on the beat far more often than hats and snares on the
  // off-beat - weighting them keeps the path from slipping half a beat
  const frames = trackBeats(env.map((v, i) => v + 2 * low[i]), period, 800);
  const beats = frames.map((f) => round3((f * HOP + FRAME / 2) / rate));
  // bar starts: the phase (mod 4) whose beats carry the most kick
  let barPhase = 0, best = -1;
  for (let ph = 0; ph < 4; ph++) {
    let s = 0;
    for (let k = ph; k < frames.length; k += 4) s += low[frames[k]] ?? 0;
    if (s > best) { best = s; barPhase = ph; }
  }
  // loudness per beat span, spread across this track's own range
  const raw = beats.map((t, k) => {
    const a = Math.floor(t * rate), b = Math.min(samples.length, Math.floor((beats[k + 1] ?? t + period * HOP / rate) * rate));
    let s = 0;
    for (let i = a; i < b; i++) s += samples[i] * samples[i];
    return Math.sqrt(s / Math.max(1, b - a));
  });
  const sorted = [...raw].sort((x, y) => x - y);
  const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? 0, p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 1;
  const energy = raw.map((v) => round3(Math.min(1, Math.max(0, (v - p10) / (p90 - p10 || 1)))));
  return { bpm: Math.round(((ENV_FPS * 60) / period) * 10) / 10, beats, barPhase, energy, duration: round3(duration) };
}

/* ---------- planning ---------- */

export type PlanClip = { duration: number };
export type PlanOptions = { pace: BeatCutPace; style: BeatCutStyle; length: number; start: number };
export type Cut = {
  clip: number;
  /** source in-point (seconds into the clip) shown at `start` */
  srcIn: number;
  /** output timeline, seconds */
  start: number;
  end: number;
  /** transition into this cut (the first cut is always "cut") */
  transition: Transition;
  /** transition length, seconds (0 for a cut) */
  dur: number;
  /** true when the clip is shorter than the shot and has to loop */
  loops: boolean;
};

/** energy over about two bars, so pace and transitions follow sections, not single hits */
export const sectionEnergy = (e: number[]) =>
  e.map((_, k) => {
    const w = e.slice(Math.max(0, k - 4), k + 5);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });

const BEAT_CHOICES = [1, 2, 4, 8];
/** beats per shot whose length is closest to `sec` */
const beatsFor = (sec: number, period: number) =>
  BEAT_CHOICES.reduce((a, b) => (Math.abs(b * period - sec) < Math.abs(a * period - sec) ? b : a));

/** Cut points on the beat over [start, start+length) of the track, as
 *  output times. "auto" follows the energy: quick cuts where it's loud,
 *  longer holds where it's quiet; holds of a bar or more start on a bar. */
export function cutPoints(grid: BeatGrid, opts: Pick<PlanOptions, "pace" | "length" | "start">): number[] {
  const { length, start } = opts;
  const idx: number[] = [];
  grid.beats.forEach((t, k) => { if (t > start + 0.05 && t < start + length - 0.3) idx.push(k); });
  const period = grid.beats.length > 1 ? (grid.beats[grid.beats.length - 1] - grid.beats[0]) / (grid.beats.length - 1) : 0.5;
  const onBar = (k: number) => (((k - grid.barPhase) % 4) + 4) % 4 === 0;
  const smooth = sectionEnergy(grid.energy);
  const points: number[] = [];
  let next = idx[0];
  // start the first hold on a bar when one comes within the first bar
  const firstBar = idx.find(onBar);
  if (firstBar !== undefined && firstBar - (idx[0] ?? 0) < 4) next = firstBar;
  for (const k of idx) {
    if (k < next) continue;
    points.push(round3(grid.beats[k] - start));
    let n: number;
    if (opts.pace !== "auto") n = Number(opts.pace);
    else {
      const e = smooth[k] ?? 0.5;
      n = beatsFor(e > 0.66 ? 0.7 : e > 0.33 ? 1.4 : 2.8, period);
    }
    next = k + n;
    if (n >= 4 && !onBar(next)) {
      // snap the next cut back to a bar line, never shorter than 2 beats
      let s = next;
      while (s > k + 2 && !onBar(s)) s--;
      next = onBar(s) ? s : next;
    }
  }
  // drop slivers: a shot under 0.35 s merges into the one before
  const out = [0];
  for (const p of points) if (p - out[out.length - 1] >= 0.35 && length - p >= 0.35) out.push(p);
  out.push(round3(length));
  return out;
}

const WHIPS: Transition[] = ["smoothleft", "smoothright"];

/** Transition into shot i (i ≥ 1) for a style. Bar starts and loud beats
 *  get the bigger moves; everything else stays a clean cut. */
function transitionFor(style: BeatCutStyle, bar: boolean, energy: number, barCount: number): Transition {
  if (style === "cut") return "cut";
  if (style === "smooth") return "fade";
  if (style === "punchy") return bar ? (barCount % 2 ? "zoomin" : "fadewhite") : "cut";
  // dynamic
  if (bar) return energy > 0.66 ? WHIPS[barCount % 2] : energy > 0.33 ? "zoomin" : "fade";
  if (energy < 0.2) return "fadeblack";
  return "cut";
}

/** Full edit plan: shots on the cut points, clips in turn (never the same
 *  clip twice in a row), each clip continuing where it left off. */
export function planEdit(grid: BeatGrid, clips: PlanClip[], opts: PlanOptions): Cut[] {
  if (clips.length < 1) return [];
  const points = cutPoints(grid, opts);
  const period = grid.beats.length > 1 ? (grid.beats[grid.beats.length - 1] - grid.beats[0]) / (grid.beats.length - 1) : 0.5;
  const beatAt = (t: number) => {
    let best = 0;
    grid.beats.forEach((b, k) => { if (Math.abs(b - t) < Math.abs(grid.beats[best] - t)) best = k; });
    return best;
  };
  const energy = sectionEnergy(grid.energy);
  const cursor = clips.map(() => 0);
  const cuts: Cut[] = [];
  let bars = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i], end = points[i + 1], len = end - start;
    const k = beatAt(start + opts.start);
    const bar = (((k - grid.barPhase) % 4) + 4) % 4 === 0 && Math.abs(grid.beats[k] - (start + opts.start)) < 0.06;
    let transition: Transition = i === 0 ? "cut" : transitionFor(opts.style, bar, energy[k] ?? 0.5, bars);
    if (bar && i > 0) bars++;
    // short, beat-sized moves; never longer than half of either shot
    const prevLen = i > 0 ? cuts[i - 1].end - cuts[i - 1].start : 0;
    let dur = transition === "cut" ? 0 : Math.min(transition === "fade" || transition === "fadeblack" ? 0.45 : 0.25, period / 2, len / 2, prevLen / 2);
    if (dur < 0.06) { transition = "cut"; dur = 0; }
    const c = clips.length === 1 ? 0 : i % clips.length;
    const d = clips[c].duration;
    const pad = 0.3; // room for the next transition's head
    let srcIn = cursor[c];
    if (srcIn + len + pad > d) srcIn = Math.min(0.15, Math.max(0, d - len - pad));
    const loops = len + pad > d;
    if (loops) srcIn = 0;
    srcIn = Math.max(srcIn, dur / 2);
    cursor[c] = srcIn + len + 0.2;
    cuts.push({ clip: c, srcIn: round3(srcIn), start: round3(start), end: round3(end), transition, dur: round3(dur), loops });
  }
  return cuts;
}

/** output frame rate of the render */
export const BEAT_CUT_FPS = 30;

/** Plan → whole output frames, so 30+ joins never drift off the beat: shot
 *  i spans [F_i, F_i+1) plus half of each neighbouring transition (lengths
 *  kept even so the halves are whole), and each xfade starts exactly half a
 *  transition before its beat. */
export function framePlan(plan: Cut[], fps = BEAT_CUT_FPS) {
  const f = plan.map((c) => Math.round(c.start * fps));
  const end = Math.round((plan[plan.length - 1]?.end ?? 0) * fps);
  const tr = plan.map((c, i) => (i === 0 || c.transition === "cut" ? 0 : Math.max(2, Math.round((c.dur * fps) / 2) * 2)));
  return plan.map((c, i) => {
    const head = tr[i] / 2, tail = (tr[i + 1] ?? 0) / 2;
    return { cut: c, head, tail, frames: (f[i + 1] ?? end) - f[i] + head + tail, offset: (f[i] - head) / fps, xfade: tr[i] / fps };
  });
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
