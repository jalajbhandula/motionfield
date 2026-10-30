"use client";
import { DIRECTOR_EMOTIONS, EMOTION_INTENSITIES, type EmotionIntensity } from "@/lib/catalog/presets/director";

/** EmotionWheel - 8 emotion wedges × 3 intensity rings. Inner = subtle,
 *  mid = moderate, outer = intense. Value is "emotion:intensity" or null -
 *  it becomes the performance clause on the prompt. */
export function EmotionWheel({ value, onChange }: {
  value: { emotion: string; intensity: string } | null;
  onChange: (v: { emotion: string; intensity: string } | null) => void;
}) {
  const S = 150, c = S / 2, R = [22, 40, 58]; // ring radii: subtle, moderate, intense
  const pick = (emotion: string, intensity: string) =>
    onChange(value?.emotion === emotion && value?.intensity === intensity ? null : { emotion, intensity });

  const arc = (r0: number, r1: number, a0: number, a1: number) => {
    const p = (r: number, a: number) => `${c + r * Math.cos(a)},${c - r * Math.sin(a)}`;
    return `M ${p(r0, a0)} L ${p(r1, a0)} A ${r1} ${r1} 0 0 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 0 0 ${p(r0, a0)} Z`;
  };

  return (
    <div className="relative inline-block" title="Pick an emotion + intensity - it steers the subject's performance clause">
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} className="block">
        {DIRECTOR_EMOTIONS.map((e, i) => {
          const a0 = (i / DIRECTOR_EMOTIONS.length) * Math.PI * 2 + Math.PI / 2;
          const a1 = ((i + 1) / DIRECTOR_EMOTIONS.length) * Math.PI * 2 + Math.PI / 2;
          const am = (a0 + a1) / 2;
          return EMOTION_INTENSITIES.map((intensity, ring) => {
            const on = value?.emotion === e && value?.intensity === intensity;
            return (
              <path key={`${e}-${intensity}`} d={arc(R[ring], R[ring + 1] ?? R[R.length - 1] + 12, a0 + 0.02, a1 - 0.02)}
                data-emotion={e} data-intensity={intensity}
                fill={on ? "var(--color-accent)" : "var(--color-panel2)"}
                stroke="var(--color-line)" strokeWidth="0.75"
                className="cursor-pointer hover:fill-[var(--color-panel)]"
                onClick={() => pick(e, intensity as EmotionIntensity)} />
            );
          }).concat(
            <text key={`lbl-${e}`} x={c + (R[2] + 14) * Math.cos(am)} y={c - (R[2] + 14) * Math.sin(am) + 3}
              textAnchor="middle" fontSize="8" fill="var(--color-dim)">{e}</text>,
          );
        })}
        <circle cx={c} cy={c} r={R[0] - 1} fill="var(--color-panel)" stroke="var(--color-line)" strokeWidth="0.75" />
        <text x={c} y={c + 3} textAnchor="middle" fontSize="8" fill="var(--color-dim)">feel</text>
      </svg>
      <div className="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--color-dim)]">
        {value ? (
          <button onClick={() => onChange(null)}
            className="rounded bg-[var(--color-panel2)] px-1 py-px text-[var(--color-fg)] hover:text-[var(--color-danger)]">
            {value.emotion} · {value.intensity} ✕
          </button>
        ) : <span>none</span>}
        <span className="ml-auto">prompt-style</span>
      </div>
    </div>
  );
}
