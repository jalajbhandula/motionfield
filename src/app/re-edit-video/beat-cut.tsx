"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Play } from "lucide-react";
import {
  BEAT_CUT_ASPECTS, BEAT_CUT_ENDPOINT, BEAT_CUT_MAX_CLIPS, BEAT_CUT_MAX_LENGTH, BEAT_CUT_MIN_CLIPS,
  TRANSITION_LABEL, planEdit, type BeatCutPace, type BeatCutStyle, type BeatGrid, type Cut,
} from "@/lib/beatcut";
import { ErrNote } from "@/components/ErrNote";
import { ApiError, uploadFile, userError, userErrorFrom, type UserError } from "@/lib/user-error";

type Job = { id: string; status: string; progress: number; error: string | null; outputs: { url: string; type: string }[] };
type Clip = { url: string; name: string; duration: number };

const LIVE = new Set(["queued", "in_progress"]);
const HUES = [18, 200, 140, 280, 48, 330, 170, 240, 90, 0, 300, 120];
const clipColour = (i: number) => `hsl(${HUES[i % HUES.length]} 70% 58%)`;
const PACES: [BeatCutPace, string][] = [["auto", "Follow the music"], ["1", "Every beat"], ["2", "2 beats"], ["4", "Every bar"], ["8", "2 bars"]];
const STYLES: [BeatCutStyle, string, string][] = [
  ["dynamic", "Dynamic", "Whips and zooms on loud bar starts, fades in quiet parts"],
  ["cut", "Straight cuts", "Hard cuts on the beat, nothing else"],
  ["smooth", "Smooth", "Short crossfades on every cut"],
  ["punchy", "Punchy", "Flash and zoom hits on every bar"],
];
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

async function upload(file: File): Promise<string> {
  return (await uploadFile(file)).url;
}

const mediaSeconds = (file: File, kind: "video" | "audio") => new Promise<number>((res) => {
  const el = document.createElement(kind);
  el.preload = "metadata";
  el.onloadedmetadata = () => { res(el.duration); URL.revokeObjectURL(el.src); };
  el.onerror = () => res(0);
  el.src = URL.createObjectURL(file);
});

