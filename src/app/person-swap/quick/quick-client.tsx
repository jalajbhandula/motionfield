"use client";
import { useEffect, useState } from "react";
import { Compare } from "../person-swap-client";
import { UploadInput } from "@/components/fields";
import { ErrNote } from "@/components/ErrNote";
import { LoginGate } from "@/components/LoginGate";
import { userError, type UserError } from "@/lib/user-error";

/** PersonSwap Quick - the shortest way to put one person into a short clip:
 *  one photo, one ≤15 s clip (or a ready gallery clip), person mode, sane
 *  defaults. Same endpoint as full PersonSwap with quick:true - the server
 *  enforces the shape; this page just exposes the honest controls. */

type Probe = { duration: number; fps: number; width: number; height: number; has_audio: boolean };
type LocalEst = { steps: number; measured_on?: string; total_min: Record<string, Record<string, number>> };
type DetectResult = { windows: number; in_range: boolean; probe: Probe; local?: LocalEst };
type PersonSwapMeta = { windows?: number; gen_box?: string; steps?: number; lip?: string; compare_src?: string };
type Run = { id: string; status: string; progress?: number | null; stage?: string | null; error?: string | null; outputs?: { url?: string; type?: string }[]; meta?: PersonSwapMeta | null };
type GalleryClip = { id: string; seconds: number; aspect: string; url: string; provenance?: unknown };

const QUICK_MAX_S = 15;

