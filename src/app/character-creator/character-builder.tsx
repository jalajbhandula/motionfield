"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import {
  CANDIDATE_ENDPOINT, DESCRIPTION_IDEAS, IDENTITY_SHOTS, MAX_SET, CHARACTER_STYLES, SHOT_ENDPOINT,
  candidatePrompt, refName, shotPrompt, type CharacterDraft,
} from "@/lib/character-builder";
import { ErrNote } from "@/components/ErrNote";
import { ApiError, uploadFile, userError, userErrorFrom, type UserError } from "@/lib/user-error";

type Job = { id: string; status: string; progress: number; error: string | null; outputs: { url: string; type: string }[] };
type Shot = { id: string; label: string; status: "idle" | "running" | "done" | "failed"; url?: string; error?: string; keep: boolean; progress?: number };

const LIVE = new Set(["queued", "in_progress"]);
const FACE_COUNT = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorText(e: unknown, status: number): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "code" in e) return `this model isn't enabled here (${String((e as { code: unknown }).code)})`;
  return `failed (${status})`;
}

/** Submit, waiting out the one-job-at-a-time plan limit instead of failing. */
async function submit(endpoint: string, params: Record<string, unknown>): Promise<Job> {
  for (let tries = 0; ; tries++) {
    const r = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ endpoint_id: endpoint, params }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) return d.job as Job;
    if (r.status === 429 && /concurrency/i.test(String(d.error)) && tries < 200) { await sleep(3000); continue; }
    throw new ApiError(userError(r.status, errorText(d.error, r.status)));
  }
}

async function waitFor(id: string, onTick?: (j: Job) => void): Promise<Job> {
  for (;;) {
    const r = await fetch(`/api/jobs/${id}`);
    if (!r.ok) throw new Error(`lost track of the job (${r.status})`);
    const { job } = (await r.json()) as { job: Job };
    onTick?.(job);
    if (!LIVE.has(job.status)) return job;
    await sleep(1500);
  }
}

async function upload(file: File): Promise<string> {
  return (await uploadFile(file)).url;
}

const freshShots = (): Shot[] => IDENTITY_SHOTS.map((s) => ({ id: s.id, label: s.label, status: "idle", keep: true }));

function Step({ n, title, on, done }: { n: number; title: string; on: boolean; done: boolean }) {
  return (
    <div className={`flex items-center gap-2 text-sm ${on ? "text-[var(--color-text)]" : "text-[var(--color-faint)]"}`}>
      <span className={`grid h-6 w-6 place-items-center rounded-full border text-xs font-semibold ${done ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-black" : on ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"}`}>{done ? "✓" : n}</span>
      {title}
    </div>
  );
}

