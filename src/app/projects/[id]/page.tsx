"use client";
import { use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Music } from "lucide-react";
import { z } from "zod";
import { MemoryMap, type MemoryRow } from "./memory-map";
import { Lightbox, type LightboxItem } from "@/components/Lightbox";
import { userError } from "@/lib/user-error";

type Project = { id: string; slug: string; title: string; description: string | null; visibility: string };
type Asset = { id: string; kind: string; url: string; prompt: string | null };
type Job = { id: string; kind: string; endpoint_id: string; title: string | null; status: string; outputs: { url?: string }[] };
type Upload = { id: string; url: string; mime: string; name: string | null };
type Folder = { id: string; name: string };
type Fav = { target_type: string; target_id: string; folder_id: string | null };

const isFav = (favs: Fav[], type: string, id: string) =>
  favs.some((f) => f.target_type === type && f.target_id === id);

/* wire shapes - parsed, never trusted */
const UploadsV = z.array(z.looseObject({ id: z.string(), url: z.string() })).catch([]);
const RefsV = z.looseObject({
  refs: z.array(z.looseObject({
    name: z.string(), images: z.array(z.string()).catch([]),
  })).catch([]),
});
const PatchErrV = z.looseObject({ error: z.string().optional() }).catch({});

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [items, setItems] = useState<Asset[]>([]);
  const [owner, setOwner] = useState<{ handle: string | null } | null>(null);
  const [mine, setMine] = useState(false);
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [instructions, setInstructions] = useState("");
  const [savedInstr, setSavedInstr] = useState("");
  const [instrNote, setInstrNote] = useState("");
  // an unsaved edit survives a background load() - dev StrictMode fires the
  // mount effect twice and every fav/folder mutation re-loads too; without
  // this the second response silently wipes what the user was typing
  const instrDirty = useRef(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [favs, setFavs] = useState<Fav[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [folderName, setFolderName] = useState("");
  const [pinFilter, setPinFilter] = useState<string>("all"); // "all" | "unfiled" | folder id
  const [mapTick, setMapTick] = useState(0);
  const [refNames, setRefNames] = useState<Record<string, string>>({});
  const [viewer, setViewer] = useState<LightboxItem | null>(null);

  const load = () => fetch(`/api/projects/${id}`).then((r) => r.json()).then((d) => {
    if (d.error) { router.push("/projects"); return; }
    setProject(d.project); setItems(d.items ?? []); setOwner(d.owner);
    setMine(d.is_owner === true);
    setMemories(d.memories ?? []);
    const nextInstr = d.instructions ?? "";
    setSavedInstr(nextInstr);
    if (!instrDirty.current) setInstructions(nextInstr);
    setInstrNote("");
    setFolders(d.folders ?? []); setFavs(d.favs ?? []);
    setJobs(d.jobs ?? []); setUploads(d.uploads ?? []);
    // a ref already holding an upload's url names the tile - reloading must
    // not offer to mint a second ref for the same file
    const ups = UploadsV.parse(d.uploads);
    if (d.is_owner === true && ups.length) {
      fetch("/api/refs").then((r) => (r.ok ? r.json() : null)).then((rd) => {
        const refs = RefsV.safeParse(rd).data?.refs ?? [];
        setRefNames((x) => {
          const next = { ...x };
          for (const u of ups) {
            if (next[u.id]) continue;
            const hit = refs.find((r) => r.images.includes(u.url));
            if (hit) next[u.id] = `@${hit.name}`;
          }
          return next;
        });
      }).catch(() => {});
    }
  }).catch(() => {});
  useEffect(() => { void load(); }, [id]);

  if (!project) return <div className="p-16 text-center text-[var(--color-dim)]">Loading…</div>;

  const publishToggle = async () => {
    const v = project.visibility === "public" ? "private" : "public";
    const r = await fetch(`/api/projects/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visibility: v }) });
    setProject((await r.json()).project);
  };
  // the PATCH body is capped at 4000 chars server-side too - read the
  // response and show its error text (or a "saved" note), never silent;
  // a dropped connection lands the same explicit note
  const saveInstructions = async () => {
    try {
      const r = await fetch(`/api/projects/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instructions }) });
      const d = PatchErrV.parse(await r.json().catch(() => ({})));
      if (r.ok) { setSavedInstr(instructions); instrDirty.current = false; setInstrNote("saved"); }
      else setInstrNote(`⚠ ${userError(r.status, d.error).message}`);
    } catch {
      setInstrNote("⚠ save failed - server unreachable");
    }
  };
  const toggleFav = async (type: "job" | "upload" | "asset", targetId: string) => {
    const body = JSON.stringify({ target_type: type, target_id: targetId });
    const on = isFav(favs, type, targetId);
    await fetch(`/api/projects/${id}/favs`, { method: on ? "DELETE" : "POST", headers: { "Content-Type": "application/json" }, body });
    load();
  };
  const addFolder = async () => {
    const name = folderName.trim();
    if (!name) return;
    const r = await fetch(`/api/projects/${id}/folders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (r.ok) { setFolderName(""); load(); }
  };
  const deleteFolder = async (folderId: string) => {
    const r = await fetch(`/api/projects/${id}/folders/${folderId}`, { method: "DELETE" });
    if (r.ok) { setPinFilter((f) => (f === folderId ? "all" : f)); load(); }
  };
  // file a pin under a folder ("" = unfiled) - PATCH carries folder_id|null
  const fileFav = async (fav: Fav, folderId: string) => {
    const r = await fetch(`/api/projects/${id}/favs`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_type: fav.target_type, target_id: fav.target_id, folder_id: folderId || null }),
    });
    if (r.ok) {
      setFavs((x) => x.map((f) => f === fav ? { ...f, folder_id: folderId || null } : f));
      load();
    }
  };
  const forget = async (memId: string) => {
    const r = await fetch(`/api/agent/memories/${memId}`, { method: "DELETE" });
    if (r.ok) { load(); setMapTick((t) => t + 1); }
  };
  // upload → @ref: a taken name retries as <slug>-2 … <slug>-9; the tile
  // then shows the @name it got (or the error - never a silent fail)
  const saveAsRef = async (u: Upload) => {
    const base = (u.name ?? "upload").replace(/\.[a-z0-9]+$/i, "")
      .toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "upload";
    const post = (name: string) => fetch("/api/refs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, category: "prop", images: [u.url] }),
    });
    let r = await post(base);
    for (let i = 2; r.status === 409 && i <= 9; i++) r = await post(`${base}-${i}`);
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      setRefNames((x) => ({ ...x, [u.id]: `@${d.ref?.name ?? base}` }));
      load();
    } else {
      const d = await r.json().catch(() => ({}));
      setRefNames((x) => ({ ...x, [u.id]: `⚠ ${userError(r.status, d.error).message}` }));
    }
  };
  const favBtn = (type: "job" | "upload" | "asset", targetId: string) => (
    <button type="button" title={isFav(favs, type, targetId) ? "Unpin" : "Pin to project"}
      data-testid={`fav-${type}-${targetId}`}
      className={`absolute right-1.5 top-1.5 rounded-md px-1.5 py-0.5 text-[11px] backdrop-blur-sm ${isFav(favs, type, targetId) ? "bg-amber-400/80 text-black" : "bg-black/50 text-white/80 hover:bg-black/70"}`}
      onClick={(e) => { e.preventDefault(); toggleFav(type, targetId); }}>
      {isFav(favs, type, targetId) ? "★" : "☆"}
    </button>
  );

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold">{project.title}</h1>
          {project.description && <p className="mt-1 max-w-2xl text-[var(--color-dim)]">{project.description}</p>}
          {owner?.handle && <p className="mt-1 text-sm text-[var(--color-faint)]">by @{owner.handle}</p>}
        </div>
        {mine && (
          <div className="flex gap-2">
            <a className="btn btn-ghost" data-testid="project-new-chat" href={`/ai-assistant?project=${project.id}`}>New chat in this project</a>
            <button className="btn btn-ghost" onClick={publishToggle}>{project.visibility === "public" ? "Unpublish" : "Publish → community"}</button>
            {project.visibility === "public" && owner?.handle && (
              <button className="btn btn-ghost" onClick={() => navigator.clipboard.writeText(`${location.origin}/u/${owner.handle}/projects/${project.slug}`)}>Copy link</button>
            )}
          </div>
        )}
      </div>

      {mine && (
        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          <section className="panel p-4">
            <h2 className="text-sm font-semibold">Project instructions</h2>
            <p className="mt-0.5 text-[11px] text-[var(--color-dim)]">Applied to every planner turn bound to this project.</p>
            <textarea data-testid="project-instructions" maxLength={4000}
              className="mt-2 h-24 w-full resize-y rounded-lg bg-[var(--color-panel2)] p-2.5 text-sm outline-none placeholder:text-[var(--color-dim)]"
              placeholder="e.g. always cut 4s clips, keep captions bold…" value={instructions}
              onChange={(e) => { instrDirty.current = true; setInstructions(e.target.value); setInstrNote(""); }} />
            <button className="btn btn-ghost mt-2" onClick={saveInstructions} data-testid="project-instructions-save">Save</button>
            {/* a fresh note (saved / save failed) beats the dirty hint -
                otherwise a failed save would still read "unsaved changes" */}
            {instrNote
              ? <span data-testid="project-instructions-note" className="ml-2 mt-2 inline-block text-[11px] text-[var(--color-dim)]">{instrNote}</span>
              : instructions !== savedInstr &&
                <span data-testid="project-instructions-note" className="ml-2 mt-2 inline-block text-[11px] text-[var(--color-dim)]">unsaved changes - hit Save</span>}
          </section>
          <section className="panel p-4">
            <h2 className="text-sm font-semibold">Memory map</h2>
            <p className="mt-0.5 text-[11px] text-[var(--color-dim)]">This project's memories and the jobs/uploads/refs they point at.</p>
            <MemoryMap projectId={id} refresh={mapTick} />
          </section>
          <section className="panel p-4">
            <h2 className="text-sm font-semibold">Project memories</h2>
            <div className="mt-2 space-y-1.5">
              {memories.map((m) => (
                <div key={m.id} data-testid={`project-memory-${m.name}`}
                  className="flex items-start gap-2 rounded-lg bg-[var(--color-panel2)] px-3 py-2 text-xs">
                  <div className="min-w-0 flex-1">
                    <span className="font-semibold">{m.name}</span>
                    <span className="ml-1.5 text-[10px] text-[var(--color-dim)]">{m.kind}</span>
                    <div className="mt-0.5 text-[var(--color-dim)]">{m.content}</div>
                    {!!m.links.length && <div className="mt-0.5 text-[10px] text-[var(--color-faint)]">→ {m.links.length} link{m.links.length === 1 ? "" : "s"}</div>}
                  </div>
                  <button title={`forget ${m.name}`} data-testid={`project-memory-forget-${m.name}`}
                    className="text-[var(--color-dim)] hover:text-red-300" onClick={() => forget(m.id)}>×</button>
                </div>
              ))}
              {memories.length === 0 && <div className="text-xs text-[var(--color-dim)]">No memories bound to this project yet.</div>}
            </div>
          </section>
          <section className="panel p-4">
            <h2 className="text-sm font-semibold">Folders</h2>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {folders.map((f) => (
                <span key={f.id} data-testid={`project-folder-${f.name}`}
                  className="flex items-center gap-1 rounded-lg bg-[var(--color-panel2)] px-2.5 py-1 text-xs">
                  {f.name}
                  <button type="button" title={`delete folder ${f.name}`} data-testid={`folder-delete-${f.name}`}
                    className="text-[var(--color-dim)] hover:text-red-300" onClick={() => deleteFolder(f.id)}>×</button>
                </span>
              ))}
              <input className="w-36 rounded-lg bg-[var(--color-panel2)] px-2 py-1 text-xs outline-none placeholder:text-[var(--color-dim)]"
                placeholder="new folder…" value={folderName} data-testid="project-folder-name"
                onChange={(e) => setFolderName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addFolder()} />
              <button className="rounded-lg bg-[var(--color-line)] px-2 py-1 text-xs" onClick={addFolder} data-testid="project-folder-add">Add</button>
            </div>
          </section>
          <section className="panel p-4 lg:col-span-2" data-testid="pinned-section">
            <h2 className="text-sm font-semibold">Pinned</h2>
            <div className="mt-2 flex flex-wrap gap-1.5" data-testid="pin-filters">
              {([["all", `All (${favs.length})`], ["unfiled", `Unfiled (${favs.filter((f) => !f.folder_id).length})`]] as const)
                .map(([v, label]) => (
                <button key={v} type="button" data-testid={`pin-filter-${v}`}
                  className={`rounded-full px-2.5 py-1 text-[11px] ${pinFilter === v ? "bg-[var(--color-panel2)] text-[var(--color-fg)]" : "text-[var(--color-dim)] hover:text-[var(--color-fg)]"}`}
                  onClick={() => setPinFilter(v)}>{label}</button>
              ))}
              {folders.map((f) => (
                <button key={f.id} type="button" data-testid={`pin-filter-${f.name}`}
                  className={`rounded-full px-2.5 py-1 text-[11px] ${pinFilter === f.id ? "bg-[var(--color-panel2)] text-[var(--color-fg)]" : "text-[var(--color-dim)] hover:text-[var(--color-fg)]"}`}
                  onClick={() => setPinFilter(f.id)}>{f.name} ({favs.filter((x) => x.folder_id === f.id).length})</button>
              ))}
            </div>
            {favs.length === 0 ? (
              <div className="mt-2 text-xs text-[var(--color-dim)]">Nothing pinned - ★ a job, upload, or asset below.</div>
            ) : (
              <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-8">
                {favs.filter((f) =>
                  pinFilter === "all" ? true : pinFilter === "unfiled" ? !f.folder_id : f.folder_id === pinFilter
                ).map((f) => {
                  const u = f.target_type === "upload" ? uploads.find((x) => x.id === f.target_id) : undefined;
                  const j = f.target_type === "job" ? jobs.find((x) => x.id === f.target_id) : undefined;
                  const a = f.target_type === "asset" ? items.find((x) => x.id === f.target_id) : undefined;
                  const url = u?.url ?? a?.url ?? (j?.outputs ?? []).find((o) => typeof o?.url === "string")?.url;
                  const img = !!url && (u ? u.mime.startsWith("image/") : a ? a.kind !== "video" && a.kind !== "audio" : j ? j.kind !== "video" && j.kind !== "audio" : false);
                  return (
                    <div key={`${f.target_type}:${f.target_id}`} className="media-tile relative aspect-square"
                      data-testid={`pinned-${f.target_type}-${f.target_id}`}>
                      {img ? <img src={url} alt="pinned item" className="cursor-pointer" onClick={() => setViewer({ url: url!, type: "image" })} /> : <div className="grid h-full place-items-center text-xl">📎</div>}
                      <select data-testid={`pin-folder-${f.target_id}`} title="File under folder"
                        className="absolute bottom-1 left-1 right-1 rounded-md bg-black/60 px-1 py-0.5 text-[10px] text-white/90"
                        value={f.folder_id ?? ""}
                        onChange={(e) => fileFav(f, e.target.value)}>
                        <option value="">Unfiled</option>
                        {folders.map((fo) => <option key={fo.id} value={fo.id}>{fo.name}</option>)}
                      </select>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          {(jobs.length > 0 || uploads.length > 0) && (
            <section className="panel p-4 lg:col-span-2">
              <h2 className="text-sm font-semibold">Project uploads</h2>
              {uploads.length === 0 && <div className="mt-2 text-xs text-[var(--color-dim)]">No uploads - attach files in a chat bound to this project.</div>}
              {uploads.length > 0 && (
                <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-8">
                  {uploads.map((u) => (
                    <div key={u.id} className="media-tile relative aspect-square" data-testid={`project-upload-${u.id}`}>
                      {u.mime.startsWith("image/") ? <img src={u.url} alt={u.name ?? "upload"} className="cursor-pointer" onClick={() => setViewer({ url: u.url, type: "image", label: u.name ?? undefined })} /> : <div className="grid h-full place-items-center text-2xl">📎</div>}
                      {favBtn("upload", u.id)}
                      {u.mime.startsWith("image/") && !refNames[u.id] && (
                        <button title="Save as @ref" data-testid={`upload-to-ref-${u.id}`}
                          className="absolute bottom-1.5 right-1.5 rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] text-white/80 hover:bg-black/70"
                          onClick={() => saveAsRef(u)}>@ref</button>
                      )}
                      {refNames[u.id] && (
                        <span data-testid={`upload-ref-name-${u.id}`}
                          className="absolute bottom-1.5 right-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-white/90">
                          {refNames[u.id]}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <h2 className="mt-5 text-sm font-semibold">Project jobs</h2>
              {jobs.length === 0 && <div className="mt-2 text-xs text-[var(--color-dim)]">No jobs yet - run something with this project selected.</div>}
              {jobs.length > 0 && (
                <div className="mt-2 space-y-1">
                  {jobs.map((j) => {
                    const out = (j.outputs ?? []).find((o) => typeof o?.url === "string");
                    return (
                      <div key={j.id} data-testid={`project-job-${j.id}`}
                        className="flex items-center gap-2 rounded-lg bg-[var(--color-panel2)] px-3 py-2 text-xs">
                        {out?.url && <img src={out.url} alt={j.title ?? "job output"} className="h-8 w-8 cursor-pointer rounded object-cover" onClick={() => setViewer({ url: out.url!, type: j.kind, label: j.title ?? undefined })} />}
                        <div className="min-w-0 flex-1">
                          <span className="font-semibold">{j.title ?? j.endpoint_id}</span>
                          <span className="ml-1.5 text-[10px] text-[var(--color-dim)]">{j.kind} · {j.status}</span>
                        </div>
                        <button title={isFav(favs, "job", j.id) ? "Unpin" : "Pin"} data-testid={`fav-job-${j.id}`}
                          className={isFav(favs, "job", j.id) ? "text-amber-300" : "text-[var(--color-dim)] hover:text-amber-300"}
                          onClick={() => toggleFav("job", j.id)}>{isFav(favs, "job", j.id) ? "★" : "☆"}</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {items.map((a) => (
          <div key={a.id} className="media-tile relative aspect-square cursor-pointer"
            onClick={() => setViewer({ url: a.url, type: a.kind, label: a.prompt ?? undefined })}>
            {a.kind === "video" ? <video src={a.url} muted loop autoPlay playsInline /> : a.kind === "audio" ? <div className="grid h-full place-items-center"><Music size={28} className="text-[var(--color-dim)]" /></div> : <img src={a.url} alt={a.prompt ?? "project asset"} />}
            {mine && favBtn("asset", a.id)}
          </div>
        ))}
      </div>
      {items.length === 0 && <div className="mt-8 rounded-2xl border border-dashed border-[var(--color-border)] p-16 text-center text-[var(--color-dim)]">No assets in this project yet - generate with a project selected, or move assets in.</div>}
      <Lightbox item={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}
