"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Heart, Maximize2, Music, RotateCcw } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { Lightbox, type LightboxItem } from "@/components/Lightbox";

type Asset = {
  id: string; kind: string; url: string; prompt: string | null; endpoint_id?: string;
  endpointId?: string; favorite: boolean; visibility: string; createdAt: string;
  jobId?: string | null; recreateHref?: string; width: number | null; height: number | null;
};

export default function Assets() {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [kind, setKind] = useState<string>("all");
  const [favOnly, setFavOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [viewer, setViewer] = useState<LightboxItem | null>(null);

  useEffect(() => { if (!isPending && !session?.user) router.push("/login?next=/assets"); }, [isPending, session]);
  useEffect(() => {
    const params = new URLSearchParams();
    if (kind !== "all") params.set("kind", kind);
    if (favOnly) params.set("favorite", "1");
    fetch(`/api/assets?${params}`).then((r) => r.json()).then((d) => setAssets(d.assets ?? [])).catch(() => {});
  }, [kind, favOnly]);

  const filtered = assets.filter((a) => !q || a.prompt?.toLowerCase().includes(q.toLowerCase()));
  const toggleSel = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function bulk(action: string) {
    for (const id of selected) {
      if (action === "favorite") await fetch(`/api/assets/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ favorite: true }) });
      if (action === "publish") await fetch(`/api/assets/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visibility: "public" }) });
      if (action === "delete") await fetch(`/api/assets/${id}`, { method: "DELETE" });
    }
    setSelected(new Set());
    const r = await fetch("/api/assets"); setAssets((await r.json()).assets ?? []);
  }

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl font-bold">Assets</h1>
        <input className="input max-w-64" placeholder="Search prompts…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {["all", "image", "video", "audio"].map((k) => (
          <button key={k} onClick={() => setKind(k)} className={`chip capitalize ${kind === k ? "chip-on" : ""}`}>{k}</button>
        ))}
        <button onClick={() => setFavOnly(!favOnly)} className={`chip ${favOnly ? "chip-on" : ""}`}><Heart size={12} /> Favorites</button>
        {selected.size > 0 && (
          <div className="ml-auto flex gap-2">
            <span className="text-xs text-[var(--color-dim)] self-center">{selected.size} selected</span>
            <button className="chip hover:text-white" onClick={() => bulk("favorite")}><Heart size={12} /> Like</button>
            <button className="chip hover:text-white" onClick={() => bulk("publish")}>Publish all</button>
            <button className="chip hover:text-white" onClick={() => bulk("delete")}>Delete</button>
          </div>
        )}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {filtered.map((a) => (
          <div key={a.id}
            className={`media-tile group aspect-square cursor-pointer ${selected.has(a.id) ? "ring-2 ring-[var(--color-accent)]" : ""}`}
            onClick={() => setViewer({ url: a.url, type: a.kind, label: a.prompt ?? undefined })}
            onDoubleClick={() => { if (a.jobId) router.push(`/jobs/${a.jobId}`); }}
          >
            {a.kind === "video" ? <video src={a.url} muted loop autoPlay playsInline /> : a.kind === "audio" ? <div className="grid h-full place-items-center"><Music size={28} className="text-[var(--color-dim)]" /></div> : <img src={a.url} alt={a.prompt ?? "generated asset"} />}
            <button aria-label={selected.has(a.id) ? "Deselect" : "Select"} aria-pressed={selected.has(a.id)}
              className={`absolute left-2 top-2 z-20 grid h-6 w-6 place-items-center rounded-full border text-[11px] leading-none transition ${selected.has(a.id) ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-black opacity-100" : "border-white/40 bg-black/60 text-white opacity-0 focus-visible:opacity-100 group-hover:opacity-100"}`}
              onClick={(e) => { e.stopPropagation(); toggleSel(a.id); }}>
              {selected.has(a.id) ? "✓" : "+"}
            </button>
            <div className="hover-ui p-2 flex flex-col justify-between pointer-events-none">
              <div className="flex justify-between">
                <span className="chip text-[10px] bg-black/60">{a.kind}</span>
                <div className="flex gap-1 pointer-events-auto">
                  <button className="btn btn-sm bg-black/60" onClick={(e) => { e.stopPropagation(); fetch(`/api/assets/${a.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ favorite: !a.favorite }) }).then(() => setAssets(as => as.map(x => x.id === a.id ? { ...x, favorite: !x.favorite } : x))); }}><Heart size={12} fill={a.favorite ? "currentColor" : "none"} /></button>
                </div>
              </div>
              <div>
                <p className="line-clamp-2 text-[11px] text-white/90">{a.prompt}</p>
                <div className="mt-1 flex gap-1 pointer-events-auto">
                  <button className="btn btn-sm bg-black/60 !px-2" title="Open fullscreen" onClick={(e) => { e.stopPropagation(); setViewer({ url: a.url, type: a.kind, label: a.prompt ?? undefined }); }}><Maximize2 size={12} /></button>
                  <a className="btn btn-sm bg-black/60 !px-2" href={a.url} download title="Save" onClick={(e) => e.stopPropagation()}><Download size={12} /></a>
                  {a.visibility !== "public" && <button className="btn btn-sm bg-black/60 !px-2" onClick={(e) => { e.stopPropagation(); fetch(`/api/assets/${a.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visibility: "public" }) }).then(() => setAssets(as => as.map(x => x.id === a.id ? { ...x, visibility: "public" } : x))); }}>Publish</button>}
                  <Link className="btn btn-sm bg-black/60 !px-2" title="Recreate" href={a.recreateHref ?? `${a.kind === "video" ? "/ai/video" : a.kind === "audio" ? "/audio" : "/ai/image"}?recreate=${encodeURIComponent(a.prompt ?? "")}`} onClick={(e) => e.stopPropagation()}><RotateCcw size={12} /></Link>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
      {filtered.length === 0 && (
        <div className="mt-8 rounded-2xl border border-dashed border-[var(--color-border)] p-16 text-center text-[var(--color-dim)]">
          No assets yet. <Link href="/ai/image" className="text-[var(--color-accent)]">Generate something →</Link>
        </div>
      )}
      <Lightbox item={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}
