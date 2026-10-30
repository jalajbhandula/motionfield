"use client";
import { PageExamples } from "@/components/ExampleCard";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PersonSwapTabs } from "./tabs";
import { UploadInput } from "@/components/fields";
import { ErrNote } from "@/components/ErrNote";
import { LoginGate } from "@/components/LoginGate";
import { userError, type UserError } from "@/lib/user-error";

/** PersonSwap - a consented identity swap on a finished clip, or the same person
 *  re-staged in a new setting. Upload → server probes windows → estimate →
 *  one job per (clip × identity) → source|result comparison. */

type Probe = { duration: number; fps: number; width: number; height: number; has_audio: boolean };
type LocalEst = { steps: number; measured_on?: string; total_min: Record<string, Record<Mode, number>> };
type DetectResult = { windows: number; in_range: boolean; probe: Probe; local?: LocalEst; preview?: string };
type PersonSwapMeta = {
  windows?: number; gen_box?: string; steps?: number; lip?: string; window_wall_s?: number[]; compare_src?: string;
  draft?: boolean; draft_steps?: number; draft_of?: string;
  matte?: string | null; mask?: string | null;
  coverage?: { person_mean?: number; face_pct?: number | null } | null;
};
type Run = {
  id: string; status: string; progress?: number | null; error?: string | null; held?: boolean;
  outputs?: { url?: string; type?: string }[]; meta?: PersonSwapMeta | null;
};
type Mode = "person" | "environment" | "both";

const MODES: { id: Mode; label: string; blurb: string }[] = [
  { id: "person", label: "Person", blurb: "Replace the person - the set stays" },
  { id: "environment", label: "Environment", blurb: "Re-create the set - the person stays" },
  { id: "both", label: "Both", blurb: "New person in a new setting" },
];

