"use client";
import { useRef, useState } from "react";
import {
  azimuthTerm, elevationTerm, lightsOf, LIGHT_COLORS, LIGHT_INTENSITIES,
  type DomeLight,
} from "@/lib/catalog/presets/director";

/** LightDome - a top-down view of the light dome: azimuth reads around the
 *  circle (0 front at the bottom, 90 frame right, 180 back, 270 left) and
 *  elevation reads inward (rim = floor-level, centre = overhead). Click the
 *  dome to place a light, drag a marker to move it, and set colour +
 *  intensity per light below. At most two lights - they steer the prompt's
 *  lighting clause today; s9's OF_Relight consumes the same fields.
 *  Value is a "+"-joined compact string "azA:elE:color:intensity". */
const NAMED_COLOR: Record<string, string> = { warm: "#f0a860", neutral: "#d8d8d8", cool: "#7db4e8" };
const fill = (l: DomeLight) => (l.color.startsWith("#") ? l.color : NAMED_COLOR[l.color] ?? "#888");

export function LightDome({ value, onChange }: { value: string | string[] | undefined; onChange: (v: string) => void }) {
  const lights = lightsOf(value);
  const [sel, setSel] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<number | null>(null);
  const active = Math.min(sel, Math.max(0, lights.length - 1));

  const emit = (ls: DomeLight[]) =>
    onChange(ls.map((l) => `az${l.az}:el${l.el}:${l.color}:${l.intensity}`).join("+"));

  const S = 176, c = S / 2, R = 76;
  /** pointer → dome coords: az around the circle (0 = front at bottom),
   *  el by radius (rim 0 → centre 90) */
  const pt = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    const x = e.clientX - r.left - c, y = e.clientY - r.top - c;
    const dist = Math.min(R, Math.hypot(x, y));
    const az = Math.round((Math.atan2(x, y) * 180) / Math.PI);
    return { az: (az + 360) % 360, el: Math.round(90 * (1 - dist / R)) };
  };
  const pos = (l: DomeLight) => {
    const r = R * (1 - l.el / 90), a = (l.az * Math.PI) / 180;
    return { x: c + r * Math.sin(a), y: c + r * Math.cos(a) };
  };

  const place = (e: React.PointerEvent) => {
    if (dragRef.current !== null || lights.length >= 2) return;
    const { az, el } = pt(e);
    emit([...lights, { az, el, color: "warm", intensity: "soft" }]);
    setSel(lights.length);
  };

  const setLight = (i: number, patch: Partial<DomeLight>) =>
    emit(lights.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div className="relative inline-block" title="Click the dome to place a light; drag a marker to move it - lights steer the prompt's lighting clause">
      <svg ref={svgRef} width={S} height={S} viewBox={`0 0 ${S} ${S}`} className="block cursor-crosshair" data-lightdome
        onPointerDown={place}
        onPointerMove={(e) => { if (dragRef.current !== null) setLight(dragRef.current, pt(e)); }}
        onPointerUp={() => { dragRef.current = null; }}
        onPointerLeave={() => { dragRef.current = null; }}>
        {/* dome: rim = el 0, mid ring = el 45, centre = el 90 overhead */}
        <circle cx={c} cy={c} r={R} fill="none" stroke="var(--color-line)" strokeWidth="1" />
        <circle cx={c} cy={c} r={R / 2} fill="none" stroke="var(--color-line)" strokeWidth="0.5" strokeDasharray="3 3" />
        <line x1={c - R} y1={c} x2={c + R} y2={c} stroke="var(--color-line)" strokeWidth="0.5" strokeDasharray="2 3" />
        <line x1={c} y1={c - R} x2={c} y2={c + R} stroke="var(--color-line)" strokeWidth="0.5" strokeDasharray="2 3" />
        {/* subject at centre; F marks the front (camera side) */}
        <circle cx={c} cy={c} r="5" fill="var(--color-dim)" opacity="0.5" />
        <text x={c} y={c + R + 10} textAnchor="middle" fontSize="7.5" fill="var(--color-dim)">front · az0</text>
        <text x={c - R + 12} y={c - 4} fontSize="7.5" fill="var(--color-dim)">az270</text>
        <text x={c + R - 10} y={c - 4} fontSize="7.5" fill="var(--color-dim)">az90</text>
        <text x={c} y={c - R + 8} textAnchor="middle" fontSize="7.5" fill="var(--color-dim)">back · az180</text>
        {lights.map((l, i) => {
          const { x, y } = pos(l);
          const on = i === active;
          const rr = l.intensity === "soft" ? 5 : l.intensity === "medium" ? 6.5 : 8;
          return (
            <g key={i} className="cursor-grab" style={{ touchAction: "none" }}
              onPointerDown={(e) => { e.stopPropagation(); dragRef.current = i; setSel(i); (e.target as Element).setPointerCapture?.(e.pointerId); }}>
              <circle cx={x} cy={y} r="10" fill="transparent" />
              <circle cx={x} cy={y} r={rr} fill={fill(l)}
                stroke={on ? "var(--color-accent)" : "var(--color-line)"}
                strokeWidth={l.intensity === "hard" ? 2.5 : 1.5}
                strokeDasharray={l.intensity === "soft" ? "2 2" : undefined} />
              {l.intensity === "hard" && <circle cx={x} cy={y} r="2" fill="var(--color-fg)" />}
            </g>
          );
        })}
      </svg>
      <div className="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--color-dim)]">
        <span className="font-semibold">{lights.length}/2</span>
        {lights.map((l, i) => (
          <button key={i} onClick={() => setSel(i)}
            className={`rounded px-1 py-px ${i === active ? "bg-[var(--color-panel2)] text-[var(--color-fg)]" : ""}`}
            title={`${azimuthTerm(l.az)} · ${elevationTerm(l.el)}`}>
            {i === active ? "▸" : ""}az{l.az}·el{l.el}
          </button>
        ))}
        <span className="ml-auto">prompt-style</span>
      </div>
      {lights.length > 0 && (
        <div className="mt-0.5 flex items-center gap-1 text-[10px]">
          {LIGHT_COLORS.map((cn) => (
            <button key={cn} onClick={() => setLight(active, { color: cn })}
              title={cn}
              className={`h-4 w-4 rounded-full border ${lights[active]?.color === cn ? "border-[var(--color-accent)]" : "border-[var(--color-line)]"}`}
              style={{ background: NAMED_COLOR[cn] }} />
          ))}
          <input type="color" value={lights[active]?.color.startsWith("#") ? lights[active].color : "#d8b4a0"}
            onChange={(e) => setLight(active, { color: e.target.value })}
            title="custom #hex" className="h-4 w-6 cursor-pointer rounded border border-[var(--color-line)] bg-transparent p-0" />
          <span className="mx-1 h-3 w-px bg-[var(--color-line)]" />
          {LIGHT_INTENSITIES.map((i2) => (
            <button key={i2} onClick={() => setLight(active, { intensity: i2 })}
              className={`rounded px-1 py-px ${lights[active]?.intensity === i2 ? "bg-[var(--color-panel2)] font-semibold text-[var(--color-fg)]" : "text-[var(--color-dim)]"}`}>
              {i2}
            </button>
          ))}
          <button onClick={() => emit(lights.filter((_, j) => j !== active))}
            className="ml-auto text-[var(--color-dim)] hover:text-[var(--color-danger)]" title="remove light">✕</button>
        </div>
      )}
    </div>
  );
}
