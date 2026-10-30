"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Ban, Clapperboard, Download, Hourglass, ImageOff, Lock, Maximize2, RotateCcw, TriangleAlert } from "lucide-react";
import type { PresetDef } from "@/lib/catalog/types";
import type { ClientModel, ClientWorkflow } from "@/lib/catalog/serialize";
import { ParamFieldView } from "@/components/fields";
import { LicenseBadge } from "./LicenseBadge";
import { Lightbox, type LightboxItem } from "./Lightbox";
import { GlbViewer } from "./GlbViewer";
import { Select } from "./select";
import { RESTYLE_PRESET_IDS } from "@/lib/catalog/video/swap";
import { EXPLAINER_LOOKS } from "@/lib/catalog/presets/explainer";
import { likenessIdentityParams, LIKENESS_CONSENT_PARAM } from "@/lib/likeness";
import { exampleFor } from "@/lib/examples";
import { ExampleCard, loadExampleParams } from "./ExampleCard";

type Job = {
  id: string; status: string; progress: number; error: string | null;
  outputs: { assetId: string; type: string; url: string; width?: number; height?: number; role?: string }[];
  prompt: string | null; modelId: string; costCredits: string; createdAt: string;
};

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued", in_progress: "Generating", completed: "Done", failed: "Failed", nsfw: "Moderated", canceled: "Canceled",
};

/** Camera presets shown before "Show all" (the grid stays one tidy block). */
const PRESETS_COLLAPSED = 8;

function MediaItem({ item }: { item: Job["outputs"][number] }) {
  if (item.type === "video") return <video src={item.url} controls autoPlay loop muted playsInline className="w-full" />;
  if (item.type === "audio") return <audio src={item.url} controls className="w-full" />;
  if (item.type === "model") return <GlbViewer url={item.url} />;
  return <img src={item.url} className="w-full" />;
}

/** Finished jobs that kept the raw render get a before/after toggle -
 *  finished (role unset/"finished") is the default view, "raw" shows the
 *  un-finished render. Click opens the fullscreen viewer. */
function ResultMedia({ outputs, onOpen }: { outputs: Job["outputs"]; onOpen: (item: LightboxItem) => void }) {
  const fin = outputs.filter((o) => o.role !== "raw");
  const raw = outputs.filter((o) => o.role === "raw");
  const [showRaw, setShowRaw] = useState(false);
  const item = (showRaw && raw.length ? raw : fin)[0] ?? outputs[0];
  if (!item) return null;
  return (
    <div className="relative">
      {item.type === "image" ? (
        <button type="button" className="block w-full cursor-zoom-in" onClick={() => onOpen(item)} title="Open fullscreen">
          <MediaItem item={item} />
        </button>
      ) : (
        <>
          <MediaItem item={item} />
          <button type="button" onClick={() => onOpen(item)} title="Open fullscreen"
            className="absolute bottom-2 right-2 rounded-md bg-black/60 p-1.5 text-white/80 backdrop-blur-sm hover:bg-black/80 hover:text-white">
            <Maximize2 size={13} />
          </button>
        </>
      )}
      {raw.length > 0 && fin.length > 0 && (
        <div className="absolute left-2 top-2 flex overflow-hidden rounded-md border border-white/20 bg-black/60 text-[11px] font-medium backdrop-blur-sm">
          <button onClick={(e) => { e.stopPropagation(); setShowRaw(false); }}
            className={`px-2 py-1 ${!showRaw ? "bg-[var(--color-accent)] text-white" : "text-white/70 hover:text-white"}`}>
            Finished 2×
          </button>
          <button onClick={(e) => { e.stopPropagation(); setShowRaw(true); }}
            className={`px-2 py-1 ${showRaw ? "bg-[var(--color-accent)] text-white" : "text-white/70 hover:text-white"}`}>
            Original
          </button>
        </div>
      )}
    </div>
  );
}