export default function BeatCut({ authed }: { authed: boolean }) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [music, setMusic] = useState<{ url: string; name: string } | null>(null);
  const [grid, setGrid] = useState<BeatGrid | null>(null);
  const [pace, setPace] = useState<BeatCutPace>("auto");
  const [style, setStyle] = useState<BeatCutStyle>("dynamic");
  const [aspect, setAspect] = useState<(typeof BEAT_CUT_ASPECTS)[number]>("9:16");
  const [length, setLength] = useState(20);
  const [start, setStart] = useState(0);
  const [busy, setBusy] = useState<null | "clips" | "music" | "render">(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<UserError | string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const vids = useRef<(HTMLVideoElement | null)[]>([]);
  const shown = useRef(-1);

  const maxLen = grid ? Math.max(5, Math.min(BEAT_CUT_MAX_LENGTH, Math.floor(grid.duration - start))) : BEAT_CUT_MAX_LENGTH;
  const len = Math.min(length, maxLen);
  const plan: Cut[] = useMemo(
    () => (grid && clips.length ? planEdit(grid, clips.map((c) => ({ duration: c.duration })), { pace, style, length: len, start }) : []),
    [grid, clips, pace, style, len, start],
  );

  async function addClips(files: File[]) {
    setBusy("clips"); setError(null);
    try {
      const room = BEAT_CUT_MAX_CLIPS - clips.length;
      if (files.length > room) setError(`Up to ${BEAT_CUT_MAX_CLIPS} clips - kept the first ${room}.`);
      for (const f of files.slice(0, room)) {
        const duration = await mediaSeconds(f, "video");
        if (!(duration > 0.3)) throw new Error(`${f.name} isn't a playable video`);
        const url = await upload(f);
        setClips((c) => [...c, { url, name: f.name, duration }]);
      }
    } catch (e) {
      setError(userErrorFrom(e));
    } finally {
      setBusy(null);
    }
  }

  async function addMusic(file: File) {
    setBusy("music"); setError(null); setGrid(null); setStart(0);
    try {
      const url = await upload(file);
      setMusic({ url, name: file.name });
      const r = await fetch("/api/re-edit/beats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audio_url: url }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(userError(r.status, d.error ?? `couldn't read the beat`));
      setGrid(d.grid as BeatGrid);
      // skip a quiet intro: start on the first bar where the track gets going
      const g = d.grid as BeatGrid;
      const k = g.energy.findIndex((e, i) => e > 0.35 && (((i - g.barPhase) % 4) + 4) % 4 === 0);
      setStart(k > 0 && g.beats[k] < g.duration - 10 ? Math.max(0, Math.round((g.beats[k] - 0.05) * 100) / 100) : 0);
    } catch (e) {
      setError(userErrorFrom(e));
    } finally {
      setBusy(null);
    }
  }

  const move = (i: number, d: number) => setClips((c) => {
    const j = i + d;
    if (j < 0 || j >= c.length) return c;
    const n = [...c];
    [n[i], n[j]] = [n[j], n[i]];
    return n;
  });

  // live preview: the track plays, the clip for the current shot shows from its in-point
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !playing) return;
    let raf = 0;
    const tick = () => {
      const t = a.currentTime - start;
      if (t >= len || a.paused) { a.pause(); setPlaying(false); setPlayhead(null); shown.current = -1; return; }
      setPlayhead(t);
      const i = plan.findIndex((c) => t >= c.start && t < c.end);
      if (i >= 0 && i !== shown.current) {
        shown.current = i;
        const c = plan[i], v = vids.current[c.clip];
        vids.current.forEach((x, j) => { if (x) { x.style.opacity = j === c.clip ? "1" : "0"; if (j !== c.clip) x.pause(); } });
        if (v) { v.currentTime = c.loops ? 0 : c.srcIn + (t - c.start); void v.play().catch(() => {}); }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, plan, start, len]);

  function preview() {
    const a = audioRef.current;
    if (!a || !plan.length) return;
    if (playing) { a.pause(); return; }
    shown.current = -1;
    a.currentTime = start;
    void a.play().then(() => setPlaying(true)).catch(() => {});
  }

  async function render() {
    if (!music || clips.length < BEAT_CUT_MIN_CLIPS || busy) return;
    audioRef.current?.pause();
    setBusy("render"); setError(null); setJob(null);
    try {
      const r = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ endpoint_id: BEAT_CUT_ENDPOINT, params: { video_urls: clips.map((c) => c.url), audio_url: music.url, pace, style, aspect_ratio: aspect, length: len, music_start: start } }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(userError(r.status, d.error));
      let j = d.job as Job;
      setJob(j);
      while (LIVE.has(j.status)) {
        await new Promise((res) => setTimeout(res, 1500));
        const pr = await fetch(`/api/jobs/${j.id}`);
        if (!pr.ok) throw new Error(`lost track of the job (${pr.status})`);
        j = (await pr.json()).job as Job;
        setJob(j);
      }
      if (j.status !== "completed") setError(j.error || `render ${j.status}`);
    } catch (e) {
      setError(userErrorFrom(e));
    } finally {
      setBusy(null);
    }
  }

  const out = job?.outputs?.find((o) => o.type === "video")?.url;
  const ratio = aspect === "9:16" ? "aspect-[9/16] max-h-[60vh]" : aspect === "1:1" ? "aspect-square max-h-[60vh]" : "aspect-video";
  const beatsIn = grid ? grid.beats.map((b, k) => ({ t: b - start, bar: (((k - grid.barPhase) % 4) + 4) % 4 === 0 })).filter((b) => b.t >= 0 && b.t <= len) : [];
  const ready = !!music && !!grid && clips.length >= BEAT_CUT_MIN_CLIPS;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <main className="min-w-0 space-y-4">
        <section className="panel p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Clips <span className="font-normal text-[var(--color-dim)]">· used in this order, taking turns</span></h2>
            <span className="text-xs text-[var(--color-faint)]">{clips.length}/{BEAT_CUT_MAX_CLIPS}</span>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6" data-testid="bc-clips">
            {clips.map((c, i) => (
              <figure key={c.url} className="group relative overflow-hidden rounded-lg border border-[var(--color-border)] bg-black">
                <video src={c.url} muted playsInline preload="metadata" className="aspect-[3/4] w-full object-cover"
                  onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})} onMouseLeave={(e) => e.currentTarget.pause()} />
                <span className="absolute left-1.5 top-1.5 h-2.5 w-2.5 rounded-full" style={{ background: clipColour(i) }} />
                <figcaption className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-black/70 px-1.5 py-1 text-[10px]">
                  <span className="tabular-nums">{c.duration.toFixed(1)}s</span>
                  <span className="ml-auto flex gap-1 opacity-70 group-hover:opacity-100">
                    <button aria-label="Move earlier" onClick={() => move(i, -1)} disabled={i === 0}>←</button>
                    <button aria-label="Move later" onClick={() => move(i, 1)} disabled={i === clips.length - 1}>→</button>
                    <button aria-label="Remove clip" onClick={() => setClips((x) => x.filter((_, j) => j !== i))}>✕</button>
                  </span>
                </figcaption>
              </figure>
            ))}
            {clips.length < BEAT_CUT_MAX_CLIPS && (
              <label className={`grid aspect-[3/4] cursor-pointer place-items-center rounded-lg border border-dashed border-[var(--color-border)] p-2 text-center text-xs text-[var(--color-dim)] ${!authed ? "pointer-events-none opacity-50" : "hover:border-[var(--color-accent)]"}`}
                onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void addClips([...e.dataTransfer.files].filter((f) => f.type.startsWith("video/"))); }}>
                {busy === "clips" ? "Uploading…" : clips.length ? "+ Add clips" : `+ Add ${BEAT_CUT_MIN_CLIPS}-${BEAT_CUT_MAX_CLIPS} clips`}
                <input type="file" accept="video/*" multiple className="hidden" data-testid="bc-clip-input" disabled={!authed}
                  onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; if (f.length) void addClips(f); }} />
              </label>
            )}
          </div>
        </section>

        <section className="panel p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">Music</h2>
            {grid && <span className="chip text-[11px]" data-testid="bc-bpm">{Math.round(grid.bpm)} BPM · {grid.beats.length} beats · {fmt(grid.duration)}</span>}
            <label className={`ml-auto cursor-pointer text-xs underline ${!authed ? "pointer-events-none opacity-50" : ""}`}>
              {busy === "music" ? "Finding the beat…" : music ? "Change track" : "Upload a track"}
              <input type="file" accept="audio/*" className="hidden" data-testid="bc-music-input" disabled={!authed}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void addMusic(f); }} />
            </label>
          </div>
          {music && <audio ref={audioRef} src={music.url} preload="auto" className="hidden" />}
          {grid ? (
            <>
              {/* whole track: energy, with the chosen window - click to move it */}
              <div className="relative h-10 cursor-pointer overflow-hidden rounded-md bg-[var(--color-panel2)]" title="Click to start the edit here"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect(), t = ((e.clientX - r.left) / r.width) * grid.duration;
                  const k = grid.beats.findIndex((b, i) => b >= t && (((i - grid.barPhase) % 4) + 4) % 4 === 0);
                  setStart(Math.max(0, Math.min(grid.duration - 5, Math.round(((k >= 0 ? grid.beats[k] : t) - 0.05) * 100) / 100)));
                }}>
                <svg viewBox={`0 0 ${grid.beats.length} 1`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
                  <polygon fill="var(--color-dim)" opacity="0.35"
                    points={`0,1 ${grid.energy.map((e, k) => `${k},${1 - 0.15 - e * 0.8}`).join(" ")} ${grid.beats.length - 1},1`} />
                </svg>
                <div className="absolute inset-y-0 border-x-2 border-[var(--color-accent)] bg-[var(--color-accent)]/15"
                  style={{ left: `${(start / grid.duration) * 100}%`, width: `${(len / grid.duration) * 100}%` }} />
              </div>
              {/* the edit: shots coloured by clip, transitions at the joins, beats below */}
              <div className="relative mt-3" data-testid="bc-timeline">
                <div className="relative flex h-9 overflow-hidden rounded-md">
                  {plan.map((c, i) => (
                    <div key={i} className="relative h-full border-r border-black/60" title={`${c.start.toFixed(2)}-${c.end.toFixed(2)}s · clip ${c.clip + 1}${i ? ` · ${TRANSITION_LABEL[c.transition]}` : ""}`}
                      style={{ width: `${((c.end - c.start) / len) * 100}%`, background: clipColour(c.clip), opacity: playhead !== null && !(playhead >= c.start && playhead < c.end) ? 0.55 : 0.9 }}>
                      {i > 0 && c.transition !== "cut" && <span className="absolute -left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 rotate-45 border border-black/70 bg-white" />}
                    </div>
                  ))}
                  {playhead !== null && <div className="absolute inset-y-0 w-0.5 bg-white" style={{ left: `${(playhead / len) * 100}%` }} />}
                </div>
                <div className="relative mt-1 h-3">
                  {beatsIn.map((b, i) => (
                    <span key={i} className={`absolute bottom-0 w-px ${b.bar ? "h-3 bg-[var(--color-text)]" : "h-1.5 bg-[var(--color-faint)]"}`} style={{ left: `${(b.t / len) * 100}%` }} />
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-[var(--color-dim)]">
                  <span>{plan.length} shots · {plan.filter((c, i) => i && c.transition !== "cut").length} transitions</span>
                  <span className="tabular-nums">{fmt(start)} → {fmt(start + len)}</span>
                </div>
              </div>
            </>
          ) : (
            <p className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-center text-xs text-[var(--color-faint)]">
              {busy === "music" ? "Finding the tempo and bars…" : "Any track with a clear rhythm - mp3, wav, m4a or flac, up to 10 minutes."}
            </p>
          )}
        </section>

        {(ready || out) && (
          <section className="panel p-4">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-sm font-semibold">{out ? "Your edit" : "Preview"}</h2>
              {!out && <span className="text-[11px] text-[var(--color-faint)]">cuts only - transitions are added in the render</span>}
              {out && <a href={out} download className="ml-auto text-xs underline" data-testid="bc-download">Download</a>}
            </div>
            {out ? (
              <video src={out} controls playsInline className={`mx-auto rounded-xl border border-[var(--color-accent)] bg-black ${ratio}`} data-testid="bc-result" />
            ) : (
              <div className={`relative mx-auto overflow-hidden rounded-xl border border-[var(--color-border)] bg-black ${ratio}`}>
                {clips.map((c, i) => (
                  <video key={c.url} ref={(el) => { vids.current[i] = el; }} src={c.url} muted playsInline preload="auto" loop
                    className={`absolute inset-0 h-full w-full object-cover ${i === 0 ? "opacity-100" : "opacity-0"}`} />
                ))}
                <button onClick={preview} className="absolute inset-0 grid place-items-center text-sm font-semibold" data-testid="bc-preview">
                  {!playing && <span className="inline-flex items-center gap-2 rounded-full bg-black/60 px-4 py-2"><Play size={14} /> Play preview</span>}
                </button>
              </div>
            )}
          </section>
        )}
      </main>

      <aside className="panel h-fit space-y-4 p-5">
        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase text-[var(--color-dim)]">Cut</div>
          <div className="flex flex-wrap gap-1" data-testid="bc-pace">
            {PACES.map(([v, l]) => (
              <button key={v} className={`chip !px-2.5 !py-1 text-xs ${pace === v ? "chip-on" : ""}`} aria-pressed={pace === v} onClick={() => setPace(v)}>{l}</button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase text-[var(--color-dim)]">Transitions</div>
          <div className="space-y-1.5" data-testid="bc-style">
            {STYLES.map(([v, l, d]) => (
              <button key={v} aria-pressed={style === v} onClick={() => setStyle(v)}
                className={`block w-full rounded-lg border px-3 py-2 text-left ${style === v ? "border-[var(--color-accent)] bg-[var(--color-panel2)]" : "border-[var(--color-border)] hover:border-[#3a3a42]"}`}>
                <div className="text-sm">{l}</div>
                <div className="text-[11px] text-[var(--color-dim)]">{d}</div>
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase text-[var(--color-dim)]">Format</div>
          <div className="flex gap-1 rounded-lg border border-[var(--color-border)] p-1 text-xs">
            {BEAT_CUT_ASPECTS.map((a) => (
              <button key={a} aria-pressed={aspect === a} onClick={() => setAspect(a)}
                className={`flex-1 rounded-md px-2 py-1.5 ${aspect === a ? "bg-[var(--color-panel2)] text-[var(--color-text)]" : "text-[var(--color-dim)]"}`}>
                {a === "9:16" ? "9:16 Vertical" : a === "1:1" ? "1:1 Square" : "16:9 Wide"}
              </button>
            ))}
          </div>
        </div>
        <label className="block text-xs text-[var(--color-dim)]">
          <span className="mb-1 flex justify-between"><span>Length</span><span className="tabular-nums">{len}s</span></span>
          <input type="range" min={5} max={maxLen} step={1} value={len} onChange={(e) => setLength(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" data-testid="bc-length" />
        </label>

        <button className="btn btn-primary w-full" disabled={!authed || !ready || busy === "render"} onClick={render} data-testid="bc-go">
          {busy === "render" ? `Cutting… ${job?.progress ?? 0}%` : "Cut to the beat"}
        </button>
        {!ready && <p className="text-[11px] text-[var(--color-faint)]">Add at least {BEAT_CUT_MIN_CLIPS} clips and a music track.</p>}
        <ErrNote err={error} />
        <p className="text-[11px] text-[var(--color-faint)]">Tempo, beats and bars are found on your machine; the edit is rendered by ffmpeg at full resolution. No model weights, no upload anywhere.</p>
      </aside>
    </div>
  );
}
