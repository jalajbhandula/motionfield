"use client";
import { useEffect, useRef, useState } from "react";
import { PersonSwapTabs } from "../person-swap/tabs";
import { UploadInput } from "@/components/fields";
import { ErrNote } from "@/components/ErrNote";
import { LoginGate } from "@/components/LoginGate";
import { PageExamples } from "@/components/ExampleCard";
import { apiJson, uploadFile, userErrorFrom, type UserError } from "@/lib/user-error";
import { Compare } from "../person-swap/person-swap-client";

/** PersonSwap Object - box the object on frame 0, feed a replacement photo.
 *  The box rasterizes client-side into the frame-0 pick the mask-track
 *  graph consumes (mask_url); the run keeps only the matte region that
 *  still overlaps the pick, and a lost track fails the job instead of
 *  regenerating at random. The draw stage takes the wide column - a
 *  picked region is only as good as the box the user could see to draw. */

type Job = { id: string; status: string; progress?: number | null; error?: string | null; outputs?: { url?: string; type?: string }[] };
type Rect = { x: number; y: number; w: number; h: number }; // normalized 0-1

const OBJECT_ENDPOINT = "motionfield/wan-vace/object-swap";
const RESOLUTIONS = ["480p", "720p"] as const;

export default function ObjectClient() {
  const [videoUrl, setVideoUrl] = useState("");
  const [videoName, setVideoName] = useState("");
  const [photoUrl, setPhotoUrl] = useState("");
  const [region, setRegion] = useState<Rect | null>(null);
  const [drawing, setDrawing] = useState<Rect | null>(null);
  const [prompt, setPrompt] = useState("");
  const [resolution, setResolution] = useState<string>("480p");
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<UserError | string | null>(null);
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  async function onVideo(file: File) {
    setErr(null); setJob(null); setRegion(null);
    try {
      const d = await uploadFile(file);
      setVideoUrl(d.url); setVideoName(file.name);
    } catch (e) { setErr(userErrorFrom(e)); }
  }

  // box drawing over the video - percentages of the element so the overlay
  // and the rasterized mask agree with the rendered frame
  function point(e: React.PointerEvent): { x: number; y: number } {
    const r = stageRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }
  function down(e: React.PointerEvent) {
    if (!videoUrl) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = point(e);
    setDrawing({ x: p.x, y: p.y, w: 0, h: 0 });
  }
  function move(e: React.PointerEvent) {
    if (!drawing) return;
    const p = point(e);
    setDrawing({
      x: Math.min(drawing.x, p.x), y: Math.min(drawing.y, p.y),
      w: Math.abs(p.x - drawing.x), h: Math.abs(p.y - drawing.y),
    });
  }
  function up() {
    if (!drawing) return;
    setRegion(drawing.w > 0.01 && drawing.h > 0.01 ? drawing : null);
    setDrawing(null);
  }

  /** rasterize the box at the clip's natural size - white on black is the
   *  pick contract the mask-track node reads */
  async function makeMaskUrl(): Promise<string | null> {
    const v = videoRef.current;
    if (!v || !region) return null;
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    const g = c.getContext("2d")!;
    g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#fff";
    g.fillRect(Math.round(region.x * c.width), Math.round(region.y * c.height),
      Math.max(1, Math.round(region.w * c.width)), Math.max(1, Math.round(region.h * c.height)));
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
    if (!blob) { setErr("Couldn't rasterize the picked region - try again."); return null; }
    return (await uploadFile(blob, "object-region.png")).url;
  }

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const maskUrl = await makeMaskUrl();
      if (!maskUrl) return;
      const d = await apiJson<{ job?: Job }>(await fetch("/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint_id: OBJECT_ENDPOINT,
          params: {
            video_url: videoUrl, mask_url: maskUrl,
            image_urls: [photoUrl], resolution,
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

  // poll the job
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
  const canSubmit = !busy && !!videoUrl && !!photoUrl && !!region;
  const shown = drawing ?? region;

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-10">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Object Swap</h1>
        <a href="/person-swap/quick" className="ml-auto rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-accent)] hover:border-[var(--color-accent)]">
          Quick Person Swap
        </a>
      </div>
      <PersonSwapTabs active="object" />
      <p className="mt-3 text-sm text-[var(--color-dim)]">
        Box the object on frame 0 - it's tracked across the clip and replaced with
        your reference photo. Everything outside the tracked region
        stays untouched, and the soundtrack carries over.
      </p>
      <PageExamples />

      <div className="mt-6 grid gap-6 md:grid-cols-[1fr_300px]">
        <div>
          <LoginGate />
          <div ref={stageRef}
            className={`relative mt-4 select-none overflow-hidden rounded-xl border bg-black ${videoUrl ? "border-[var(--color-border)]" : "border-dashed border-[var(--color-border)]"}`}
            onPointerDown={down} onPointerMove={move} onPointerUp={up}
            style={{ touchAction: "none", cursor: videoUrl ? "crosshair" : "default" }}>
            {videoUrl ? (
              <>
                <video ref={videoRef} src={videoUrl} muted playsInline preload="metadata" className="block w-full" />
                {shown && (
                  <div className="pointer-events-none absolute border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-accent)]/10"
                    style={{ left: `${shown.x * 100}%`, top: `${shown.y * 100}%`, width: `${shown.w * 100}%`, height: `${shown.h * 100}%` }} />
                )}
              </>
            ) : (
              <label className="grid h-64 cursor-pointer place-items-center text-sm text-[var(--color-dim)] hover:text-[var(--color-accent)]">
                + Drop a clip - then drag a box over the object
                <input type="file" accept="video/*" aria-label="Source clip" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void onVideo(f); }} />
              </label>
            )}
          </div>
          {videoUrl && (
            <div className="mt-2 flex items-center justify-between text-xs">
              <span className="truncate text-[var(--color-faint)]">{videoName} - {region ? "object picked, drag again to re-box" : "drag a box over the object on frame 0"}</span>
              <label className="shrink-0 cursor-pointer text-[var(--color-accent)]">
                Replace clip
                <input type="file" accept="video/*" aria-label="Source clip" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void onVideo(f); }} />
              </label>
            </div>
          )}
          <ErrNote err={err} className="mt-2" />

          {doneUrl && videoUrl && (
            <div className="mt-6">
              <h2 className="mb-2 text-sm font-medium">Source ↔ swapped</h2>
              <Compare srcUrl={videoUrl} outUrl={doneUrl} />
              <a href={doneUrl} download className="mt-2 inline-block text-sm text-[var(--color-accent)]">Download result</a>
            </div>
          )}
        </div>

        <div>
          <div>
            <span className="mb-1 block text-sm text-[var(--color-dim)]">Replacement object photo (1)</span>
            <UploadInput value={photoUrl || null} accept="image/*" ariaLabel="Replacement object photo" tileAlt="replacement object"
              onChange={(v) => setPhotoUrl(Array.isArray(v) ? v[0] ?? "" : v)} />
          </div>

          <div className="mt-4">
            <span className="mb-1 block text-sm text-[var(--color-dim)]">Describe the swap (optional)</span>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2}
              placeholder="e.g. the red mug becomes the steel thermos in the photo"
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
            {busy ? "Submitting…" : "Run object swap"}
          </button>
          {videoUrl && !region && <p className="mt-1 text-xs text-[var(--color-dim)]">Drag a box over the object first.</p>}

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
        </div>
      </div>
    </div>
  );
}
