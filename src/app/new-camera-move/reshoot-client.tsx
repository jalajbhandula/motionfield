"use client";
import { useMemo, useRef, useState } from "react";
import type { PresetDef } from "@/lib/catalog/types";
import { TrajectoryPicker } from "@/components/TrajectoryPicker";
import { honestNote, presetTrajectories, trajectoryOf, TRAJECTORY_GROUP_LABELS, type TrajectoryGroup } from "@/lib/catalog/presets/trajectories";
import { isReshootMove, RESHOOT_TRAJECTORY_IDS, RESHOOT_ETA_S_PER_PIXEL_STEP, RESHOOT_ETA_FIXED_S } from "@/lib/catalog/video/camera";
import { ErrNote } from "@/components/ErrNote";
import { uploadFile, userError, userErrorFrom, type UserError } from "@/lib/user-error";

/** Re-shoot - re-render one of your clips from a new camera path.
 *  DA3 recovers the source camera and per-frame depth; the picked path is
 *  re-anchored on the source's first pose (its own move is replaced, not
 *  layered); Wan VACE fills only the disocclusions. Output keeps the source
 *  frame count, fps and audio track exactly - the probe card shows the numbers
 *  before you spend anything. */

type Probe = {
  duration: number; fps: number; width: number; height: number;
  rotation: number; has_audio: boolean; frames: number;
  render_width: number; render_height: number;
  local_cap: number; capped_at: number;
};
type Job = {
  id: string; status: string; progress?: number | null;
  error?: string | null; outputs?: { url?: string }[];
};

