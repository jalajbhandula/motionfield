"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import SceneCanvas from "@/app/render/scene-canvas";
import type { SceneSpec, SpecParam } from "@/lib/render/spec";
import { MOTION_TEMPLATES } from "@/lib/render/templates";
import { userError } from "@/lib/user-error";

const ASPECTS = ["16:9", "9:16", "1:1", "4:5"] as const;
const RESOLUTIONS = ["720p", "1080p", "4k"] as const;
const FPSES = [24, 30, 60] as const;

type Recent = { id: string; title: string | null; created_at: string };
type TranscriptRow = { instruction: string; id: string };
type RenderJob = { id: string; status: string; progress: number; url?: string; error?: string };

async function jfetch(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: d as Record<string, unknown> };
}

export default function MotionStudio({ canRender, llmReady }: { canRender: boolean; llmReady: boolean }) {
  const [prompt, setPrompt] = useState("");
  const [url, setUrl] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [aspect, setAspect] = useState<(typeof ASPECTS)[number]>("16:9");
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]>("720p");
  const [fps, setFps] = useState<(typeof FPSES)[number]>(24);
  const [duration, setDuration] = useState(4);

  const router = useRouter();
  const [specId, setSpecId] = useState<string | null>(null);
  const [spec, setSpec] = useState<SceneSpec | null>(null);
  const [title, setTitle] = useState("");
  const [values, setValues] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<"generate" | "refine" | "render" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsLlm, setNeedsLlm] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptRow[]>([]);
  const [instruction, setInstruction] = useState("");
  const [recent, setRecent] = useState<Recent[]>([]);
  const [renderNote, setRenderNote] = useState<string | null>(null);
  const [renderJob, setRenderJob] = useState<RenderJob | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const busySince = useRef<number>(0);
  // poll lifecycle: the render poll must die with the component (and never
  // outlive 15 min) - a mounted-until-done loop kept hammering /api/jobs
  // after navigation
  const pollCtl = useRef<AbortController | null>(null);
  useEffect(() => () => pollCtl.current?.abort(), []);

  // elapsed-seconds readout while a generate/refine/render call is in flight
  useEffect(() => {
    if (!busy) return;
    busySince.current = Date.now();
    setElapsed(0);
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - busySince.current) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [busy]);

  const loadRecent = useCallback(async () => {
    const r = await jfetch("/api/render/specs");
    if (r.ok) setRecent((r.data.specs as Recent[]) ?? []);
  }, []);
  useEffect(() => { loadRecent(); }, [loadRecent]);

  // ?id=<uuid> reopens a saved spec
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) void openSpec(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applySpec = useCallback((id: string, s: SceneSpec, t: string) => {
    setSpecId(id);
    setSpec(s);
    setTitle(t);
    setValues(Object.fromEntries((s.params ?? []).map((p) => [p.id, p.default])));
    setError(null);
    setRenderNote(null);
  }, []);

  async function openSpec(id: string) {
    const r = await jfetch(`/api/render/specs/${id}`);
    if (r.ok) {
      applySpec(id, r.data.spec as SceneSpec, String(r.data.title ?? "spec"));
    } else {
      setError("spec not found");
    }
  }

  // With no spec-writer configured, only a template can produce a spec - and
  // it needs no prompt (the button reads "Use template").
  const templateOnly = !llmReady && Boolean(templateId);
  const canGenerate = !busy && (templateOnly || Boolean(prompt.trim()));

  const generate = async () => {
    if (!canGenerate) return;
    if (!llmReady && !templateId) {
      setNeedsLlm(true);
      setError(null);
      return;
    }
    setBusy("generate");
    setError(null);
    setNeedsLlm(false);
    const r = await jfetch("/api/render/motion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: prompt.trim() || undefined,
        url: url.trim() || undefined,
        template_id: templateId ?? undefined,
        aspect, resolution, fps, duration,
      }),
    });
    setBusy(null);
    if (!r.ok) {
      setNeedsLlm(r.data.code === "NEEDS_LLM");
      setError(userError(r.status, r.data.error ?? "generate failed").message);
      return;
    }
    applySpec(String(r.data.id), r.data.spec as SceneSpec,
      prompt.trim() ? titleOf(prompt) : (MOTION_TEMPLATES.find((t) => t.id === templateId)?.label ?? "motion"));
    router.replace(`/motion-graphics?id=${String(r.data.id)}`);
    setTranscript([]);
    void loadRecent();
  };

  const refine = async () => {
    if (!specId || !instruction.trim() || busy) return;
    setBusy("refine");
    setError(null);
    const r = await jfetch(`/api/render/motion/${specId}/refine`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: instruction.trim() }),
    });
    setBusy(null);
    if (!r.ok) {
      setNeedsLlm(r.data.code === "NEEDS_LLM");
      setError(userError(r.status, r.data.error ?? "refine failed").message);
      return;
    }
    applySpec(String(r.data.id), r.data.spec as SceneSpec, title);
    router.replace(`/motion-graphics?id=${String(r.data.id)}`);
    setTranscript((t) => [...t, { instruction: instruction.trim(), id: String(r.data.id) }]);
    setInstruction("");
    void loadRecent();
  };

  const renderMp4 = async () => {
    if (!specId || busy) return;
    setBusy("render");
    setRenderNote(null);
    setRenderJob(null);
    const r = await jfetch(`/api/render/motion/${specId}/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values }),
    });
    if (!r.ok) {
      setBusy(null);
      setRenderNote(userError(r.status, r.data.error ?? "render failed").message);
      return;
    }
    const jobId = String(r.data.job_id);
    setRenderJob({ id: jobId, status: "queued", progress: 0 });
    // poll until the job settles - /api/jobs/:id ticks the recipe in dev.
    // bounded: unmount aborts it, 15 min caps it.
    pollCtl.current?.abort();
    const ctl = (pollCtl.current = new AbortController());
    const deadline = Date.now() + 15 * 60 * 1000;
    for (;;) {
      if (ctl.signal.aborted) return;
      if (Date.now() > deadline) {
        setRenderJob((j2) => (j2 ? { ...j2, status: "failed", error: "timed out waiting for the render job" } : j2));
        break;
      }
      await new Promise((res) => setTimeout(res, 1500));
      if (ctl.signal.aborted) return;
      const j = await jfetch(`/api/jobs/${jobId}`);
      const job = j.data.job as { status?: string; progress?: number; outputs?: { type?: string; url?: string }[]; error?: string } | undefined;
      if (!j.ok || !job) {
        setRenderJob((j2) => (j2 ? { ...j2, status: "failed", error: String(j.data.error ?? "poll failed") } : j2));
        break;
      }
      const done = job.status === "completed" || job.status === "failed" || job.status === "canceled";
      const url = (job.outputs ?? []).find((o) => o.type === "video" && o.url)?.url
        ?? (job.outputs ?? []).find((o) => o.url)?.url;
      setRenderJob({
        id: jobId,
        status: String(job.status ?? "queued"),
        progress: Number(job.progress ?? 0),
        url: done ? url : undefined,
        error: job.status === "failed" ? String(job.error ?? "render failed") : undefined,
      });
      if (done) break;
    }
    setBusy(null);
  };

  const params = useMemo(() => spec?.params ?? [], [spec]);

  return (
    <div className="mx-auto grid max-w-[1400px] grid-cols-[360px_minmax(0,1fr)] gap-6 px-4 py-8 max-lg:grid-cols-1">
      {/* left rail - generate form + recent */}
      <div className="space-y-5">
        <div>
          <h1 className="font-display text-3xl font-bold">Motion Graphics</h1>
          <p className="text-sm text-[var(--color-dim)]">
            Describe a title card or clip - the spec-writer turns it into a deterministic scene you can preview, tweak, and render.
          </p>
        </div>

        <div className="panel space-y-3 p-4">
          <textarea
            className="input min-h-24 w-full resize-y"
            placeholder="A bold product-launch title card with a rising 3D wordmark and drifting dust…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={4000}
          />
          <input
            className="input w-full"
            placeholder="https://your-site.com (optional - brand context)"
            title={llmReady ? "Optional - fetched for brand context" : "needs the spec-writer"}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={!llmReady}
          />

          <div className="space-y-2">
            <div className="text-xs font-medium text-[var(--color-faint)]">Template (optional)</div>
            <div className="flex flex-wrap gap-1.5">
              {MOTION_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  title={t.description}
                  className={`chip text-[11px] ${templateId === t.id ? "chip-on" : ""}`}
                  onClick={() => setTemplateId((v) => (v === t.id ? null : t.id))}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <label className="space-y-1">
              <span className="text-[var(--color-faint)]">Aspect</span>
              <select className="input w-full" value={aspect} onChange={(e) => setAspect(e.target.value as typeof aspect)}>
                {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[var(--color-faint)]">Resolution <span className="opacity-70">(up to 4K)</span></span>
              <select className="input w-full" value={resolution} onChange={(e) => setResolution(e.target.value as typeof resolution)}>
                {RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[var(--color-faint)]">FPS</span>
              <select className="input w-full" value={fps} onChange={(e) => setFps(Number(e.target.value) as typeof fps)}>
                {FPSES.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[var(--color-faint)]">Duration (s)</span>
              <input className="input w-full" type="number" min={2} max={30} value={duration}
                onChange={(e) => setDuration(Math.min(30, Math.max(2, Number(e.target.value) || 4)))} />
            </label>
          </div>

          <button className="btn btn-primary w-full" onClick={generate} disabled={!canGenerate}>
            {busy === "generate" ? `Writing spec… ${elapsed}s` : templateOnly ? "Use template" : "Generate spec"}
          </button>
          {(needsLlm || !llmReady) && (
            <p className="text-xs text-[var(--color-faint)]">
              Spec-writing LLM isn't configured (set <code>LLM_BASE_URL</code>/<code>LLM_MODEL</code>/<code>LLM_API_KEY</code> or a provider in Settings) - pick a template to generate without it.
            </p>
          )}
          {error && !needsLlm && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
        </div>

        {recent.length > 0 && (
          <div className="panel p-4">
            <div className="mb-2 text-xs font-medium text-[var(--color-faint)]">Recent specs</div>
            <div className="space-y-1">
              {recent.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => { router.replace(`/motion-graphics?id=${r.id}`); void openSpec(r.id); }}
                  className={`block w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--color-panel2)] ${r.id === specId ? "text-[var(--color-accent)]" : ""}`}
                >
                  {r.title || "untitled"}
                  <span className="ml-2 text-[10px] text-[var(--color-faint)]">
                    {new Date(r.created_at).toLocaleDateString()}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* right - preview + customize + refine */}
      <div className="min-w-0 space-y-4">
        {spec ? (
          <>
            <div className="panel p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="truncate font-display text-lg font-semibold">{title || "untitled spec"}</h2>
                <div className="flex shrink-0 gap-2">
                  {canRender && specId && (
                    <button className="btn btn-primary btn-sm" onClick={renderMp4} disabled={busy === "render"}>
                      {busy === "render" ? `Rendering… ${elapsed}s` : "Render MP4"}
                    </button>
                  )}
                </div>
              </div>
              <SceneCanvas spec={spec} params={values} />
              {renderNote && <p className="mt-2 text-xs text-[var(--color-dim)]">{renderNote}</p>}
              {renderJob && (
                <div className="mt-3 space-y-2">
                  {renderJob.status === "completed" && renderJob.url ? (
                    <>
                      <video className="w-full rounded-lg" src={renderJob.url} controls playsInline />
                      <a className="inline-block text-xs text-[var(--color-accent)]" href={renderJob.url} download>
                        Download MP4
                      </a>
                    </>
                  ) : renderJob.status === "failed" || renderJob.status === "canceled" ? (
                    <p className="text-xs text-[var(--color-danger)]">Render {renderJob.status}: {renderJob.error ?? ""}</p>
                  ) : (
                    <div className="space-y-1">
                      <div className="h-1.5 w-full overflow-hidden rounded bg-[var(--color-panel2)]">
                        <div className="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${Math.max(2, renderJob.progress)}%` }} />
                      </div>
                      <p className="text-xs text-[var(--color-dim)]">Rendering… {renderJob.progress}%</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {params.length > 0 && (
              <div className="panel p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-xs font-medium text-[var(--color-faint)]">Customize</div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setValues(Object.fromEntries(params.map((p) => [p.id, p.default])))}
                  >
                    Reset
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 max-md:grid-cols-1">
                  {params.map((p: SpecParam) => (
                    <label key={p.id} className="space-y-1 text-xs">
                      <span className="flex justify-between text-[var(--color-dim)]">
                        <span>{p.label}</span>
                        <span className="font-mono">{values[p.id] ?? p.default}</span>
                      </span>
                      <input
                        type="range"
                        className="w-full accent-[var(--color-accent)]"
                        min={p.min} max={p.max} step={p.step}
                        value={values[p.id] ?? p.default}
                        onChange={(e) => setValues((v) => ({ ...v, [p.id]: Number(e.target.value) }))}
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}

            {specId && llmReady && (
              <div className="panel space-y-3 p-4">
                <div className="text-xs font-medium text-[var(--color-faint)]">Refine</div>
                {transcript.length > 0 && (
                  <div className="space-y-1 text-xs text-[var(--color-dim)]">
                    {transcript.map((t) => <div key={t.id}>“{t.instruction}”</div>)}
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    className="input min-w-0 flex-1"
                    placeholder="make the title bigger and warmer…"
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && refine()}
                  />
                  <button className="btn btn-ghost" onClick={refine} disabled={busy === "refine" || !instruction.trim()}>
                    {busy === "refine" ? `Refining… ${elapsed}s` : "Refine"}
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="panel grid min-h-[420px] place-items-center p-8 text-center text-sm text-[var(--color-faint)]">
            Write a prompt on the left - or pick a template chip - and Generate. The spec preview lands here.
          </div>
        )}
      </div>
    </div>
  );
}

function titleOf(prompt: string) {
  return prompt.trim().split(/\s+/).slice(0, 8).join(" ").slice(0, 80);
}
