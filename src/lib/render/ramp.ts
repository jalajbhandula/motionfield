/**
 * Speed-ramp curves - the step-7 hook. A curve is piecewise-linear `speed`
 * over OUTPUT time: at output second u the source plays at speed(u)×.
 *
 *   sourceTimeAt(curve, u)      → source second shown at output u  (F(u))
 *   outputDuration(curve, d)    → output seconds needed to play d source seconds
 *   setptsExpr(curve)           → ffmpeg `setpts=` expression producing the
 *                                 same retiming on the rendered stream
 *   hudKeyframes(curve, max)    → `props.value` keyframes so a `hud` layer's
 *                                 dial tracks the live speed factor
 *
 * Speeds are clamped to [0.1, 8]. Pure math - no I/O, deterministic.
 */

export interface SpeedPoint { t: number; speed: number }
export type SpeedCurve = SpeedPoint[];

const MIN_SPEED = 0.1;
const MAX_SPEED = 8;

const speedAt = (curve: SpeedPoint[], u: number): number => {
  if (u <= curve[0].t) return curve[0].speed;
  for (let i = 1; i < curve.length; i++) {
    if (u <= curve[i].t) {
      const [a, b] = [curve[i - 1], curve[i]];
      const span = b.t - a.t;
      const f = span <= 0 ? 0 : (u - a.t) / span;
      return a.speed + (b.speed - a.speed) * f;
    }
  }
  return curve[curve.length - 1].speed;
};

/** sort by t, clamp speeds, drop duplicate times, ensure a t=0 knot */
export function normalizeCurve(curve: SpeedCurve): SpeedCurve {
  if (!curve.length) return [{ t: 0, speed: 1 }];
  const pts = [...curve]
    .map((p) => ({ t: Math.max(0, p.t), speed: Math.min(MAX_SPEED, Math.max(MIN_SPEED, p.speed)) }))
    .sort((a, b) => a.t - b.t);
  const out: SpeedCurve = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t === out[out.length - 1].t) out[out.length - 1] = pts[i];
    else out.push(pts[i]);
  }
  if (out[0].t > 0) out.unshift({ t: 0, speed: out[0].speed });
  return out;
}

/** F(u): source seconds elapsed by output second u - piecewise integral. */
export function sourceTimeAt(curve: SpeedCurve, u: number): number {
  const pts = normalizeCurve(curve);
  if (u <= 0) return 0;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (u <= a.t) break;
    const hi = Math.min(u, b.t);
    // ∫ speed du over [a.t, hi] - trapezoid of the linear speed
    acc += ((speedAt(pts, a.t) + speedAt(pts, hi)) / 2) * (hi - a.t);
    if (u <= b.t) return acc;
  }
  if (u > pts[pts.length - 1].t) {
    acc += (u - pts[pts.length - 1].t) * pts[pts.length - 1].speed;
  }
  return acc;
}

/** inverse of F: the output time at which the source has played `d` seconds. */
export function outputDuration(curve: SpeedCurve, sourceDuration: number): number {
  const pts = normalizeCurve(curve);
  if (sourceDuration <= 0) return 0;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segSrc = ((a.speed + b.speed) / 2) * (b.t - a.t);
    if (acc + segSrc >= sourceDuration) {
      const k = (b.speed - a.speed) / (b.t - a.t);
      const s = sourceDuration - acc;
      if (Math.abs(k) < 1e-9) return a.t + s / a.speed;
      // solve a.t + du: a.speed*du + k/2*du² = s
      const du = (-a.speed + Math.sqrt(Math.max(0, a.speed * a.speed + 2 * k * s))) / k;
      return a.t + du;
    }
    acc += segSrc;
  }
  const last = pts[pts.length - 1];
  return last.t + (sourceDuration - acc) / last.speed;
}

const fmt = (n: number) => {
  if (!Number.isFinite(n)) throw new Error("non-finite value in speed curve");
  return Math.abs(n) < 1e-12 ? "0" : String(n);
};

/**
 * ffmpeg `setpts=` expression - maps each input frame's PTS (source seconds)
 * to F⁻¹(PTS), i.e. the output second where that frame belongs. Constants are
 * baked in; the expression is a nested if() over the curve's segments.
 *
 * For a single constant speed this reduces to `PTS/v`.
 *
 * NOTE: the expression contains commas inside if() - in a filtergraph the
 * whole `setpts=` value must be single-quoted (`setpts='<expr>'`) or the
 * ffmpeg lexer splits the arguments.
 */
export function setptsExpr(curve: SpeedCurve): string {
  const pts = normalizeCurve(curve);
  if (pts.length === 1) return `PTS/${fmt(pts[0].speed)}`;

  // F_i - source time at each knot
  const F: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    F.push(F[i - 1] + ((a.speed + b.speed) / 2) * (b.t - a.t));
  }

  // per-segment inverse branch over input PTS*TB (= source seconds s)
  let expr = "";
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const k = (b.speed - a.speed) / (b.t - a.t);
    const s0 = F[i - 1];
    const s1 = F[i];
    let body: string;
    if (Math.abs(k) < 1e-9) {
      body = `${fmt(a.t)}+(PTS*TB-${fmt(s0)})/${fmt(a.speed)}`;
    } else {
      body = `${fmt(a.t)}+(sqrt(max(0,${fmt(a.speed)}*${fmt(a.speed)}+2*${fmt(k)}*(PTS*TB-${fmt(s0)})))-${fmt(a.speed)})/${fmt(k)}`;
    }
    const cond = `between(PTS*TB,${fmt(s0)},${fmt(s1)})`;
    expr = expr ? `if(${cond},${body},${expr})` : `if(${cond},${body},__TAIL__)`;
  }
  const last = pts[pts.length - 1];
  const tail = `${fmt(last.t)}+(PTS*TB-${fmt(F[F.length - 1])})/${fmt(last.speed)}`;
  expr = expr.replace("__TAIL__", tail);
  return `(${expr})/TB`;
}

/**
 * Keyframes that make a `hud` layer's dial track the live speed factor -
 * one knot per curve point, `props.value` = the speed clamped to the dial max.
 * Pair with a hud layer whose props.max ≥ the curve's top speed.
 */
export function hudKeyframes(curve: SpeedCurve, max: number): { t: number; path: "props.value"; value: number; ease: "linear" }[] {
  const pts = normalizeCurve(curve);
  return pts.map((p) => ({ t: p.t, path: "props.value" as const, value: Math.min(Math.max(MIN_SPEED, p.speed), max), ease: "linear" as const }));
}