export default function ReShootClient({ presets }: { presets: readonly PresetDef[] }) {
  const [videoUrl, setVideoUrl] = useState("");
  const [probe, setProbe] = useState<Probe | null>(null);
  const [camera, setCamera] = useState("Auto");
  // the picked move stack (catalog ids, ≤3) - chips are the honest picker:
  // every id here is one the re-shoot rig actually executes
  const [pickedMoves, setPickedMoves] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [backend, setBackend] = useState<"local" | "cloud">("local");
  const [strength, setStrength] = useState(1);
  const [distance, setDistance] = useState(4);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<UserError | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const pollRef = useRef<Record<string, boolean>>({});

  async function onVideo(file: File) {
    setErr(null); setJob(null); setProbe(null); setVideoUrl("");
    let url: string;
    try {
      url = (await uploadFile(file)).url;
    } catch (e) { setErr(userErrorFrom(e)); return; }
    setVideoUrl(url); setProbing(true);
    try {
      const r = await fetch("/api/reshoot/probe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_url: url }),
      });
      const p = await r.json();
      if (!r.ok) { setErr(userError(r.status, p.error ?? "probe failed")); setVideoUrl(""); return; }
      setProbe(p.probe as Probe);
    } finally {
      setProbing(false);
    }
  }

  function pollJob(id: string) {
    if (pollRef.current[id]) return;
    pollRef.current[id] = true;
    const tick = async () => {
      const r = await fetch(`/api/jobs/${id}`);
      const j = (await r.json()).job as Job;
      setJob(j);
      if (["queued", "in_progress"].includes(j.status)) setTimeout(tick, 1200);
      else delete pollRef.current[id];
    };
    void tick();
  }

  /** the chip grid - video-capable pose moves only, grouped like the catalog */
  const moveGroups = useMemo(() => {
    const g = new Map<TrajectoryGroup, string[]>();
    for (const id of RESHOOT_TRAJECTORY_IDS) {
      if (id === "locked-off") continue; // an empty stack means locked-off
      const grp = trajectoryOf(id)?.group ?? "basic";
      g.set(grp, [...(g.get(grp) ?? []), id]);
    }
    return [...g.entries()];
  }, []);
  const toggleMove = (id: string) => setPickedMoves((cur) => {
    if (cur.includes(id)) return cur.filter((x) => x !== id);
    if (cur.length >= 3) return cur;
    return [...cur, id];
  });
  const presetStack = useMemo(() => {
    const p = presets.find((x) => x.title === camera);
    return p ? presetTrajectories(p).filter(isReshootMove) : [];
  }, [camera, presets]);
  const moves = pickedMoves.length ? pickedMoves.join("+")
    : presetStack.length ? presetStack.join("+") : "";

  async function submit() {
    if (!videoUrl || busy) return;
    setBusy(true); setErr(null); setJob(null);
    try {
      const r = await fetch("/api/reshoot/submit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video_url: videoUrl, moves, prompt, backend, strength, distance,
        }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(userError(r.status, d.error ?? "submit failed")); return; }
      setJob(d.job);
      pollJob(d.job.id);
    } finally {
      setBusy(false);
    }
  }

  const overHardCap = !!probe && probe.frames > probe.capped_at;
  const overLocalCap = !!probe && !overHardCap && probe.frames > probe.local_cap;
  // the clip loader's force_rate tops out at 60 - flag it on the card and
  // keep the button off (the endpoint 400s it anyway)
  const tooFast = !!probe && probe.fps > 60;
  // measured seconds per frame·pixel·step (the smoke's rate) - the card
  // multiplies it by the probed size and labels itself an estimate
  const estMin = probe
    ? Math.max(1, Math.round((RESHOOT_ETA_FIXED_S + probe.frames * probe.render_width * probe.render_height * 8 * RESHOOT_ETA_S_PER_PIXEL_STEP) / 60))
    : 0;
  const outUrl = job?.outputs?.[0]?.url;
  const canSubmit = !!videoUrl && !!probe && !overHardCap && !tooFast && !busy && !probing;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">New Camera Move</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-dim)]">
          Same action, new camera path. The clip&apos;s own camera move is <em>replaced</em> - timing stays
          frame-exact with the source (same frames, same fps) and the source audio track is kept.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="panel space-y-4 p-5">
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase text-[var(--color-dim)]">Your clip</label>
            {!videoUrl ? (
              <label className="grid aspect-video cursor-pointer place-items-center rounded-xl border border-dashed border-[var(--color-border)] text-sm text-[var(--color-dim)] hover:border-[var(--color-accent)]">
                {probing ? "Probing…" : "Drop or choose a video"}
                <input type="file" accept="video/*" className="hidden" onChange={(e) => e.target.files?.[0] && onVideo(e.target.files[0])} />
              </label>
            ) : (
              <div className="relative">
                <video src={videoUrl} muted controls className="max-h-[320px] w-full rounded-xl border border-[var(--color-border)] object-contain" />
                <button onClick={() => { setVideoUrl(""); setProbe(null); setJob(null); }}
                  className="absolute right-2 top-2 rounded bg-black/70 px-2 py-0.5 text-xs">✕</button>
              </div>
            )}
            {probe && (
              <div className="mt-2 rounded-lg bg-[var(--color-panel2)] p-2.5 text-xs text-[var(--color-dim)]" data-testid="probe-card">
                <span className="font-mono">{probe.frames} frames · {probe.fps.toFixed(2)} fps · {probe.width}×{probe.height}{probe.rotation ? ` · rotated ${probe.rotation}°` : ""} · renders at {probe.render_width}×{probe.render_height}</span>
                {probe.has_audio
                  ? <span className="ml-1">· keeps the source audio</span>
                  : <span className="ml-1">· silent - the source has no audio track</span>}
                {tooFast && (
                  <p className="mt-1 text-[var(--color-danger)]" data-testid="over-cap">
                    {probe.fps.toFixed(2)} fps - tops out at 60 fps
                  </p>
                )}
                {overLocalCap && (
                  <p className="mt-1 text-[var(--color-danger)]" data-testid="over-cap">
                    {probe.frames} frames is over the {probe.local_cap}-frame local budget - cloud recommended
                  </p>
                )}
                {overHardCap && (
                  <p className="mt-1 text-[var(--color-danger)]" data-testid="over-cap">
                    {probe.frames} frames is over the {probe.capped_at}-frame limit - this clip can&apos;t be re-shot
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <TrajectoryPicker label="New path" value={camera} presets={presets} onChange={setCamera}
              executes execMove={isReshootMove} hideDisabled />
            <select value={backend} onChange={(e) => setBackend(e.target.value as "local" | "cloud")}
              title="local: this Mac - DA3 + rig + Wan VACE · cloud: Uni3C 14B - untested - bring your own GPU"
              className="min-w-0 max-w-full flex-1 rounded-lg border border-[var(--color-border)] bg-transparent px-2 py-1 text-xs">
              <option value="local">Local · DA3 + Wan VACE</option>
              <option value="cloud">Cloud GPU · Uni3C 14B - cloud-recommended, untested (needs your own ComfyUI GPU)</option>
            </select>
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between text-[10px] uppercase tracking-wider text-[var(--color-dim)]">
              <span>or build a move stack - pick up to 3 (<span className="normal-case">partial</span> = part of the new view is generated)</span>
              {pickedMoves.length > 0 && (
                <button onClick={() => setPickedMoves([])} className="normal-case text-[var(--color-dim)] hover:text-[var(--color-fg)]">clear</button>
              )}
            </div>
            {(pickedMoves.length > 0 || presetStack.length > 0) && (
              <div className="mb-1.5 flex flex-wrap items-center gap-1">
                {(pickedMoves.length ? pickedMoves : presetStack).map((id) => (
                  <span key={id} className="rounded-md bg-[var(--color-panel2)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-fg)]"
                    title={honestNote(id, "video") ?? "Executes on the camera-move rig"}>
                    {trajectoryOf(id)?.label ?? id}
                    {honestNote(id, "video") && <span className="ml-1 text-[8px] uppercase text-[var(--color-faint)]">partial</span>}
                  </span>
                ))}
                {!pickedMoves.length && <span className="text-[9px] text-[var(--color-faint)]">from preset</span>}
              </div>
            )}
            <div className="max-h-36 space-y-1.5 overflow-y-auto rounded-lg border border-[var(--color-line)] p-2" data-testid="move-chips">
              {moveGroups.map(([grp, ids]) => (
                <div key={grp} className="flex flex-wrap items-center gap-1">
                  <span className="w-16 shrink-0 text-[9px] uppercase tracking-wider text-[var(--color-faint)]">
                    {TRAJECTORY_GROUP_LABELS[grp] ?? grp}
                  </span>
                  {ids.map((id) => {
                    const on = pickedMoves.includes(id);
                    const note = honestNote(id, "video");
                    return (
                      <button key={id} type="button" onClick={() => toggleMove(id)}
                        title={[trajectoryOf(id)?.mechanism ?? id, note].filter(Boolean).join(" - ")}
                        className={`rounded-md px-1.5 py-0.5 text-[10px] transition ${on ? "bg-[var(--color-accent)] font-semibold text-black" : "bg-[var(--color-panel2)] text-[var(--color-dim)] hover:text-[var(--color-fg)]"}`}>
                        {trajectoryOf(id)?.label ?? id}
                        {note && <span className={`ml-1 text-[8px] font-semibold uppercase ${on ? "text-black/60" : "text-[var(--color-faint)]"}`}>partial</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-xs text-[var(--color-dim)]">Strength</span>
            <input type="range" min={0.25} max={2} step={0.05} value={strength}
              onChange={(e) => setStrength(Number(e.target.value))}
              aria-label="Move strength"
              className="flex-1 accent-[var(--color-accent)]" />
            <span className="w-10 text-right text-xs text-[var(--color-dim)]">{strength}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-xs text-[var(--color-dim)]">Subject distance</span>
            <input type="number" min={0.5} max={20} step={0.5} value={distance}
              onChange={(e) => setDistance(Number(e.target.value))}
              aria-label="Subject distance"
              className="input w-24" />
            <span className="text-xs text-[var(--color-dim)]">m</span>
          </div>

          <input value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="Look/style hint (optional) - geometry comes from the clip"
            className="w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]" />

          {probe && !overHardCap && (
            <p className="text-xs text-[var(--color-dim)]">
              {backend === "local"
                ? `~${estMin} min on this Mac (estimate)`
                : "timing depends on your GPU - untested"}
              {" · "}{probe.frames} frames at {probe.fps.toFixed(2)} fps
            </p>
          )}
          <ErrNote err={err} />
          <button onClick={submit} disabled={!canSubmit}
            className="w-full rounded-xl bg-[var(--color-accent)] py-2.5 text-sm font-semibold text-black disabled:opacity-40">
            {busy ? "Starting…" : "Apply new camera move"}
          </button>
        </div>

        <div className="panel p-5">
          {job ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold capitalize">{job.status}</span>
                {["queued", "in_progress"].includes(job.status) && (
                  <button onClick={() => fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" })}
                    className="text-xs text-red-400 underline">cancel</button>
                )}
              </div>
              {["queued", "in_progress"].includes(job.status) && (
                <div className="h-1.5 overflow-hidden rounded bg-[var(--color-panel2)]">
                  <div className="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${job.progress ?? 5}%` }} />
                </div>
              )}
              {job.error && <p className="text-sm text-red-400">{job.error}</p>}
              {outUrl
                ? <video src={outUrl} controls muted className="max-h-[320px] w-full rounded-xl border border-[var(--color-border)] object-contain" data-testid="reshoot-output" />
                : <video src={videoUrl} muted className="max-h-[320px] w-full rounded-xl border border-[var(--color-border)] object-contain opacity-50" />}
            </div>
          ) : (
            <div className="grid h-full place-items-center text-center text-sm text-[var(--color-dim)]">
              <div>
                <p className="font-semibold text-[var(--color-ink)]">No camera move yet</p>
                <p className="mt-1 max-w-xs">Upload a clip, pick a path. Your camera is recovered
                  from the clip; each frame is re-projected along the new path and the gaps are filled in.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
