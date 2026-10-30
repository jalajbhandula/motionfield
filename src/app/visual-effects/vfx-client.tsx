"use client";
import { useState, useRef, useMemo } from "react";
import { LicenseBadge } from "@/components/LicenseBadge";
import type { LicenseInfo } from "@/lib/catalog/types";
import {
  VFX_LTX_TOKEN_CAP, VFX_LTX_STEPS, VFX_ETA_S_PER_TOKEN_STEP,
  type VfxEngine, type VfxPlateLock, type VfxAltStructure, type VfxAltLength,
} from "@/lib/catalog/video/vfx";
import { ErrNote } from "@/components/ErrNote";
import { uploadFile, userError, userErrorFrom, type UserError } from "@/lib/user-error";

/** VFX Lab - run a cataloged effect over your own plate. Every preset is a
 *  real graph run: LTX-Video 2B (distilled when installed, classic denoise
 *  otherwise) for plate/image passes, or the Wan VACE alt - the Apache
 *  option. Timing comes from the probe: output is the plate's own frames at
 *  the engine's rate; estimates are measured-on-this-Mac numbers. */

export interface VfxPresetLite {
  id: string; label: string; blurb: string; family: string;
  defaults: {
    lock?: VfxPlateLock; hold?: number; duration?: number;
    resolution?: "480p" | "720p"; target_strength?: number;
    alt_structure?: VfxAltStructure;
  };
  target: boolean; verified: boolean;
}

type Probe = {
  kind: "video" | "image";
  width: number; height: number;
  duration: number; fps: number;
  frames?: number; src_fps?: number; has_audio?: boolean;
  render_frames: number; render_width: number; render_height: number;
  render_tokens: number; token_cap: number;
  alt_fps: number; alt_frames: number; alt_frames_full: number;
  alt_render_width: number; alt_render_height: number;
  alt_truncates?: boolean;
  ltx098: boolean; ltx098_file: string;
  estimates: { ltx095: number; ltx098: number; wan_alt: number; wan_alt_full?: number };
};
type Job = {
  id: string; status: string; progress?: number | null;
  error?: string | null; outputs?: { url?: string }[];
};

const FAMILIES = ["material", "weather", "arc", "fracture"] as const;
const LOCKS: [VfxPlateLock, string][] = [
  ["light", "light - gentle grade"],
  ["medium", "medium - clear effect"],
  ["strong", "strong - big change"],
  ["full", "full - regenerate"],
];
const STRUCTURES: [VfxAltStructure, string][] = [
  ["depth", "depth - geometry"],
  ["pose", "pose - people"],
  ["edges", "edges - linework"],
  ["image", "image - keyframes (stills)"],
];

