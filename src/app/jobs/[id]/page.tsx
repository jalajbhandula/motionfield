"use client";
import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { recreateHref } from "@/lib/recreate";
import { userError, userErrorFrom, type UserError } from "@/lib/user-error";
import { ErrNote } from "@/components/ErrNote";
import { Download, Hourglass, Maximize2, RotateCcw } from "lucide-react";
import { Lightbox, type LightboxItem } from "@/components/Lightbox";

type Job = {
  id: string; status: string; progress: number; modelId: string; workflow: string; kind: string;
  prompt: string | null; params: Record<string, unknown>; costCredits: string; error: string | null;
  createdAt: string; outputs: { assetId: string; url: string; type: string; width?: number; height?: number }[];
};

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<UserError | null>(null);
  const [viewer, setViewer] = useState<LightboxItem | null>(null);
  const timer = useRef<NodeJS.Timeout | null>(null);

  const fetched = useRef<string | null>(null);

  const load = useCallback(async (retry = false) => {
    // StrictMode re-invokes effects - the first mount's fetch may still be in
    // flight when the second runs. Auto-loads dedupe per id; Retry is explicit.
    if (!retry && fetched.current === id) return;
    fetched.current = id;
    try {
      const r = await fetch(`/api/jobs/${id}`);
      const d = await r.json().catch(() => null);
      if (!r.ok) { setErr(userError(r.status, d?.error)); return; }
      setErr(null);
      if (d?.job) {
        setJob(d.job);
        if (["queued", "in_progress"].includes(d.job.status)) timer.current = setTimeout(() => load(true), 1200);
        return;
      }
      setErr(userError(500, "Job not found"));
    } catch (e) {
      setErr(userErrorFrom(e));
    }
  }, [id]);

  useEffect(() => {
    load();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [load]);

  if (!job) return (
    <div className="p-16 text-center">
      {err ? (
        <div className="mx-auto max-w-md space-y-3">
          <ErrNote err={err} />
          <button className="btn btn-ghost btn-sm" onClick={() => load(true)}>Retry</button>
        </div>
      ) : (
        <span className="text-[var(--color-dim)]">Loading…</span>
      )}
    </div>
  );

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-8">
      <div className="flex items-center gap-3">
        <h1 className="font-display text-2xl font-bold">{job.modelId} · {job.workflow}</h1>
        <span className={`chip ${job.status === "completed" ? "chip-on" : ""}`}>{job.status}{job.status === "in_progress" ? ` ${job.progress}%` : ""}</span>
      </div>
      {job.prompt && <p className="mt-2 text-[var(--color-dim)]">{job.prompt}</p>}
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_300px]">
        <div>
          {job.outputs?.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {job.outputs.map((o) => (
                <div key={o.assetId} className="media-tile">
                  {o.type === "video" ? (
                    <div className="relative">
                      <video src={o.url} controls autoPlay loop muted playsInline className="w-full" />
                      <button type="button" title="Open fullscreen" onClick={() => setViewer({ url: o.url, type: o.type, label: job.prompt ?? undefined })}
                        className="absolute bottom-2 right-2 rounded-md bg-black/60 p-1.5 text-white/80 backdrop-blur-sm hover:bg-black/80 hover:text-white">
                        <Maximize2 size={13} />
                      </button>
                    </div>
                  ) : o.type === "audio" ? <audio src={o.url} controls className="w-full p-4" /> : (
                    <button type="button" className="block w-full cursor-zoom-in" title="Open fullscreen"
                      onClick={() => setViewer({ url: o.url, type: o.type, label: job.prompt ?? undefined })}>
                      <img src={o.url} className="w-full" />
                    </button>
                  )}
                  <div className="p-2"><a className="btn btn-ghost btn-sm" href={o.url} download><Download size={12} className="mr-1 inline-block" /> Download</a></div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid aspect-video place-items-center rounded-2xl border border-dashed border-[var(--color-border)]">
              {["queued", "in_progress"].includes(job.status) ? (
                <div className="text-center"><Hourglass size={36} className="mx-auto text-[var(--color-dim)]" /><p className="mt-2 text-sm text-[var(--color-dim)]">{job.status === "queued" ? "In queue…" : `Generating… ${job.progress}%`}</p>
                <button className="btn btn-ghost btn-sm mt-3" onClick={() => fetch(`/api/jobs/${id}/cancel`, { method: "POST" }).then(() => location.reload())}>Cancel (refund)</button></div>
              ) : (
                <ErrNote err={job.error ?? job.status} />
              )}
            </div>
          )}
        </div>
        <div className="panel h-fit p-4 text-sm">
          <div className="space-y-1.5">
            <Row k="Status" v={job.status} />
            <Row k="Cost" v={`${job.costCredits} credits`} />
            <Row k="Created" v={new Date(job.createdAt).toLocaleString()} />
            <Row k="Kind" v={job.kind} />
          </div>
          <div className="mt-3 border-t border-[var(--color-border)] pt-3">
            <div className="mb-1 text-xs font-semibold uppercase text-[var(--color-dim)]">Parameters</div>
            <pre className="max-h-64 overflow-auto text-[11px] text-[var(--color-dim)]">{JSON.stringify(job.params, null, 2)}</pre>
          </div>
          <Link href={recreateHref(job)} className="btn btn-primary btn-sm mt-3 w-full"><RotateCcw size={13} className="mr-1 inline-block" /> Recreate</Link>
        </div>
      </div>
      <Lightbox item={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between"><span className="text-[var(--color-dim)]">{k}</span><span>{v}</span></div>;
}
