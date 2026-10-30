"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_SETUP, MAX_LIGHTS, RELIGHT_PRESETS, type RelightLight, type RelightSetup } from "@/lib/relight/light";
import { prepare, relightInto, type Prepared } from "@/lib/relight/shade";
import { ErrNote } from "@/components/ErrNote";
import { ApiError, uploadFile, userError, userErrorFrom, type UserError } from "@/lib/user-error";

type Job = { id: string; status: string; progress: number; error: string | null; outputs: { url: string; type: string }[] };

const LIVE = new Set(["queued", "in_progress"]);
const PREVIEW_W = 960;

async function upload(file: File): Promise<string> {
  return (await uploadFile(file)).url;
}

async function submit(endpoint: string, params: Record<string, unknown>): Promise<Job> {
  const r = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ endpoint_id: endpoint, params }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(userError(r.status, d.error));
  return d.job as Job;
}

async function waitFor(id: string, onTick: (j: Job) => void): Promise<Job> {
  for (;;) {
    const r = await fetch(`/api/jobs/${id}`);
    if (!r.ok) throw new Error(`lost track of the job (${r.status})`);
    const { job } = (await r.json()) as { job: Job };
    onTick(job);
    if (!LIVE.has(job.status)) return job;
    await new Promise((res) => setTimeout(res, 1200));
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("could not read that image"));
    im.src = url;
  });
}

function pixels(im: HTMLImageElement, w: number, h: number): ImageData {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(im, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** Top-down light dome: the camera sits at the bottom, overhead is the centre. */
function Dome({ lights, sel, onSelect, onMove }: {
  lights: RelightLight[]; sel: number; onSelect: (i: number) => void; onMove: (i: number, az: number, el: number) => void;
}) {
  const S = 220, c = S / 2, R = 92;
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const toDome = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * S - c, y = ((e.clientY - r.top) / r.height) * S - c;
    const dist = Math.min(R, Math.hypot(x, y));
    return { az: Math.round(((Math.atan2(x, y) * 180) / Math.PI + 360) % 360), el: Math.round(90 * (1 - dist / R)) };
  };
  const pos = (l: RelightLight) => {
    const r = R * (1 - Math.max(0, l.el) / 90), a = (l.az * Math.PI) / 180;
    return { x: c + r * Math.sin(a), y: c + r * Math.cos(a) };
  };
  return (
    <svg ref={svg} viewBox={`0 0 ${S} ${S}`} className="mx-auto block w-full max-w-[240px] touch-none select-none" data-testid="relight-dome"
      onPointerMove={(e) => { if (drag.current !== null) { const p = toDome(e); onMove(drag.current, p.az, p.el); } }}
      onPointerUp={() => { drag.current = null; }} onPointerLeave={() => { drag.current = null; }}
      onPointerDown={(e) => { const p = toDome(e); onMove(sel, p.az, p.el); drag.current = sel; }}>
      <circle cx={c} cy={c} r={R} fill="rgba(255,255,255,0.03)" stroke="var(--color-border)" />
      <circle cx={c} cy={c} r={R / 2} fill="none" stroke="var(--color-border)" strokeDasharray="3 4" />
      <line x1={c - R} y1={c} x2={c + R} y2={c} stroke="var(--color-border)" strokeDasharray="2 5" />
      <line x1={c} y1={c - R} x2={c} y2={c + R} stroke="var(--color-border)" strokeDasharray="2 5" />
      {/* subject + camera */}
      <circle cx={c} cy={c} r={9} fill="var(--color-panel2)" stroke="var(--color-dim)" />
      <rect x={c - 9} y={c + R + 4} width={18} height={11} rx={2} fill="var(--color-dim)" />
      <text x={c} y={14} textAnchor="middle" fontSize="9" fill="var(--color-faint)">behind</text>
      <text x={8} y={c + 3} fontSize="9" fill="var(--color-faint)">left</text>
      <text x={S - 8} y={c + 3} textAnchor="end" fontSize="9" fill="var(--color-faint)">right</text>
      {lights.map((l, i) => {
        const p = pos(l);
        return (
          <g key={i} className="cursor-grab" onPointerDown={(e) => { e.stopPropagation(); onSelect(i); drag.current = i; (e.target as Element).setPointerCapture?.(e.pointerId); }}>
            <line x1={c} y1={c} x2={p.x} y2={p.y} stroke={l.color} strokeOpacity={0.5} />
            <circle cx={p.x} cy={p.y} r={i === sel ? 12 : 10} fill={l.color} stroke={i === sel ? "#fff" : "rgba(0,0,0,.5)"} strokeWidth={i === sel ? 2.5 : 1.5} data-testid={`relight-light-${i}`} />
            <text x={p.x} y={p.y + 3.5} textAnchor="middle" fontSize="10" fontWeight="700" fill="rgba(0,0,0,.7)" pointerEvents="none">{i + 1}</text>
          </g>
        );
      })}
    </svg>
  );
}

function Slider({ label, value, min, max, step, onChange, fmt, testId }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string; testId?: string;
}) {
  return (
    <label className="block text-xs text-[var(--color-dim)]">
      <span className="mb-1 flex justify-between"><span>{label}</span><span className="tabular-nums">{fmt ? fmt(value) : value}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} data-testid={testId}
        onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" />
    </label>
  );
}

