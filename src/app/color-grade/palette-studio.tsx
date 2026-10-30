"use client";
import { PageExamples } from "@/components/ExampleCard";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { COLOR_PALETTES } from "@/lib/catalog/presets/palettes";
import {
  LUT_EXPORT, LUT_PREVIEW, applyLut, buildLut, dominantColors, gradeTitle, labStats, toCube, withIntensity,
  type GradeSpec, type LabStats,
} from "@/lib/grade/palette";
import { ErrNote } from "@/components/ErrNote";
import { uploadFile, userError, userErrorFrom, type UserError } from "@/lib/user-error";

type Source = { url: string; kind: "image" | "video" };
type Mode = "look" | "match" | "palette";
type Job = { id: string; status: string; progress: number; error: string | null; outputs: { url: string; type: string }[] };

const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;
const PREVIEW_W = 1280;
const THUMB_W = 168;
const LIVE = new Set(["queued", "in_progress"]);

/** our own starting palettes - dark → light */
const PALETTE_PRESETS: { name: string; colors: string[] }[] = [
  { name: "Teal & amber", colors: ["#0f2a3d", "#1f6f78", "#e0a458", "#f6e7cb"] },
  { name: "Noir rose", colors: ["#120d12", "#4a2c3a", "#b5838d", "#f2e6e9"] },
  { name: "Mint film", colors: ["#1c2b2d", "#3e6259", "#a8c3a0", "#eef3e2"] },
  { name: "Sunset pop", colors: ["#2b0f3a", "#8e2c58", "#f2734b", "#ffd27a"] },
  { name: "Arctic", colors: ["#0d1b2a", "#415a77", "#a9c6de", "#f0f6fb"] },
  { name: "Desert", colors: ["#2d1e12", "#8c5a2b", "#d9a066", "#f5e3c3"] },
];

const pretty = (id: string) => id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, " ");

async function upload(file: File): Promise<string> {
  return (await uploadFile(file)).url;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("could not read that image"));
    im.src = url;
  });
}

function videoFrame(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((res) => {
    const done = () => { v.removeEventListener("seeked", done); res(); };
    v.addEventListener("seeked", done);
    v.currentTime = Math.min(Math.max(t, 0), Math.max(0, v.duration - 0.05));
  });
}

function pixels(src: CanvasImageSource, w0: number, h0: number, maxW: number): ImageData {
  const w = Math.min(maxW, w0), h = Math.max(1, Math.round((h0 * w) / w0));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function LookThumb({ id, thumb, active, onPick }: { id: string; thumb: ImageData | null; active: boolean; onPick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !thumb) return;
    c.width = thumb.width; c.height = thumb.height;
    const img = new ImageData(new Uint8ClampedArray(thumb.data), thumb.width, thumb.height);
    applyLut(img.data, buildLut({ kind: "look", id: id as (typeof COLOR_PALETTES)[number] }, 9), 1);
    c.getContext("2d")!.putImageData(img, 0, 0);
  }, [id, thumb]);
  return (
    <button onClick={onPick} data-testid={`look-${id}`} aria-pressed={active}
      className={`group overflow-hidden rounded-xl border text-left transition-colors ${active ? "border-[var(--color-accent)]" : "border-[var(--color-border)] hover:border-[#3a3a42]"}`}>
      {thumb
        ? <canvas ref={ref} className="block aspect-[3/2] w-full object-cover" />
        /* before a source is picked: the same LUT pre-rendered on a sample still (scripts/gen-look-thumbs.ts) */
        : <img src={`/examples/palette/${id}.webp`} alt="" loading="lazy" decoding="async" width={320} height={214}
            className="block aspect-[3/2] w-full bg-[var(--color-panel2)] object-cover" />}
      <span className={`block truncate px-2 py-1 text-[11px] ${active ? "text-[var(--color-text)]" : "text-[var(--color-dim)]"}`}>{pretty(id)}</span>
    </button>
  );
}