export function Compare({ srcUrl, outUrl }: { srcUrl: string; outUrl: string }) {
  const [pos, setPos] = useState(50);
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  // keep the two videos roughly in lockstep - the matte edges only read as
  // "swap" when both sides move together
  useEffect(() => {
    const v1 = a.current, v2 = b.current;
    if (!v1 || !v2) return;
    const sync = () => { if (Math.abs(v1.currentTime - v2.currentTime) > 0.25) v2.currentTime = v1.currentTime; };
    v1.addEventListener("timeupdate", sync);
    v1.play().catch(() => {});
    v2.play().catch(() => {});
    return () => v1.removeEventListener("timeupdate", sync);
  }, [srcUrl, outUrl]);
  return (
    <div className="relative overflow-hidden rounded-xl border border-[var(--color-border)] bg-black has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-accent)]">
      <video ref={a} src={srcUrl} muted loop playsInline className="block w-full" />
      <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>
        <video ref={b} src={outUrl} muted loop playsInline className="block w-full" />
      </div>
      <div className="pointer-events-none absolute inset-y-0" style={{ left: `${pos}%` }}>
        <div className="absolute inset-y-0 -left-px w-0.5 bg-white/80" />
      </div>
      <input type="range" min={0} max={100} value={pos} aria-label="Compare source and result" aria-valuenow={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0" />
      <div className="absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">source</div>
      <div className="absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">swapped</div>
    </div>
  );
}

export default function PersonSwapClient() {
  const sp = useSearchParams();
  const [tab, setTab] = useState<"single" | "batch">("single");
  const [videoUrl, setVideoUrl] = useState("");
  const [galleryId, setGalleryId] = useState("");
  const [srcPreview, setSrcPreview] = useState("");
  const [extraClips, setExtraClips] = useState<string[]>([]);
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [mode, setMode] = useState<Mode>("person");
  const [refs, setRefs] = useState<string[]>([]);
  const [batchRefs, setBatchRefs] = useState<string[][]>([[], [], [], []]);
  const [consent, setConsent] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [envPrompt, setEnvPrompt] = useState("");
  const [lipSync, setLipSync] = useState(true);
  const [draftFirst, setDraftFirst] = useState(true);
  const [resolution, setResolution] = useState("480p");
  const [estimate, setEstimate] = useState<{ credits: number; usd: number } | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [err, setErr] = useState<UserError | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sxsUrl, setSxsUrl] = useState<string | null>(null);
  const srcRef = useRef<HTMLVideoElement>(null);

  // deep-link preselect - Quick's "Open in PersonSwap" lands here as
  // /person-swap?clip=<url>|gallery=<id>&photo=<url>. Every id is re-checked
  // server-side inside one detect call (a foreign or unknown id fails the
  // probe and nothing gets preselected); consent still needs the tick.
  const preselectDone = useRef(false);
  useEffect(() => {
    if (preselectDone.current) return;
    preselectDone.current = true;
    const clip = sp.get("clip"), gallery = sp.get("gallery"), photo = sp.get("photo");
    if (!clip && !gallery) return;
    (async () => {
      setDetecting(true);
      try {
        const r = await fetch("/api/person-swap/detect", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(clip ? { video_url: clip } : { gallery_id: gallery }),
            ...(photo ? { image_urls: [photo] } : {}),
          }),
        });
        const d = await r.json();
        if (!r.ok) { setErr(userError(r.status, d.error ?? "preselect failed")); return; }
        setDetect(d as DetectResult);
        if (clip) { setVideoUrl(clip); setSrcPreview(clip); }
        else { setGalleryId(gallery!); setSrcPreview(d.preview ?? ""); }
        if (photo) setRefs([photo]);
      } finally {
        setDetecting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);

  async function onVideoUrl(url: string) {
    setErr(null); setDetect(null); setRuns([]); setSxsUrl(null);
    if (!url) { setVideoUrl(""); setGalleryId(""); setSrcPreview(""); return; }
    setVideoUrl(url); setGalleryId(""); setSrcPreview(url); setDetecting(true);
    try {
      const r = await fetch("/api/person-swap/detect", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_url: url }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(userError(r.status, d.error ?? "detection failed")); return; }
      setDetect(d as DetectResult);
    } finally {
      setDetecting(false);
    }
  }

  const needRefs = mode !== "environment";
  const identities: string[][] = tab === "batch" ? batchRefs.filter((s) => s.length > 0) : [refs];
  const wantsLip = lipSync && mode !== "environment" && !!detect?.probe.has_audio;
  const units = (tab === "batch" ? Math.max(1, identities.length) : 1) * (1 + extraClips.length);

  // live estimate - the same cost fn the charge uses, with server-derived windows
  useEffect(() => {
    if (!detect?.in_range || !videoUrl) { setEstimate(null); return; }
    const t = setTimeout(async () => {
      const r = await fetch("/api/estimate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint_id: "motionfield/person-swap/v1.0",
          params: { video_url: videoUrl, mode, windows: detect.windows, lip_sync: wantsLip, resolution,
            ...(tab === "single" && draftFirst ? { draft: true } : {}) },
        }),
      });
      const d = await r.json().catch(() => null);
      setEstimate(r.ok && d ? { credits: d.credits * units, usd: d.usd * units } : null);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detect?.windows, detect?.in_range, mode, wantsLip, resolution, units, videoUrl, draftFirst, tab]);

  /** the exact body the draft ran with - approve reuses it so the final is
   *  the same request, not whatever the form happens to show now */
  const lastBody = useRef<Record<string, unknown> | null>(null);

  async function postRun(body: Record<string, unknown>) {
    const r = await fetch("/api/person-swap", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.jobs?.length) { setErr(userError(r.status, d.error ?? "submit failed")); return null; }
    return d.jobs as Run[];
  }

  async function submit() {
    setBusy(true); setErr(null);
    const body: Record<string, unknown> = {
      ...(galleryId ? { gallery_id: galleryId } : { video_url: videoUrl }),
      mode, prompt, likeness_consent: consent,
      lip_sync: lipSync, resolution,
      ...(tab === "single" && draftFirst ? { draft: true } : {}),
      ...(mode !== "person" && envPrompt.trim() ? { env_prompt: envPrompt.trim() } : {}),
      ...(extraClips.length ? { clips: extraClips } : {}),
    };
    if (tab === "batch") body.identities = identities.map((s) => ({ image_urls: s }));
    else body.image_urls = refs;
    const jobs = await postRun(body);
    setBusy(false);
    if (!jobs) return;
    lastBody.current = body;
    setRuns(jobs); setSxsUrl(null);
  }

  /** approve the draft - same request + draft_of, the final reuses the
   *  draft's seed (the matte recomputes identically on the same frames) */
  async function approveDraft(draftId: string) {
    if (!lastBody.current) return;
    setBusy(true); setErr(null);
    const body = { ...lastBody.current, draft: false, draft_of: draftId };
    const jobs = await postRun(body);
    setBusy(false);
    if (!jobs) return;
    lastBody.current = body;
    setRuns((rs) => [...rs, ...jobs]);
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

  const done = [...runs].reverse().find((r) => r.status === "completed" && r.meta?.draft !== true);
  const doneUrl = done?.outputs?.find((o) => o.type === "video")?.url;
  // a completed draft waiting on review - shown until the user approves
  // (a non-draft run joins the list) or discards it
  const draftDone = runs.find((r) => r.status === "completed" && r.meta?.draft === true);
  const draftUrl = draftDone?.outputs?.find((o) => o.type === "video")?.url;
  const finalStarted = runs.some((r) => r.meta?.draft !== true);
  const showReview = !!draftDone && !finalStarted;
  useEffect(() => { setSxsUrl(null); }, [doneUrl]);

  async function exportSxs() {
    if (!done) return;
    const r = await fetch(`/api/person-swap/${done.id}/export`);
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.url) setSxsUrl(d.url); else setErr(userError(r.status, d.error ?? "export failed"));
  }

  const canSubmit = !busy && !!(videoUrl || galleryId) && !!detect?.in_range && consent &&
    (!needRefs || identities.every((s) => s.length > 0)) &&
    (tab === "single" || identities.length > 0);

  const localTotal = detect?.local?.total_min?.[resolution]?.[mode];

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-10">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Person Swap</h1>
        <a href="/person-swap/quick" className="ml-auto rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-accent)] hover:border-[var(--color-accent)]">
          Quick Person Swap - the short path
        </a>
      </div>
      <PersonSwapTabs active="person" />
      <p className="mt-3 text-sm text-[var(--color-dim)]">
        Put a consented identity into a finished clip - or move the same person into a new setting.
        The server cuts the clip into ≤5&nbsp;s windows, mattes the person, runs the masked
        swap passes, and re-assembles at the original fps with the original soundtrack.
      </p>
      <PageExamples />

      <div className="mt-6 grid gap-6 md:grid-cols-[1fr_340px]">
        <div>
          <LoginGate />

          <div className="mt-4 flex items-start gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2">
            <input id="person-swap-consent" type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />
            <label htmlFor="person-swap-consent" className="text-sm text-[var(--color-dim)]">
              I have the right to use this person's likeness.{" "}
              <span className="opacity-70">Required - the clip and the reference photos re-render a real person.</span>
            </label>
          </div>

          <div className="mt-4 block">
            <span className="mb-1 block text-sm text-[var(--color-dim)]">Source clip (1-30 s)</span>
            <UploadInput value={videoUrl || null} accept="video/*" disabled={!consent} ariaLabel="Source clip"
              onChange={(v) => onVideoUrl(Array.isArray(v) ? v[0] ?? "" : v)} />
          </div>
          {galleryId && (
            <p className="mt-1 text-xs text-[var(--color-faint)]">gallery clip “{galleryId}” - it is copied into your uploads on submit.</p>
          )}
          {detecting && <p className="mt-2 text-sm text-[var(--color-dim)]">Probing…</p>}
          {detect && !detect.in_range && (
            <p className="mt-2 text-sm text-red-400">
              Clip must be 1-30 s - this one is {detect.probe.duration.toFixed(1)} s.
            </p>
          )}

          <div className="mt-4 flex gap-2">
            {MODES.map((m) => (
              <button key={m.id} onClick={() => setMode(m.id)}
                title={m.blurb}
                className={`flex-1 rounded-lg border px-3 py-2 text-left text-sm transition
                  ${mode === m.id ? "border-[var(--color-accent)] text-[var(--color-accent)]" : "border-[var(--color-border)] text-[var(--color-dim)]"}`}>
                <div className="font-medium">{m.label}</div>
                <div className="text-xs opacity-80">{m.blurb}</div>
              </button>
            ))}
          </div>

          {mode !== "environment" && (
            <div className="mt-4">
              <span className="mb-1 block text-sm text-[var(--color-dim)]">Describe the person</span>
              {mode === "both" && <p className="mb-1 text-xs text-[var(--color-faint)]">helps when refs are few</p>}
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
                placeholder="Who the new person is, how they look, styling…"
                className="w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm" />
            </div>
          )}
          {mode !== "person" && (
            <div className="mt-4">
              <span className="mb-1 block text-sm text-[var(--color-dim)]">Describe the setting (best-effort)</span>
              <textarea value={envPrompt} onChange={(e) => setEnvPrompt(e.target.value)} rows={3}
                placeholder="The setting to re-create around the person…"
                className="w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm" />
            </div>
          )}

          <div className="mt-4 flex gap-2 text-sm">
            <button onClick={() => setTab("single")}
              className={`rounded-lg border px-3 py-1.5 ${tab === "single" ? "border-[var(--color-accent)] text-[var(--color-accent)]" : "border-[var(--color-border)] text-[var(--color-dim)]"}`}>
              Single
            </button>
            <button onClick={() => setTab("batch")}
              className={`rounded-lg border px-3 py-1.5 ${tab === "batch" ? "border-[var(--color-accent)] text-[var(--color-accent)]" : "border-[var(--color-border)] text-[var(--color-dim)]"}`}>
              Batch - clips × up to 4 identities
            </button>
          </div>
          {tab === "batch" && (
            <p className="mt-1 text-xs text-[var(--color-faint)]">
              The batch runs one after another on this machine - members beyond a free slot are held and start when a member finishes.
            </p>
          )}

          {tab === "single" ? (
            <div className="mt-3">
              <span className="mb-1 block text-sm text-[var(--color-dim)]">
                {needRefs ? "Identity refs (1-8 photos - best 3 used)" : "Setting ref (optional, 1)"}
              </span>
              <UploadInput value={refs} accept="image/*" multiple maxItems={needRefs ? 8 : 1} disabled={!consent}
                ariaLabel={needRefs ? "Identity refs" : "Setting ref"} tileAlt="ref"
                onChange={(v) => setRefs(Array.isArray(v) ? v : v ? [v] : [])} />
            </div>
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-3">
              {batchRefs.map((slot, i) => (
                <div key={i} className="rounded-lg border border-[var(--color-border)] p-2">
                  <span className="mb-1 block text-xs text-[var(--color-dim)]">Identity {i + 1}</span>
                  <UploadInput value={slot} accept="image/*" multiple maxItems={8}
                    disabled={!consent || (!needRefs && i > 0)} ariaLabel={`Identity ${i + 1}`} tileAlt="ref"
                    onChange={(v) => setBatchRefs((b) => b.map((s, j) => (j === i ? (Array.isArray(v) ? v : v ? [v] : []) : s)))} />
                </div>
              ))}
              <div className="col-span-2">
                <span className="mb-1 block text-xs text-[var(--color-dim)]">Extra clips (optional, up to 3 - same identities)</span>
                <UploadInput value={extraClips} accept="video/*" multiple maxItems={3} disabled={!consent} ariaLabel="Extra clips"
                  onChange={(v) => setExtraClips(Array.isArray(v) ? v : v ? [v] : [])} />
              </div>
            </div>
          )}

          {mode !== "environment" && detect?.probe.has_audio && (
            <label className="mt-3 flex items-center gap-2 text-sm text-[var(--color-dim)]">
              <input type="checkbox" checked={lipSync} onChange={(e) => setLipSync(e.target.checked)} />
              Restore lip sync - MuseTalk re-times the swapped person's mouth to the original soundtrack
            </label>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <select value={resolution} onChange={(e) => setResolution(e.target.value)}
              className="rounded-lg border border-[var(--color-border)] bg-transparent px-2 py-1.5">
              <option value="480p">480p</option>
              <option value="720p">720p</option>
            </select>
            {tab === "single" && (
              <label className="flex items-center gap-2 text-[var(--color-dim)]" title="A cheap first-window preview - approve the matte + render before paying the full run">
                <input type="checkbox" checked={draftFirst} onChange={(e) => setDraftFirst(e.target.checked)} />
                Draft first - review a preview before the full render
              </label>
            )}
            {estimate && (
              <span className="text-[var(--color-dim)]">
                ≈ {estimate.credits} credits
                {units > 1 ? ` · ${units} jobs` : ""}
              </span>
            )}
          </div>

          <button onClick={submit} disabled={!canSubmit}
            className="mt-4 w-full rounded-lg bg-[var(--color-accent)] px-4 py-2.5 text-sm font-medium text-black disabled:opacity-40">
            {busy ? "Submitting…" : tab === "single" && draftFirst ? "Run draft preview" : `Run person swap${units > 1 ? ` × ${units}` : ""}`}
          </button>
          {!consent && <p className="mt-1 text-xs text-[var(--color-dim)]">Tick the likeness box to enable the uploads and submission.</p>}
          <ErrNote err={err} className="mt-2" />
        </div>

        <div>
          <div className="rounded-xl border border-[var(--color-border)] p-3">
            <h2 className="text-sm font-medium">Source</h2>
            {srcPreview ? (
              <>
                <video ref={srcRef} src={srcPreview} muted loop playsInline controls
                  className="mt-2 max-h-[300px] w-full rounded-lg border border-[var(--color-border)] object-contain" />
                {detect?.in_range && (
                  <p className="mt-2 text-xs text-[var(--color-dim)]">
                    {detect.probe.duration.toFixed(1)} s · {detect.probe.width}×{detect.probe.height} · {detect.probe.fps} fps
                    {detect.probe.has_audio ? " · has audio" : " · no audio"} - {detect.windows} generation window{detect.windows > 1 ? "s" : ""}
                  </p>
                )}
                {detect?.in_range && detect.local && localTotal != null && (
                  <p className={`mt-1 text-xs ${localTotal > 60 ? "text-amber-400" : "text-[var(--color-faint)]"}`}>
                    ≈ {Math.ceil(localTotal)} min local{localTotal > 60 ? " - long run" : ""}
                    {" · first run after ComfyUI starts adds ≈10 min model load"}
                  </p>
                )}
              </>
            ) : (
              <div className="mt-2 grid h-40 place-items-center rounded-lg border border-dashed border-[var(--color-border)] text-center text-xs text-[var(--color-faint)]">
                Upload a clip - the preview, runs and result appear here
              </div>
            )}
          </div>

          {runs.length > 0 && (
            <div className="mt-4 rounded-xl border border-[var(--color-border)] p-3">
              <h2 className="text-sm font-medium">Runs</h2>
              <ul className="mt-2 space-y-1.5 text-sm">
                {runs.map((r, i) => (
                  <li key={r.id}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[var(--color-dim)]">
                        {runs.length > 1 ? `job ${i + 1}` : "run"}
                        {r.meta?.draft === true ? " · draft" : r.meta?.draft_of ? " · final" : ""}
                      </span>
                      <span className={
                        r.status === "completed" ? "text-emerald-400"
                        : r.status === "failed" ? "text-red-400"
                        : "text-[var(--color-dim)]"}>
                        {r.held ? "held - waiting for a slot"
                          : r.status === "in_progress" || r.status === "queued"
                            ? `${r.status} ${Math.round(r.progress ?? 0)}%` : r.status}
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

          {showReview && draftDone && draftUrl && (
            <div className="mt-4 rounded-xl border border-[var(--color-accent)] p-3">
              <h2 className="text-sm font-medium">Draft review - approve before the full render</h2>
              <p className="mt-1 text-xs text-[var(--color-faint)]">
                First window at {draftDone.meta?.draft_steps ?? "low"} steps - same seed + matte the final reuses.
                Check the person matte below covers the person cleanly before approving.
              </p>
              <video src={draftUrl} muted loop playsInline controls className="mt-2 w-full rounded-lg border border-[var(--color-border)]" />
              {(draftDone.meta?.mask ?? draftDone.meta?.matte) && (
                <div className="mt-2">
                  <span className="text-xs text-[var(--color-dim)]">Person matte{draftDone.meta?.mask ? " (applied)" : " (preflight)"} - white is re-rendered</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={(draftDone.meta?.mask ?? draftDone.meta?.matte) as string} alt="person matte evidence"
                    className="mt-1 w-full rounded-lg border border-[var(--color-border)]" />
                </div>
              )}
              {draftDone.meta?.coverage?.person_mean != null && (
                <p className="mt-1 text-xs text-[var(--color-faint)]">
                  mean person coverage {(draftDone.meta.coverage.person_mean * 100).toFixed(1)}%
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <button onClick={() => approveDraft(draftDone.id)} disabled={busy}
                  className="flex-1 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-black disabled:opacity-40">
                  {busy ? "Submitting…" : "Approve - run the full render"}
                </button>
                <button onClick={() => setRuns([])}
                  className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-dim)]">
                  Discard - re-pick
                </button>
              </div>
            </div>
          )}

          {doneUrl && srcPreview && (
            <div className="mt-4">
              <h2 className="mb-2 text-sm font-medium">Source ↔ swapped</h2>
              {/* an aspect-cropped run compares against the crop the model
                  actually saw, kept in the job's evidence dir */}
              <Compare srcUrl={done?.meta?.compare_src ?? srcPreview} outUrl={doneUrl} />
              <div className="mt-2 flex gap-3 text-sm">
                <a href={doneUrl} download className="text-[var(--color-accent)]">Download result</a>
                <button onClick={exportSxs} className="text-[var(--color-accent)]">Side-by-side mp4</button>
                {sxsUrl && <a href={sxsUrl} download className="text-[var(--color-accent)]">saved - download</a>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