export default function CharacterBuilder({ authed }: { authed: boolean }) {
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<CharacterDraft>({ description: "", style: "photo", outfit: "" });
  const [fromPhoto, setFromPhoto] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [faceTick, setFaceTick] = useState<{ n: number; progress: number } | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [shots, setShots] = useState<Shot[]>(freshShots);
  const [building, setBuilding] = useState(false);
  const [consent, setConsent] = useState(true);
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState<null | "faces" | "upload" | "save">(null);
  const [error, setError] = useState<UserError | string | null>(null);
  const stop = useRef(false);
  const seed = useRef(Math.floor(Math.random() * 1e9));

  const setShot = (id: string, patch: Partial<Shot>) => setShots((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const kept = [anchor, ...shots.filter((s) => s.status === "done" && s.keep).map((s) => s.url)].filter(Boolean).slice(0, MAX_SET) as string[];
  const anyDone = shots.some((s) => s.status === "done");

  async function faces() {
    if (!draft.description.trim()) { setError("Describe your character first."); return; }
    setBusy("faces"); setError(null); setAnchor(null); setShots(freshShots()); setSaved(null); setCandidates([]);
    try {
      // one face per job so each lands as soon as it's ready - a batch of
      // four at 1K holds every face back for minutes on a laptop GPU
      for (let n = 0; n < FACE_COUNT; n++) {
        seed.current = (seed.current + 7919) % 2147483647;
        setFaceTick({ n, progress: 0 });
        const job = await submit(CANDIDATE_ENDPOINT, { prompt: candidatePrompt(draft), aspect_ratio: "3:4", resolution: "720p", batch_size: 1, steps: 8, seed: seed.current });
        const done = await waitFor(job.id, (j) => setFaceTick({ n, progress: j.progress }));
        const url = done.outputs?.find((o) => o.type === "image")?.url;
        if (done.status !== "completed" || !url) throw new Error(done.error || "generation failed");
        setCandidates((c) => [...c, url]);
      }
    } catch (e) {
      setError(userErrorFrom(e));
    } finally {
      setBusy(null); setFaceTick(null);
    }
  }

  async function usePhoto(file: File) {
    setBusy("upload"); setError(null); setShots(freshShots()); setSaved(null); setCandidates([]);
    try { setAnchor(await upload(file)); setConsent(false); } catch (e) { setError(userErrorFrom(e)); } finally { setBusy(null); }
  }

  async function runShot(id: string) {
    const shot = IDENTITY_SHOTS.find((s) => s.id === id)!;
    setShot(id, { status: "running", error: undefined, progress: 0 });
    try {
      const job = await submit(SHOT_ENDPOINT, { prompt: shotPrompt(draft, shot), image_url: anchor, steps: 4, seed: (seed.current + id.length * 131) % 2147483647 });
      const done = await waitFor(job.id, (j) => setShot(id, { progress: j.progress }));
      const url = done.outputs?.find((o) => o.type === "image")?.url;
      if (done.status !== "completed" || !url) throw new Error(done.error || "no image");
      setShot(id, { status: "done", url });
    } catch (e) {
      setShot(id, { status: "failed", error: (e as Error).message });
    }
  }

  async function buildSet() {
    if (!anchor) return;
    setBuilding(true); stop.current = false; setError(null);
    for (const s of shots) {
      if (stop.current) break;
      if (s.status === "done") continue;
      await runShot(s.id);
    }
    setBuilding(false);
  }

  async function save() {
    if (!anchor) return;
    const slug = refName(name);
    if (!slug) { setError("Give your character a name."); return; }
    if (!consent) { setError(fromPhoto ? "Confirm you have the right to use this person's likeness." : "Confirm the likeness box to save."); return; }
    setBusy("save"); setError(null);
    try {
      const r = await fetch("/api/refs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: slug, category: "character", kind: "person", description: draft.description.trim().slice(0, 500) || undefined, images: kept, likeness_consent: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(userError(r.status, typeof d.error === "string" ? d.error : `save failed (${r.status})`));
      setSaved({ id: d.ref.id, name: d.ref.name });
    } catch (e) {
      setError(userErrorFrom(e));
    } finally {
      setBusy(null);
    }
  }

  const step = saved ? 4 : anyDone ? 4 : anchor ? 3 : candidates.length ? 2 : 1;

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8">
      <h1 className="font-display text-2xl font-bold tracking-tight">Character Creator</h1>
      <p className="mt-1 text-sm text-[var(--color-dim)]">Design a character once, keep them consistent everywhere. Describe them, pick a face, get a matching set of angles, outfits and scenes, and save it as a character.</p>
      {!authed && <p className="panel mt-6 p-4 text-sm"><Link href="/login?next=/character-creator" className="underline">Sign in</Link> to build a character.</p>}

      <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2" data-testid="pb-steps">
        <Step n={1} title="Describe" on={step >= 1} done={step > 1} />
        <Step n={2} title="Pick a face" on={step >= 2} done={step > 2} />
        <Step n={3} title="Identity set" on={step >= 3} done={anyDone} />
        <Step n={4} title="Save" on={step >= 4} done={!!saved} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[400px_minmax(0,1fr)]">
        <section className="panel h-fit space-y-4 p-5">
          <div className="flex gap-1 rounded-lg border border-[var(--color-border)] p-1 text-xs">
            <button className={`flex-1 rounded-md px-2 py-1.5 ${!fromPhoto ? "bg-[var(--color-panel2)] text-[var(--color-text)]" : "text-[var(--color-dim)]"}`} onClick={() => setFromPhoto(false)}>Describe a new person</button>
            <button className={`flex-1 rounded-md px-2 py-1.5 ${fromPhoto ? "bg-[var(--color-panel2)] text-[var(--color-text)]" : "text-[var(--color-dim)]"}`} onClick={() => setFromPhoto(true)} data-testid="pb-from-photo">Start from a photo</button>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-[var(--color-dim)]">Name</span>
            <input className="input w-full" placeholder="e.g. Rosa Vale" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} data-testid="pb-name" />
            {refName(name) && <span className="mt-1 block text-[11px] text-[var(--color-faint)]">Saved as @{refName(name)}</span>}
          </label>

          {!fromPhoto ? (
            <>
              <label className="block">
                <span className="mb-1 flex items-center justify-between text-xs font-semibold uppercase text-[var(--color-dim)]">
                  Who are they?
                  <button type="button" className="text-[11px] font-normal normal-case text-[var(--color-accent)] hover:underline"
                    onClick={() => setDraft((d) => ({ ...d, description: DESCRIPTION_IDEAS[(DESCRIPTION_IDEAS.indexOf(d.description) + 1) % DESCRIPTION_IDEAS.length] }))}>Give me an idea</button>
                </span>
                <textarea className="input min-h-24 w-full" maxLength={600} data-testid="pb-description"
                  placeholder="Age, face, hair, eyes, skin, anything distinctive - e.g. a woman in her thirties with a sharp bob, dark brown eyes and a small scar on her chin"
                  value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
              </label>
              <div>
                <span className="mb-1 block text-xs font-semibold uppercase text-[var(--color-dim)]">Style</span>
                <div className="flex flex-wrap gap-1" data-testid="pb-styles">
                  {CHARACTER_STYLES.map((s) => (
                    <button key={s.id} className={`chip !px-2.5 !py-1 text-xs ${draft.style === s.id ? "chip-on" : ""}`} aria-pressed={draft.style === s.id}
                      onClick={() => setDraft((d) => ({ ...d, style: s.id }))}>{s.label}</button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <label className={`flex cursor-pointer flex-col items-center gap-1 rounded-xl border border-dashed border-[var(--color-border)] p-5 text-center text-sm ${!authed ? "pointer-events-none opacity-50" : "hover:border-[var(--color-accent)]"}`}>
              {busy === "upload" ? "Uploading…" : anchor ? "Replace photo" : "Upload a clear, front-facing photo"}
              <span className="text-[11px] text-[var(--color-faint)]">You&apos;ll confirm you have the right to use this likeness before saving.</span>
              <input type="file" accept="image/*" className="hidden" data-testid="pb-photo" disabled={!authed}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) usePhoto(f); e.target.value = ""; }} />
            </label>
          )}

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-[var(--color-dim)]">Signature outfit <span className="font-normal normal-case text-[var(--color-faint)]">(optional)</span></span>
            <input className="input w-full" maxLength={160} placeholder="e.g. a mustard wool coat over a black turtleneck" value={draft.outfit}
              onChange={(e) => setDraft((d) => ({ ...d, outfit: e.target.value }))} />
          </label>

          {!fromPhoto && (
            <button className="btn btn-primary w-full" disabled={!authed || busy === "faces" || building} onClick={faces} data-testid="pb-faces">
              {faceTick ? `Generating face ${faceTick.n + 1} of ${FACE_COUNT}… ${faceTick.progress}%` : candidates.length ? `Try ${FACE_COUNT} new faces` : `Generate ${FACE_COUNT} faces`}
            </button>
          )}
          <ErrNote err={error} />
          <p className="text-[11px] text-[var(--color-faint)]">Faces: Z-Image Turbo. Identity set: FLUX.2 klein 4B edits from the face you pick. Both Apache-2.0, running on your machine.</p>
        </section>

        <main className="min-w-0 space-y-5">
          {!fromPhoto && (candidates.length > 0 || busy === "faces") && (
            <section aria-label="Pick a face">
              <h2 className="mb-2 text-sm font-semibold">Pick a face</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="pb-candidates">
                {candidates.map((u) => (
                    <button key={u} onClick={() => { setAnchor(u); setShots(freshShots()); setSaved(null); }} aria-pressed={anchor === u}
                      className={`media-tile aspect-[3/4] ring-offset-2 ring-offset-[var(--color-bg)] ${anchor === u ? "ring-2 ring-[var(--color-accent)]" : "opacity-90 hover:opacity-100"}`}>
                      <img src={u} alt="Candidate face" className="h-full w-full object-cover" />
                    </button>
                  ))}
                {busy === "faces" && Array.from({ length: FACE_COUNT - candidates.length }, (_, i) => <div key={i} className="media-tile aspect-[3/4] animate-pulse" />)}
              </div>
            </section>
          )}

          {anchor && (
            <section aria-label="Identity set" data-testid="pb-set">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold">Identity set</h2>
                <span className="text-xs text-[var(--color-dim)]">{kept.length} of {MAX_SET} images kept · click a shot to leave it out</span>
                <span className="ml-auto flex gap-2">
                  {building
                    ? <button className="btn btn-ghost btn-sm" onClick={() => { stop.current = true; }}>Stop after this shot</button>
                    : <button className="btn btn-sm" onClick={buildSet} data-testid="pb-build" disabled={!authed || busy === "faces"}>{anyDone ? "Fill in missing shots" : `Build the set · ${IDENTITY_SHOTS.length} shots`}</button>}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3 md:grid-cols-5">
                <figure className="media-tile relative aspect-[3/4] ring-2 ring-[var(--color-accent)]">
                  <img src={anchor} alt="Front" className="h-full w-full object-cover" />
                  <figcaption className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">Front · anchor</figcaption>
                </figure>
                {shots.map((s) => (
                  <div key={s.id} className="relative" data-testid={`pb-shot-${s.id}`} data-status={s.status}>
                    <button className={`media-tile block aspect-[3/4] w-full ${s.status === "done" && !s.keep ? "opacity-30" : ""}`}
                      disabled={s.status !== "done"} onClick={() => setShot(s.id, { keep: !s.keep })} aria-pressed={s.keep} title={s.status === "done" ? (s.keep ? "Leave out of the set" : "Keep in the set") : undefined}>
                      {s.url ? <img src={s.url} alt={s.label} className="h-full w-full object-cover" />
                        : <span className="grid h-full place-items-center px-2 text-center text-[11px] text-[var(--color-dim)]">
                          {s.status === "running" ? `Shooting… ${s.progress ?? 0}%` : s.status === "failed" ? `Failed - ${s.error}` : "Waiting"}
                        </span>}
                    </button>
                    <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{s.label}</span>
                    {(s.status === "done" || s.status === "failed") && !building && (
                      <button className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-xs text-white hover:bg-black/80" title="Reshoot" aria-label={`Reshoot ${s.label}`}
                        onClick={async () => { setBuilding(true); await runShot(s.id); setBuilding(false); }}>↻</button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {anchor && (
            <section className="panel space-y-3 p-4" aria-label="Save character">
              {saved ? (
                <div className="space-y-3" data-testid="pb-saved">
                  <p className="text-sm">Saved <b>@{saved.name}</b> with {kept.length} images. Use it anywhere a character reference is taken.</p>
                  <div className="flex flex-wrap gap-2">
                    <Link className="btn btn-primary btn-sm" href="/ai-assistant">Ask the AI assistant with @{saved.name}</Link>
                    <Link className="btn btn-ghost btn-sm" href="/characters">All characters</Link>
                  </div>
                </div>
              ) : (
                <>
                  <label className="flex items-start gap-2 text-xs text-[var(--color-dim)]">
                    <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 accent-[var(--color-accent)]" data-testid="pb-consent" />
                    <span>{fromPhoto ? "I have the right to use this person's likeness." : "This is a generated person - or, if they resemble someone real, I have the right to use that likeness."}</span>
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <button className="btn btn-primary" disabled={!authed || busy === "save" || building} onClick={save} data-testid="pb-save">
                      {busy === "save" ? "Saving…" : `Save character · ${kept.length} image${kept.length === 1 ? "" : "s"}`}
                    </button>
                    {!anyDone && <span className="text-xs text-[var(--color-faint)]">Tip: build the set first - more angles mean steadier identity.</span>}
                  </div>
                </>
              )}
            </section>
          )}

          {!anchor && !candidates.length && busy !== "faces" && (
            <div className="grid min-h-80 place-items-center rounded-2xl border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-dim)]">
              {fromPhoto ? "Upload a photo to anchor the character." : `Describe someone and generate ${FACE_COUNT} faces to choose from.`}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