export default function RelightStudio({ authed }: { authed: boolean }) {
  const [photo, setPhoto] = useState<string | null>(null);
  const [normalsJob, setNormalsJob] = useState<Job | null>(null);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [setup, setSetup] = useState<RelightSetup>(DEFAULT_SETUP);
  const [preset, setPreset] = useState<string>(RELIGHT_PRESETS[0].id);
  const [sel, setSel] = useState(0);
  const [split, setSplit] = useState(0);
  const [note, setNote] = useState("");
  const [render, setRender] = useState<Job | null>(null);
  const [busy, setBusy] = useState<null | "upload" | "render">(null);
  const [error, setError] = useState<UserError | string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const original = useRef<HTMLCanvasElement | null>(null);
  const frame = useRef<number>(0);

  async function pick(file: File) {
    setBusy("upload"); setError(null); setPrep(null); setRender(null); setNormalsJob(null);
    try {
      const url = await upload(file);
      setPhoto(url);
      setBusy(null);
      const job = await submit("motionfield/relight/normals", { image_url: url });
      setNormalsJob(job);
      const done = await waitFor(job.id, setNormalsJob);
      const nUrl = done.outputs?.[0]?.url;
      if (done.status !== "completed" || !nUrl) throw new Error(done.error || "could not read the shape of this photo");
      const [im, nm] = await Promise.all([loadImage(url), loadImage(nUrl)]);
      const w = Math.min(PREVIEW_W, im.naturalWidth), h = Math.max(1, Math.round((im.naturalHeight * w) / im.naturalWidth));
      const ph = pixels(im, w, h);
      const oc = document.createElement("canvas");
      oc.width = w; oc.height = h;
      oc.getContext("2d")!.putImageData(ph, 0, 0);
      original.current = oc;
      setPrep(prepare(ph, pixels(nm, w, h)));
    } catch (e) {
      setError(userErrorFrom(e));
      setBusy(null);
    }
  }

  // live shading, one frame per animation tick
  useEffect(() => {
    if (!prep) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const c = canvas.current;
      if (!c) return;
      c.width = prep.w; c.height = prep.h;
      const ctx = c.getContext("2d")!;
      const out = ctx.createImageData(prep.w, prep.h);
      relightInto(prep, setup, out);
      ctx.putImageData(out, 0, 0);
      const sx = Math.round(prep.w * split);
      if (original.current && sx > 0) ctx.drawImage(original.current, 0, 0, sx, prep.h, 0, 0, sx, prep.h);
    });
  }, [prep, setup, split]);

  const light = setup.lights[Math.min(sel, setup.lights.length - 1)];
  const setLight = (i: number, patch: Partial<RelightLight>) => {
    setPreset("custom");
    setSetup((s) => ({ ...s, lights: s.lights.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  };

  async function doRender() {
    if (!photo || busy) return;
    setBusy("render"); setError(null); setRender(null);
    try {
      const job = await submit("motionfield/relight/render", {
        image_url: photo, lights: JSON.stringify(setup.lights), ambient: setup.ambient,
        ambient_color: setup.ambientColor, strength: setup.strength, ...(note.trim() ? { prompt: note.trim() } : {}),
      });
      setRender(job);
      await waitFor(job.id, setRender);
    } catch (e) {
      setError(userErrorFrom(e));
    } finally {
      setBusy(null);
    }
  }

  const out = render?.outputs?.[0];
  const reading = normalsJob && LIVE.has(normalsJob.status);

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Relight</h1>
        <p className="mt-1 text-sm text-[var(--color-dim)]">Put the light where you want it. Drag lights around your subject, pick colour and softness, see it live - then render a photographic relight that keeps the subject.</p>
      </div>
      {!authed && <p className="panel mt-6 p-4 text-sm"><Link href="/login?next=/relight" className="underline">Sign in</Link> to relight your photos.</p>}

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <main className="min-w-0 space-y-3">
          {!photo ? (
            <label className={`panel flex aspect-video cursor-pointer flex-col items-center justify-center gap-2 border-dashed text-center ${!authed ? "pointer-events-none opacity-50" : "hover:border-[var(--color-accent)]"}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) pick(f); }}>
              <span className="font-display text-lg font-semibold">{busy === "upload" ? "Uploading…" : "Drop a photo"}</span>
              <span className="text-sm text-[var(--color-dim)]">Portraits, products, rooms - anything with a clear subject</span>
              <input type="file" accept="image/*" className="hidden" data-testid="relight-source" disabled={!authed}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ""; }} />
            </label>
          ) : (
            <>
              <div className="relative overflow-hidden rounded-2xl border border-[var(--color-border)] bg-black">
                {prep ? (
                  <canvas ref={canvas} data-testid="relight-canvas" className="block h-auto w-full" />
                ) : (
                  <div className="relative">
                    <img src={photo} alt="Your photo" className="block w-full opacity-60" />
                    <div className="absolute inset-0 grid place-items-center">
                      <div className="rounded-xl bg-black/70 px-4 py-3 text-center text-sm text-white" data-testid="relight-reading">
                        {error ? "Couldn't read this photo" : reading ? `Reading the shape of your photo… ${normalsJob?.progress ?? 0}%` : "Preparing…"}
                        <div className="mt-1 text-[11px] text-white/60">depth → surface normals, once per photo</div>
                      </div>
                    </div>
                  </div>
                )}
                {prep && (
                  <>
                    {split > 0 && <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/80" style={{ left: `${split * 100}%` }} />}
                    <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">Live preview</span>
                  </>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--color-dim)]">
                {prep && (
                  <label className="flex flex-1 items-center gap-2">Compare with original
                    <input type="range" min={0} max={1} step={0.01} value={split} onChange={(e) => setSplit(Number(e.target.value))} className="max-w-48 flex-1 accent-[var(--color-accent)]" aria-label="Before / after split" />
                  </label>
                )}
                {(prep || error) && (
                  <button className="btn btn-ghost btn-sm ml-auto" onClick={() => { setPhoto(null); setPrep(null); setRender(null); setNormalsJob(null); setError(null); }}>Change photo</button>
                )}
              </div>
            </>
          )}

          {render && (
            <section className="panel p-4" aria-label="Rendered relight" data-testid="relight-result" data-status={render.status}>
              <div className="flex items-center gap-3">
                <div className="text-sm font-medium">Rendered relight</div>
                <span className="text-xs text-[var(--color-dim)]">{LIVE.has(render.status) ? `Rendering… ${render.progress}%` : render.status === "completed" ? "Done - saved to your history" : render.error ?? render.status}</span>
                {out && <a className="btn btn-sm ml-auto" href={out.url} download data-testid="relight-download">Download</a>}
              </div>
              {out && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <figure><img src={photo ?? ""} alt="Original" className="w-full rounded-lg" /><figcaption className="mt-1 text-[11px] text-[var(--color-faint)]">Original</figcaption></figure>
                  <figure><img src={out.url} alt="Relit" className="w-full rounded-lg" /><figcaption className="mt-1 text-[11px] text-[var(--color-faint)]">Relit</figcaption></figure>
                </div>
              )}
            </section>
          )}
        </main>

        <aside className="space-y-4">
          <section className="panel space-y-4 p-4">
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-dim)]">Presets</div>
              <div className="grid grid-cols-2 gap-1.5" data-testid="relight-presets">
                {RELIGHT_PRESETS.map((p) => (
                  <button key={p.id} title={p.hint} data-testid={`relight-preset-${p.id}`} aria-pressed={preset === p.id}
                    onClick={() => { setPreset(p.id); setSetup(structuredClone(p.setup)); setSel(0); }}
                    className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs ${preset === p.id ? "border-[var(--color-accent)] text-[var(--color-text)]" : "border-[var(--color-border)] text-[var(--color-dim)] hover:border-[#3a3a42]"}`}>
                    <span className="flex shrink-0 -space-x-1">{p.setup.lights.map((l, i) => <span key={i} className="h-3.5 w-3.5 rounded-full border border-black/40" style={{ background: l.color }} />)}</span>
                    <span className="truncate">{p.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-dim)]">Lights</span>
                <span className="flex gap-1">
                  {setup.lights.length < MAX_LIGHTS && (
                    <button className="btn btn-ghost btn-sm" data-testid="relight-add" onClick={() => {
                      setPreset("custom");
                      setSetup((s) => ({ ...s, lights: [...s.lights, { az: 90, el: 25, color: "#ffffff", power: 0.8, soft: 0.5 }] }));
                      setSel(setup.lights.length);
                    }}>+ Light</button>
                  )}
                  {setup.lights.length > 1 && (
                    <button className="btn btn-ghost btn-sm" onClick={() => {
                      setPreset("custom");
                      setSetup((s) => ({ ...s, lights: s.lights.filter((_, j) => j !== sel) }));
                      setSel(0);
                    }}>Remove {sel + 1}</button>
                  )}
                </span>
              </div>
              <Dome lights={setup.lights} sel={sel} onSelect={setSel} onMove={(i, az, el) => setLight(i, { az, el })} />
              <p className="mt-1 text-center text-[11px] text-[var(--color-faint)]">Camera at the bottom · centre is overhead · drag a light</p>
            </div>

            {light && (
              <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-3">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-medium">Light {sel + 1}</span>
                  <input type="color" value={light.color} aria-label={`Light ${sel + 1} colour`} data-testid="relight-color"
                    onChange={(e) => setLight(sel, { color: e.target.value })}
                    className="ml-auto h-7 w-10 cursor-pointer rounded border border-[var(--color-border)] bg-transparent p-0.5" />
                </div>
                <Slider label="Brightness" value={light.power} min={0} max={3} step={0.05} onChange={(v) => setLight(sel, { power: v })} fmt={(v) => v.toFixed(2)} testId="relight-power" />
                <Slider label="Softness" value={light.soft} min={0} max={1} step={0.01} onChange={(v) => setLight(sel, { soft: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                <Slider label="Height" value={light.el} min={-30} max={90} step={1} onChange={(v) => setLight(sel, { el: v })} fmt={(v) => `${v}°`} />
              </div>
            )}

            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <Slider label="Ambient" value={setup.ambient} min={0} max={1.2} step={0.01} onChange={(v) => { setPreset("custom"); setSetup((s) => ({ ...s, ambient: v })); }} fmt={(v) => v.toFixed(2)} />
              <input type="color" value={setup.ambientColor} aria-label="Ambient colour" onChange={(e) => { setPreset("custom"); setSetup((s) => ({ ...s, ambientColor: e.target.value })); }}
                className="h-7 w-10 cursor-pointer rounded border border-[var(--color-border)] bg-transparent p-0.5" />
            </div>
            <Slider label="Strength" value={setup.strength} min={0} max={1} step={0.01} onChange={(v) => setSetup((s) => ({ ...s, strength: v }))} fmt={(v) => `${Math.round(v * 100)}%`} />

            <input className="input w-full text-sm" placeholder="Extra direction (optional) - e.g. “light haze in the air”" value={note} onChange={(e) => setNote(e.target.value)} maxLength={400} />

            <button className="btn btn-primary w-full" data-testid="relight-render" disabled={!authed || !prep || busy === "render"} onClick={doRender}>
              {busy === "render" ? "Rendering…" : "Render relight"}
            </button>
            <ErrNote err={error} />
          </section>
          <p className="px-1 text-xs text-[var(--color-faint)]">Preview: our own shading on Depth Anything 3 normals, in your browser. Render: that light guide harmonised by FLUX.2 klein 4B (Apache-2.0) on your machine.</p>
        </aside>
      </div>
    </div>
  );
}