export function Studio({ kind, models, presets, paletteOptions, elements, fixedPreset, fixedModel }: {
  kind: "image" | "video" | "audio" | "all";
  models: ClientModel[];
  presets: PresetDef[];
  paletteOptions?: readonly string[];
  elements?: { id: string; name: string; category: string }[];
  fixedPreset?: string;
  fixedModel?: string;
}) {
  const sp = useSearchParams();
  const router = useRouter();
  // Unfinished workflows stay in the catalog so a later GPU check can turn
  // them on. The studio does not offer them.
  const offered = models
    .map((m) => ({ ...m, workflows: m.workflows.filter((w) => !w.comingSoon) }))
    .filter((m) => m.workflows.length > 0);
  // a ?flow= deep link may name a workflow on another model - resolve to the
  // model that owns it so the link lands on the requested flow
  // ?example=<endpoint> lands on the workflow that ran a shipped example
  const exampleWf = sp.get("example")
    ? offered.flatMap((m) => m.workflows.map((w) => ({ m, w }))).find(({ w }) => w.endpointId === sp.get("example"))
    : undefined;
  const flowOwner = offered.find((m) => m.workflows.some((w) => w.id === sp.get("flow")));
  const [modelId, setModelId] = useState(exampleWf?.m.id ?? sp.get("model") ?? fixedModel ?? flowOwner?.id ?? offered[0]?.id);
  const model = offered.find((m) => m.id === modelId) ?? offered[0];
  const [wfId, setWfId] = useState(exampleWf?.w.id ?? sp.get("flow") ?? model?.workflows[0]?.id);
  const wf: ClientWorkflow | undefined = model?.workflows.find((w) => w.id === wfId) ?? model?.workflows[0];

  const [params, setParams] = useState<Record<string, unknown>>({});
  const [presetId, setPresetId] = useState(sp.get("preset") ?? fixedPreset ?? "");
  const [showAllPresets, setShowAllPresets] = useState(false);
  /** verification-gated preset ids - empty until /api/catalog answers so a
   *  stale render can never offer an unverified preset */
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [cost, setCost] = useState<number | null>(null);
  const [unlimited, setUnlimited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [viewer, setViewer] = useState<LightboxItem | null>(null);
  const pollRef = useRef<Record<string, boolean>>({});
  // restricted-weight workflows (e.g. LTX-2.x Community) need the user's
  // one-time acceptance; asked inline here instead of failing the submit
  const [licenseOk, setLicenseOk] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/api/licenses/opt-in").then((r) => (r.ok ? r.json() : null))
      .then((d) => setLicenseOk(d ? !!d.opted_in : null)).catch(() => setLicenseOk(null));
  }, []);

  // recreate deep-link: /ai/*?recreate=<urlencoded prompt> or ?params=<json>
  useEffect(() => {
    fetch("/api/catalog").then((r) => r.json())
      .then((d) => setVisible(new Set(d.presets_visible ?? [])))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const recreate = sp.get("recreate");
    const rawParams = sp.get("params");
    if (recreate) setParams((p) => ({ ...p, prompt: recreate }));
    const ex = exampleFor(sp.get("example") ?? undefined);
    if (ex) loadExampleParams(ex).then(setParams).catch(() => {});
    if (rawParams) {
      try {
        const prefill: unknown = JSON.parse(rawParams);
        if (prefill && typeof prefill === "object" && !Array.isArray(prefill)) {
          // consent is an assertion, not data - a crafted deep link must
          // never pre-tick the box (docs/POLICY.md)
          const p = prefill as Record<string, unknown>;
          delete p[LIKENESS_CONSENT_PARAM];
          setParams(p);
        }
      } catch {}
    }
  }, []);

  // switching models picks its first workflow - unless a flow deep link names one
  useEffect(() => { setWfId((cur) => model?.workflows.some((w) => w.id === cur) ? cur : sp.get("flow") ?? model?.workflows[0]?.id); }, [modelId]);

  // cost estimate
  useEffect(() => {
    if (!wf) return;
    const t = setTimeout(() => {
      fetch("/api/estimate", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint_id: wf.endpointId, params }) })
        .then((r) => r.json()).then((d) => { setCost(d.credits ?? null); setUnlimited(!!d.unlimited); }).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [wf?.endpointId, params]);

  const selectOptions = useMemo(() => {
    const o: Record<string, { value: string; label: string }[]> = {
      look: [
        ...EXPLAINER_LOOKS.map((l) => ({ value: l.id, label: l.label })),
        { value: "custom", label: "Custom" },
      ],
      captions: [
        { value: "karaoke", label: "Karaoke" },
        { value: "pop", label: "Pop" },
        { value: "off", label: "Off" },
      ],
      motion_model: [
        { value: "wan-vace", label: "Wan 2.1 VACE 1.3B - Apache-2.0" },
        { value: "wan22-ti2v", label: "Wan 2.2 TI2V 5B - Apache-2.0 (~11 GB download)" },
        { value: "ltx", label: "LTX-Video 0.9.5 - Open RAIL-M, opt-in" },
        { value: "still", label: "Still pan/zoom - no model" },
      ],
    };
    if (paletteOptions) o.color_palette = paletteOptions.map((p) => ({ value: p, label: p.replace(/-/g, " ") }));
    // look_id options = verified look presets only (o.refs/character_id were
    // dead - no workflow param consumes them)
    const looks = presets.filter((p) => p.kind === "style" && visible.has(p.id));
    if (looks.length) o.look_id = looks.map((p) => ({ value: p.id, label: p.title }));
    // preset_id = the verified subset of the restyle allowlist - the enum on
    // the field is "not hidden", offering it would 400 every submit
    const restyles = presets.filter((p) => p.kind === "effect" && visible.has(p.id) && RESTYLE_PRESET_IDS.includes(p.id));
    if (restyles.length) o.preset_id = restyles.map((p) => ({ value: p.id, label: p.title }));
    return o;
  }, [paletteOptions, elements, presets, visible]);

  async function submit() {
    if (!wf || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ endpoint_id: wf.endpointId, params, preset_id: presetId || null, preset_kind: presetId ? presets.find(p => p.id === presetId)?.kind : null }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || "failed"); if (r.status === 401) router.push(`/login?next=${location.pathname}`); return; }
      setJobs((j) => [d.job, ...j]);
      pollJob(d.job.id);
    } finally { setBusy(false); }
  }

  function pollJob(id: string) {
    if (pollRef.current[id]) return;
    pollRef.current[id] = true;
    const tick = async () => {
      const r = await fetch(`/api/jobs/${id}`);
      const { job } = await r.json();
      setJobs((js) => js.map((j) => (j.id === id ? job : j)));
      if (["queued", "in_progress"].includes(job.status)) setTimeout(tick, 1200);
      else delete pollRef.current[id];
    };
    tick();
  }

  // resume polling in-flight jobs on mount
  useEffect(() => {
    fetch("/api/jobs?limit=10").then((r) => r.json()).then((d) => {
      const mine = (d.jobs ?? []) as Job[];
      setJobs((j) => [...mine.filter((m) => !j.some((x) => x.id === m.id)), ...j]);
      mine.filter((m) => ["queued", "in_progress"].includes(m.status)).forEach((m) => pollJob(m.id));
    }).catch(() => {});
  }, []);

  // attaching a still to a text-to-video flow means image-to-video -
  // switch the workflow instead of letting the upload sit ignored
  useEffect(() => {
    if (!wf || !model) return;
    const wantsImage = typeof params.image_url === "string" && !!params.image_url;
    if (!wantsImage) return;
    const accepts = wf.params.some((f) => f.name === "image_url");
    if (accepts) return;
    const i2v = model.workflows.find((w) => w.params.some((f) => f.name === "image_url"));
    if (i2v) setWfId(i2v.id);
  }, [params.image_url, wf, model]);

  // keyboard: ⌘/Ctrl+Enter generates, [ / ] step through result tiles,
  // d downloads the focused tile's first output
  const [focusJob, setFocusJob] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void submit(); return; }
      if (e.key === "[" || e.key === "]") {
        setFocusJob((i) => Math.max(0, Math.min(jobs.length - 1, i + (e.key === "]" ? 1 : -1))));
      }
      if (e.key === "d" || e.key === "D") {
        const out = jobs[focusJob]?.outputs?.[0];
        if (jobs[focusJob]?.status === "completed" && out) {
          const a = document.createElement("a");
          a.href = out.url; a.download = ""; a.click();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // pickers list only verified presets - the API enforces the same gate
  const motionPresets = presets.filter((p) => p.kind === "motion" && visible.has(p.id));
  const effectPresets = presets.filter((p) => p.kind === "effect" && visible.has(p.id));

  return (
    <div className="mx-auto grid max-w-[1600px] gap-6 px-4 py-6 lg:grid-cols-[420px_1fr]">
      {/* left - controls */}
      <div className="space-y-4">
        <div className="panel p-4 space-y-4">
          {/* model picker - a small model list reads as tabs, not a select */}
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-[var(--color-dim)]">Model</label>
            {kind === "audio" && offered.length <= 8 ? (
              <div className="flex flex-wrap gap-1.5">
                {offered.map((m) => (
                  <button key={m.id} onClick={() => setModelId(m.id)}
                    className={`chip ${modelId === m.id ? "chip-on" : "hover:border-[#3a3a42]"}`}>
                    {m.label}{m.minPlanTier ? <Lock size={11} className="ml-1 inline-block opacity-70" /> : null}
                  </button>
                ))}
              </div>
            ) : (
              <Select label="Model" testId="studio-model" value={modelId} onChange={setModelId}
                options={offered.map((m) => ({ value: m.id, label: `${m.label}${m.minPlanTier ? " (plan-gated)" : ""}`, note: m.description, badge: m.vendor }))} />
            )}
            <p className="mt-1 text-xs text-[var(--color-faint)]">{model?.description}</p>
          </div>

          {/* workflow tabs */}
          {model && model.workflows.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {model.workflows.map((w) => (
                <button key={w.id} onClick={() => setWfId(w.id)}
                  className={`chip ${wf?.id === w.id ? "chip-on" : ""}`}>{w.label}{w.heavy ? <TriangleAlert size={11} className="ml-1 inline-block text-amber-400" /> : null}</button>
              ))}
            </div>
          )}

          {/* preset picker (video models) */}
          {/* camera presets only on t2v/i2v workflows - on v2v flows
              (character-swap, restyle, camera-rig…) a camera chip would
              imply a rig the job can't drive. Without executesTrajectory
              the chips steer the prompt, not a rig - labelled as such. */}
          {(motionPresets.length || effectPresets.length) > 0 && kind !== "image" && wf?.kind === "video" && (
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-[var(--color-dim)]">
                Preset
                {!wf?.executesTrajectory && (
                  <span className="ml-2 font-normal normal-case tracking-normal text-[var(--color-faint)]"
                    title="A preset adds a camera/feel clause to the prompt - no trajectory runs">
                    prompt-guided
                  </span>
                )}
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                <button onClick={() => setPresetId("")} className={`chip justify-center ${!presetId ? "chip-on" : ""}`}>None</button>
                {(showAllPresets ? motionPresets : motionPresets.filter((p, i) => i < PRESETS_COLLAPSED || p.id === presetId)).map((p) => (
                  <button key={p.id} onClick={() => setPresetId(p.id)}
                    title={`${p.description}${wf?.executesTrajectory ? "" : " - prompt-guided (steers the prompt; no camera rig runs)"}`}
                    className={`chip justify-center truncate ${presetId === p.id ? "chip-on" : ""}`}>{p.title}</button>
                ))}
              </div>
              {motionPresets.length > PRESETS_COLLAPSED && (
                <button type="button" onClick={() => setShowAllPresets((v) => !v)}
                  className="mt-2 text-xs font-medium text-[var(--color-dim)] hover:text-[var(--color-text)]">
                  {showAllPresets ? "Show fewer" : `Show all ${motionPresets.length} presets`}
                </button>
              )}
              {(() => {
                const sel = [...motionPresets, ...effectPresets].find((p) => p.id === presetId);
                return sel?.poster ? (
                  <div className="mt-2 overflow-hidden rounded-lg border border-[var(--color-border)]">
                    {sel.poster.endsWith(".mp4") ? (
                      <video src={sel.poster} className="aspect-video w-full object-cover" muted loop playsInline autoPlay preload="metadata" />
                    ) : (
                      <img src={sel.poster} alt={sel.title} className="aspect-video w-full object-cover" />
                    )}
                    <div className="border-t border-[var(--color-border)] px-2.5 py-1.5 text-[11px] text-[var(--color-dim)]">
                      Verified output - {sel.description}
                    </div>
                  </div>
                ) : null;
              })()}
            </div>
          )}

          {/* params */}
          {wf && groupFields(wf).map(([group, fields]) => (
            <div key={group}>
              {group && <div className="mb-2 mt-1 text-[13px] font-medium text-[var(--color-faint)]">{group}</div>}
              <div className="space-y-3">
                {fields.filter((f) =>
                  (f.name !== "look_id" || (selectOptions.look_id?.length ?? 0) > 0)
                  && (f.name !== "preset_id" || (selectOptions.preset_id?.length ?? 0) > 0)).map((f) => {
                  // identity uploads stay disabled until the consent box is
                  // ticked - the server rejects the job either way
                  const identityField = wf ? likenessIdentityParams(wf.endpointId, params).includes(f.name) : false;
                  return (
                  <div key={f.name}>
                    <div className="mb-1 flex items-baseline justify-between">
                      <label className="text-[13px] font-medium text-[var(--color-dim)]">{f.label}{f.required && <span className="text-[var(--color-accent)]"> *</span>}</label>
                    </div>
                    <ParamFieldView field={f} value={params[f.name]} onChange={(v) => setParams((p) => ({ ...p, [f.name]: v }))} options={selectOptions}
                      disabled={identityField && params[LIKENESS_CONSENT_PARAM] !== true} />
                    {f.description && <p className="mt-1 text-xs text-[var(--color-faint)]">{f.description}</p>}
                  </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* current license - explainer-class endpoints resolve per motion_model choice */}
          {(() => {
            const v = wf?.licenseVariants;
            const shown = v ? v.byValue[String(params[v.param] ?? "")] ?? wf?.license : wf?.license;
            return shown ? (
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--color-dim)]">Licenses</span>
                <LicenseBadge license={shown} />
              </div>
            ) : null;
          })()}

          {wf?.heavy && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
              <TriangleAlert size={15} className="mt-0.5 shrink-0" /> Heavy workflow - {wf.heavy}
            </p>
          )}

          {error && <p className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">{error}</p>}

          {(() => {
            const lic = wf?.licenseVariants ? wf.licenseVariants.byValue[String(params[wf.licenseVariants.param] ?? "")] ?? wf?.license : wf?.license;
            if (lic?.class !== "restricted" || licenseOk !== false) return null;
            const terms = lic.components.filter((c) => c.class === "restricted");
            return (
              <label className="flex items-start gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-dim)]" data-testid="license-accept">
                <input type="checkbox" className="mt-0.5" onChange={(e) => {
                  if (!e.target.checked) return;
                  fetch("/api/licenses/opt-in", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) })
                    .then((r) => setLicenseOk(r.ok)).catch(() => setLicenseOk(false));
                }} />
                <span>I accept the {terms.map((c, i) => <a key={c.name} href={c.url} target="_blank" rel="noreferrer" className="underline">{i ? ", " : ""}{c.license}</a>)} terms for these weights (one time, revocable in Settings → Licenses).</span>
              </label>
            );
          })()}
          {wf?.comingSoon && (
            <p className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-dim)]">
              Coming soon - {wf.comingSoon}
            </p>
          )}
          <button onClick={submit} disabled={busy || !!wf?.comingSoon} className="btn btn-primary w-full text-base">
            {busy ? "Submitting…" : `Generate${cost != null ? (unlimited ? " - unlimited" : ` · ${Math.ceil(cost)} credits`) : ""}`}
          </button>
        </div>
      </div>

      {/* right - results */}
      <div className="min-h-[60vh]">
        {(() => {
          const ex = exampleFor(wf?.endpointId);
          return ex ? (
            <div className="mb-4 max-w-4xl">
              <ExampleCard layout="row" e={ex} onTry={(p) => { setParams(p); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
            </div>
          ) : null;
        })()}
        {jobs.length === 0 && (
          <div className="grid h-full min-h-96 place-items-center rounded-2xl border border-dashed border-[var(--color-border)] text-center">
            <div>
              <Clapperboard size={40} className="mx-auto text-[var(--color-faint)]" />
              <p className="mt-2 text-sm text-[var(--color-dim)]">Your generations appear here.</p>
              <p className="text-xs text-[var(--color-faint)]">Pick a model, write a prompt, hit Generate.</p>
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {jobs.map((j, ji) => (
            <div key={j.id} className={`media-tile aspect-video ${ji === focusJob ? "ring-1 ring-white/30" : ""}`} data-job-status={j.status}>
              {j.status === "completed" && j.outputs?.[0] ? <ResultMedia outputs={j.outputs} onOpen={(item) => setViewer({ ...item, label: j.prompt ?? undefined, prompt: j.prompt ?? undefined })} /> : (
                <div className="grid h-full place-items-center">
                  <div className="text-center">
                    <div>
                      {j.status === "failed" ? <TriangleAlert size={26} className="mx-auto text-[var(--color-danger)]" />
                        : j.status === "canceled" || j.status === "nsfw" ? <Ban size={26} className="mx-auto text-[var(--color-dim)]" />
                        : j.status === "completed" ? <ImageOff size={26} className="mx-auto text-[var(--color-faint)]" />
                        : <Hourglass size={24} className="mx-auto text-[var(--color-dim)]" />}
                    </div>
                    <p className="mt-1 text-xs text-[var(--color-dim)]">{STATUS_LABEL[j.status]}{j.status === "in_progress" && j.progress ? ` · ${j.progress}%` : ""}</p>
                    {j.status === "failed" && j.error && <p className="mt-1 px-3 text-[11px] text-[var(--color-danger)]">{j.error}</p>}
                  </div>
                </div>
              )}
              <div className="hover-ui flex flex-col justify-between p-2">
                <div className="flex justify-end gap-1">
                  {["queued", "in_progress"].includes(j.status) && (
                    <button className="btn btn-sm bg-black/60 hover:bg-black" onClick={() => fetch(`/api/jobs/${j.id}/cancel`, { method: "POST" }).then(() => pollJob(j.id))}>Cancel</button>
                  )}
                </div>
                <div>
                  <p className="line-clamp-2 text-xs text-white/90">{j.prompt || j.modelId}</p>
                  <div className="mt-1 flex gap-1">
                    {j.status === "completed" && j.outputs?.[0] && (
                      <>
                        <a className="btn btn-sm bg-black/60 hover:bg-black" href={j.outputs[0].url} download title="Save">
                          <Download size={12} className="mr-1 inline-block" /> Save</a>
                        <button className="btn btn-sm bg-black/60 hover:bg-black" onClick={() => {
                          setParams({ prompt: j.prompt ?? "" });
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }} title="Recreate"><RotateCcw size={12} className="mr-1 inline-block" /> Recreate</button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <Lightbox item={viewer} onClose={() => setViewer(null)} onRecreate={(p) => { setViewer(null); setParams({ prompt: p }); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
    </div>
  );
}

function groupFields(wf: ClientWorkflow): [string | null, typeof wf.params][] {
  const groups = new Map<string | null, typeof wf.params>();
  for (const f of wf.params) {
    const g = f.group ?? null;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(f);
  }
  return [...groups.entries()];
}
