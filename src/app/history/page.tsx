"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Headphones, RotateCcw } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { creditsUsdLabel } from "@/lib/catalog/plans";
import { Lightbox, type LightboxItem } from "@/components/Lightbox";

type Job = {
  id: string; status: string; progress: number; modelId: string; workflow: string; kind?: string;
  prompt: string | null; costCredits: string; error: string | null; createdAt: string;
  outputs: { url: string; type: string }[];
};

const S_LABEL: Record<string, string> = { queued: "Queued", in_progress: "Running", completed: "Done", failed: "Failed", nsfw: "Moderated", canceled: "Canceled" };

export default function History() {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [viewer, setViewer] = useState<LightboxItem | null>(null);
  const timer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => { if (!isPending && !session?.user) router.push("/login?next=/history"); }, [isPending, session]);

  useEffect(() => {
    const load = () => fetch("/api/jobs?limit=100").then((r) => r.json()).then((d) => setJobs(d.jobs ?? [])).catch(() => {});
    load();
    timer.current = setInterval(() => {
      if (jobs.some((j) => ["queued", "in_progress"].includes(j.status))) load();
    }, 2500);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [jobs.some((j) => ["queued", "in_progress"].includes(j.status))]);

  async function cancel(id: string) {
    await fetch(`/api/jobs/${id}/cancel`, { method: "POST" });
    setJobs((js) => js.map((j) => j.id === id ? { ...j, status: "canceled" } : j));
  }

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-8">
      <h1 className="font-display text-3xl font-bold">History</h1>
      <p className="text-[var(--color-dim)]">Every generation request - status, cost, results. Failed & canceled jobs auto-refund.</p>
      <div className="mt-6 space-y-2">
        {jobs.map((j) => (
          <div key={j.id} className="panel flex items-center gap-4 p-3">
            <div className="media-tile h-14 w-24 shrink-0">
              {j.outputs?.[0] ? (
                <button type="button" className="block h-full w-full cursor-zoom-in" title="Open fullscreen"
                  onClick={() => setViewer({ url: j.outputs[0].url, type: j.outputs[0].type, label: j.prompt ?? j.modelId, recreateHref: `${j.kind === "video" || j.kind === "v2v" ? "/ai/video" : j.kind === "audio" || j.kind === "avatar" ? "/audio" : "/ai/image"}?recreate=${encodeURIComponent(j.prompt ?? "")}&model=${j.modelId}` })}>
                  {j.outputs[0].type === "video" ? <video src={j.outputs[0].url} muted className="pointer-events-none h-full w-full object-cover" />
                    : j.outputs[0].type === "audio" ? <div className="grid h-full place-items-center"><Headphones size={20} className="text-[var(--color-dim)]" /></div>
                    : <img src={j.outputs[0].url} className="h-full w-full object-cover" />}
                </button>
              ) : <div className="skeleton h-full w-full" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm">{j.modelId}</span>
                <span className="text-xs text-[var(--color-faint)]">{j.workflow}</span>
                <span className={`chip text-[10px] ${j.status === "completed" ? "chip-on" : j.status === "failed" ? "!text-[var(--color-danger)]" : ""}`}>{S_LABEL[j.status]}{j.status === "in_progress" ? ` ${j.progress}%` : ""}</span>
              </div>
              <p className="mt-0.5 truncate text-xs text-[var(--color-dim)]">{j.prompt ?? "-"}</p>
              {j.error && <p className="truncate text-xs text-[var(--color-danger)]">{j.error}</p>}
            </div>
            <div className="text-right shrink-0">
              <div className="text-xs text-[var(--color-dim)]" title={creditsUsdLabel(Number(j.costCredits))}>
                {Number(j.costCredits)} cr · {creditsUsdLabel(Number(j.costCredits))}
              </div>
              <div className="text-[11px] text-[var(--color-faint)]">{new Date(j.createdAt).toLocaleString()}</div>
            </div>
            <div className="flex shrink-0 gap-1.5">
              {["queued", "in_progress"].includes(j.status) && <button className="btn btn-ghost btn-sm" onClick={() => cancel(j.id)}>Cancel</button>}
              {j.status === "completed" && j.outputs?.[0] && <a className="btn btn-ghost btn-sm" href={j.outputs[0].url} download title="Save"><Download size={13} /></a>}
              {j.status === "completed" && <a className="btn btn-ghost btn-sm" title="Recreate with same prompt" href={`${j.kind === "video" || j.kind === "v2v" ? "/ai/video" : j.kind === "audio" || j.kind === "avatar" ? "/audio" : "/ai/image"}?recreate=${encodeURIComponent(j.prompt ?? "")}&model=${j.modelId}`}><RotateCcw size={13} /></a>}
            </div>
          </div>
        ))}
        {jobs.length === 0 && <div className="rounded-2xl border border-dashed border-[var(--color-border)] p-16 text-center text-[var(--color-dim)]">No generations yet.</div>}
      </div>
      <Lightbox item={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}