export default function VfxClient({ licenses, presets }: {
  licenses: { plate: LicenseInfo | null; image: LicenseInfo | null; alt: LicenseInfo | null };
  presets: VfxPresetLite[];
}) {
  const [plateKind, setPlateKind] = useState<"video" | "image">("video");
  const [plateUrl, setPlateUrl] = useState("");
  const [probe, setProbe] = useState<Probe | null>(null);
  const [preset, setPreset] = useState<VfxPresetLite | null>(null);
  const [prompt, setPrompt] = useState("");
  const [engine, setEngine] = useState<VfxEngine>("ltx095");
  const [lock, setLock] = useState<VfxPlateLock>("medium");
  const [hold, setHold] = useState(9);
  const [useAlt, setUseAlt] = useState(false);
  const [structure, setStructure] = useState<VfxAltStructure>("depth");
  const [altLen, setAltLen] = useState<VfxAltLength>("preview");
  const [resolution, setResolution] = useState<"480p" | "720p">("480p");
  const [steps, setSteps] = useState(VFX_LTX_STEPS);
  const [seed, setSeed] = useState<number | undefined>(undefined);
  const [targetUrl, setTargetUrl] = useState("");
  const [targetBusy, setTargetBusy] = useState(false);
  const [targetErr, setTargetErr] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [err, setErr] = useState<UserError | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const pollRef = useRef<Record<string, boolean>>({});

  async function onPlate(file: File) {
    setErr(null); setJobs([]); setProbe(null); setPlateUrl(""); setTargetUrl("");
    let url: string;
    try {
      url = (await uploadFile(file)).url;
    } catch (e) { setErr(userErrorFrom(e)); return; }
    setPlateUrl(url); setProbing(true);
    try {
      const r = await fetch("/api/vfx-lab/probe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(plateKind === "video"
          ? { video_url: url, resolution } : { image_url: url, resolution }),
      });
      const p = await r.json();
      if (!r.ok) { setErr(userError(r.status, p.error ?? "probe failed")); setPlateUrl(""); return; }
      setProbe(p.probe as Probe);
    } finally {
      setProbing(false);
    }
  }

  function applyPreset(p: VfxPresetLite) {
    if (!p.verified) return;
    setPreset(p);
    setPrompt(p.label.toLowerCase()); // the route merges the preset's own text - this is the visible intent
    if (p.defaults.lock) setLock(p.defaults.lock);
    if (p.defaults.hold !== undefined) setHold(p.defaults.hold);
    if (p.defaults.resolution) setResolution(p.defaults.resolution);
    if (p.defaults.alt_structure && p.defaults.alt_structure !== "image") {
      setUseAlt(true); setStructure(p.defaults.alt_structure);
    } else setUseAlt(false);
  }

  function pollJob(id: string) {
    if (pollRef.current[id]) return;
    pollRef.current[id] = true;
    const tick = async () => {
      const r = await fetch(`/api/jobs/${id}`);
      const j = (await r.json()).job as Job;
      setJobs((js) => js.map((x) => (x.id === id ? j : x)));
      if (["queued", "in_progress"].includes(j.status)) setTimeout(tick, 1200);
      else delete pollRef.current[id];
    };
    void tick();
  }

  /** target-frame maker - edits the plate's frame toward the effect's
   *  destination through klein-edit; its image output feeds end_image_url. */
  async function makeTarget() {
    if (!plateUrl || targetBusy) return;
    setTargetBusy(true); setTargetErr(null);
    try {
      const r = await fetch("/api/vfx-lab/target", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_url: plateUrl, vfx_preset: preset?.id, instruction: preset?.target ? undefined : prompt || undefined }),
      });
      const d = await r.json();
      if (!r.ok) { setTargetErr(userError(r.status, d.error ?? "target job failed").message); return; }
      const id = d.job.id as string;
      const tick = async () => {
        const jr = await fetch(`/api/jobs/${id}`);
        const j = (await jr.json()).job as Job;
        const url = j.outputs?.[0]?.url;
        if (j.status === "completed" && url) { setTargetUrl(url); return; }
        if (["queued", "in_progress"].includes(j.status)) setTimeout(tick, 1500);
        else setTargetErr(j.error ?? "target job failed");
      };
      void tick();
    } finally {
      setTargetBusy(false);
    }
  }

  async function submit(pairOf?: string) {
    if (!plateUrl || busy || !probe) return;
    setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = {
        ...(plateKind === "video" ? { video_url: plateUrl } : { image_url: plateUrl }),
        prompt, vfx_preset: preset?.id, seed,
        end_image_url: targetUrl || undefined,
        resolution,
      };
      const isAlt = useAlt || !!pairOf;
      if (isAlt) {
        body.structure = plateKind === "image" ? "image" : structure;
        body.alt_length = altLen;
      } else {
        body.engine = engine;
        if (plateKind === "video") { body.plate_lock = lock; body.hold = hold; }
        if (targetUrl) body.target_strength = 0.8;
        body.steps = steps;
      }
      if (pairOf) body.pair_of = pairOf;
      const r = await fetch("/api/vfx-lab/submit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { setErr(userError(r.status, d.error ?? "submit failed")); return; }
      setJobs((js) => [...js, d.job]);
      pollJob(d.job.id);
    } finally {
      setBusy(false);
    }
  }

  // estimate - the same token formula the probe uses, live over the picks
  const est = useMemo(() => {
    if (!probe) return null;
    if (useAlt) {
      const f = altLen === "full" ? probe.alt_frames_full : probe.alt_frames;
      const sec = (probe.estimates.wan_alt) * (f / probe.alt_frames);
      return { label: `~${Math.max(1, Math.round(sec / 60))} min · Wan VACE`, cls: "" };
    }
    const rate = VFX_ETA_S_PER_TOKEN_STEP * (engine === "ltx095" ? 1 : 0.5) * (steps / VFX_LTX_STEPS);
    const sec = probe.render_tokens * rate;
    const m = Math.max(1, Math.round(sec / 60));
    return {
      label: `~${m} min · LTX ${engine === "ltx098" ? "0.9.8 distilled" : "0.9.5"}`,
      cls: sec > 3600 ? "text-amber-400" : "",
    };
  }, [probe, useAlt, altLen, engine, steps]);

  const canSubmit = !!plateUrl && !!probe && !busy && !probing;
  const done = jobs.filter((j) => j.status === "completed" && j.outputs?.[0]?.url);

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Visual Effects</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-dim)]">
            A cataloged effect over your own clip or still. Local-first on this Mac,
            with an open-license option. The numbers are probe-derived before anything is charged.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-[var(--color-dim)]">LTX plate/image</span>
          <LicenseBadge license={licenses.plate} />
          <span className="text-[var(--color-dim)]">Wan alt</span>
          <LicenseBadge license={licenses.alt} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-4">
          {/* ---- plate ---- */}
          <div className="panel space-y-3 p-5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold uppercase text-[var(--color-dim)]">Your plate</label>
              <div className="flex gap-1 text-xs" role="tablist" aria-label="plate kind">
                {(["video", "image"] as const).map((k) => (
                  <button key={k} onClick={() => { setPlateKind(k); setPlateUrl(""); setProbe(null); }}
                    className={`rounded-md px-2 py-1 ${plateKind === k ? "bg-[var(--color-panel2)] font-semibold" : "text-[var(--color-dim)]"}`}>
                    {k === "video" ? "a clip" : "a still"}
                  </button>
                ))}
              </div>
            </div>
            {!plateUrl ? (
              <label className="grid aspect-video cursor-pointer place-items-center rounded-xl border border-dashed border-[var(--color-border)] text-sm text-[var(--color-dim)] hover:border-[var(--color-accent)]">
                {probing ? "Probing…" : plateKind === "video" ? "Drop or choose a clip (≤10 s)" : "Drop or choose a still"}
                <input type="file" accept={plateKind === "video" ? "video/*" : "image/*"} className="hidden"
                  onChange={(e) => e.target.files?.[0] && onPlate(e.target.files[0])} />
              </label>
            ) : (
              <div className="relative">
                {plateKind === "video"
                  ? <video src={plateUrl} muted controls className="w-full rounded-xl border border-[var(--color-border)]" data-testid="vfx-plate" />
                  : <img src={plateUrl} alt="plate" className="w-full rounded-xl border border-[var(--color-border)]" data-testid="vfx-plate" />}
                <button onClick={() => { setPlateUrl(""); setProbe(null); setJobs([]); setTargetUrl(""); }}
                  className="absolute right-2 top-2 rounded bg-black/70 px-2 py-0.5 text-xs">✕</button>
              </div>
            )}
            {probe && (
              <div className="rounded-lg bg-[var(--color-panel2)] p-2.5 text-xs text-[var(--color-dim)]" data-testid="vfx-probe-card">
                <p className="font-mono">
                  {probe.kind === "video"
                    ? `${probe.frames} frames · ${probe.src_fps?.toFixed(2)} fps · ${probe.duration.toFixed(2)} s`
                    : `${probe.width}×${probe.height} still`}
                  {" · "}{probe.width}×{probe.height} → renders {probe.render_width}×{probe.render_height}
                  {" · "}{probe.render_frames} frames @ {probe.fps}
                </p>
                <p className="mt-0.5">
                  {probe.render_tokens} latent tokens of {probe.token_cap} budget
                  {probe.render_tokens > probe.token_cap && (
                    <span className="text-amber-400"> - over budget; shorter plate or lower res</span>
                  )}
                </p>
                <p className="mt-0.5">
                  est {probe.estimates.ltx095} s on LTX 0.9.5
                  {probe.ltx098 ? ` · ${probe.estimates.ltx098} s distilled` : ""}
                  {" · "}{probe.estimates.wan_alt} s Wan alt
                  {probe.alt_truncates ? " (full run caps at 81 frames)" : ""}
                </p>
                {!probe.ltx098 && (
                  <p className="mt-0.5 opacity-70">
                    ltx098 hidden - install {probe.ltx098_file} under ComfyUI checkpoints to unlock
                  </p>
                )}
                {probe.kind === "video" && (
                  <p className="mt-0.5 opacity-70">
                    {probe.has_audio ? "source audio is kept on the Wan alt · LTX runs keep it too" : "no source audio - output is silent"}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ---- preset grid ---- */}
          <div className="panel p-5">
            <div className="mb-2 flex items-center justify-between">
              <label className="text-xs font-semibold uppercase text-[var(--color-dim)]">Presets</label>
              <span className="text-[10px] text-[var(--color-dim)]">verified runs only can submit - others show as pending</span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="vfx-preset-grid">
              {FAMILIES.map((fam) =>
                presets.filter((p) => p.family === fam).map((p) => (
                  <button key={p.id} onClick={() => applyPreset(p)} disabled={!p.verified}
                    title={`${p.blurb}${p.verified ? "" : " - pending verification"}`}
                    className={`rounded-lg border px-2.5 py-2 text-left text-xs ${
                      preset?.id === p.id ? "border-[var(--color-accent)] bg-[var(--color-panel2)]" : "border-[var(--color-line)]"
                    } ${p.verified ? "" : "opacity-50"}`}>
                    <div className="font-semibold">{p.label}</div>
                    <div className="mt-0.5 text-[10px] text-[var(--color-dim)] line-clamp-2">{p.blurb}</div>
                    <div className="mt-1 text-[9px] font-mono uppercase">
                      {p.verified ? <span className="text-emerald-400">verified</span> : <span className="text-[var(--color-dim)]">pending</span>}
                    </div>
                  </button>
                )))}
            </div>
          </div>

          {/* ---- controls ---- */}
          <div className="panel space-y-3 p-5">
            <input value={prompt} onChange={(e) => setPrompt(e.target.value)}
              placeholder="Direction (optional) - the preset carries its own effect text"
              className="w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]" />

            <div className="flex flex-wrap items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={useAlt} onChange={(e) => setUseAlt(e.target.checked)}
                  data-testid="vfx-alt-toggle" />
                <span>Wan VACE alt (Apache)</span>
              </label>
              {useAlt ? (
                <>
                  {plateKind === "video" && (
                    <select value={structure} onChange={(e) => setStructure(e.target.value as VfxAltStructure)}
                      aria-label="structure" className="rounded-md border border-[var(--color-line)] bg-transparent px-2 py-1">
                      {STRUCTURES.filter(([s]) => s !== "image").map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  )}
                  {plateKind === "image" && <span className="text-[var(--color-dim)]">structure: image keyframes</span>}
                  <select value={altLen} onChange={(e) => setAltLen(e.target.value as VfxAltLength)}
                    aria-label="alt length" className="rounded-md border border-[var(--color-line)] bg-transparent px-2 py-1">
                    <option value="preview">preview · 2 s</option>
                    <option value="full">full · up to 5 s</option>
                  </select>
                </>
              ) : (
                <>
                  <select value={engine} onChange={(e) => setEngine(e.target.value as VfxEngine)}
                    aria-label="engine" className="rounded-md border border-[var(--color-line)] bg-transparent px-2 py-1">
                    <option value="ltx095">LTX 0.9.5 (on this Mac)</option>
                    {probe?.ltx098 && <option value="ltx098">LTX 0.9.8 distilled</option>}
                  </select>
                  {plateKind === "video" && (
                    <>
                      <select value={lock} onChange={(e) => setLock(e.target.value as VfxPlateLock)}
                        aria-label="plate lock" className="rounded-md border border-[var(--color-line)] bg-transparent px-2 py-1">
                        {LOCKS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                      <select value={hold} onChange={(e) => setHold(Number(e.target.value))}
                        aria-label="hold" className="rounded-md border border-[var(--color-line)] bg-transparent px-2 py-1">
                        {[0, 9, 17, 25].map((h) => <option key={h} value={h}>{h === 0 ? "no hold" : `hold ${h}`}</option>)}
                      </select>
                    </>
                  )}
                  <select value={resolution} onChange={(e) => setResolution(e.target.value as "480p" | "720p")}
                    aria-label="resolution" className="rounded-md border border-[var(--color-line)] bg-transparent px-2 py-1">
                    <option value="480p">480p</option>
                    <option value="720p">720p</option>
                  </select>
                  <label className="flex items-center gap-1 text-[var(--color-dim)]">
                    steps
                    <input type="number" min={2} max={30} value={steps} onChange={(e) => setSteps(Number(e.target.value))}
                      aria-label="steps" className="input w-14" />
                  </label>
                </>
              )}
            </div>

            <div className="flex items-center gap-2 text-xs">
              {plateKind === "video" && !useAlt && targetUrl && (
                <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5 text-[10px] text-[var(--color-dim)]">end frame attached</span>
              )}
              {!useAlt && (
                <div className="flex items-center gap-2">
                  {targetUrl && <img src={targetUrl} alt="target" className="h-10 rounded border border-[var(--color-line)]" />}
                  {plateUrl && (
                    <label className="cursor-pointer text-[var(--color-accent)] underline">
                      {targetUrl ? "change" : "pick"} a target frame
                      <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                        const f = e.target.files?.[0]; if (!f) return;
                        try { setTargetUrl((await uploadFile(f)).url); } catch (e2) { setErr(userErrorFrom(e2)); }
                      }} />
                    </label>
                  )}
                  {preset?.target && plateUrl && (
                    <button onClick={makeTarget} disabled={targetBusy}
                      className="text-[var(--color-accent)] underline">
                      {targetBusy ? "making…" : "make it with klein-edit"}
                    </button>
                  )}
                  {targetErr && <span className="text-red-400">{targetErr}</span>}
                </div>
              )}
              <span className="flex-1" />
              {est && <span className={`font-mono ${est.cls}`} data-testid="vfx-est">{est.label}</span>}
            </div>

            <ErrNote err={err} />
            <button onClick={() => submit()} disabled={!canSubmit}
              data-testid="vfx-run"
              className="w-full rounded-xl bg-[var(--color-accent)] py-2.5 text-sm font-semibold text-black disabled:opacity-40">
              {busy ? "Starting…" : useAlt ? "Run Wan alt" : "Run effect"}
            </button>
          </div>
        </div>

        {/* ---- jobs ---- */}
        <div className="space-y-4">
          {jobs.length === 0 ? (
            <div className="panel grid h-full min-h-40 place-items-center p-5 text-center text-sm text-[var(--color-dim)]">
              <div>
                <p className="font-semibold text-[var(--color-ink)]">No runs yet</p>
                <p className="mt-1 max-w-xs">Upload a plate, pick a verified preset. Outputs land side by side here - the plate always stays on the left.</p>
              </div>
            </div>
          ) : jobs.map((j) => {
            const out = j.outputs?.[0]?.url;
            return (
              <div key={j.id} className="panel space-y-2 p-4" data-testid="vfx-job">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold capitalize">{j.status}</span>
                  {["queued", "in_progress"].includes(j.status) && (
                    <button onClick={() => fetch(`/api/jobs/${j.id}/cancel`, { method: "POST" })}
                      className="text-red-400 underline">cancel</button>
                  )}
                </div>
                {["queued", "in_progress"].includes(j.status) && (
                  <div className="h-1.5 overflow-hidden rounded bg-[var(--color-panel2)]">
                    <div className="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${j.progress ?? 5}%` }} />
                  </div>
                )}
                {j.error && <p className="text-xs text-red-400">{j.error}</p>}
                <div className="grid grid-cols-2 gap-2" data-testid="vfx-side-by-side">
                  <div className="space-y-1">
                    <div className="text-[10px] uppercase text-[var(--color-dim)]">plate</div>
                    {plateKind === "video"
                      ? <video src={plateUrl} muted className="w-full rounded-lg border border-[var(--color-line)]" />
                      : <img src={plateUrl} alt="plate" className="w-full rounded-lg border border-[var(--color-line)]" />}
                  </div>
                  <div className="space-y-1">
                    <div className="text-[10px] uppercase text-[var(--color-dim)]">output</div>
                    {out
                      ? <video src={out} controls muted loop className="w-full rounded-lg border border-[var(--color-line)]" data-testid="vfx-output" />
                      : <div className="grid aspect-video place-items-center rounded-lg border border-[var(--color-line)] text-[10px] text-[var(--color-dim)]">…</div>}
                  </div>
                </div>
                {j.status === "completed" && !useAlt && plateKind === "video" && (
                  <button onClick={() => submit(j.id)} disabled={busy}
                    className="text-xs text-[var(--color-accent)] underline">
                    run the Wan alt on the same plate →
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
