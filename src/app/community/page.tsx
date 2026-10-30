"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GitFork, Heart, RotateCcw } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { Lightbox, type LightboxItem } from "@/components/Lightbox";

type FeedJob = {
  id: string; kind: string; model_id: string; prompt: string | null;
  outputs: { url: string; type: string }[]; likes_count: number; created_at: string;
  has_graph?: boolean; graph_forks?: number;
  handle: string | null; display_name: string | null; avatar_url: string | null;
};
type FeedProject = {
  id: string; slug: string; title: string; description: string | null; cover_url: string | null;
  likes_count: number; handle: string | null; display_name: string | null;
};

export default function Community() {
  const { data: session } = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<"all" | "image" | "video">("all");
  const [jobs, setJobs] = useState<FeedJob[]>([]);
  const [projects, setProjects] = useState<FeedProject[]>([]);
  const [liked, setLiked] = useState<Set<string>>(new Set());
  const [viewer, setViewer] = useState<LightboxItem | null>(null);

  useEffect(() => {
    fetch(`/api/feed${tab === "all" ? "" : `?kind=${tab}`}`).then((r) => r.json())
      .then((d) => { setJobs(d.jobs ?? []); setProjects(d.projects ?? []); }).catch(() => {});
  }, [tab]);

  async function like(j: FeedJob) {
    if (!session?.user) { router.push("/login?next=/community"); return; }
    const isLiked = liked.has(j.id);
    setLiked((s) => { const n = new Set(s); isLiked ? n.delete(j.id) : n.add(j.id); return n; });
    setJobs((js) => js.map((x) => x.id === j.id ? { ...x, likes_count: x.likes_count + (isLiked ? -1 : 1) } : x));
    await fetch("/api/social", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: isLiked ? "unlike" : "like", targetType: "job", targetId: j.id }) });
  }

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold">Community</h1>
          <p className="text-[var(--color-dim)]">Public generations and projects from creators.</p>
        </div>
        <div className="flex gap-1.5">
          {(["all", "image", "video"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`chip capitalize ${tab === t ? "chip-on" : ""}`}>{t}</button>
          ))}
        </div>
      </div>

      {projects.length > 0 && (
        <>
          <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-[var(--color-dim)]">Projects</h2>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {projects.map((p) => (
              <Link key={p.id} href={`/u/${p.handle}/projects/${p.slug}`} className="panel overflow-hidden transition-colors hover:border-[var(--color-accent)]">
                <div className="poster-gradient h-28" style={{ ["--h" as string]: (p.title.length * 31) % 360 }}>
                  {p.cover_url && <img src={p.cover_url} alt={p.title} className="h-full w-full object-cover" />}
                </div>
                <div className="p-3">
                  <div className="font-semibold">{p.title}</div>
                  <div className="mt-0.5 line-clamp-1 text-xs text-[var(--color-dim)]">@{p.handle} · ♥ {p.likes_count}</div>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-[var(--color-dim)]">Shots</h2>
      {jobs.length === 0 && (
        <div className="mt-6 rounded-2xl border border-dashed border-[var(--color-border)] p-12 text-center text-[var(--color-dim)]">
          Nothing public yet - be the first. Generate something, then publish it from Assets.
        </div>
      )}
      <div className="mt-4 columns-2 gap-3 sm:columns-3 lg:columns-5 [&>*]:mb-3">
        {jobs.map((j) => {
          const out = j.outputs?.[0];
          return (
            <div key={j.id} className="media-tile break-inside-avoid cursor-pointer"
              onClick={() => out && setViewer({ url: out.url, type: out.type, label: j.prompt ?? undefined,
                recreateHref: `/ai/${j.kind === "video" ? "video" : "image"}?recreate=${encodeURIComponent(j.prompt ?? "")}&model=${j.model_id}` })}>
              {out?.type === "video" ? <video src={out.url} muted loop autoPlay playsInline /> : out ? <img src={out.url} alt={j.prompt ?? "community generation"} /> : <div className="skeleton aspect-video" />}
              <div className="hover-ui p-3 flex flex-col justify-between">
                <div />
                <div>
                  <p className="line-clamp-2 text-xs text-white/90">{j.prompt}</p>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-[11px] text-white/60">@{j.handle ?? "anon"}</span>
                    <div className="flex gap-1.5">
                      <button onClick={(e) => { e.stopPropagation(); like(j); }} className={`btn btn-sm bg-black/60 hover:bg-black ${liked.has(j.id) ? "text-[var(--color-accent)]" : ""}`}>
                        <Heart size={12} fill={liked.has(j.id) ? "currentColor" : "none"} /> {j.likes_count}
                      </button>
                      {j.has_graph && (
                        <Link className="btn btn-sm bg-black/60 hover:bg-black" title="Fork this workflow graph"
                          href={`/graph/${j.id}`}>
                          <GitFork size={12} /> {(j.graph_forks ?? 0) > 0 ? j.graph_forks : ""}
                        </Link>
                      )}
                      <Link className="btn btn-sm bg-black/60 hover:bg-black" title="Recreate"
                        href={`/ai/${j.kind === "video" ? "video" : "image"}?recreate=${encodeURIComponent(j.prompt ?? "")}&model=${j.model_id}`}>
                        <RotateCcw size={12} />
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <Lightbox item={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}
