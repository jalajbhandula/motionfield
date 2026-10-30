"use client";
import { useEffect, useRef, useState } from "react";
import { ErrNote } from "@/components/ErrNote";
import { uploadFile, userError, userErrorFrom, type UserError } from "@/lib/user-error";

/** tiles arrive from the server wrapper - already filtered to verified
 *  restyle presets (the POST route enforces the same gate) */
export type RestyleTile = { id: string; title: string; posterHue: number; poster?: string };

/** ReCut - reference-edit rebuild on Wan VACE.
 *  Upload → server-side shot split → per-shot hints → ONE job regenerates
 *  every shot through the flow's VACE graph and assembles a single file that
 *  keeps the original cut order, timing, aspect, fps and soundtrack. Any shot
 *  can be regenerated on its own afterwards. */

type ShotSpan = { start: number; end: number };
type Shot = { index: number; start: number; end: number; hint?: string; windows: ShotSpan[] };
type ShotState = "pending" | "running" | "completed" | "failed";
type Chain = {
  id: string; status: string; flow: string; shots: Shot[];
  shot_outputs?: { index: number; urls: (string | null)[] }[];
  result_url?: string | null; error?: string | null;
  video_url?: string;
};
type JobRow = { id: string; status: string; progress?: number | null; error?: string | null };
type DetectResult = {
  shots: Shot[]; windows: number;
  probe: { duration: number; fps: number; width: number; height: number; rotation: number; has_audio: boolean };
};

const FLOWS = [
  ["character-swap", "Character swap", "Put your people into the shots - the default re-edit flow", 3],
  ["motion-transfer", "Motion transfer", "Keep the reference's movement, one new subject performs it", 1],
  ["restyle", "Restyle", "New visual style, same motion + composition + audio", 1],
] as const;

type FlowId = (typeof FLOWS)[number][0];
const flowInfo = (f: FlowId) => FLOWS.find(([v]) => v === f)!;

