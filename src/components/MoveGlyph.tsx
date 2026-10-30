import { composeTrajectory } from "@/lib/camera/trajectory";

/** MoveGlyph - renders the preset's *actual* camera path as a blocking
 *  diagram (top-down by default; side view for vertical-dominant moves;
 *  an aim-fan for pure-rotation moves like pans). Server component, pure SVG.
 *  The path is computed by the same trajectory engine the generator runs -
 *  this is documentation, not decoration. */
export default function MoveGlyph({
  moves,
  distance = 4,
  className,
}: {
  moves: readonly string[];
  distance?: number;
  className?: string;
}) {
  let traj;
  try {
    traj = composeTrajectory({ moves: [...moves], duration: 3, fps: 8, distance, seed: 7 });
  } catch {
    return null; // unknown move ids render no glyph rather than a wrong one
  }
  const frames = traj.frames;
  if (frames.length < 2) return null;

  // travel per axis decides the projection plane
  let dx = 0, dy = 0, dz = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].pos, b = frames[i].pos;
    dx += Math.abs(b[0] - a[0]); dy += Math.abs(b[1] - a[1]); dz += Math.abs(b[2] - a[2]);
  }
  const side = dy > dx + dz; // pedestal/crane-class → side view (z→x, -y→y)

  // world→svg projection; subject sits at (0,0,distance), camera starts at origin
  const W = 160, H = 90;
  const pts = frames.map((f) => (side ? [f.pos[2], -f.pos[1]] : [f.pos[0], -f.pos[2]]));
  // subject anchor: top-down → [0,-distance]; side → [distance,0]
  const subj = side ? ([distance, 0] as const) : ([0, -distance] as const);

  const all = [...pts, [subj[0], subj[1]]];
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const pad = 16;
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sx = (W - pad * 2) / Math.max(1e-6, x1 - x0);
  const sy = (H - pad * 2) / Math.max(1e-6, y1 - y0);
  const s = Math.min(sx, sy);
  const ox = pad + ((W - pad * 2) - (x1 - x0) * s) / 2;
  const oy = pad + ((H - pad * 2) - (y1 - y0) * s) / 2;
  const P = (wx: number, wy: number) => `${(ox + (wx - x0) * s).toFixed(1)},${(oy + (wy - y0) * s).toFixed(1)}`;

  const pathLen = pts.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : a), 0);
  const start = pts[0], end = pts[pts.length - 1];

  // aim direction at the last frame (yaw, in the chosen plane)
  const yaw = (frames[frames.length - 1].yaw * Math.PI) / 180;
  const aim = side ? [Math.cos(0), -Math.sin(0)] : [Math.sin(yaw), Math.cos(yaw)];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} aria-hidden>
      {/* grid */}
      {Array.from({ length: 5 }, (_, i) => (
        <line key={`v${i}`} x1={(W / 5) * (i + 0.5)} y1={0} x2={(W / 5) * (i + 0.5)} y2={H}
          stroke="currentColor" strokeOpacity="0.08" strokeWidth="0.5" />
      ))}
      {Array.from({ length: 3 }, (_, i) => (
        <line key={`h${i}`} x1={0} y1={(H / 3) * (i + 0.5)} x2={W} y2={(H / 3) * (i + 0.5)}
          stroke="currentColor" strokeOpacity="0.08" strokeWidth="0.5" />
      ))}
      {/* subject */}
      <circle cx={P(subj[0], subj[1]).split(",")[0]} cy={P(subj[0], subj[1]).split(",")[1]}
        r="3.5" fill="currentColor" fillOpacity="0.9" />
      <circle cx={P(subj[0], subj[1]).split(",")[0]} cy={P(subj[0], subj[1]).split(",")[1]}
        r="7" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="0.75" />
      {pathLen > 0.15 ? (
        <>
          {/* camera path */}
          <polyline points={pts.map((p) => P(p[0], p[1])).join(" ")}
            fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          {/* start */}
          <circle cx={P(start[0], start[1]).split(",")[0]} cy={P(start[0], start[1]).split(",")[1]}
            r="2.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          {/* end + aim tick */}
          <circle cx={P(end[0], end[1]).split(",")[0]} cy={P(end[0], end[1]).split(",")[1]}
            r="2.5" fill="currentColor" />
          <line x1={P(end[0], end[1]).split(",")[0]} y1={P(end[0], end[1]).split(",")[1]}
            x2={Number(P(end[0], end[1]).split(",")[0]) + aim[0] * 10}
            y2={Number(P(end[0], end[1]).split(",")[1]) + aim[1] * 10}
            stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" />
        </>
      ) : (
        /* pure-rotation move - aim fan from the camera point */
        <g>
          {[frames[0].yaw, frames[Math.floor(frames.length / 2)].yaw, frames[frames.length - 1].yaw].map((a, i) => {
            const r = (a * Math.PI) / 180;
            const d = side ? [Math.cos(r), Math.sin(r)] : [Math.sin(r), Math.cos(r)];
            return (
              <line key={i} x1={P(start[0], start[1]).split(",")[0]} y1={P(start[0], start[1]).split(",")[1]}
                x2={Number(P(start[0], start[1]).split(",")[0]) + d[0] * 22}
                y2={Number(P(start[0], start[1]).split(",")[1]) + d[1] * 22}
                stroke="currentColor" strokeOpacity={i === 1 ? "0.9" : "0.45"} strokeWidth="1.3" />
            );
          })}
          <circle cx={P(start[0], start[1]).split(",")[0]} cy={P(start[0], start[1]).split(",")[1]}
            r="2.5" fill="currentColor" />
        </g>
      )}
    </svg>
  );
}