export default function PaletteStudio({ authed }: { authed: boolean }) {
  const [src, setSrc] = useState<Source | null>(null);
  const [base, setBase] = useState<ImageData | null>(null);
  const [thumb, setThumb] = useState<ImageData | null>(null);
  const [duration, setDuration] = useState(0);
  const [frameT, setFrameT] = useState(0);
  const [mode, setMode] = useState<Mode>("look");
  const [look, setLook] = useState<string>("cinema-amber");
  const [ref, setRef] = useState<{ url: string; stats: LabStats; colors: string[] } | null>(null);
  const [colors, setColors] = useState<string[]>(PALETTE_PRESETS[0].colors);
  const [intensity, setIntensity] = useState(0.8);
  const [split, setSplit] = useState(0.5);
  const [busy, setBusy] = useState<null | "upload" | "ref" | "save">(null);
  const [error, setError] = useState<UserError | string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const original = useRef<HTMLCanvasElement | null>(null);

  // the source's own colour stats (for "match")
  const srcStats = useMemo(() => (base ? labStats(base.data) : null), [base]);

  const spec: GradeSpec | null = useMemo(() => {
    if (mode === "look") return { kind: "look", id: look as (typeof COLOR_PALETTES)[number] };
    if (mode === "palette") return colors.length >= 3 ? { kind: "palette", colors } : null;
    return ref && srcStats ? { kind: "match", source: srcStats, reference: ref.stats } : null;
  }, [mode, look, colors, ref, srcStats]);

  const lut = useMemo(() => (spec ? buildLut(spec, LUT_PREVIEW) : null), [spec]);

  async function pickSource(file: File) {
    setBusy("upload"); setError(null); setJob(null);
    try {
      const url = await upload(file);
      const kind = file.type.startsWith("video") || VIDEO_EXT.test(file.name) ? "video" : "image";
      setSrc({ url, kind });
      if (kind === "image") {
        const im = await loadImage(url);
        setBase(pixels(im, im.naturalWidth, im.naturalHeight, PREVIEW_W));
        setThumb(pixels(im, im.naturalWidth, im.naturalHeight, THUMB_W));
      }
      // video: the <video> element below loads it and grabs a frame
    } catch (e) {
      setError(userErrorFrom(e));
    } finally {
      setBusy(null);
    }
  }

  // ?example=1 - load the shipped example input with its look ("Try this example")
  useEffect(() => {
    if (typeof window === "undefined" || !new URLSearchParams(window.location.search).has("example")) return;
    void (async () => {
      const blob = await (await fetch("/examples/inputs/person.jpg")).blob();
      setMode("look"); setLook("cinema-amber"); setIntensity(0.8);
      await pickSource(new File([blob], "person.jpg", { type: blob.type || "image/jpeg" }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function grabFrame(t: number) {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    await videoFrame(v, t);
    setBase(pixels(v, v.videoWidth, v.videoHeight, PREVIEW_W));
    setThumb((th) => th ?? pixels(v, v.videoWidth, v.videoHeight, THUMB_W));
  }

  async function pickReference(file: File) {
    setBusy("ref"); setError(null);
    try {
      const url = await upload(file);
      const im = await loadImage(url);
      const px = pixels(im, im.naturalWidth, im.naturalHeight, 320);
      setRef({ url, stats: labStats(px.data), colors: dominantColors(px.data, 5) });
      setMode("match");
    } catch (e) {
      setError(userErrorFrom(e));
    } finally {
      setBusy(null);
    }
  }

  // keep an untouched copy for the "before" half
  useEffect(() => {
    if (!base) return;
    const c = document.createElement("canvas");
    c.width = base.width; c.height = base.height;
    c.getContext("2d")!.putImageData(base, 0, 0);
    original.current = c;
  }, [base]);

  // live preview: graded frame, original to the left of the split
  useEffect(() => {
    const c = canvas.current;
    if (!c || !base) return;
    c.width = base.width; c.height = base.height;
    const ctx = c.getContext("2d")!;
    const img = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
    if (lut) applyLut(img.data, lut, intensity);
    ctx.putImageData(img, 0, 0);
    const sx = Math.round(base.width * split);
    if (original.current && sx > 0) ctx.drawImage(original.current, 0, 0, sx, base.height, 0, 0, sx, base.height);
  }, [base, lut, intensity, split]);

  function downloadCube() {
    if (!spec) return;
    const text = toCube(withIntensity(buildLut(spec, LUT_EXPORT), intensity), gradeTitle(spec));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = `motionfield-${gradeTitle(spec)}.cube`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function save() {
    if (!src || !spec || busy) return;
    setBusy("save"); setError(null); setJob(null);
    const params: Record<string, unknown> = { intensity, [src.kind === "video" ? "video_url" : "image_url"]: src.url };
    if (spec.kind === "look") params.look = spec.id;
    else if (spec.kind === "palette") params.colors = spec.colors.join(",");
    else params.reference_url = ref?.url;
    try {
      const r = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ endpoint_id: `motionfield/palette/grade-${src.kind}`, params }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(userError(r.status, d.error)); setBusy(null); return; }
      setJob(d.job);
      const tick = async () => {
        const res = await fetch(`/api/jobs/${d.job.id}`);
        const { job: j } = (await res.json()) as { job: Job };
        setJob(j);
        if (LIVE.has(j.status)) setTimeout(tick, 1200);
        else setBusy(null);
      };
      tick();
    } catch (e) {
      setError(userErrorFrom(e));
      setBusy(null);
    }
  }

  const out = job?.outputs?.[0];

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-8">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Color Grade</h1>
        <p className="mt-1 text-sm text-[var(--color-dim)]">Colour grade a photo or a clip - from a look, a reference you love, or your own colours. Preview live, export the full-res file or the .cube.</p>
        <PageExamples />
      </div>
      {!authed && <p className="panel mt-6 p-4 text-sm"><Link href="/login?next=/color-grade" className="underline">Sign in</Link> to grade your media.</p>}

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
        <main className="min-w-0 space-y-3">
          {!src ? (
            <label className={`panel flex aspect-video cursor-pointer flex-col items-center justify-center gap-2 border-dashed text-center ${!authed ? "pointer-events-none opacity-50" : "hover:border-[var(--color-accent)]"}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) pickSource(f); }}>
              <span className="font-display text-lg font-semibold">{busy === "upload" ? "Uploading…" : "Drop a photo or video"}</span>
              <span className="text-sm text-[var(--color-dim)]">or click to choose · JPG, PNG, WebP, MP4, MOV</span>
              <input type="file" accept="image/*,video/*" className="hidden" data-testid="palette-source" disabled={!authed}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) pickSource(f); e.target.value = ""; }} />
            </label>
          ) : (
            <>
              <div className="relative overflow-hidden rounded-2xl border border-[var(--color-border)] bg-black">
                {base ? <canvas ref={canvas} data-testid="palette-canvas" className="block h-auto w-full" /> : <div className="skeleton aspect-video w-full" />}
                {base && (
                  <>
                    <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/80 shadow-[0_0_0_1px_rgba(0,0,0,.3)]" style={{ left: `${split * 100}%` }} />
                    <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">Before</span>
                    <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">After</span>
                    <input type="range" min={0} max={1} step={0.001} value={split} aria-label="Before / after split"
                      onChange={(e) => setSplit(Number(e.target.value))} data-testid="palette-split"
                      className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0" />
                  </>
                )}
              </div>
              {src.kind === "video" && (
                <>
                  <video ref={video} src={src.url} muted playsInline preload="auto" className="hidden"
                    onLoadedData={(e) => { const d = e.currentTarget.duration || 0; setDuration(d); setFrameT(d / 3); grabFrame(d / 3); }} />
                  {duration > 0 && (
                    <label className="flex items-center gap-3 text-xs text-[var(--color-dim)]">
                      Preview frame
                      <input type="range" min={0} max={duration} step={0.05} value={frameT} className="flex-1 accent-[var(--color-accent)]"
                        onChange={(e) => setFrameT(Number(e.target.value))} onPointerUp={() => grabFrame(frameT)} onKeyUp={() => grabFrame(frameT)} />
                      <span className="w-12 text-right tabular-nums">{frameT.toFixed(1)} s</span>
                    </label>
                  )}
                </>
              )}
              <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-dim)]">
                <span>Drag across the picture to compare.</span>
                <button className="btn btn-ghost btn-sm ml-auto" onClick={() => { setSrc(null); setBase(null); setThumb(null); setJob(null); }}>Change {src.kind}</button>
              </div>
            </>
          )}

          {job && (
            <section className="panel p-4" aria-label="Full-resolution result" data-testid="palette-result" data-status={job.status}>
              <div className="flex items-center gap-3">
                <div className="text-sm font-medium">Full-resolution grade</div>
                <span className="text-xs text-[var(--color-dim)]">{LIVE.has(job.status) ? `Grading… ${job.progress}%` : job.status === "completed" ? "Done - saved to your history" : job.error ?? job.status}</span>
                {out && <a className="btn btn-sm ml-auto" href={out.url} download data-testid="palette-download">Download</a>}
              </div>
              {out && (out.type === "video"
                ? <video src={out.url} controls loop muted playsInline className="mt-3 max-h-80 rounded-lg" />
                : <img src={out.url} alt="Graded result" className="mt-3 max-h-80 rounded-lg" />)}
            </section>
          )}
        </main>

        <aside className="space-y-4">
          <section className="panel space-y-4 p-4">
            <div className="flex gap-1.5" role="tablist" aria-label="Grade from">
              {([["look", "Looks"], ["match", "Match a reference"], ["palette", "Palette"]] as const).map(([m, label]) => (
                <button key={m} role="tab" aria-selected={mode === m} data-testid={`palette-mode-${m}`}
                  className={`chip ${mode === m ? "chip-on" : ""}`} onClick={() => setMode(m)}>{label}</button>
              ))}
            </div>

            {mode === "look" && (
              <div className="grid max-h-[460px] grid-cols-3 gap-2 overflow-y-auto pr-1" data-testid="palette-looks">
                {COLOR_PALETTES.map((id) => <LookThumb key={id} id={id} thumb={thumb} active={look === id} onPick={() => setLook(id)} />)}
              </div>
            )}

            {mode === "match" && (
              <div className="space-y-3">
                <p className="text-xs text-[var(--color-dim)]">Pick a still whose colour you want - a film frame, a photo, a painting. Its balance and contrast carry over; your picture stays yours.</p>
                <label className={`flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-[var(--color-border)] p-3 ${!authed ? "pointer-events-none opacity-50" : "hover:border-[var(--color-accent)]"}`}>
                  {ref ? <img src={ref.url} alt="Reference" className="h-16 w-24 rounded-md object-cover" /> : <span className="grid h-16 w-24 place-items-center rounded-md bg-[var(--color-panel2)] text-xl text-[var(--color-dim)]">+</span>}
                  <span className="text-sm">{busy === "ref" ? "Reading colours…" : ref ? "Change reference" : "Choose a reference image"}</span>
                  <input type="file" accept="image/*" className="hidden" data-testid="palette-reference" disabled={!authed}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) pickReference(f); e.target.value = ""; }} />
                </label>
                {ref && ref.colors.length >= 3 && (
                  <div className="flex items-center gap-2 text-xs text-[var(--color-dim)]">
                    <span className="flex overflow-hidden rounded-md">{ref.colors.map((c) => <span key={c} className="h-5 w-6" style={{ background: c }} />)}</span>
                    <button className="underline" onClick={() => { setColors(ref.colors.slice(0, 6)); setMode("palette"); }}>Use as palette</button>
                  </div>
                )}
              </div>
            )}

            {mode === "palette" && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2" data-testid="palette-colors">
                  {colors.map((c, i) => (
                    <div key={i} className="relative">
                      <input type="color" value={c} aria-label={`Colour ${i + 1}`}
                        onChange={(e) => setColors((cs) => cs.map((x, j) => (j === i ? e.target.value : x)))}
                        className="h-10 w-10 cursor-pointer rounded-lg border border-[var(--color-border)] bg-transparent p-0.5" />
                      {colors.length > 3 && (
                        <button aria-label={`Remove colour ${i + 1}`} onClick={() => setColors((cs) => cs.filter((_, j) => j !== i))}
                          className="absolute -right-1 -top-1 h-4 w-4 rounded-full bg-black/80 text-[10px] text-white">×</button>
                      )}
                    </div>
                  ))}
                  {colors.length < 6 && (
                    <button className="grid h-10 w-10 place-items-center rounded-lg border border-dashed border-[var(--color-border)] text-[var(--color-dim)] hover:border-[var(--color-accent)]"
                      aria-label="Add colour" onClick={() => setColors((cs) => [...cs, "#888888"])}>+</button>
                  )}
                </div>
                <p className="text-xs text-[var(--color-faint)]">Darkest colour tints the shadows, lightest the highlights. 3-6 colours.</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {PALETTE_PRESETS.map((p) => (
                    <button key={p.name} onClick={() => setColors(p.colors)}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-[var(--color-dim)] hover:bg-[var(--color-panel2)] hover:text-[var(--color-text)]">
                      <span className="flex overflow-hidden rounded">{p.colors.map((c) => <span key={c} className="h-4 w-3" style={{ background: c }} />)}</span>
                      {p.name}
                    </button>
                  ))}
                </div>
                {base && (
                  <button className="text-xs underline" onClick={() => { const d = dominantColors(base.data, 5); if (d.length >= 3) setColors(d); }}>
                    Extract from my {src?.kind ?? "picture"}
                  </button>
                )}
              </div>
            )}

            <label className="block text-xs text-[var(--color-dim)]">
              <span className="mb-1 flex justify-between"><span>Intensity</span><span className="tabular-nums">{Math.round(intensity * 100)}%</span></span>
              <input type="range" min={0} max={1} step={0.01} value={intensity} data-testid="palette-intensity"
                onChange={(e) => setIntensity(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" />
            </label>

            <div className="flex gap-2">
              <button className="btn btn-primary flex-1" data-testid="palette-save" disabled={!authed || !src || !spec || busy === "save"} onClick={save}>
                {busy === "save" ? "Grading…" : `Grade full ${src?.kind ?? "file"}`}
              </button>
              <button className="btn" disabled={!spec} onClick={downloadCube} data-testid="palette-cube" title="A 33³ LUT for Resolve, Premiere, ffmpeg…">.cube</button>
            </div>
            <ErrNote err={error} />
          </section>
          <p className="px-1 text-xs text-[var(--color-faint)]">Runs on your machine - our own colour math and ffmpeg, no model weights. Video keeps its sound.</p>
        </aside>
      </div>
    </div>
  );
}