export default function ReCutClient({ restyleTiles }: { restyleTiles: RestyleTile[] }) {
  const [videoUrl, setVideoUrl] = useState("");
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [hints, setHints] = useState<string[]>([]);
  const [presetId, setPresetId] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [resolution, setResolution] = useState("480p");
  const [flow, setFlow] = useState<FlowId>("character-swap");
  const [detecting, setDetecting] = useState(false);
  const [chain, setChain] = useState<Chain | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [shotStatus, setShotStatus] = useState<ShotState[]>([]);
  const [err, setErr] = useState<UserError | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [regenIdx, setRegenIdx] = useState<number | null>(null);
  const vidRef = useRef<HTMLVideoElement>(null);

  async function onVideo(file: File) {
    setErr(null); setChain(null); setDetect(null);
    let url: string;
    try {
      url = (await uploadFile(file)).url;
    } catch (e) { setErr(userErrorFrom(e)); return; }
    setVideoUrl(url); setDetecting(true);
    try {
      const r = await fetch("/api/re-edit/detect", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_url: url }),
      });
      const det = await r.json();
      if (!r.ok) { setErr(userError(r.status, det.error ?? "detection failed")); return; }
      setDetect(det as DetectResult);
      setHints((det.shots as Shot[]).map(() => ""));
    } finally {
      setDetecting(false);
    }
  }

  async function addPhotos(files: FileList | null) {
    const cap = flowInfo(flow)[3];
    for (const f of Array.from(files ?? []).slice(0, cap - photos.length)) {
      try {
        const { url } = await uploadFile(f);
        setPhotos((p) => [...p, url].slice(0, cap));
      } catch (e) { setErr(userErrorFrom(e)); }
    }
  }

  async function submit() {
    if (!videoUrl || !detect?.shots.length) { setErr("Upload a reference video first."); return; }
    setBusy(true); setErr(null);
    const r = await fetch("/api/re-edit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_url: videoUrl, flow,
        image_urls: photos, instructions,
        hints, resolution, likeness_consent: consent,
        ...(flow === "restyle" && presetId ? { preset_id: presetId } : {}),
      }),
    });
    const d = await r.json();
    setBusy(false);
    if (!r.ok) { setErr(userError(r.status, d.error ?? "failed")); return; }
    setChain(d.chain); setJobs(d.job ? [d.job] : []);
    setShotStatus((d.chain?.shots ?? []).map(() => "pending"));
  }

  async function regenShot(index: number) {
    if (!chain) return;
    setRegenIdx(index); setErr(null);
    const r = await fetch(`/api/re-edit/${chain.id}/shots/${index}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hint: hints[index] || undefined }),
    });
    const d = await r.json();
    setRegenIdx(null);
    if (!r.ok) { setErr(userError(r.status, d.error ?? "regenerate failed")); return; }
    setChain(d.chain);
  }

  async function cancelChain() {
    if (!chain) return;
    await fetch(`/api/re-edit/${chain.id}`, { method: "DELETE" });
  }

  // poll the chain while it's live
  useEffect(() => {
    if (!chain || !["queued", "running", "assembling"].includes(chain.status)) return;
    const t = setInterval(async () => {
      const r = await fetch(`/api/re-edit/${chain.id}`);
      if (!r.ok) return;
      const d = await r.json();
      setChain(d.chain); setJobs(d.jobs ?? []); setShotStatus(d.shot_status ?? []);
      if (!["queued", "running", "assembling"].includes(d.chain.status)) clearInterval(t);
    }, 2000);
    return () => clearInterval(t);
  }, [chain?.id, chain?.status]);

  const shots = detect?.shots ?? chain?.shots ?? [];
  const cap = flowInfo(flow)[3];
  const liveJob = jobs[jobs.length - 1];
  const needPhotos = flow !== "restyle";
  const canSubmit = !busy && !!videoUrl && !!shots.length && !detecting &&
    (!needPhotos || photos.length > 0);

  const stateChip = (s: ShotState) =>
    s === "completed" ? "border-emerald-500/60 text-emerald-400"
    : s === "failed" ? "border-red-500/60 text-red-400"
    : s === "running" ? "border-[var(--color-accent)] text-[var(--color-accent)]"
    : "border-[var(--color-border)] text-[var(--color-dim)]";

  return (
    <div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="panel space-y-5 p-5">
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase text-[var(--color-dim)]">Edit type</label>
            <div className="space-y-1.5">
              {FLOWS.map(([v, l, d]) => (
                <button key={v} onClick={() => { setFlow(v); setPresetId(""); setPhotos((p) => p.slice(0, flowInfo(v)[3])); }}
                  className={`block w-full rounded-xl border px-3 py-2 text-left ${flow === v ? "border-[var(--color-accent)] bg-[var(--color-panel2)]" : "border-[var(--color-border)]"}`}>
                  <div className="text-sm font-semibold">{l}</div>
                  <div className="text-xs text-[var(--color-dim)]">{d}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase text-[var(--color-dim)]">Reference edit (1-30 s)</label>
            <label className="grid h-32 cursor-pointer place-items-center rounded-xl border border-dashed border-[var(--color-border)] text-[var(--color-dim)] hover:border-[var(--color-accent)]">
              {videoUrl ? <video src={videoUrl} className="max-h-[320px] h-full w-full object-contain" muted /> : "+ Upload reference video"}
              <input type="file" accept="video/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onVideo(f); }} />
            </label>
            {detecting && <p className="mt-1.5 text-center text-xs text-[var(--color-accent)]">Splitting into shots on the server…</p>}
            {detect && !detecting && (
              <div className="mt-2">
                <div className="mb-1 flex items-center justify-between text-xs text-[var(--color-dim)]">
                  <span>{detect.shots.length} shot{detect.shots.length === 1 ? "" : "s"} · {detect.windows} generation window{detect.windows === 1 ? "" : "s"} · {detect.probe.duration.toFixed(1)} s @ {Math.round(detect.probe.fps)} fps</span>
                </div>
                <div className="space-y-1.5">
                  {detect.shots.map((s, i) => (
                    <div key={s.index} className="flex items-center gap-2">
                      <div className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-panel2)] px-2 py-1 font-mono text-[10px]">
                        {s.index + 1} · {s.start.toFixed(1)}-{s.end.toFixed(1)}s{s.windows.length > 1 ? ` ·${s.windows.length}w` : ""}
                      </div>
                      <input value={hints[i] ?? ""} onChange={(e) => setHints((h) => h.map((v, j) => j === i ? e.target.value : v))}
                        placeholder="shot hint (optional)"
                        className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]" />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {flow === "restyle" && (
              <>
                <div className="mt-1.5 text-center text-xs text-[var(--color-faint)]">- style preset -</div>
                {restyleTiles.length === 0 ? (
                  <p className="mt-1.5 rounded-lg border border-dashed border-[var(--color-border)] p-2 text-center text-xs text-[var(--color-faint)]">
                    No verified style presets yet - leave unset for a prompt-only restyle.
                  </p>
                ) : null}
                <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                  {restyleTiles.map((p) => (
                    <button key={p.id} onClick={() => setPresetId(presetId === p.id ? "" : p.id)}
                      className={`media-tile relative aspect-video overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] text-left transition-colors hover:border-[var(--color-dim)] ${presetId === p.id ? "ring-2 ring-[var(--color-accent)]" : ""}`}>
                      {p.poster ? (
                        p.poster.endsWith(".mp4") ? (
                          <video src={p.poster} className="absolute inset-0 h-full w-full object-cover" muted loop playsInline autoPlay preload="metadata" />
                        ) : (
                          <img src={p.poster} alt={p.title} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
                        )
                      ) : (
                        <div className="absolute inset-0" style={{ background: `linear-gradient(160deg, hsl(${p.posterHue} 35% 20%), var(--color-panel) 80%)` }} />
                      )}
                      <span className="absolute bottom-0 w-full border-t border-[var(--color-border)] bg-[var(--color-panel)]/85 p-1.5 text-[10px] font-semibold backdrop-blur-sm">{p.title}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase text-[var(--color-dim)]">
              Your subjects - {flow === "character-swap" ? "1-3 photos" : `${needPhotos ? "1 photo" : "optional photo"}`}
            </label>
            {needPhotos && (
              <label className="mb-2 flex cursor-pointer items-start gap-2 text-xs text-[var(--color-dim)]">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 accent-[var(--color-accent)]" />
                <span>I have the right to use this person&apos;s likeness</span>
              </label>
            )}
            <div className="flex flex-wrap gap-1.5">
              {photos.map((u, i) => (
                <div key={i} className="media-tile h-16 w-16"><img src={u} /><button className="absolute right-0.5 top-0.5 z-10 rounded bg-black/70 px-1 text-xs" onClick={() => setPhotos((p) => p.filter((_, j) => j !== i))}>✕</button></div>
              ))}
              {photos.length < cap && (
                <label title={needPhotos && !consent ? "Tick the consent box first" : undefined} className={`grid h-16 w-16 place-items-center rounded-lg border border-dashed border-[var(--color-border)] ${needPhotos && !consent ? "cursor-not-allowed opacity-40" : "cursor-pointer text-[var(--color-dim)] hover:border-[var(--color-accent)]"}`}>
                  +
                  <input type="file" accept="image/*" multiple={cap > 1} className="hidden" disabled={needPhotos && !consent} onChange={(e) => addPhotos(e.target.files)} />
                </label>
              )}
            </div>
          </div>

          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input value={instructions} onChange={(e) => setInstructions(e.target.value)}
              placeholder="Instructions for the whole edit (optional)…"
              className="w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]" />
            <select value={resolution} onChange={(e) => setResolution(e.target.value)}
              className="rounded-lg border border-[var(--color-border)] bg-transparent px-2 text-sm">
              <option value="480p">480p</option><option value="720p">720p</option>
            </select>
          </div>
          <ErrNote err={err} />
          <button onClick={submit} disabled={!canSubmit}
            className="w-full rounded-xl bg-[var(--color-accent)] py-2.5 text-sm font-semibold text-black disabled:opacity-40">
            {busy ? "Starting…" : `Re-edit ${shots.length ? `- ${shots.length} shot${shots.length === 1 ? "" : "s"}` : ""}`}
          </button>
        </div>

        <div className="panel space-y-4 p-5">
          {chain ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold capitalize">{chain.status}</span>
                {["queued", "running", "assembling"].includes(chain.status)
                  ? <button onClick={cancelChain} className="text-xs text-red-400 underline">cancel</button>
                  : <span className="text-xs text-[var(--color-dim)]">{chain.flow}</span>}
              </div>
              {liveJob && ["queued", "in_progress"].includes(liveJob.status) && (
                <div className="h-1.5 overflow-hidden rounded bg-[var(--color-panel2)]">
                  <div className="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${liveJob.progress ?? 5}%` }} />
                </div>
              )}
              {chain.error && <p className="text-sm text-red-400">{chain.error}</p>}

              {chain.result_url ? (
                <video ref={vidRef} src={chain.result_url} controls className="w-full rounded-xl border border-[var(--color-border)]" />
              ) : chain.video_url ? (
                <video src={chain.video_url} muted className="w-full rounded-xl border border-[var(--color-border)] opacity-50" />
              ) : null}

              <div>
                <div className="mb-1 text-xs font-semibold uppercase text-[var(--color-dim)]">Shots</div>
                <div className="space-y-1.5">
                  {chain.shots.map((s, i) => {
                    const st = shotStatus[i] ?? "pending";
                    return (
                      <div key={s.index} className="flex items-center gap-2">
                        <div className={`rounded-md border px-2 py-1 font-mono text-[10px] ${stateChip(st)}`}>
                          {s.index + 1} · {s.start.toFixed(1)}-{s.end.toFixed(1)}s · {st}
                        </div>
                        {s.hint && <span className="flex-1 truncate text-xs text-[var(--color-dim)]">{s.hint}</span>}
                        <button disabled={["queued", "running", "assembling"].includes(chain.status) || regenIdx !== null}
                          onClick={() => regenShot(i)}
                          className="ml-auto rounded-md border border-[var(--color-border)] px-2 py-0.5 text-xs hover:border-[var(--color-accent)] disabled:opacity-40">
                          {regenIdx === i ? "…" : "regenerate"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          ) : (
            <div className="grid h-full place-items-center text-center text-sm text-[var(--color-dim)]">
              <div>
                <p className="font-semibold text-[var(--color-ink)]">No edit yet</p>
                <p className="mt-1">Upload a reference edit to see its shots split server-side.<br />Each shot is regenerated and re-assembled into one file.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
