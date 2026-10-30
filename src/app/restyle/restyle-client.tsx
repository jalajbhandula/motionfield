"use client";
import { useEffect, useRef, useState } from "react";
import { PersonSwapTabs } from "../person-swap/tabs";
import { ErrNote } from "@/components/ErrNote";
import { LoginGate } from "@/components/LoginGate";
import { apiJson, uploadFile, userErrorFrom, type UserError } from "@/lib/user-error";
import { Compare } from "../person-swap/person-swap-client";

export type RestylePreset = { id: string; label: string; description: string };

/** PersonSwap Restyle - depth-guided v2v on Wan VACE. The grid is the
 *  currently-verified presets only (the same gate the job route enforces),
 *  and the count beside it is the real number. The soundtrack passes
 *  through the graph - the restyled clip keeps the original audio. */

type Job = { id: string; status: string; progress?: number | null; error?: string | null; outputs?: { url?: string; type?: string }[] };

const RESTYLE_ENDPOINT = "motionfield/wan-vace/restyle";
const RESOLUTIONS = ["480p", "720p"] as const;

export default function RestyleClient({ presets }: { presets: RestylePreset[] }) {
  const [videoUrl, setVideoUrl] = useState("");
  const [videoName, setVideoName] = useState("");
  const [presetId, setPresetId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [resolution, setResolution] = useState<string>("480p");
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<UserError | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onVideo(file: File) {
    setErr(null); setJob(null); setUploading(true);
    try {
      const d = await uploadFile(file);
      setVideoUrl(d.url); setVideoName(file.name);
    } catch (e) { setErr(userErrorFrom(e)); }
    finally { setUploading(false); }
  }

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const d = await apiJson<{ job?: Job }>(await fetch("/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint_id: RESTYLE_ENDPOINT,
          params: {
            video_url: videoUrl, preset_id: presetId, resolution,
            ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
          },
        }),
      }));
      if (!d.job) { setErr("Submit returned no job - try again."); return; }
      setJob(d.job);
    } catch (e) {
      setErr(userErrorFrom(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!job || ["completed", "failed", "canceled", "nsfw"].includes(job.status)) return;
    const t = setInterval(async () => {
      const r = await fetch(`/api/jobs/${job.id}`);
      const d = await r.json().catch(() => null);
      if (r.ok && d?.job) setJob(d.job as Job);
    }, 3000);
    return () => clearInterval(t);
  }, [job]);

  const doneUrl = job?.status === "completed" ? job.outputs?.find((o) => o.type === "video")?.url : null;
  const canSubmit = !busy && !uploading && !!videoUrl && !!presetId;

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-10">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Video Restyle</h1>
        <a href="/person-swap/quick" className="ml-auto rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-accent)] hover:border-[var(--color-accent)]">
          Quick Person Swap
        </a>
      </div>
      <PersonSwapTabs active="restyle" />
      <p className="mt-3 text-sm text-[var(--color-dim)]">
        Re-render a clip's look - depth keeps the motion and framing, the preset
        drives the style, and the soundtrack comes through unchanged.
      </p>

      <div className="mt-6 grid gap-6 md:grid-cols-[1fr_340px]">
        <div>
          <LoginGate />

          <div className="mt-4">
            <span className="mb-1 block text-sm text-[var(--color-dim)]">Source clip</span>
            {videoUrl ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm">
                <span className="truncate text-[var(--color-dim)]">{videoName || "clip uploaded"}</span>
                <button onClick={() => fileRef.current?.click()} className="shrink-0 text-[var(--color-accent)]">Replace</button>
              </div>
            ) : (
              <button onClick={() => fileRef.current?.click()} disabled={uploading}
                className="grid h-28 w-full place-items-center rounded-xl border border-dashed border-[var(--color-border)] text-sm text-[var(--color-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">
                {uploading ? "Uploading…" : "+ Drop a clip to restyle"}
              </button>
            )}
            <input ref={fileRef} type="file" accept="video/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void onVideo(f); }} />
          </div>

          <div className="mt-4">
            <span className="mb-1 block text-sm text-[var(--color-dim)]">
              Style preset - {presets.length} verified
            </span>
            {presets.length === 0 && (
              <p className="mt-1 text-xs text-[var(--color-faint)]">
                No verified presets yet - the verification batch records land before any tile is offered here.
              </p>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {presets.map((p) => (
                <button key={p.id} onClick={() => setPresetId(p.id)} title={p.description}
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition
                    ${presetId === p.id ? "border-[var(--color-accent)] text-[var(--color-accent)]" : "border-[var(--color-border)] text-[var(--color-dim)]"}`}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4">
            <span className="mb-1 block text-sm text-[var(--color-dim)]">Extra direction (optional)</span>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2}
              placeholder="More detail for the look…"
              className="w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm" />
          </div>

          <div className="mt-4">
            <span className="mb-1 block text-sm text-[var(--color-dim)]">Resolution</span>
            <div className="flex gap-1.5">
              {RESOLUTIONS.map((r) => (
                <button key={r} onClick={() => setResolution(r)}
                  className={`chip ${resolution === r ? "chip-on" : "hover:border-[#3a3a42]"}`}>{r}</button>
              ))}
            </div>
          </div>

          <button onClick={submit} disabled={!canSubmit}
            className="mt-4 w-full rounded-lg bg-[var(--color-accent)] px-4 py-2.5 text-sm font-medium text-black disabled:opacity-40">
            {busy ? "Submitting…" : "Run restyle"}
          </button>
          <ErrNote err={err} className="mt-2" />
        </div>

        <div>
          <div className="rounded-xl border border-[var(--color-border)] p-3">
            <h2 className="text-sm font-medium">Source</h2>
            {videoUrl ? (
              <video src={videoUrl} muted loop playsInline controls
                className="mt-2 max-h-[300px] w-full rounded-lg border border-[var(--color-border)] object-contain" />
            ) : (
              <div className="mt-2 grid h-40 place-items-center rounded-lg border border-dashed border-[var(--color-border)] text-center text-xs text-[var(--color-faint)]">
                Upload a clip - the preview, run and result appear here
              </div>
            )}
          </div>

          {job && (
            <div className="mt-4 rounded-xl border border-[var(--color-border)] p-3">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="text-[var(--color-dim)]">run</span>
                <span className={job.status === "completed" ? "text-emerald-400" : job.status === "failed" ? "text-red-400" : "text-[var(--color-dim)]"}>
                  {job.status === "in_progress" || job.status === "queued" ? `${job.status} ${Math.round(job.progress ?? 0)}%` : job.status}
                </span>
              </div>
              <ErrNote err={job.error} className="mt-2" />
            </div>
          )}

          {doneUrl && videoUrl && (
            <div className="mt-4">
              <h2 className="mb-2 text-sm font-medium">Source ↔ restyled</h2>
              <Compare srcUrl={videoUrl} outUrl={doneUrl} />
              <a href={doneUrl} download className="mt-2 inline-block text-sm text-[var(--color-accent)]">Download result</a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
