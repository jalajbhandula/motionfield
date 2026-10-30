"use client";
import { useEffect, useState } from "react";
import { Lightbox, type LightboxItem } from "@/components/Lightbox";
import { ErrNote } from "@/components/ErrNote";
import { uploadFile as uploadShared, userError, userErrorFrom, type UserError } from "@/lib/user-error";

type Character = { id: string; name: string; images: string[] };
type Job = { id: string; status: string; progress: number; error?: string | null; outputs?: { url: string; type: string }[] };

async function uploadFile(file: File): Promise<string> {
  return (await uploadShared(file)).url;
}

export default function CharacterStudio() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [refs, setRefs] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState<UserError | string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [viewer, setViewer] = useState<LightboxItem | null>(null);

  useEffect(() => {
    fetch("/api/refs?category=character").then((r) => r.json()).then((d) => {
      const list = (d.refs ?? []) as Character[];
      setCharacters(list);
      // ?character=<id> - arriving from Character Builder preselects the new character
      const want = new URLSearchParams(window.location.search).get("character");
      if (want && list.some((p) => p.id === want)) setSelectedId(want);
    }).catch(() => {});
  }, []);

  const active = characters.find((p) => p.id === selectedId);
  const refsForRun = active ? active.images.slice(0, 3) : refs.slice(0, 3);

  async function saveCharacter() {
    if (!name.trim() || !refs.length) { setMsg("Give the character a name and at least one reference image."); return; }
    const r = await fetch("/api/refs", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), category: "character", kind: "person", images: refs.slice(0, 10), likeness_consent: consent }) });
    const d = await r.json();
    if (!r.ok) { setMsg(userError(r.status, d.error)); return; }
    setCharacters((p) => [d.ref as Character, ...p]);
    setSelectedId(d.ref.id); setMsg(null);
  }

  async function generate() {
    if (!refsForRun.length) { setMsg("Pick a saved character or upload a reference image."); return; }
    if (!prompt.trim()) { setMsg("Describe the shot - scene, outfit, mood."); return; }
    setBusy(true); setMsg(null);
    const r = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint_id: "motionfield/character/generate", params: {
        prompt: prompt.trim(), image_urls: refsForRun, aspect_ratio: "3:4", resolution: "480p", batch_size: 2, steps: 12,
      } }) });
    const d = await r.json();
    if (!r.ok) { setMsg(userError(r.status, d.error)); setBusy(false); return; }
    let job = d.job;
    setJobs((j) => [job, ...j]);
    while (["queued", "in_progress"].includes(job.status)) {
      await new Promise((x) => setTimeout(x, 2000));
      job = (await (await fetch(`/api/jobs/${job.id}`)).json()).job;
      setJobs((j) => j.map((x) => (x.id === job.id ? job : x)));
    }
    setBusy(false);
    if (job.status !== "completed") setMsg(job.error ?? job.status);
  }

  return (
    <div className="mx-auto grid max-w-[1400px] gap-8 px-4 py-10 lg:grid-cols-[400px_1fr]">
      <div className="space-y-4">
        <div className="panel h-fit space-y-4 p-5">
          <div className="flex items-center justify-between">
            <h1 className="font-display text-xl font-bold">Character Studio</h1>
            <span className="chip text-[10px]">no training</span>
          </div>
          <p className="text-xs text-[var(--color-dim)]">1-3 reference photos become a saved character. Prompt it into new scenes, outfits and lighting - no model training involved.</p>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-[var(--color-dim)]">Saved characters</label>
            {characters.length === 0 && <p className="text-xs text-[var(--color-faint)]">None yet - upload references below and save.</p>}
            <div className="flex flex-wrap gap-1">
              {characters.map((p) => (
                <button key={p.id} onClick={() => setSelectedId(selectedId === p.id ? "" : p.id)}
                  className={`chip !px-2 !py-1 text-[11px] ${selectedId === p.id ? "chip-on" : ""}`}>
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          {!active && (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase text-[var(--color-dim)]">Reference photos (up to 3)</label>
                <label className="mb-2 flex cursor-pointer items-start gap-2 text-xs text-[var(--color-dim)]">
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 accent-[var(--color-accent)]" />
                  <span>I have the right to use this person&apos;s likeness</span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {refs.map((u, i) => (
                    <div key={i} className="relative media-tile h-16 w-16">
                      <img src={u} alt={`reference ${i + 1}`} className="cursor-pointer" onClick={() => setViewer({ url: u, type: "image" })} />
                      <button onClick={() => setRefs((r) => r.filter((_, j) => j !== i))}
                        className="absolute right-0.5 top-0.5 h-4 w-4 rounded-full bg-black/70 text-[10px] text-white">×</button>
                    </div>
                  ))}
                  {refs.length < 3 && (
                    <label title={consent ? undefined : "Tick the consent box first"} className={`grid h-16 w-16 place-items-center rounded-xl border border-dashed border-[var(--color-border)] text-xl ${!consent ? "cursor-not-allowed opacity-40" : "cursor-pointer text-[var(--color-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"}`}>
                      {uploading ? "…" : "+"}
                      <input type="file" accept="image/*" multiple className="hidden" disabled={uploading || !consent}
                        onChange={async (e) => {
                          const files = Array.from(e.target.files ?? []);
                          if (!files.length) return;
                          setUploading(true);
                          try {
                            const urls = await Promise.all(files.map(uploadFile));
                            setRefs((r) => [...r, ...urls].slice(0, 3));
                          } catch (err) {
                            setMsg(userErrorFrom(err));
                          } finally { setUploading(false); e.target.value = ""; }
                        }} />
                    </label>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <input className="input" placeholder="Character name" value={name} onChange={(e) => setName(e.target.value)} />
                <button className="btn btn-ghost whitespace-nowrap" disabled={refs.length > 0 && !consent} onClick={saveCharacter}>Save character</button>
              </div>
            </div>
          )}
          {active && (
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase text-[var(--color-dim)]">References · {active.name}</label>
              <div className="flex flex-wrap gap-2">
                {active.images.slice(0, 3).map((u, i) => (
                  <div key={i} className="media-tile h-16 w-16 cursor-pointer" onClick={() => setViewer({ url: u, type: "image" })}><img src={u} alt={`${active.name} reference ${i + 1}`} /></div>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-[var(--color-dim)]">Prompt</label>
            <textarea className="input min-h-20" placeholder="e.g. at a rooftop café at golden hour, linen shirt, soft bokeh"
              value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </div>

          <ErrNote err={msg} />
          <button className="btn btn-primary w-full" onClick={generate} disabled={busy}>{busy ? "Generating…" : "Generate · 2 shots"}</button>
          <p className="text-[11px] text-[var(--color-faint)]">Local path: Wan VACE reference conditioning - no training, no LoRA. For best identity keep refs near portrait aspect and lead with the clearest face shot. A multi-reference Qwen-Image-Edit path is marked cloud-recommended in the catalog.</p>
        </div>
      </div>
      <div>
        <div className="grid grid-cols-2 gap-3">
          {jobs.flatMap((j) => (j.outputs ?? []).filter((o) => o.type === "image").map((o, i) => (
            <div key={`${j.id}-${i}`} className="media-tile aspect-[3/4] cursor-pointer" onClick={() => setViewer({ url: o.url, type: "image", label: prompt || undefined })}>
              <img src={o.url} alt="character shot" />
              <div className="hover-ui p-2 flex items-end justify-end">
                <a className="btn btn-sm bg-black/60" href={o.url} download>Save</a>
              </div>
            </div>
          )))}
          {jobs.filter((j) => j.status === "queued" || j.status === "in_progress").map((j) => (
            <div key={j.id} className="media-tile aspect-[3/4] grid place-items-center">
              <p className="text-xs text-[var(--color-dim)]">Generating… {j.progress ? `${j.progress}%` : ""}</p>
            </div>
          ))}
        </div>
        {jobs.length === 0 && <div className="grid min-h-96 place-items-center rounded-2xl border border-dashed border-[var(--color-border)] text-[var(--color-dim)]">Pick a character → write a prompt → shots appear here.</div>}
      </div>
      <Lightbox item={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}
