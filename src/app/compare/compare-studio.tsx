"use client";
import Link from "next/link";
import { userError } from "@/lib/user-error";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { UploadInput } from "@/components/fields";
import {
  COMPARE_MODES, MAX_COMPARE, commonAspects, compareParams, type CompareCandidate, type CompareMode, type CompareShared,
} from "@/lib/compare";

type Job = {
  id: string; status: string; progress: number; error: string | null; endpointId: string;
  outputs: { assetId: string; type: string; url: string }[];
  prompt: string | null; params: Record<string, unknown>; costCredits: string;
  createdAt: string; startedAt: string | null; completedAt: string | null;
};

/** pending = not submitted yet: plans cap active jobs (free = 1), so a run
 *  submits one model at a time and the next goes in when the last settles */
type Cell = { candidate: CompareCandidate | null; endpointId: string; job: Job | null; error: string | null; pending?: boolean };

const LIVE = new Set(["queued", "in_progress"]);
const STATUS: Record<string, string> = {
  queued: "Waiting for the GPU", in_progress: "Generating", completed: "Done", failed: "Failed", nsfw: "Moderated", canceled: "Canceled",
};

/** job errors are strings, except the licence gate's {code, license, enable_at} */
function errorText(e: unknown, status: number): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "license" in e) return `${String((e as { license: unknown }).license)} licence is opt-in - enable it under Licences`;
  return `failed (${status})`;
}

function newSeed() { return Math.floor(Math.random() * 2_000_000_000); }

