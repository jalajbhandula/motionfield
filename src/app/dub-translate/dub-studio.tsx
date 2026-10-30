"use client";
import Link from "next/link";
import { useState } from "react";
import { PageExamples } from "@/components/ExampleCard";
import { DUB_ENDPOINT, DUB_LANGUAGES, DUB_MAX_SECONDS } from "@/lib/dub";
import { ErrNote } from "@/components/ErrNote";
import { ApiError, uploadFile, userError, userErrorFrom, type UserError } from "@/lib/user-error";

type Job = { id: string; status: string; progress: number; error: string | null; outputs: { url: string; type: string }[] };

const LIVE = new Set(["queued", "in_progress"]);
const NATIVE: Record<string, string> = { es: "Español", fr: "Français", it: "Italiano", pt: "Português", hi: "हिन्दी", ja: "日本語", zh: "中文" };

function errorText(e: unknown, status: number): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "code" in e) return `this pipeline isn't enabled here (${String((e as { code: unknown }).code)})`;
  return `failed (${status})`;
}

export default function DubStudio({ authed }: { authed: boolean }) {
  const [video, setVideo] = useState<{ url: string; name: string; seconds: number } | null>(null);
  const [language, setLanguage] = useState("es");
  const [voice, setVoice] = useState<"auto" | "female" | "male">("auto");
  const [lipsync, setLipsync] = useState(true);
  const [bed, setBed] = useState(0);
  const [consent, setConsent] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState<null | "upload" | "dub">(null);
  const [error, setError] = useState<UserError | string | null>(null);

  async function pick(file: File) {
    setBusy("upload"); setError(null); setJob(null);
    try {
      const seconds = await new Promise<number>((res) => {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.onloadedmetadata = () => { res(v.duration); URL.revokeObjectURL(v.src); };
        v.onerror = () => res(0);
        v.src = URL.createObjectURL(file);
      });
      if (seconds > DUB_MAX_SECONDS + 0.5) throw new Error(`Clips up to ${DUB_MAX_SECONDS / 60} minutes - this one is ${Math.round(seconds)}s.`);
      const d = await uploadFile(file);
      setVideo({ url: d.url, name: file.name, seconds });
    } catch (e) {
      setError(userErrorFrom(e));
    } finally {
      setBusy(null);
    }
  }

  async function dub() {
    if (!video || busy) return;
    if (!consent) { setError("Confirm you have the right to use this person's voice and likeness."); return; }
    setBusy("dub"); setError(null); setJob(null);
    try {
      const r = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ endpoint_id: DUB_ENDPOINT, params: { video_url: video.url, language, voice, lipsync, original_volume: bed, likeness_consent: true } }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(userError(r.status, errorText(d.error, r.status)));
      let j = d.job as Job;
      setJob(j);
      while (LIVE.has(j.status)) {
        await new Promise((res) => setTimeout(res, 2000));
        const pr = await fetch(`/api/jobs/${j.id}`);
        if (!pr.ok) throw new Error(`lost track of the job (${pr.status})`);
        j = (await pr.json()).job as Job;
        setJob(j);
      }
      if (j.status !== "completed") setError(j.error || `dub ${j.status}`);
    } catch (e) {
      setError(userErrorFrom(e));
    } finally {
      setBusy(null);
    }
  }

  const out = job?.outputs?.find((o) => o.type === "video");
  // Finishing changes the displayed video's path; subtitle sidecars belong
  // to the original dub render, which remains among the raw outputs.
  const subtitleSource = job?.outputs?.find((o) => o.type === "video"
    && o.url.startsWith("/files/generated/dub/") && o.url.endsWith(".mp4"));
  const lang = DUB_LANGUAGES.find((l) => l.id === language)!;
  const stage = !job ? "" : job.progress < 8 ? "Listening" : job.progress < 12 ? "Learning the voice" : job.progress < 15 ? "Translating"
    : job.progress < 57 ? "Voicing each line" : job.progress < 62 ? "Fitting the timing" : job.progress < 93 ? (lipsync ? "Re-syncing the lips" : "Mixing") : "Finishing";

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8">
      <h1 className="font-display text-2xl font-bold tracking-tight">Dub & Translate</h1>
      <p className="mt-1 text-sm text-[var(--color-dim)]">Your clip in another language, in the same voice, with the lips re-synced. Upload an English talking clip, pick a language, and get the dubbed video plus subtitles.</p>
      <PageExamples />
      {!authed && <p className="panel mt-6 p-4 text-sm"><Link href="/login?next=/dub-translate" className="underline">Sign in</Link> to dub a clip.</p>}

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <main className="min-w-0 space-y-4">
          {!video ? (
            <label className={`panel flex aspect-video cursor-pointer flex-col items-center justify-center gap-2 border-dashed text-center ${!authed ? "pointer-events-none opacity-50" : "hover:border-[var(--color-accent)]"}`}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) pick(f); }}>
              <span className="font-display text-lg font-semibold">{busy === "upload" ? "Uploading…" : "Drop a talking clip"}</span>
              <span className="text-sm text-[var(--color-dim)]">English speech · one main speaker · face visible · up to {DUB_MAX_SECONDS / 60} minutes</span>
              <input type="file" accept="video/*" className="hidden" data-testid="dub-source" disabled={!authed}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ""; }} />
            </label>
          ) : (
            <div className={`grid gap-3 ${out ? "md:grid-cols-2" : ""}`}>
              <figure>
                <video src={video.url} controls playsInline className="max-h-[62vh] w-full rounded-2xl border border-[var(--color-border)] bg-black object-contain" />
                <figcaption className="mt-1 flex items-center gap-2 text-xs text-[var(--color-dim)]">
                  Original · English · {Math.round(video.seconds)}s
                  <button className="ml-auto underline" onClick={() => { setVideo(null); setJob(null); }}>Change clip</button>
                </figcaption>
              </figure>
              {out && (
                <figure data-testid="dub-result">
                  <video src={out.url} controls playsInline className="max-h-[62vh] w-full rounded-2xl border border-[var(--color-accent)] bg-black object-contain" />
                  <figcaption className="mt-1 flex items-center gap-2 text-xs text-[var(--color-dim)]">
                    Dubbed · {lang.label}
                    <a className="ml-auto underline" href={out.url} download data-testid="dub-download">Video</a>
                    {subtitleSource && <a className="underline" href={subtitleSource.url.replace(/\.mp4$/, ".srt")} download>Subtitles (.srt)</a>}
                  </figcaption>
                </figure>
              )}
            </div>
          )}

          {job && LIVE.has(job.status) && (
            <div className="panel p-4" data-testid="dub-progress">
              <div className="flex justify-between text-sm"><span>{stage}…</span><span className="tabular-nums text-[var(--color-dim)]">{job.progress}%</span></div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-panel2)]"><div className="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${Math.max(3, job.progress)}%` }} /></div>
              <p className="mt-2 text-[11px] text-[var(--color-faint)]">Runs on your machine. Lip-sync is the slow part - a 30-second clip takes a few minutes.</p>
            </div>
          )}
        </main>

        <aside className="panel h-fit space-y-4 p-5">
          <div>
            <div className="mb-2 text-xs font-semibold uppercase text-[var(--color-dim)]">Dub into</div>
            <div className="grid grid-cols-2 gap-1.5" data-testid="dub-languages">
              {DUB_LANGUAGES.map((l) => (
                <button key={l.id} aria-pressed={language === l.id} onClick={() => setLanguage(l.id)} data-testid={`dub-lang-${l.id}`}
                  className={`rounded-lg border px-2.5 py-2 text-left ${language === l.id ? "border-[var(--color-accent)]" : "border-[var(--color-border)] hover:border-[#3a3a42]"}`}>
                  <div className="text-sm">{NATIVE[l.id]}</div>
                  <div className="text-[11px] text-[var(--color-dim)]">{l.label}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-[var(--color-dim)]">Base voice</div>
            <div className="flex gap-1 rounded-lg border border-[var(--color-border)] p-1 text-xs">
              {(["auto", "female", "male"] as const).map((v) => (
                <button key={v} onClick={() => setVoice(v)} aria-pressed={voice === v}
                  className={`flex-1 rounded-md px-2 py-1.5 capitalize ${voice === v ? "bg-[var(--color-panel2)] text-[var(--color-text)]" : "text-[var(--color-dim)]"}`}>
                  {v === "auto" ? "Match speaker" : v === "female" ? "Higher" : "Lower"}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-[var(--color-faint)]">A native {lang.label} voice speaks each line, then it&apos;s converted to the speaker&apos;s own timbre.</p>
          </div>

          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Re-sync lips<span className="block text-[11px] text-[var(--color-faint)]">MuseTalk - off is much faster</span></span>
            <input type="checkbox" checked={lipsync} onChange={(e) => setLipsync(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" data-testid="dub-lipsync" />
          </label>

          <label className="block text-xs text-[var(--color-dim)]">
            <span className="mb-1 flex justify-between"><span>Keep original audio underneath</span><span className="tabular-nums">{bed ? `${Math.round(bed * 100)}%` : "off"}</span></span>
            <input type="range" min={0} max={0.5} step={0.05} value={bed} onChange={(e) => setBed(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" />
          </label>

          <label className="flex items-start gap-2 text-xs text-[var(--color-dim)]">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 accent-[var(--color-accent)]" data-testid="dub-consent" />
            <span>I have the right to use this person&apos;s voice and likeness. Cloned speech is watermarked where supported.</span>
          </label>

          <button className="btn btn-primary w-full" disabled={!authed || !video || busy === "dub"} onClick={dub} data-testid="dub-go">
            {busy === "dub" ? "Dubbing…" : `Dub into ${lang.label}`}
          </button>
          <ErrNote err={error} />
          <p className="text-[11px] text-[var(--color-faint)]">whisper.cpp listens, your local LLM translates, Kokoro speaks, Chatterbox matches the voice, MuseTalk moves the lips. All open weights, all on your machine.</p>
        </aside>
      </div>
    </div>
  );
}