export default function PersonSwapQuickClient() {
  const [consent, setConsent] = useState(false);
  const [refUrl, setRefUrl] = useState("");
  const [clipUrl, setClipUrl] = useState("");
  const [galleryId, setGalleryId] = useState("");
  const [gallery, setGallery] = useState<GalleryClip[]>([]);
  const [srcPreview, setSrcPreview] = useState("");
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [aspect, setAspect] = useState<"source" | "9:16" | "16:9">("source");
  const [resolution, setResolution] = useState("480p");
  const [lipSync, setLipSync] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [estimate, setEstimate] = useState<{ credits: number; usd: number } | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [err, setErr] = useState<UserError | string | null>(null);
  const [busy, setBusy] = useState(false);

  // gallery list - verified entries only, count is the real number
  useEffect(() => {
    fetch("/api/person-swap/gallery")
      .then((r) => (r.ok ? r.json() : { clips: [] }))
      .then((d) => setGallery(Array.isArray(d.clips) ? d.clips : []))
      .catch(() => {});
  }, []);

  async function probe(body: Record<string, unknown>) {
    setDetecting(true); setDetect(null);
    try {
      const r = await fetch("/api/person-swap/detect", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { setErr(userError(r.status, d.error ?? "detection failed")); return; }
      setDetect(d as DetectResult);
    } finally {
      setDetecting(false);
    }
  }

  function onPhotoUrl(url: string) {
    setErr(null);
    setRefUrl(url);
  }

  async function onClipUrl(url: string) {
    setErr(null); setRuns([]);
    if (!url) { setClipUrl(""); setSrcPreview(""); setDetect(null); return; }
    setClipUrl(url); setGalleryId(""); setSrcPreview(url);
    await probe({ video_url: url });
  }

  async function pickGallery(c: GalleryClip) {
    setErr(null); setRuns([]);
    setGalleryId(c.id); setClipUrl(""); setSrcPreview(c.url);
    await probe({ gallery_id: c.id });
  }

  const overLimit = !!detect && detect.probe.duration > QUICK_MAX_S;
  const readyClip = (!!clipUrl || !!galleryId) && !!detect?.in_range && !overLimit;
  const wantsLip = lipSync && !!detect?.probe.has_audio;

  // live estimate - same cost fn as the charge, with server-derived windows
  useEffect(() => {
    if (!readyClip) { setEstimate(null); return; }
    const t = setTimeout(async () => {
      const r = await fetch("/api/estimate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint_id: "motionfield/person-swap/v1.0",
          params: {
            ...(clipUrl ? { video_url: clipUrl } : { gallery_id: galleryId }),
            mode: "person", quick: true,
            windows: detect?.windows ?? 1, lip_sync: wantsLip, resolution,
          },
        }),
      });
      const d = await r.json().catch(() => null);
      setEstimate(r.ok && d ? { credits: d.credits, usd: d.usd } : null);
    }, 300);
    return () => clearTimeout(t);
  }, [readyClip, clipUrl, detect?.windows, wantsLip, resolution]);

  async function submit() {
    setBusy(true); setErr(null);
    const r = await fetch("/api/person-swap", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quick: true,
        ...(clipUrl ? { video_url: clipUrl } : { gallery_id: galleryId }),
        mode: "person",
        image_urls: [refUrl],
        prompt: prompt.trim() || undefined,
        likeness_consent: consent,
        lip_sync: lipSync, resolution,
        ...(aspect !== "source" ? { aspect } : {}),
      }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok || !d.jobs?.length) { setErr(userError(r.status, d.error ?? "submit failed")); return; }
    setRuns(d.jobs);
  }

  // poll live runs
  useEffect(() => {
    const live = runs.filter((r) => !["completed", "failed", "canceled", "nsfw"].includes(r.status));
    if (!live.length) return;
    const t = setInterval(async () => {
      const next = await Promise.all(runs.map(async (r) => {
        if (["completed", "failed", "canceled", "nsfw"].includes(r.status)) return r;
        const res = await fetch(`/api/person-swap/${r.id}`);
        const d = await res.json().catch(() => null);
        return res.ok && d?.job ? d.job as Run : r;
      }));
      setRuns(next);
    }, 2000);
    return () => clearInterval(t);
  }, [runs]);

  const done = runs.find((r) => r.status === "completed");
  const doneUrl = done?.outputs?.find((o) => o.type === "video")?.url;
  const localTotal = detect?.local?.total_min?.[resolution]?.person;
  const canSubmit = !busy && consent && !!refUrl && readyClip && !detecting;

  return (
    <div className="mx-auto max-w-[860px] px-4 py-10">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Quick Person Swap</h1>
        <a href="/person-swap" className="ml-auto rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-accent)] hover:border-[var(--color-accent)]">
          Full controls → Person Swap
        </a>
      </div>
      <p className="mt-1 text-sm text-[var(--color-dim)]">
        The shortest way to put one person into a short clip - one photo, one
        clip ≤15&nbsp;s, person swap with the defaults already chosen.
      </p>

      <div className="mt-6">
        <LoginGate />

        <div className="mt-4 flex items-start gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2">
          <input id="quick-consent" type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />
          <label htmlFor="quick-consent" className="text-sm text-[var(--color-dim)]">
            I have the right to use this person's likeness.{" "}
            <span className="opacity-70">Required - the clip and the reference photo re-render a real person.</span>
          </label>
        </div>

        <div className="mt-4 block">
          <span className="mb-1 block text-sm text-[var(--color-dim)]">Identity photo (exactly 1)</span>
          <UploadInput value={refUrl || null} accept="image/*" disabled={!consent} ariaLabel="Identity photo" tileAlt="ref"
            onChange={(v) => onPhotoUrl(Array.isArray(v) ? v[0] ?? "" : v)} />
        </div>

        <div className="mt-4 block">
          <span className="mb-1 block text-sm text-[var(--color-dim)]">Clip (1-15 s)</span>
          <UploadInput value={clipUrl || null} accept="video/*" disabled={!consent} ariaLabel="Clip (1-15 s)"
            onChange={(v) => onClipUrl(Array.isArray(v) ? v[0] ?? "" : v)} />
        </div>

        {gallery.length > 0 && (
          <div className="mt-3">
            <span className="mb-1 block text-sm text-[var(--color-dim)]">…or a ready clip ({gallery.length} verified)</span>
            <div className="grid grid-cols-3 gap-2">
              {gallery.map((c) => (
                <button key={c.id} onClick={() => consent && pickGallery(c)} disabled={!consent}
                  className={`rounded-lg border p-1 text-left text-xs disabled:opacity-40 ${
                    galleryId === c.id ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"}`}>
                  <video src={c.url} muted playsInline preload="metadata" className="w-full rounded-md" />
                  <div className="mt-1 px-0.5 text-[var(--color-dim)]">{c.seconds.toFixed(1)} s · {c.aspect}</div>
                </button>
              ))}
            </div>
          </div>
        )}
        {gallery.length === 0 && (
          <p className="mt-2 text-xs text-[var(--color-faint)]">0 ready clips - upload your own above.</p>
        )}

        {srcPreview && (
          <video src={srcPreview} muted loop playsInline controls className="mt-3 max-h-[360px] w-full rounded-xl border border-[var(--color-border)] object-contain" />
        )}
        {detecting && <p className="mt-2 text-sm text-[var(--color-dim)]">Probing…</p>}
        {detect && !detect.in_range && (
          <p className="mt-2 text-sm text-red-400">Clip must be 1-30 s - this one is {detect.probe.duration.toFixed(1)} s.</p>
        )}
        {overLimit && (
          <p className="mt-2 text-sm text-red-400">
            Quick Person Swap clips are ≤15 s - this one is {detect?.probe.duration.toFixed(1)} s.{" "}
            <a href="/person-swap" className="text-[var(--color-accent)]">Open full Person Swap</a> for longer clips.
          </p>
        )}
        {detect?.in_range && (
          <p className="mt-2 text-sm text-[var(--color-dim)]">
            {detect.probe.duration.toFixed(1)} s · {detect.probe.width}×{detect.probe.height} · {detect.probe.fps} fps
            {detect.probe.has_audio ? " · has audio" : " · no audio"} - {detect.windows} generation window{detect.windows > 1 ? "s" : ""}
          </p>
        )}
        {detect?.in_range && localTotal != null && (
          <p className={`mt-1 text-xs ${localTotal > 60 ? "text-amber-400" : "text-[var(--color-faint)]"}`}>
            Local ≈ {Math.ceil(localTotal)} min total ({detect.local?.measured_on ?? "this machine"}, {resolution}, {detect.local?.steps} steps)
            {" · first run after ComfyUI starts adds ≈10 min model load"}
          </p>
        )}

        <div className="mt-4">
          <span className="mb-1 block text-sm text-[var(--color-dim)]">Describe the person (optional)</span>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2}
            placeholder="Who the new person is, how they look…"
            className="w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm" />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2 text-[var(--color-dim)]">
            Aspect
            <select value={aspect} onChange={(e) => setAspect(e.target.value as typeof aspect)}
              className="rounded-lg border border-[var(--color-border)] bg-transparent px-2 py-1.5">
              <option value="source">Source</option>
              <option value="9:16">9:16 (crops your clip)</option>
              <option value="16:9">16:9 (crops your clip)</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-[var(--color-dim)]">
            Resolution
            <select value={resolution} onChange={(e) => setResolution(e.target.value)}
              className="rounded-lg border border-[var(--color-border)] bg-transparent px-2 py-1.5">
              <option value="480p">480p</option>
              <option value="720p">720p - longer ETA</option>
            </select>
          </label>
          {estimate && <span className="text-[var(--color-dim)]">≈ {estimate.credits} credits</span>}
        </div>

        {detect?.probe.has_audio && (
          <label className="mt-3 flex items-center gap-2 text-sm text-[var(--color-dim)]">
            <input type="checkbox" checked={lipSync} onChange={(e) => setLipSync(e.target.checked)} />
            Restore lip sync - keeps the original soundtrack
          </label>
        )}

        <button onClick={submit} disabled={!canSubmit}
          className="mt-4 w-full rounded-lg bg-[var(--color-accent)] px-4 py-2.5 text-sm font-medium text-black disabled:opacity-40">
          {busy ? "Submitting…" : "Run quick person swap"}
        </button>
        {!consent && <p className="mt-1 text-xs text-[var(--color-dim)]">Tick the likeness box to enable the uploads and submission.</p>}
        <ErrNote err={err} className="mt-2" />
      </div>

      {runs.length > 0 && (
        <div className="mt-6 rounded-xl border border-[var(--color-border)] p-3">
          <h2 className="text-sm font-medium">Run</h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {runs.map((r) => (
              <li key={r.id}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[var(--color-dim)]">run</span>
                  <span className={
                    r.status === "completed" ? "text-emerald-400"
                    : r.status === "failed" ? "text-red-400"
                    : "text-[var(--color-dim)]"}>
                    {r.status === "in_progress" || r.status === "queued"
                      ? `${r.status} ${Math.round(r.progress ?? 0)}%${r.stage ? ` - ${r.stage}` : ""}` : r.status}
                  </span>
                </div>
                {r.meta?.lip && <p className="text-xs text-[var(--color-faint)]">{r.meta.lip}</p>}
              </li>
            ))}
          </ul>
          {runs.find((r) => r.error) && (
            <p className="mt-2 text-xs text-red-400">{runs.find((r) => r.error)?.error}</p>
          )}
        </div>
      )}

      {doneUrl && srcPreview && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-medium">Source ↔ swapped</h2>
          {/* an aspect-cropped run compares against the crop the model saw,
              not the raw upload - the recipe kept it as compare_src */}
          <Compare srcUrl={done?.meta?.compare_src ?? srcPreview} outUrl={doneUrl} />
          <div className="mt-2 flex gap-3 text-sm">
            <a href={doneUrl} download className="text-[var(--color-accent)]">Download result</a>
            {/* hands the same clip + photo to full PersonSwap - the ids are
                re-checked server-side on that page's detect call */}
            <a href={`/person-swap?${clipUrl ? `clip=${encodeURIComponent(clipUrl)}` : `gallery=${encodeURIComponent(galleryId)}`}&photo=${encodeURIComponent(refUrl)}`}
              className="text-[var(--color-accent)]">Open in Person Swap - full controls</a>
          </div>
        </div>
      )}
    </div>
  );
}