function seconds(j: Job): string | null {
  if (!j.completedAt) return null;
  const from = Date.parse(j.startedAt ?? j.createdAt);
  const ms = Date.parse(j.completedAt) - from;
  return Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(1)} s` : null;
}

function studioHref(c: CompareCandidate, prompt: string) {
  const page = c.kind === "video" ? "/ai/video" : "/ai/image";
  return `${page}?model=${encodeURIComponent(c.modelId)}&flow=${encodeURIComponent(c.workflowId)}&recreate=${encodeURIComponent(prompt)}`;
}

export default function CompareStudio({ candidates, authed }: { candidates: Record<CompareMode, CompareCandidate[]>; authed: boolean }) {
  const router = useRouter();
  const sp = useSearchParams();
  const byEndpoint = useMemo(() => {
    const m = new Map<string, CompareCandidate>();
    for (const list of Object.values(candidates)) for (const c of list) m.set(c.id, c);
    return m;
  }, [candidates]);

  const [mode, setMode] = useState<CompareMode>("image");
  const list = candidates[mode];
  const [picked, setPicked] = useState<string[]>(() => defaults(candidates.image));
  const [prompt, setPrompt] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [seed, setSeed] = useState<number>(newSeed);
  const [aspect, setAspect] = useState<string>("");
  const [cells, setCells] = useState<Cell[]>([]);
  const [runPrompt, setRunPrompt] = useState("");
  const [winner, setWinner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const polling = useRef<Set<string>>(new Set());

  const chosen = list.filter((c) => picked.includes(c.id));
  // real example outputs for the empty state: the picked models first, max three
  const samples = [...chosen, ...list.filter((c) => !picked.includes(c.id))].filter((c) => c.thumb).slice(0, 3);
  const aspects = commonAspects(chosen);
  const needsImage = (COMPARE_MODES[mode].inputs as readonly string[]).includes("image_url");

  function defaults(cs: CompareCandidate[]) {
    // light, open-licence models first - heavy or opt-in ones are one click away
    const ok = cs.filter((c) => !c.unavailable);
    const easy = ok.filter((c) => !c.heavy && c.license !== "restricted");
    return (easy.length >= 2 ? easy : ok).slice(0, 3).map((c) => c.id);
  }

  function switchMode(m: CompareMode) {
    setMode(m);
    setPicked(defaults(candidates[m]));
    setAspect("");
  }

  function toggle(id: string) {
    if (list.find((c) => c.id === id)?.unavailable) return;
    setPicked((p) => p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_COMPARE ? p : [...p, id]);
  }

  const run = useRef<{ token: number; shared: CompareShared; ids: string[] } | null>(null);

  function poll(id: string, onSettled?: () => void) {
    if (polling.current.has(id)) return;
    polling.current.add(id);
    const tick = async () => {
      try {
        const r = await fetch(`/api/jobs/${id}`);
        if (!r.ok) { polling.current.delete(id); onSettled?.(); return; }
        const { job } = (await r.json()) as { job: Job };
        setCells((cs) => cs.map((c) => (c.job?.id === id ? { ...c, job } : c)));
        if (LIVE.has(job.status)) setTimeout(tick, 1500);
        else { polling.current.delete(id); onSettled?.(); }
      } catch {
        setTimeout(tick, 3000);
      }
    };
    tick();
  }

  // ?jobs=a,b,c restores a run (refresh-safe, and the URL is the run's record)
  useEffect(() => {
    const ids = (sp.get("jobs") ?? "").split(",").filter((x) => /^[\w-]{8,64}$/.test(x)).slice(0, MAX_COMPARE);
    if (!ids.length || cells.length) return;
    (async () => {
      const loaded: Cell[] = [];
      for (const id of ids) {
        const r = await fetch(`/api/jobs/${id}`).catch(() => null);
        if (!r?.ok) continue;
        const { job } = (await r.json()) as { job: Job };
        loaded.push({ candidate: byEndpoint.get(job.endpointId) ?? null, endpointId: job.endpointId, job, error: null });
      }
      if (!loaded.length) return;
      setCells(loaded);
      setRunPrompt(loaded[0].job?.prompt ?? "");
      setWinner(sp.get("winner"));
      loaded.forEach((c) => c.job && LIVE.has(c.job.status) && poll(c.job.id));
    })();
  }, []);

  /** submit the run's next pending model; called again whenever one settles */
  async function submitNext(token: number, slot: number) {
    const r0 = run.current;
    if (!r0 || r0.token !== token || slot >= cellsRef.current.length) { setBusy(false); return; }
    const cell = cellsRef.current[slot];
    const c = cell.candidate!;
    const r = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ endpoint_id: c.id, params: compareParams(c, r0.shared) }),
    }).catch(() => null);
    if (run.current?.token !== token) return;
    const d = r ? await r.json().catch(() => ({})) : {};
    if (r?.status === 401) { router.push("/login?next=/compare"); return; }
    // another job of yours (maybe from a studio) holds the slot - wait for it
    if (r?.status === 429 && /concurrency/i.test(String(d.error))) { setTimeout(() => submitNext(token, slot), 3000); return; }
    if (r?.ok && d.job) {
      const job: Job = { ...d.job, endpointId: c.id };
      setCell(slot, { job, pending: false });
      r0.ids.push(job.id);
      router.replace(`/compare?jobs=${r0.ids.join(",")}`, { scroll: false });
      poll(job.id, () => submitNext(token, slot + 1));
    } else {
      setCell(slot, { error: r ? userError(r.status, errorText(d.error, r.status)).message : "Couldn't reach the server - check your connection.", pending: false });
      submitNext(token, slot + 1);
    }
  }

  const cellsRef = useRef<Cell[]>([]);
  cellsRef.current = cells;
  function setCell(slot: number, patch: Partial<Cell>) {
    setCells((cs) => {
      const next = cs.map((c, i) => (i === slot ? { ...c, ...patch } : c));
      cellsRef.current = next;
      return next;
    });
  }

  function start() {
    if (busy || chosen.length < 2 || prompt.trim().length < 2) return;
    if (needsImage && !image) { setError("Add an image first."); return; }
    setBusy(true); setError(null); setWinner(null);
    const token = Date.now();
    run.current = { token, shared: { prompt: prompt.trim(), image_url: image, seed, aspect_ratio: aspect || null }, ids: [] };
    const fresh: Cell[] = chosen.map((c) => ({ candidate: c, endpointId: c.id, job: null, error: null, pending: true }));
    cellsRef.current = fresh;
    setCells(fresh);
    setRunPrompt(prompt.trim());
    submitNext(token, 0);
  }

  function pick(id: string) {
    setWinner(id);
    const ids = cells.flatMap((c) => (c.job ? [c.job.id] : []));
    router.replace(`/compare?jobs=${ids.join(",")}&winner=${id}`, { scroll: false });
  }

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-8">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Compare models</h1>
        <p className="mt-1 text-sm text-[var(--color-dim)]">One prompt, up to four models, side by side. Pick the winner and keep going in the studio.</p>
        <ol className="mt-4 flex flex-wrap items-center gap-2 text-sm" data-testid="compare-steps">
          {["Write a prompt", `Pick up to ${MAX_COMPARE} models`, "Compare results side by side"].map((t, i) => (
            <li key={t} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden className="text-[var(--color-faint)]">→</span>}
              <span className="flex items-center gap-2 rounded-full border border-[var(--color-border)] px-3 py-1">
                <span className="grid h-5 w-5 place-items-center rounded-full bg-[var(--color-panel2)] text-[11px] font-semibold">{i + 1}</span>
                {t}
              </span>
            </li>
          ))}
        </ol>
      </div>

      {!authed && (
        <p className="panel mt-6 p-4 text-sm"><Link href="/login?next=/compare" className="underline">Sign in</Link> to run a comparison.</p>
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-[380px_minmax(0,1fr)]">
        <aside className="space-y-5">
          <section className="panel space-y-4 p-4" aria-label="Comparison setup">
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="What to compare">
              {(Object.keys(COMPARE_MODES) as CompareMode[]).map((m) => (
                <button key={m} role="radio" aria-checked={mode === m} data-testid={`compare-mode-${m}`}
                  disabled={candidates[m].length < 2}
                  className={`chip ${mode === m ? "chip-on" : ""} disabled:opacity-40`} onClick={() => switchMode(m)}>
                  {COMPARE_MODES[m].label}
                </button>
              ))}
            </div>

            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--color-dim)]">Prompt</span>
              <textarea className="input min-h-28 w-full resize-y" data-testid="compare-prompt"
                placeholder={mode === "edit" ? "What should change? e.g. \"turn it into a rainy night\"" : "e.g. a lighthouse on a cliff at dusk, cinematic, 35mm"}
                value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </label>

            {needsImage && (
              <div>
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--color-dim)]">Image</span>
                <UploadInput value={image} onChange={(v) => setImage(typeof v === "string" ? v : null)} accept="image/*" ariaLabel="Image to compare on" />
              </div>
            )}

            <div>
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-dim)]">Models</span>
                <span className="text-[11px] text-[var(--color-faint)]">{chosen.length}/{MAX_COMPARE} picked</span>
              </div>
              <ul className="grid grid-cols-2 gap-2" data-testid="compare-candidates">
                {list.map((c) => {
                  const on = picked.includes(c.id);
                  const off = !!c.unavailable;
                  return (
                    <li key={c.id}>
                      <label title={c.unavailable ?? c.heavy ?? undefined}
                        className={`relative flex h-full flex-col overflow-hidden rounded-xl border text-sm transition-colors ${off ? "cursor-not-allowed opacity-50" : "cursor-pointer"} ${on ? "border-[var(--color-accent)]" : "border-[var(--color-border)] hover:border-[#3a3a42]"}`}>
                        <input type="checkbox" className="absolute right-2 top-2 z-10 accent-[var(--color-accent)]" checked={on}
                          disabled={off || (!on && picked.length >= MAX_COMPARE)} onChange={() => toggle(c.id)} data-testid={`compare-pick-${c.modelId}-${c.workflowId}`} />
                        <span className="relative block aspect-video w-full shrink-0 overflow-hidden bg-[var(--color-panel2)]">
                          {c.thumb?.kind === "image" && <img src={c.thumb.url} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover object-[center_25%]" />}
                          {c.thumb?.kind === "video" && <video src={`${c.thumb.url}#t=0.5`} muted playsInline preload="metadata" className="absolute inset-0 h-full w-full object-cover object-[center_25%]" />}
                          {!c.thumb && (
                            <span className="grid h-full w-full place-items-center text-[var(--color-faint)]"
                              style={{ background: "linear-gradient(160deg, #1c1f14, var(--color-panel2) 70%)" }}>
                              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                {c.kind === "video" ? <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /></> : <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></>}
                              </svg>
                            </span>
                          )}
                        </span>
                        <span className="flex flex-1 flex-col gap-0.5 px-2.5 py-2">
                          <span className="font-medium leading-tight">{c.model.replace(/ - .*$/, "")}{list.filter((x) => x.modelId === c.modelId).length > 1 && <span className="font-normal text-[var(--color-dim)]"> · {c.workflow}</span>}</span>
                          <span className="text-[11px] text-[var(--color-dim)]">{c.unavailable ? "Coming soon" : c.hint}</span>
                          <span className="mt-auto flex flex-wrap gap-1 pt-1 text-[10px] text-[var(--color-faint)]">
                            {c.licenseName && <span>{c.licenseName}</span>}
                            {c.license === "restricted" && <span className="text-[var(--color-warn,#e9b949)]">· opt-in</span>}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {list.length <= 2 && (
                <p className="mt-2 text-[11px] text-[var(--color-faint)]">These are all the {COMPARE_MODES[mode].label.toLowerCase()} models installed right now.</p>
              )}
            </div>

            <details className="group rounded-xl border border-[var(--color-border)]" data-testid="compare-advanced">
              <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-dim)]">
                Advanced <span aria-hidden className="transition-transform group-open:rotate-90">›</span>
              </summary>
              <div className="grid grid-cols-2 gap-3 px-3 pb-3">
                <label className="col-span-2 block text-xs text-[var(--color-dim)] sm:col-span-1">
                  <span className="mb-1 block">Seed</span>
                  <div className="flex gap-1.5">
                    <input type="number" className="input min-w-0 flex-1" value={seed} min={0} data-testid="compare-seed"
                      onChange={(e) => setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
                    <button className="btn btn-sm shrink-0" type="button" aria-label="New random seed" title="New random seed" onClick={() => setSeed(newSeed())}>↻</button>
                  </div>
                </label>
                {aspects.length > 0 && (
                  <label className="col-span-2 block text-xs text-[var(--color-dim)] sm:col-span-1">
                    <span className="mb-1 block">Aspect</span>
                    <select className="input w-full" value={aspect} onChange={(e) => setAspect(e.target.value)} data-testid="compare-aspect">
                      <option value="">Model default</option>
                      {aspects.map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </label>
                )}
                <p className="col-span-2 text-[11px] text-[var(--color-faint)]">Same seed for every model, so the comparison is fair. It starts random.</p>
              </div>
            </details>

            <button className="btn btn-primary w-full" data-testid="compare-run"
              disabled={!authed || busy || chosen.length < 2 || prompt.trim().length < 2 || (needsImage && !image)} onClick={start}>
              {busy ? "Running…" : `Compare ${chosen.length} models`}
            </button>
            {chosen.length < 2 && <p className="text-xs text-[var(--color-faint)]">Pick at least two models.</p>}
            <p className="text-xs text-[var(--color-faint)]">Each model is a normal job - it shows in your history, costs what it costs in the studio, and waits its turn on the GPU.</p>
          </section>
        </aside>

        <main className="min-w-0">
          {error && <p role="alert" className="mb-3 text-sm text-[var(--color-danger)]">{error}</p>}
          {cells.length === 0 ? (
            <div className="panel p-5" data-testid="compare-empty">
              <div className="font-display text-lg font-semibold">Results line up here</div>
              <p className="mt-1 max-w-2xl text-sm text-[var(--color-dim)]">Every model gets your prompt and the same seed, so differences come from the model, not luck. Below: one real output per model, made on our GPU, each from its own prompt.</p>
              {samples.length > 0 ? (
                <div className={`mt-4 grid gap-3 ${samples.length > 2 ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
                  {samples.map((c) => (
                    <figure key={c.id} className="overflow-hidden rounded-xl border border-[var(--color-border)]">
                      <div className="aspect-square bg-black/40">
                        {c.thumb!.kind === "video"
                          ? <video src={c.thumb!.url} muted loop playsInline autoPlay preload="metadata" className="h-full w-full object-contain" />
                          : <img src={c.thumb!.url} alt={`${c.model} sample`} loading="lazy" className="h-full w-full object-contain" />}
                      </div>
                      <figcaption className="px-3 py-2 text-xs"><span className="font-medium">{c.model.replace(/ - .*$/, "")}</span> <span className="text-[var(--color-faint)]">· sample</span></figcaption>
                    </figure>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <p className="mb-3 line-clamp-2 text-sm text-[var(--color-dim)]" data-testid="compare-run-prompt">“{runPrompt}”</p>
              <div className="grid gap-4 md:grid-cols-2" data-testid="compare-grid">
                {cells.map((cell, i) => {
                  const j = cell.job;
                  const c = cell.candidate;
                  const out = j?.outputs?.[0];
                  const isWinner = !!j && winner === j.id;
                  return (
                    <article key={`${cell.endpointId}-${i}`} data-testid="compare-cell" data-status={j?.status ?? (cell.pending ? "pending" : "error")}
                      className={`panel overflow-hidden p-0 ${isWinner ? "ring-2 ring-[var(--color-accent)]" : ""}`}>
                      <header className="flex items-center gap-2 px-3 py-2.5">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {c ? <>{c.model} <span className="font-normal text-[var(--color-dim)]">· {c.workflow}</span></> : cell.endpointId}
                        </span>
                        {isWinner && <span className="chip chip-on" data-testid="compare-winner">Winner</span>}
                        {j && <span className="text-[11px] text-[var(--color-faint)]">{STATUS[j.status] ?? j.status}</span>}
                        {cell.pending && <span className="text-[11px] text-[var(--color-faint)]">Up next</span>}
                      </header>
                      <div className="relative flex aspect-square items-center justify-center bg-black/40">
                        {out?.type === "video" && <video src={out.url} controls autoPlay loop muted playsInline className="h-full w-full object-contain" />}
                        {out && out.type !== "video" && <img src={out.url} alt={`${c?.model ?? "model"} result`} className="h-full w-full object-contain" />}
                        {cell.pending && <p className="text-xs text-[var(--color-faint)]">Starts when the one before it finishes</p>}
                        {!out && j && LIVE.has(j.status) && (
                          <div className="w-2/3">
                            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-panel2)]">
                              <div className="h-full bg-[var(--color-accent)] transition-[width]" style={{ width: `${Math.max(4, j.progress)}%` }} />
                            </div>
                            <p className="mt-2 text-center text-xs text-[var(--color-dim)]">{STATUS[j.status]}</p>
                          </div>
                        )}
                        {!out && (cell.error || (j && !LIVE.has(j.status))) && (
                          <p className="max-w-[80%] text-center text-xs text-[var(--color-danger)]" data-testid="compare-cell-error">
                            {cell.error ?? j?.error ?? "No output"}
                            {(cell.error ?? "").toLowerCase().includes("licen") && <> - <Link className="underline" href="/settings/licenses">licences</Link></>}
                          </p>
                        )}
                      </div>
                      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-[11px] text-[var(--color-dim)]">
                        {j && seconds(j) && <span data-testid="compare-time">{seconds(j)}</span>}
                        {j?.params?.seed != null && <span>seed {String(j.params.seed)}</span>}
                        {j && <span>{Number(j.costCredits)} cr</span>}
                        <span className="ml-auto flex gap-1.5">
                          {out && j && !isWinner && <button className="btn btn-sm" onClick={() => pick(j.id)} data-testid="compare-pick-winner">Pick</button>}
                          {out && c && <Link className="btn btn-sm" href={studioHref(c, runPrompt)}>Open in studio</Link>}
                          {out && <a className="btn btn-ghost btn-sm" href={out.url} download>Download</a>}
                        </span>
                      </footer>
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
