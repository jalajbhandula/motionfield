"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { z } from "zod";
import BrandMark from "@/components/BrandMark";
import { useDismiss, useDropUp } from "@/lib/use-dismiss";

/** Assistant - agentic creative chat backed by the real session protocol:
 *  POST /api/agent/sessions → POST messages → poll ?after=<seq> → interrupt.
 *  Skill cards still use the local multi-step planner (they compose pipelines). */

type Step = { step: string; label?: string; endpoint: string; params: Record<string, unknown>; cost: number; readsScript?: boolean };
type PlanLine = { id: string; label: string; status: string };
/** Plan-card steps as emitted by the run engine's plan message. */
type PlanStepMsg = { id: string; title: string; endpoint_id: string; cost: number; eta_seconds: number | null };
type StepOutput = z.infer<typeof StepOutputV>;
type RunStepView = z.infer<typeof RunStepV>;
type RunView = z.infer<typeof RunViewV>;

/* wire shapes - parsed, not trusted */
const StepOutputV = z.looseObject({
  url: z.string().optional(), type: z.string().optional(), assetId: z.string().optional(),
  /** builtin tool leaves carry a bounded preview + the tool that wrote them */
  text: z.string().optional(), via: z.string().optional(),
});
const RevisionV = z.looseObject({
  rev: z.number(), outputs: z.array(StepOutputV).default([]),
  job_id: z.string().nullable().default(null), created_at: z.string().default(""),
});
const RunStepV = z.looseObject({
  id: z.string(), step_id: z.string(), idx: z.number(), title: z.string(), endpoint_id: z.string(),
  status: z.string(), job_id: z.string().nullable(), outputs: z.array(StepOutputV).default([]),
  error: z.string().nullable(), depends_on: z.array(z.string()).default([]),
  input_hash: z.string().nullable().default(null),
  params: z.record(z.string(), z.unknown()).default({}),
  cost: z.number().nullable().default(null), eta_seconds: z.number().nullable().default(null),
  started_at: z.string().nullable().default(null),
  model_label: z.string().nullable().default(null), rev: z.number().default(0),
  model_choice: z.string().nullable().default(null), effort: z.string().nullable().default(null),
  model_options: z.array(ModelOptionV).default([]),
  revisions: z.array(RevisionV).default([]),
});
const RunViewV = z.looseObject({
  id: z.string(), status: z.string(), title: z.string().nullable().default(null),
  estimate_credits: z.number().default(0), eta_seconds: z.number().nullable().default(null),
  ask_first: z.boolean().default(false), steps: z.array(RunStepV).default([]),
  mode: z.string().default("auto"),
  via: z.string().nullable().default(null),
  planner_note: z.string().nullable().default(null),
  created_at: z.string().nullable().default(null),
});
const LiveJobV = z.looseObject({ id: z.string(), status: z.string(), progress: z.number().nullable().default(null), endpointId: z.string(), kind: z.string() });
const PlanStepMsgV = z.looseObject({ id: z.string(), title: z.string(), endpoint_id: z.string(), cost: z.number().default(0), eta_seconds: z.number().nullable().default(null) });
const PlanLineV = z.looseObject({ id: z.string(), label: z.string().default(""), status: z.string().default("pending") });
const AgentMsgV = z.looseObject({ seq: z.number(), role: z.string(), kind: z.string(), content: z.record(z.string(), z.unknown()).default({}) });
/** The bits of session.context the composer restores on chat reopen -
 *  the planner pick + mode stick server-side, the picker mirrors them. */
const SessionCtxV = z.looseObject({
  planner: z.string().optional(), mode: z.string().optional(),
  todo: z.object({
    items: z.array(z.looseObject({ text: z.string(), done: z.boolean() })).catch([]),
  }).optional(),
});
const PollV = z.looseObject({
  session: z.looseObject({
    status: z.string(), context: SessionCtxV.optional(),
    /** the session's own project binding - reopened bound chats keep it */
    projectId: z.string().nullable().optional(),
  }).optional(),
  jobs: z.array(LiveJobV).catch([]), runs: z.array(RunViewV).catch([]), messages: z.array(AgentMsgV).catch([]),
});
/* small response shapes - parsed, never trusted */
const ErrV = z.looseObject({ error: z.string().optional() });
const SessionListV = z.looseObject({
  sessions: z.array(z.looseObject({ id: z.string(), title: z.string().optional() })).catch([]),
});
const PrefsV = z.looseObject({ offline: z.boolean().optional(), locked: z.boolean().optional() });
const SessionCreatedV = z.looseObject({ session: z.looseObject({ id: z.string() }) });
const ProjectTitleV = z.looseObject({ project: z.looseObject({ title: z.string().optional() }).optional() });

/** Reads ?project=<id> and reports it to the page - a separate component
 *  under a Suspense boundary because useSearchParams can't run during
 *  prerender (Next 16 docs: wrap the reader in <Suspense/>). */
function ProjectParamProbe({ onProject }: { onProject: (id: string | null) => void }) {
  const sp = useSearchParams();
  useEffect(() => { onProject(sp.get("project")); }, [sp, onProject]);
  return null;
}
const UploadV = z.looseObject({ url: z.string(), mime: z.string().optional() });
const ScriptV = z.looseObject({ script: z.string().optional() });
const ProvidersV = z.looseObject({
  groups: z.array(z.looseObject({
    providers: z.array(z.looseObject({
      id: z.string(), label: z.string(), group: z.string(), status: z.string(),
      local: z.boolean().optional(), baseUrl: z.string().nullable().optional(),
      defaultModel: z.string().optional(), models: z.array(z.string()).optional(),
      capabilities: z.looseObject({ tools: z.boolean().optional() }).optional(),
    })).catch([]),
  })).catch([]),
});

/** The params worth a glance on a step row - ordered, media inputs excluded. */
const KEY_PARAMS = ["resolution", "duration", "aspect_ratio", "fps", "steps", "denoise", "seed", "voice", "scenes", "motion_model"];
function keyParams(params: Record<string, unknown>): string {
  const out: string[] = [];
  for (const k of KEY_PARAMS) {
    const v = params[k];
    if (typeof v === "string" || typeof v === "number") out.push(`${k === "aspect_ratio" ? "aspect" : k} ${v}`);
    if (out.length >= 4) break;
  }
  return out.join(" · ");
}
type Msg = {
  role: "user" | "agent"; text: string; pending?: boolean;
  plan?: Step[]; lines?: PlanLine[]; atts?: Uploaded[];
  planSteps?: PlanStepMsg[]; runId?: string;
  results?: StepOutput[];
  /** ask_user option chips - a click sends the option as the next brief */
  options?: string[];
  /** agent/* endpoint this line belongs to - renders a "· tool" marker */
  tool?: string;
};

import { SKILLS as CATALOG_SKILLS } from "@/lib/catalog/skills";
import { skillExample } from "@/lib/examples";
import { findEndpoint } from "@/lib/catalog/video-models";
import { JOB_KIND_OUTPUT } from "@/lib/generation/types";
import { mediaBaseKind, mediaKindOf } from "@/lib/runs/media";
import { ModeMenu, modeToApi, apiToMode, type ModeId } from "./modes/menu";
import { uploadFile, userError, userErrorFrom } from "@/lib/user-error";
import { ModelOptionV, StepModeControls } from "./modes/custom-step";


/** A step's attached /files/ inputs - the attachment leaf on the node. */
function stepAttachments(step: RunStepView): { name: string; url: string; kind: string }[] {
  const wf = findEndpoint(step.endpoint_id)?.workflow;
  if (!wf) return [];
  const out: { name: string; url: string; kind: string }[] = [];
  for (const f of wf.params) {
    const kind = mediaKindOf(f);
    if (!kind) continue;
    const raw = step.params?.[f.name];
    for (const v of Array.isArray(raw) ? raw : [raw]) {
      if (typeof v === "string" && v.startsWith("/files/"))
        out.push({ name: v.split("/").pop() ?? v, url: v, kind: mediaBaseKind(kind) });
    }
  }
  return out;
}

/** Small output thumb shared by the step leaf, the run strip and revisions -
 *  every item links out to its asset. Text/json leaves (builtin tool output)
 *  are expandable: the summary names the leaf + the tool that wrote it; the
 *  preview renders as TEXT (React escapes it - a fetched page's markup never
 *  reaches the DOM). */
function OutThumb({ o }: { o: StepOutput }) {
  const url = o.url!;
  if (o.type === "text" || o.type === "json")
    return (
      <details className="w-56 max-w-full rounded bg-[var(--color-line)] px-2 py-1 text-[10px] text-[var(--color-dim)]" data-testid="text-leaf">
        <summary className="flex cursor-pointer select-none items-center gap-1">
          <Icon n="clip" s={11} /><span className="truncate">{url.split("/").pop()?.slice(0, 18)}{o.via ? ` · via ${o.via}` : ""}</span>
        </summary>
        {typeof o.text === "string" && o.text.length > 0 && (
          <pre className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap break-words">{o.text}</pre>
        )}
        <a href={url} target="_blank" rel="noreferrer" className="mt-1 inline-block underline underline-offset-2">open file</a>
      </details>
    );
  return (
    <a href={url} target="_blank" rel="noreferrer" className="block shrink-0" title={url.split("/").pop()}>
      {o.type === "video"
        ? <video src={url} muted playsInline preload="metadata" className="h-14 w-24 rounded object-cover" />
        : o.type === "audio"
          ? <span className="flex h-14 w-24 items-center justify-center gap-1 rounded bg-[var(--color-line)] px-2 text-[10px] text-[var(--color-dim)]"><Icon n="clip" s={11} />{url.split("/").pop()?.slice(0, 12)}</span>
          : <img src={url} alt="" className="h-14 w-24 rounded object-cover" />}
    </a>
  );
}

const SKILLS = CATALOG_SKILLS.map((k) => ({ id: k.id, cat: k.category, name: k.name, desc: k.blurb, prompt: `Run ${k.name} on`,
  steps: (brief: string): Step[] => k.steps(brief).map((t) => ({ step: t.label, endpoint: t.endpoint, params: t.params, cost: t.cost, readsScript: t.readsScript })) }));
type AgentMsg = {
  seq: number; role: string; kind: string;
  content: { text?: string; question?: string; steps?: (PlanLine | PlanStepMsg)[]; run_id?: string; via?: string; job_id?: string; status?: string; endpoint?: string; outputs?: { url: string; type: string }[]; tool?: string; args?: Record<string, unknown>; error?: string };
};
type LiveJob = { id: string; status: string; progress: number | null; endpointId: string; kind: string };
type Uploaded = { name: string; url: string; mime: string };
const mediaKind = (u: Uploaded) => (u.mime.startsWith("video/") ? "video" : u.mime.startsWith("audio/") ? "audio" : "image");

const CATS = [
  { id: "all", label: "All", icon: "grid" },
  { id: "marketing", label: "Marketing", icon: "tag" },
  { id: "explainer", label: "Explainer videos", icon: "film" },
  { id: "apps", label: "Apps", icon: "grid" },
  { id: "games", label: "Games", icon: "gamepad" },
] as const;
const CAT_MATCH: Record<string, RegExp> = {
  marketing: /ad|market|brand|product|campaign|ugc|multiplier/i,
  explainer: /explain|narrat|tutorial|story|video|film/i,
  apps: /app|card|thumb|marketplace/i,
  games: /game|trailer|sprite|character/i,
};
const HUES = [142, 210, 265, 20, 330, 180, 45, 290];
/** A run status that can hold a live stream - module-scoped: the set is
 *  constant for the page's life, never a per-render allocation. */
const LIVE_STREAM = new Set(["running", "paused"]);
const MAX_STREAMS = 2;

const PLACEHOLDERS = [
  "Create a cinematic trailer for my app",
  "Turn my podcast into 9:16 Reels",
  "A 30s sneaker ad with 3 shots",
  "Animate my product photo with a dolly zoom",
  "Restyle this clip as neon cyberpunk",
  "Make an explainer video about my app",
];

function Icon({ n, s = 14 }: { n: string; s?: number }) {
  const p = { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const paths: Record<string, React.ReactNode> = {
    plus: <><path d="M12 5v14M5 12h14" /></>,
    search: <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>,
    folder: <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
    zap: <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
    dots: <><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>,
    shield: <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />,
    up: <path d="m5 12 7-7 7 7M12 19V5" />,
    tag: <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />,
    film: <><rect x="2" y="2" width="20" height="20" rx="2.18" /><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5" /></>,
    gamepad: <><path d="M6 12h4M8 10v4M15 13h.01M18 11h.01" /><path d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59C2.6 9.42 2 14.46 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.54-.6-6.58-.68-7.41A4 4 0 0 0 17.32 5z" /></>,
    panel: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></>,
    globe: <><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20" /></>,
    x: <path d="M18 6 6 18M6 6l12 12" />,
    send: <path d="m5 12 7-7 7 7M12 19V5" />,
    spark: <><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" /></>,
    card: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></>,
    chev: <path d="m6 9 6 6 6-6" />,
    clip: <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />,
  };
  return <svg {...p}>{paths[n]}</svg>;
}

/* -------------------------- run task-tree card --------------------------- */

const STEP_STATUS_UI: Record<string, { icon: string; cls: string; label: string }> = {
  pending: { icon: "○", cls: "text-[var(--color-dim)]", label: "pending" },
  running: { icon: "…", cls: "text-amber-300", label: "running" },
  done: { icon: "✓", cls: "text-emerald-300", label: "done" },
  failed: { icon: "✕", cls: "text-red-300", label: "failed" },
  skipped: { icon: "-", cls: "text-[var(--color-dim)]", label: "skipped" },
  canceled: { icon: "-", cls: "text-red-300", label: "canceled" },
};

const RUN_CHIP: Record<string, string> = {
  awaiting_approval: "bg-amber-400/15 text-amber-300",
  running: "bg-emerald-400/15 text-emerald-300",
  paused: "bg-sky-400/15 text-sky-300",
  done: "bg-emerald-400/15 text-emerald-300",
  failed: "bg-red-400/15 text-red-300",
  stopped: "bg-red-400/15 text-red-300",
};

function fmtEta(s: number | null): string {
  if (s == null) return "ETA unknown";
  return s >= 60 ? `~${Math.round(s / 60)}m` : `~${s}s`;
}

/** One node of the tree - click opens the detail card. The collapsed row
 *  already shows model · key params · cost · ETA; attachments and outputs are
 *  always-visible leaves below it; any step may be re-run via the param form
 *  while the run is parked or finished. */
function StepNode({
  step, run, job, onEditStep,
}: {
  step: RunStepView;
  run: RunView | null;
  job: LiveJob | undefined;
  /** returns the server's error text, or null when the edit landed */
  onEditStep: (stepId: string, edit: {
    params?: Record<string, unknown>; title?: string; endpoint_id?: string; effort?: string; rev: number;
  }) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [expKinds, setExpKinds] = useState<ReadonlySet<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const ui = STEP_STATUS_UI[step.status] ?? STEP_STATUS_UI.pending;
  // an edit re-runs the step + its descendants - legal while the run is
  // parked or finished; never while the run or the step itself is live
  const editable = !!run && run.status !== "running" && step.status !== "running";
  const pk = keyParams(step.params ?? {});
  const out = (step.outputs ?? []).filter((o) => typeof o.url === "string" && o.url);
  const atts = stepAttachments(step);
  // "earlier versions" - superseded specs that produced or attempted work;
  // empty snapshots (a pending spec never ran) don't list
  const revs = step.revisions.filter((r) => r.outputs.length > 0 || r.job_id);
  const groups = new Map<string, StepOutput[]>();
  for (const o of out) groups.set(o.type ?? "file", [...(groups.get(o.type ?? "file") ?? []), o]);
  const wf = findEndpoint(step.endpoint_id)?.workflow;
  const editFields = (wf?.params ?? []).filter((f) => !mediaKindOf(f) && f.type !== "multishots");
  const fieldCls = "w-full rounded-md border border-[var(--color-line)] bg-[var(--color-panel2)] px-2 py-1 text-[11px]";

  const fieldInput = (f: (typeof editFields)[number]) => {
    const v = draft[f.name];
    const set = (val: unknown) => setDraft((d) => ({ ...d, [f.name]: val }));
    const tid = `step-param-${step.step_id}-${f.name}`;
    if (f.enum?.length) {
      return (
        <select value={v == null ? "" : String(v)} data-testid={tid} className={fieldCls}
          onChange={(e) => { const raw = e.target.value; const num = Number(raw); set(raw === "" ? undefined : f.enum!.includes(num) ? num : raw); }}>
          {!f.required && <option value="">-</option>}
          {f.enum.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
        </select>
      );
    }
    if (f.type === "boolean")
      return <input type="checkbox" checked={!!v} data-testid={tid} onChange={(e) => set(e.target.checked)} />;
    if (f.type === "number" || f.type === "integer" || f.type === "slider") {
      return (
        <input type="number" value={v == null ? "" : String(v)} min={f.min} max={f.max}
          step={f.step ?? (f.type === "integer" ? 1 : "any")} data-testid={tid} className={fieldCls}
          onChange={(e) => set(e.target.value === "" ? undefined : Number(e.target.value))} />
      );
    }
    if (f.name === "prompt" || f.type === "textarea" || f.type === "prompt") {
      return (
        <textarea value={v == null ? "" : String(v)} rows={3} spellCheck={false} placeholder={f.placeholder}
          data-testid={tid} className={fieldCls} onChange={(e) => set(e.target.value)} />
      );
    }
    return (
      <input type="text" value={v == null ? "" : String(v)} placeholder={f.placeholder}
        data-testid={tid} className={fieldCls} onChange={(e) => set(e.target.value)} />
    );
  };

  return (
    <div className="rounded-lg bg-[var(--color-panel2)]" data-testid={`step-${step.step_id}`} data-status={step.status}>
      <button type="button" className="flex w-full items-center gap-2 px-3 pt-2 pb-1 text-left text-xs" onClick={() => setOpen((o) => !o)}>
        <span className={`shrink-0 ${ui.cls}`} title={ui.label}>{ui.icon}</span>
        {step.depends_on.length > 0 && (
          <span className="shrink-0 text-[10px] text-[var(--color-dim)]" title={`after ${step.depends_on.join(", ")}`}>↳{step.depends_on.join("+")}</span>
        )}
        <span className="min-w-0 flex-1 truncate">{step.idx + 1}. {step.title}</span>
        {step.rev > 0 && <span className="shrink-0 rounded bg-[var(--color-line)] px-1 text-[9px] text-[var(--color-dim)]" title={`edited - rev ${step.rev}`}>r{step.rev}</span>}
        <span className="shrink-0 text-[var(--color-dim)]">
          {step.status === "running" && job?.progress != null ? `${job.progress}%` : ""}
        </span>
      </button>
      <div className="flex items-center gap-1.5 truncate px-3 pb-1.5 pl-8 text-[10px] text-[var(--color-dim)]" data-testid={`step-meta-${step.step_id}`}>
        <span className="truncate">{step.model_label ?? step.endpoint_id}{pk ? ` · ${pk}` : ""} · {(step.cost ?? 0).toFixed(2)} cr · {fmtEta(step.eta_seconds)}</span>
      </div>
      {step.status === "running" && (
        <div className="mx-3 mb-2 h-1 overflow-hidden rounded-full bg-[var(--color-line)]">
          <div className="h-full rounded-full bg-[var(--color-accent)] transition-all" style={{ width: `${job?.progress ?? 4}%` }} />
        </div>
      )}
      {run?.mode === "custom" && (
        <StepModeControls
          stepId={step.step_id} rev={step.rev}
          endpointId={step.endpoint_id}
          endpointLabel={step.model_label ?? step.endpoint_id}
          modelChoice={step.model_choice} effort={step.effort}
          options={step.model_options} editable={editable}
          onEdit={(e) => onEditStep(step.step_id, e)} />
      )}
      {atts.length > 0 && (
        <div className="mx-3 mb-1.5 flex flex-wrap gap-1 pl-8" data-testid={`step-atts-${step.step_id}`}>
          {atts.map((a, j) => (
            <a key={j} href={a.url} target="_blank" rel="noreferrer" title={a.url}
              className="flex items-center gap-1 rounded-md bg-[var(--color-line)] px-1.5 py-0.5 text-[10px] text-[var(--color-dim)] hover:text-[var(--color-fg)]">
              <Icon n="clip" s={10} />{a.name}
            </a>
          ))}
        </div>
      )}
      {out.length > 0 && (
        <div className="mx-3 mb-1.5 flex flex-wrap items-center gap-1.5 pl-8" data-testid={`step-outs-${step.step_id}`}>
          {[...groups.entries()].map(([kind, items]) => (
            <div key={kind} className="contents">
              {(expKinds.has(kind) ? items : items.slice(0, 3)).map((o, j) => <OutThumb key={j} o={o} />)}
              {items.length > 3 && !expKinds.has(kind) && (
                <button type="button" className="rounded-md bg-[var(--color-line)] px-2 py-1 text-[10px] text-[var(--color-dim)]"
                  onClick={() => setExpKinds((x) => new Set([...x, kind]))}>+{items.length - 3} more</button>
              )}
            </div>
          ))}
        </div>
      )}
      {open && (
        <div className="mx-2 mb-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] p-2.5 text-[11px]" data-testid={`step-detail-${step.step_id}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium text-[var(--color-dim)]">{step.model_label ?? step.endpoint_id}</span>
            <span className="shrink-0 text-[var(--color-dim)]">{fmtEta(step.eta_seconds)}</span>
          </div>
          {pk && <div className="mt-1 text-[var(--color-dim)]">{pk}</div>}
          <div className="mt-1 truncate text-[10px] text-[var(--color-dim)]">{step.endpoint_id}{step.input_hash ? ` · #${step.input_hash.slice(0, 10)}` : ""}{step.job_id ? ` · job ${step.job_id.slice(0, 8)}` : ""}</div>
          {typeof step.params.prompt === "string" && (
            <div className="mt-1.5 max-h-16 overflow-y-auto whitespace-pre-wrap rounded bg-[var(--color-panel2)] p-1.5 text-[10px] text-[var(--color-dim)]">{String(step.params.prompt)}</div>
          )}
          {step.error && <div className="mt-1.5 rounded bg-red-400/10 px-1.5 py-1 text-[10px] text-red-300">{step.error}</div>}
          {out.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {out.map((o, j) => (
                <div key={j} className="media-tile max-w-xs">
                  {o.type === "video" ? <video src={o.url} controls muted playsInline className="w-full" />
                    : o.type === "audio" ? <audio src={o.url} controls className="w-full" />
                    : o.type === "text" || o.type === "json" ? <OutThumb o={o} />
                    : <a href={o.url} target="_blank" rel="noreferrer"><img src={o.url} className="w-full" alt="step output" /></a>}
                </div>
              ))}
            </div>
          )}
          {revs.length > 0 && (
            <div className="mt-2" data-testid={`step-revisions-${step.step_id}`}>
              <div className="text-[10px] font-semibold text-[var(--color-dim)]">Earlier versions</div>
              {revs.map((r) => (
                <div key={r.rev} className="mt-1 flex items-center gap-1.5 rounded bg-[var(--color-panel2)] px-1.5 py-1 text-[10px] text-[var(--color-dim)]">
                  <span className="shrink-0 rounded bg-[var(--color-line)] px-1" title={`rev ${r.rev}`}>r{r.rev}</span>
                  {((r.outputs ?? []).filter((o) => typeof o.url === "string" && o.url)).map((o, j) => <OutThumb key={j} o={o} />)}
                  {r.job_id && <span className="truncate" title={r.job_id}>job {r.job_id.slice(0, 8)}</span>}
                </div>
              ))}
            </div>
          )}
          {editable && !editing && (
            <button type="button" className="mt-2 rounded-md bg-[var(--color-line)] px-2 py-1 text-[10px] font-semibold hover:opacity-80"
              data-testid={`step-edit-${step.step_id}`}
              onClick={() => { setEditing(true); setTitleDraft(step.title); setDraft({ ...step.params }); setErr(null); }}>
              Edit step
            </button>
          )}
          {editing && (
            <div className="mt-2 space-y-1.5" data-testid={`step-form-${step.step_id}`}>
              <label className="block text-[10px] font-semibold text-[var(--color-dim)]">
                Title
                <input type="text" value={titleDraft} className={`${fieldCls} mt-0.5`} data-testid={`step-param-${step.step_id}-title`}
                  onChange={(e) => setTitleDraft(e.target.value)} />
              </label>
              {editFields.map((f) => (
                <label key={f.name} className="block text-[10px] font-semibold text-[var(--color-dim)]">
                  {f.label}{f.required ? " *" : ""}
                  <span className="mt-0.5 block">{fieldInput(f)}</span>
                </label>
              ))}
              {err && <div className="text-[10px] text-red-300">{err}</div>}
              <div className="flex gap-1.5">
                <button type="button" className="btn btn-primary btn-sm" data-testid={`step-save-${step.step_id}`}
                  onClick={async () => {
                    // media inputs ride along untouched - the form only edits
                    // declared scalar params + title
                    const params: Record<string, unknown> = {};
                    for (const f of wf?.params ?? []) {
                      if (mediaKindOf(f) && step.params?.[f.name] !== undefined) params[f.name] = step.params[f.name];
                    }
                    for (const [k, v] of Object.entries(draft)) if (v !== undefined) params[k] = v;
                    const e = await onEditStep(step.step_id, {
                      params, rev: step.rev,
                      ...(titleDraft !== step.title ? { title: titleDraft } : {}),
                    });
                    if (e === null) { setEditing(false); setErr(null); } else setErr(e);
                  }}>
                  Save &amp; re-run
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The durable run as a live task tree - dependencies, per-step state +
 *  progress, outputs, errors, and the pause/resume/approve/stop controls. */
function RunTreeCard({
  run, planSteps, jobs, onAct, onEditStep,
}: {
  run: RunView | undefined;
  planSteps: PlanStepMsg[];
  jobs: LiveJob[];
  onAct: (runId: string, action: "approve" | "stop" | "pause" | "resume") => void;
  onEditStep: (runId: string, stepId: string, edit: {
    params?: Record<string, unknown>; title?: string; endpoint_id?: string; effort?: string; rev: number;
  }) => Promise<string | null>;
}) {
  const [stripAll, setStripAll] = useState(false);
  const steps: RunStepView[] = run?.steps ?? planSteps.map((s, j): RunStepView => ({
    id: s.id, step_id: s.id, idx: j, title: s.title, endpoint_id: s.endpoint_id,
    status: "pending", params: {}, job_id: null, outputs: [], error: null,
    depends_on: [], input_hash: null, rev: 0, cost: s.cost, eta_seconds: s.eta_seconds,
    started_at: null,
    model_label: findEndpoint(s.endpoint_id)?.model.label ?? null,
    model_choice: null, effort: null, model_options: [], revisions: [],
  }));
  const status = run?.status ?? "running";
  const total = run?.estimate_credits ?? planSteps.reduce((a, s) => a + s.cost, 0);
  const eta = run?.eta_seconds ?? (() => {
    const known = steps.every((s) => s.eta_seconds != null);
    return known ? steps.reduce((a, s) => a + (s.eta_seconds ?? 0), 0) : null;
  })();
  const doneCount = steps.filter((s) => s.status === "done").length;
  // "~Ns left" is a claim, not a guess: show it only when EVERY pending or
  // running step has a known ETA, minus the running step's elapsed so far;
  // one unknown ETA and the honest answer is "time left unknown"
  const liveSteps = steps.filter((s) => s.status === "pending" || s.status === "running");
  const left = !liveSteps.length || !liveSteps.every((s) => s.eta_seconds != null)
    ? null
    : liveSteps.reduce((a, s) => a + Math.max(0, (s.eta_seconds ?? 0)
        - (s.status === "running" && s.started_at
          ? Math.max(0, (Date.now() - Date.parse(s.started_at)) / 1000) : 0)), 0);
  // after an edit, estimate_credits is the pending delta - "cr total" would
  // under-read what the re-run charges; once the re-run lands it's history -
  // "last re-run", not "to re-run"
  const edited = steps.some((s) => s.rev > 0);
  const rerunDone = edited && ["done", "failed", "stopped"].includes(status);
  // a thumbnail strip on the run node while it runs - 3 thumbs + "+N" over
  const runOutputs = steps.flatMap((s) => (s.outputs ?? []).filter((o) => typeof o.url === "string" && o.url));
  return (
    <div className="panel mt-3 space-y-1.5 p-3" data-testid={`run-card-${run?.id ?? "pending"}`}>
      <div className="flex items-center justify-between gap-2 px-1 pb-1 text-[11px]">
        <span className="min-w-0 truncate font-semibold">{run?.title ?? "Run"}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {run && <span className="rounded-full bg-[var(--color-line)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-dim)]" data-testid={`run-mode-${run.id}`}>{run.mode}</span>}
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${RUN_CHIP[status] ?? "bg-[var(--color-line)] text-[var(--color-dim)]"}`}>
            {status.replaceAll("_", " ")}
          </span>
        </span>
      </div>
      {run && (
        <div className="truncate px-1 pb-1 text-[10px] text-[var(--color-dim)]" data-testid={`run-via-${run.id}`}>
          {run.via ? `via ${run.via}` : ""}{run.via && run.planner_note ? " · " : ""}
          {run.planner_note ? <span className="text-amber-300">{run.planner_note}</span> : ""}
        </div>
      )}
      {run && ["running", "paused"].includes(status) && runOutputs.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-1 pb-1" data-testid={`run-strip-${run.id}`}>
          {(stripAll ? runOutputs : runOutputs.slice(0, 3)).map((o, j) => <OutThumb key={j} o={o} />)}
          {runOutputs.length > 3 && !stripAll && (
            <button type="button" className="rounded-md bg-[var(--color-line)] px-2 py-1 text-[10px] text-[var(--color-dim)]"
              data-testid={`run-strip-more-${run.id}`} onClick={() => setStripAll(true)}>+{runOutputs.length - 3} more</button>
          )}
        </div>
      )}
      {steps.map((s) => (
        <StepNode key={s.step_id} step={s} run={run ?? null}
          job={jobs.find((j) => j.id === s.job_id)}
          onEditStep={(sid, edit) => run ? onEditStep(run.id, sid, edit) : Promise.resolve("no run yet")} />
      ))}
      <div className="flex items-center justify-between gap-2 px-1 pt-0.5 text-[11px] text-[var(--color-dim)]"
        data-testid={run ? `run-footer-${run.id}` : undefined}>
        <span>{run ? `${run.mode} · ` : ""}{doneCount}/{steps.length} done · {total.toFixed(2)} cr {edited ? (rerunDone ? "last re-run" : "to re-run") : "total"}{eta != null ? ` · ${fmtEta(eta)}` : " · ETA unknown"}{status === "running" ? (left != null ? ` · ~${Math.round(left)}s left` : " · time left unknown") : ""}</span>
      </div>
      {run && ["awaiting_approval", "running", "paused"].includes(status) && (
        <div className="flex gap-2 pt-1">
          {status === "awaiting_approval" && (
            <button className="btn btn-primary btn-sm" data-testid={`run-approve-${run.id}`} onClick={() => onAct(run.id, "approve")}>
              Approve &amp; run ({total.toFixed(2)} cr)
            </button>
          )}
          {status === "running" && (
            <button className="btn btn-sm" data-testid={`run-pause-${run.id}`} onClick={() => onAct(run.id, "pause")}>Pause</button>
          )}
          {status === "paused" && (
            <button className="btn btn-primary btn-sm" data-testid={`run-resume-${run.id}`} onClick={() => onAct(run.id, "resume")}>Resume</button>
          )}
          <button className="btn btn-sm" data-testid={`run-stop-${run.id}`} onClick={() => onAct(run.id, "stop")}>Stop</button>
        </div>
      )}
    </div>
  );
}

export default function Assistant() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [askFirst, setAskFirst] = useState(true);
  const [mode, setMode] = useState<ModeId>("Auto");
  const [modeLocked, setModeLocked] = useState(false);
  const [cat, setCat] = useState<string>("all");
  const [files, setFiles] = useState<Uploaded[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [activeJobs, setActiveJobs] = useState<LiveJob[]>([]);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const agentWrap = useDismiss<HTMLDivElement>(agentOpen, setAgentOpen);
  const agentUp = useDropUp(agentWrap, agentOpen);
  /** planner picker: "" = auto (configured route), "builtin", or
   *  "<providerId>:<model>" - sent with each message, sticks in session ctx */
  const [planner, setPlanner] = useState("");
  const [plannerOpen, setPlannerOpen] = useState(false);
  const plannerWrap = useDismiss<HTMLDivElement>(plannerOpen, setPlannerOpen);
  const plannerUp = useDropUp(plannerWrap, plannerOpen);
  const [providerPicks, setProviderPicks] = useState<{ value: string; label: string; hint?: string; local: boolean }[]>([]);
  // Offline mode narrows the picker to loopback-capable routes - the server
  // refuses a remote pick too (policy.llmRouteOk), this is just the UI half
  const plannerOptions = [
    { value: "", label: "Auto", hint: "Uses the AI model set in Settings, or the built-in planner if none" },
    { value: "builtin", label: "Built-in", hint: "Simple built-in planner, no AI model needed" },
    ...(mode === "Offline" ? providerPicks.filter((p) => p.local) : providerPicks),
    // a pick restored from the session the provider list no longer offers
    // still shows its real value - never a silent relabel back to "Auto"
    ...(planner && planner !== "builtin" && !providerPicks.some((p) => p.value === planner)
      ? [{ value: planner, label: planner }] : []),
  ];
  const [phIdx, setPhIdx] = useState(0);
  useEffect(() => { const t = setInterval(() => setPhIdx((i) => (i + 1) % PLACEHOLDERS.length), 3000); return () => clearInterval(t); }, []);
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>("active");
  const [sessionList, setSessionList] = useState<{ id: string; title?: string }[]>([]);
  const [todos, setTodos] = useState<{ text: string; done: boolean }[]>([]);
  // ?project=<id> (the project page's "New chat in this project") binds the
  // next session; a reopened chat shows its own stored binding instead
  const [wantedProject, setWantedProject] = useState<string | null>(null);
  const [sessionProject, setSessionProject] = useState<string | null>(null);
  const [projectTitle, setProjectTitle] = useState<string | null>(null);
  const lastSeq = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  // poll server session messages incrementally
  const restoredCtx = useRef(false);
  useEffect(() => {
    if (!sessionId) return;
    const t = setInterval(async () => {
      const r = await fetch(`/api/agent/sessions/${sessionId}/messages?after=${lastSeq.current}`).catch(() => null);
      if (!r?.ok) return;
      const parsed = PollV.safeParse(await r.json());
      if (!parsed.success) return;
      const d = parsed.data;
      // chat restore: the stored planner pick + mode mirror back onto the
      // composer once - the server kept them, the picker shouldn't pretend
      // it's still on defaults
      if (!restoredCtx.current) {
        restoredCtx.current = true;
        const ctx = d.session?.context;
        // a chat with no stored pick must NOT inherit the previous chat's -
        // reset to auto when the ctx carries nothing (stale-pick fix)
        setPlanner(ctx?.planner ?? "");
        const m = ctx?.mode ? apiToMode(ctx.mode) : null;
        if (m && !modeLocked) setMode(m);
      }
      setTodos(d.session?.context?.todo?.items ?? []);
      setSessionStatus(d.session?.status ?? "active");
      setSessionProject(d.session?.projectId ?? null);
      setActiveJobs(d.jobs);
      setRuns(d.runs);
      for (const m of d.messages) {
        lastSeq.current = Math.max(lastSeq.current, Number(m.seq));
        if (m.kind === "status" && m.seq === 1) continue;
        const c = m.content ?? {};
        if (m.role === "user") {
          // fold into the optimistic bubble if we just sent it, else render (chat restore)
          const uatts = z.array(z.looseObject({ url: z.string(), name: z.string().optional(), mime: z.string().optional() }))
            .catch([]).parse(c.attachments ?? [])
            .map((a) => ({ url: a.url, name: a.name ?? a.url.split("/").pop() ?? "file", mime: a.mime ?? "" }));
          setMsgs((x) => {
            const i = x.findIndex((mm) => mm.pending && mm.text.startsWith(String(c.text ?? "")));
            if (i >= 0) { const copy = [...x]; copy[i] = { ...copy[i], pending: false, atts: uatts.length ? uatts : copy[i].atts }; return copy; }
            return [...x, { role: "user", text: String(c.text ?? ""), atts: uatts.length ? uatts : undefined }];
          });
          continue;
        }
        if (m.kind === "plan") setMsgs((x) => [...x, c.run_id
          ? { role: "agent" as const, text: String(c.text ?? "Plan:"), planSteps: z.array(PlanStepMsgV).catch([]).parse(c.steps ?? []), runId: String(c.run_id) }
          : { role: "agent" as const, text: String(c.text ?? "Plan:"), lines: z.array(PlanLineV).catch([]).parse(c.steps ?? []) }]);
        else if (m.kind === "question") setMsgs((x) => [...x, {
          role: "agent", text: String(c.question ?? c.text ?? "?"),
          options: z.array(z.string()).catch([]).parse(c.options ?? []).slice(0, 4),
        }]);
        else if (m.kind === "tool_call") setMsgs((x) => [...x, {
          role: "agent", text: String(c.text ?? `Running ${c.endpoint ?? c.tool ?? "step"}…`),
          tool: String(c.endpoint ?? "").startsWith("agent/") ? String(c.endpoint) : undefined,
        }]);
        else if (m.kind === "tool_result") setMsgs((x) => [...x, {
          role: "agent", text: c.error ? `⚠ ${String(c.error)}` : (typeof c.text === "string" ? c.text : (c.job_id ? `Job ${String(c.job_id).slice(0, 8)} done.` : "Done.")),
          tool: String(c.endpoint ?? "").startsWith("agent/") ? String(c.endpoint) : undefined,
          results: z.array(StepOutputV).catch([]).parse(c.outputs ?? []),
        }]);
        else if (m.kind === "status") setMsgs((x) => [...x, { role: "agent", text: `· ${String(c.text ?? c.status ?? "")}` }]);
        else if (m.kind === "text" || m.role === "assistant") setMsgs((x) => [...x, { role: "agent", text: String(c.text ?? "") }]);
      }
    }, 1600);
    return () => clearInterval(t);
  }, [sessionId]);

  // live run streams - an EventSource only while a run is actually live
  // (running/paused), at most two at once, newest first. Browsers cap
  // ~6 HTTP/1.1 connections per host - parked approval runs holding streams
  // would starve the 1.6 s poll and the Approve click. snapshot/run frames
  // carry the full run view and merge into the same `runs` state the poll
  // fills; a "done" frame closes AND frees the slot so a still-live run can
  // take it; an errored stream stays dead and the poll remains the fallback.
  const streamRef = useRef(new Map<string, EventSource>());
  const deadStreams = useRef(new Set<string>());
  useEffect(() => {
    // SSE merges prepend rows - sort by created_at first so the newest live
    // runs take the two stream slots, not whichever row landed last
    const allowed = [...runs]
      .filter((r) => LIVE_STREAM.has(r.status))
      .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
      .slice(0, MAX_STREAMS).map((r) => r.id);
    const allowedSet = new Set(allowed);
    // close streams whose run left running/paused or fell out of the top-2
    for (const [id, es] of [...streamRef.current]) {
      if (!allowedSet.has(id)) { es.close(); streamRef.current.delete(id); }
    }
    for (const id of allowed) {
      if (streamRef.current.has(id) || deadStreams.current.has(id)) continue;
      const es = new EventSource(`/api/agent/runs/${id}/events`);
      const apply = (e: Event) => {
        try {
          if (!(e instanceof MessageEvent) || typeof e.data !== "string") return;
          const d = z.looseObject({ run: z.unknown() }).safeParse(JSON.parse(e.data));
          const v = d.success ? RunViewV.safeParse(d.data.run) : null;
          if (v?.success) setRuns((x) => [v.data, ...x.filter((y) => y.id !== v.data.id)]);
        } catch { /* malformed frame - ignore */ }
      };
      es.addEventListener("snapshot", apply);
      es.addEventListener("run", apply);
      // done frees the slot - a run still live after the 10-minute cap
      // reopens on the next poll; a terminal run just stays closed
      es.addEventListener("done", () => { es.close(); streamRef.current.delete(id); });
      es.onerror = () => {
        es.close(); deadStreams.current.add(id); streamRef.current.delete(id);
      };
      streamRef.current.set(id, es);
    }
  }, [runs]);
  useEffect(() => () => {
    for (const es of streamRef.current.values()) es.close();
    streamRef.current.clear();
  }, []);

  // load previous chats once + the persisted Offline toggle (new sessions
  // start in Offline when it's on; env-forced shows the picker locked)
  useEffect(() => {
    fetch("/api/agent/sessions").then((r) => (r.ok ? r.json() : null)).then((d) => {
      const parsed = SessionListV.safeParse(d);
      if (parsed.success && parsed.data.sessions.length)
        setSessionList(parsed.data.sessions.map((s) => ({ id: s.id, title: s.title })));
    }).catch(() => {});
    fetch("/api/llm/prefs").then((r) => (r.ok ? r.json() : null)).then((d) => {
      const parsed = PrefsV.safeParse(d);
      if (!parsed.success) return;
      if (parsed.data.offline) setMode("Offline");
      if (parsed.data.locked) setModeLocked(true);
    }).catch(() => {});
    // planner picker options - providers the planner could actually use:
    // tool-capable, detected or key-saved (the server re-checks on submit)
    fetch("/api/llm/providers").then((r) => (r.ok ? r.json() : null)).then((d) => {
      const parsed = ProvidersV.safeParse(d);
      if (!parsed.success) return;
      const picks = parsed.data.groups.flatMap((g) => g.providers)
        .filter((p) => p.group !== "cli" && p.capabilities?.tools && ["detected", "key saved"].includes(p.status))
        .flatMap((p) => (p.models?.length ? p.models.slice(0, 3) : [p.defaultModel].filter((m): m is string => !!m))
          .map((m) => ({
            value: `${p.id}:${m}`, label: `${p.label} · ${m}`,
            local: p.local === true || /^https?:\/\/(localhost|127\.|\[::1\]|::1)/i.test(p.baseUrl ?? ""),
          })));
      if (picks.length) setProviderPicks(picks);
    }).catch(() => {});
  }, []);

  // the chip's binding: a live session shows ITS project; before the first
  // brief, the ?project= param binds the session we're about to create
  const boundProject = sessionId ? sessionProject : wantedProject;
  useEffect(() => {
    if (!boundProject) { setProjectTitle(null); return; }
    let dead = false;
    fetch(`/api/projects/${boundProject}`).then((r) => (r.ok ? r.json() : null)).then((d) => {
      const title = ProjectTitleV.safeParse(d).data?.project?.title ?? null;
      if (!dead) setProjectTitle(title);
    }).catch(() => {});
    return () => { dead = true; };
  }, [boundProject]);

  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId;
    const r = await fetch("/api/agent/sessions", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: modeToApi(mode), ...(wantedProject ? { project_id: wantedProject } : {}) }) });
    if (r.status === 401) { location.href = "/login?next=/ai-assistant"; throw new Error("unauthorized"); }
    const created = SessionCreatedV.safeParse(await r.json().catch(() => null));
    if (!created.success) throw new Error("session create failed");
    const id = created.data.session.id;
    setSessionId(id);
    setSessionList((x) => [{ id, title: "Untitled chat" }, ...x]);
    return id;
  }

  async function sendToAgent(brief: string) {
    setSending(true);
    try {
      const sid = await ensureSession();
      const r = await fetch(`/api/agent/sessions/${sid}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: brief, mode: modeToApi(mode), ask_first: askFirst, planner, attachments: files.map(({ name, url, mime }) => ({ name, url, mime })) }),
      });
      if (!r.ok) {
        const d = ErrV.catch({}).parse(await r.json().catch(() => ({})));
        setMsgs((m) => [...m, { role: "agent", text: `⚠ ${d.error ?? `request failed (${r.status})`}` }]);
      }
      setFiles([]);
    } catch { setMsgs((m) => [...m, { role: "agent", text: "⚠ couldn't reach the server" }]); }
    setSending(false);
  }

  async function attach(list: FileList | null) {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    setUploading(true);
    for (const f of picked) {
      try {
        const up = await uploadFile(f);
        const d = UploadV.safeParse(up);
        if (d.success) setFiles((x) => [...x, { name: f.name, url: d.data.url, mime: d.data.mime ?? f.type }]);
        else setMsgs((m) => [...m, { role: "agent", text: `⚠ upload failed: ${f.name}` }]);
      } catch (e) {
        const ue = userErrorFrom(e);
        setMsgs((m) => [...m, { role: "agent", text: `⚠ ${ue.message} (${f.name})` }]);
      }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function interrupt() {
    if (!sessionId) return;
    await fetch(`/api/agent/sessions/${sessionId}/interrupt`, { method: "POST" });
    setSessionStatus("interrupted");
    setActiveJobs([]);
  }

  function newChat() {
    setMsgs([]); setSessionId(null); setSessionStatus("active"); lastSeq.current = 0; setFiles([]); setActiveJobs([]);
    setRuns([]); deadStreams.current.clear(); restoredCtx.current = false; setTodos([]);
  }

  function openChat(id: string) {
    setMsgs([]); lastSeq.current = 0; setActiveJobs([]); setSessionStatus("active");
    restoredCtx.current = false; setTodos([]); setSessionId(id);
  }

  /** The user ticking a checklist item - optimistic, then PATCH the ctx. */
  async function tickTodo(i: number) {
    if (!sessionId) return;
    const next = todos.map((t, j) => (j === i ? { ...t, done: !t.done } : t));
    setTodos(next);
    await fetch(`/api/agent/sessions/${sessionId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ todo: { items: next } }),
    }).catch(() => null);
  }

  /** A skill brief → one durable run via /api/agent/runs.
   *  Steps chain sequentially; unset media params take attachments first
   *  (each attachment used once across the pipeline), then a $step ref to the
   *  nearest earlier step whose output kind feeds the param. */
  async function submitRun(msg: Msg, brief?: string) {
    if (!msg.plan || running) return;
    setRunning(true);
    const sid = await ensureSession().catch(() => null);
    if (!sid) { setRunning(false); return; }

    const atts = msg.atts ?? files;
    const usedAtt = new Set<string>();
    const steps: { id: string; title: string; endpoint_id: string; params: Record<string, unknown>; depends_on: string[] }[] = [];
    for (const [i, s] of msg.plan.entries()) {
      const params: Record<string, unknown> = { ...s.params };
      // spoken steps read a writer-LLM script when one is configured -
      // /api/llm/script falls back to the user's text verbatim
      if (s.readsScript && typeof params.prompt === "string") {
        const r = await fetch("/api/llm/script", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: params.prompt }),
        }).catch(() => null);
        const d = ScriptV.safeParse(r?.ok ? await r.json().catch(() => null) : null);
        if (d.success && d.data.script) params.prompt = d.data.script;
      }
      const found = findEndpoint(s.endpoint);
      if (found) {
        for (const f of found.workflow.params) {
          if (params[f.name] != null) continue;
          const kind = mediaKindOf(f);
          if (!kind) continue;
          const base = mediaBaseKind(kind);
          const att = atts.find((a) => mediaKind(a) === base && !usedAtt.has(a.url));
          // nearest earlier step whose output kind feeds this param
          let upId: string | null = null;
          for (let k = steps.length - 1; k >= 0; k--) {
            const kw = findEndpoint(steps[k].endpoint_id)?.workflow.kind;
            if (kw && JOB_KIND_OUTPUT[kw] === base) { upId = steps[k].id; break; }
          }
          const url = att?.url ?? (upId ? `$step:${upId}.outputs[0]` : null);
          if (url) {
            if (att) usedAtt.add(att.url);
            params[f.name] = kind === "images" ? [url] : url;
          }
        }
      }
      steps.push({
        id: `s${i + 1}`, title: s.step, endpoint_id: s.endpoint, params,
        depends_on: i > 0 ? [steps[i - 1].id] : [],
      });
    }

    // keep the brief in the session feed - chat restore shows it, and the
    // optimistic bubble leaves pending state on the next poll
    await fetch(`/api/agent/sessions/${sid}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: brief ?? msg.text, record_only: true,
        mode: modeToApi(mode), ask_first: askFirst, planner,
        attachments: atts.map(({ name, url, mime }) => ({ name, url, mime })),
      }),
    }).catch(() => null);

    const r = await fetch("/api/agent/runs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sid, mode: modeToApi(mode), ask_first: askFirst, planner,
        plan: { title: msg.text.trim().slice(0, 120) || "Skill run", steps },
      }),
    });
    const d = ErrV.catch({}).parse(await r.json().catch(() => ({})));
    if (!r.ok) setMsgs((m) => [...m, { role: "agent", text: `⚠ ${d.error ?? `plan refused (${r.status})`}` }]);
    setFiles([]);
    setRunning(false);
  }

  async function runAct(runId: string, action: "approve" | "stop" | "pause" | "resume") {
    const r = await fetch(`/api/agent/runs/${runId}/${action}`, { method: "POST" }).catch(() => null);
    if (r?.ok) {
      const d = z.looseObject({ run: z.unknown() }).safeParse(await r.json().catch(() => null));
      const run = d.success ? RunViewV.safeParse(d.data.run) : null;
      if (run?.success) setRuns((x) => [run.data, ...x.filter((y) => y.id !== run.data.id)]);
    } else {
      const d = ErrV.catch({}).parse(await r?.json().catch(() => ({})));
      setMsgs((m) => [...m, { role: "agent", text: `⚠ ${userError(r?.status, d.error ?? `${action} failed`).message}` }]);
    }
  }

  /** Step edit → POST steps/:stepId (rev = optimistic concurrency); the
   *  returned view replaces the run row. Returns the server's error text -
   *  verbatim, so the form shows the real refusal - or null on success. */
  async function editRunStep(runId: string, stepId: string, edit: {
    params?: Record<string, unknown>; title?: string; endpoint_id?: string; effort?: string; rev: number;
  }): Promise<string | null> {
    const r = await fetch(`/api/agent/runs/${runId}/steps/${stepId}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(edit),
    }).catch(() => null);
    const d = z.looseObject({ run: z.unknown(), error: z.unknown(), rev: z.unknown() })
      .safeParse(r ? await r.json().catch(() => null) : null);
    const run = d.success ? RunViewV.safeParse(d.data.run) : null;
    if (r?.ok && run?.success) { setRuns((x) => [run.data, ...x.filter((y) => y.id !== run.data.id)]); return null; }
    const msg = d.success && typeof d.data.error === "string" ? d.data.error : "step edit refused";
    const rev = d.success && typeof d.data.rev === "number" ? ` (rev ${d.data.rev})` : "";
    const errText = `${r && !r.ok ? userError(r.status, msg).message : msg}${rev}`;
    setMsgs((m) => [...m, { role: "agent", text: `⚠ ${errText}` }]);
    return errText;
  }

  const chatting = msgs.length > 0;
  const busy = sending || activeJobs.some((j) => ["queued", "in_progress"].includes(j.status));
  const submit = (brief: string) => {
    if (!brief.trim() || running || uploading) return;
    const skill = SKILLS.find((s) => brief.startsWith(s.prompt));
    setMsgs((m) => [...m, { role: "user", text: brief + (files.length ? `\n📎 ${files.map((f) => f.name).join(", ")}` : ""), pending: true }]);
    if (skill) {
      // straight to the server: the durable run's own plan card (catalog
      // costs + ETA) is the only card and the only approve gate
      const topic = brief.slice(skill.prompt.length).trim() || brief;
      void submitRun({ role: "agent", text: `Skill: ${skill.name}`, plan: skill.steps(topic), atts: files }, brief);
      setFiles([]);
    }
    else sendToAgent(brief);
  };

  // only skills with a real, graded example run are shown
  const shownSkills = SKILLS.filter((s) => skillExample(s.id));
  const [learn, setLearn] = useState<string | null>(null);
  const filtered = cat === "all" ? shownSkills : shownSkills.filter((s) => CAT_MATCH[cat]?.test(`${s.cat} ${s.name} ${s.desc}`));

  const sidebar = collapsed ? (
    <aside className="hidden w-[44px] shrink-0 flex-col items-center border-r border-[var(--color-line)] bg-[var(--color-panel)] py-3 md:flex" style={{ height: "calc(100vh - 56px)" }}>
      <a href="/ai-assistant" title="AI Assistant" className="flex h-7 w-7 items-center justify-center"><BrandMark size={26} /></a>
      <button className="mt-3 rounded-md p-1.5 text-[var(--color-dim)] hover:bg-[var(--color-panel2)]" title="Expand sidebar" onClick={() => setCollapsed(false)}><Icon n="panel" /></button>
      <button className="mt-1 rounded-md p-1.5 text-[var(--color-dim)] hover:bg-[var(--color-panel2)]" title="New chat" onClick={newChat}><Icon n="plus" /></button>
    </aside>
  ) : (
    <aside className="hidden w-[230px] shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-panel)] md:flex" style={{ height: "calc(100vh - 56px)" }}>
      <div className="flex items-center justify-between px-3 pt-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm font-semibold">
            <BrandMark size={24} className="shrink-0" />
            AI Assistant
          </div>
        </div>
        <div className="flex shrink-0 gap-1 self-start text-[var(--color-dim)]">
          <button className="rounded-md p-1.5 hover:bg-[var(--color-panel2)]" title="Collapse sidebar" onClick={() => setCollapsed(true)}><Icon n="panel" /></button>
        </div>
      </div>
      <button className="mx-3 mt-3 flex items-center gap-2 rounded-lg bg-[var(--color-panel2)] px-3 py-2 text-sm hover:bg-[var(--color-line)]" onClick={newChat}>
        <Icon n="plus" /> New chat <span className="ml-auto text-[10px] text-[var(--color-dim)]">⌘↵</span>
      </button>
      <nav className="mt-1 space-y-0.5 px-3 pt-2 text-sm text-[var(--color-dim)]">
        <a href="/projects" className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-[var(--color-panel2)] hover:text-[var(--color-fg)]"><Icon n="folder" /> Projects</a>
      </nav>
      <div className="mt-4 flex items-center justify-between px-5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-dim)]">
        Chats <Icon n="chev" s={11} />
      </div>
      <div className="flex-1 overflow-y-auto px-3 pt-2">
        {sessionList.length === 0 ? (
          <div className="mt-6 flex flex-col items-center gap-2 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--color-panel2)] text-[var(--color-dim)]"><Icon n="folder" s={20} /></div>
            <div className="text-xs font-semibold">No chats yet</div>
            <div className="text-[11px] text-[var(--color-dim)]">Create one to get started</div>
          </div>
        ) : sessionList.map((s) => (
          <button key={s.id} onClick={() => openChat(s.id)}
            className={`w-full truncate rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-[var(--color-panel2)] ${s.id === sessionId ? "bg-[var(--color-panel2)] text-[var(--color-fg)]" : "text-[var(--color-dim)]"}`}>
            {s.title ?? s.id.slice(0, 8)}
          </button>
        ))}
      </div>
    </aside>
  );

  // the todo checklist lives above the composer - the planner refreshes it
  // per plan, the run's todo step rewrites it, the user ticks it (T5)
  const checklist = todos.length > 0 && (
    <div className="mb-1.5 space-y-0.5 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2" data-testid="session-todo">
      {todos.map((t, i) => (
        <label key={i} className="flex cursor-pointer items-center gap-2 text-xs" data-testid={`todo-item-${i}`}>
          <input type="checkbox" checked={t.done} onChange={() => tickTodo(i)}
            className="h-3.5 w-3.5 accent-[var(--color-accent)]" />
          <span className={t.done ? "text-[var(--color-dim)] line-through" : ""}>{t.text}</span>
        </label>
      ))}
    </div>
  );

  const composer = (
    <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel2)] p-2">
      <form onSubmit={(e) => { e.preventDefault(); const b = input; setInput(""); submit(b); }}>
        <textarea
          className="w-full resize-none bg-transparent px-2.5 pt-1.5 text-sm outline-none placeholder:text-[var(--color-dim)]"
          rows={2}
          placeholder={PLACEHOLDERS[phIdx]}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); const b = input; setInput(""); submit(b); }
            else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); newChat(); }
          }}
        />
        {files.length > 0 || uploading ? (
          <div className="flex flex-wrap gap-1 px-2 pb-1">
            {files.map((f) => (
              <span key={f.url} className="flex items-center gap-1 rounded-md bg-[var(--color-line)] px-2 py-0.5 text-[10px]">
                {f.name}
                <button type="button" className="text-[var(--color-dim)] hover:text-[var(--color-fg)]" onClick={() => setFiles((x) => x.filter((y) => y.url !== f.url))}>×</button>
              </span>
            ))}
            {uploading && <span className="rounded-md bg-[var(--color-line)] px-2 py-0.5 text-[10px] text-[var(--color-dim)]">uploading…</span>}
          </div>
        ) : null}
        <div className="flex items-center gap-1.5 px-1 pb-0.5">
          <button type="button" title="Attach" className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--color-dim)] hover:bg-[var(--color-line)]" onClick={() => fileRef.current?.click()}><Icon n="plus" s={15} /></button>
          <input ref={fileRef} type="file" multiple className="hidden" accept="image/*,video/*,audio/*" onChange={(e) => attach(e.target.files)} />
          <ModeMenu mode={mode} locked={modeLocked}
            onPick={(m) => {
              setMode(m);
              // a remote pick becomes unreachable in Offline - drop it back to auto
              if (m === "Offline") {
                const allowed = new Set(["", "builtin", ...providerPicks.filter((p) => p.local).map((p) => p.value)]);
                setPlanner((p) => allowed.has(p) ? p : "");
              }
            }}
            chev={<Icon n="chev" s={11} />} />
          <div className="relative" ref={plannerWrap}>
            <button type="button" title="Planner model" data-testid="planner-pick" className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-[var(--color-dim)] hover:bg-[var(--color-line)]" onClick={() => setPlannerOpen((o) => !o)}>
              <Icon n="spark" s={12} /> <span className="text-[var(--color-faint)]">Model:</span> {plannerOptions.find((o) => o.value === planner)?.label ?? "Auto"} <Icon n="chev" s={11} />
            </button>
            {plannerOpen && (
              <div data-testid="planner-menu" className={`absolute left-0 z-30 w-72 ${plannerUp ? "bottom-full mb-1" : "top-full mt-1"} rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-1 shadow-xl`}>
                {plannerOptions.map((o) => (
                  <button type="button" key={o.value || "auto"} className={`w-full rounded-lg px-2.5 py-2 text-left hover:bg-[var(--color-panel2)] ${o.value === planner ? "text-[var(--color-accent)]" : ""}`}
                    onClick={() => { setPlanner(o.value); setPlannerOpen(false); }}>
                    <div className="text-xs font-semibold">{o.label}</div>
                    {o.hint && <div className="text-[10px] text-[var(--color-dim)]">{o.hint}</div>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex-1" />
          <div className="relative" ref={agentWrap}>
            <button type="button" title="Autonomy" className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs ${askFirst ? "text-[var(--color-fg)]" : "text-[var(--color-dim)]"}`} onClick={() => setAgentOpen((o) => !o)}>
              <Icon n="shield" s={12} /> <span><span className="block text-left leading-none">{askFirst ? "Confirm" : "Auto-run"}</span><span className="block text-left text-[10px] leading-tight text-[var(--color-dim)]">{askFirst ? "Confirm before running" : "Run without asking"}</span></span> <Icon n="chev" s={11} />
            </button>
            {agentOpen && (
              <div className={`absolute right-0 z-30 w-56 ${agentUp ? "bottom-full mb-1" : "top-full mt-1"} rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-1 shadow-xl`}>
                {([["Confirm before running", "Review each plan before it runs", true], ["Run without asking", "Plans start as soon as they're priced", false]] as const).map(([l, d, v]) => (
                  <button type="button" key={l} className={`w-full rounded-lg px-2.5 py-2 text-left hover:bg-[var(--color-panel2)] ${v === askFirst ? "text-[var(--color-accent)]" : ""}`} onClick={() => { setAskFirst(v); setAgentOpen(false); }}>
                    <div className="text-xs font-semibold">{l}</div>
                    <div className="text-[10px] text-[var(--color-dim)]">{d}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
          {sessionId && busy ? (
            <button type="button" className="flex h-8 w-8 items-center justify-center rounded-xl bg-red-400/20 text-red-300" onClick={interrupt} title="Stop"><Icon n="x" s={14} /></button>
          ) : (
            <button type="submit" className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--color-accent)] text-black disabled:opacity-40" disabled={running || uploading} title="Send"><Icon n="up" s={15} /></button>
          )}
        </div>
      </form>
    </div>
  );

  // the project chip - bound sessions link back by title; unbound still
  // says "No project" and points at the list
  const projectChip = boundProject ? (
    <a href={`/projects/${boundProject}`} data-testid="project-chip"
      className="flex items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-[var(--color-panel2)]">
      <Icon n="folder" s={12} /> {projectTitle ?? "Project"}
    </a>
  ) : (
    <a href="/projects" data-testid="project-chip"
      className="flex items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-[var(--color-panel2)]">
      <Icon n="folder" s={12} /> No project
    </a>
  );

  const metaChips = (
    <div className="mt-3 flex items-center gap-2 text-[11px] text-[var(--color-dim)]">
      {projectChip}
      <div className="flex-1" />
      <a href="/mcp" className="flex items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-[var(--color-panel2)]"><Icon n="grid" s={12} /> Try MCP</a>
    </div>
  );

  if (!chatting) {
    /* empty state - sidebar + centered greeting + composer + category pills + visual skill cards */
    return (
      <div className="flex">
        <Suspense fallback={null}><ProjectParamProbe onProject={setWantedProject} /></Suspense>
        {sidebar}
        <div className="relative flex min-w-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-10" style={{ height: "calc(100vh - 56px)" }}>
          <div className="mt-[13vh] flex w-full max-w-[640px] flex-col items-center">
            <h1 className="flex items-center gap-3 whitespace-nowrap font-display text-2xl font-extrabold uppercase tracking-tight sm:text-3xl">
              <BrandMark size={36} className="shrink-0" />
              What are we creating today?
            </h1>
            <div className="mt-8 w-full">{checklist}{composer}</div>
            {metaChips}
          </div>
          {shownSkills.length > 0 && <div className="mt-16 flex w-full max-w-[1040px] flex-col">
            <div className="mb-4 flex items-center gap-2">
              {CATS.filter((c) => c.id === "all" || shownSkills.some((s) => CAT_MATCH[c.id]?.test(`${s.cat} ${s.name} ${s.desc}`))).map((c) => (
                <button key={c.id} onClick={() => setCat(c.id)} className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors ${cat === c.id ? "bg-[var(--color-panel2)] text-[var(--color-fg)]" : "text-[var(--color-dim)] hover:text-[var(--color-fg)]"}`}>
                  <Icon n={c.icon} s={13} /> {c.label}
                </button>
              ))}
            </div>
            <div id="skills" className="grid grid-cols-1 gap-5 pb-4 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((s) => {
                const ex = skillExample(s.id)!;
                return (
                  <div key={s.id} className="group text-left" data-skill={s.id}>
                    <div className="relative aspect-[4/3] overflow-hidden rounded-2xl bg-[var(--color-panel)] shadow-[0_8px_30px_rgba(0,0,0,.35)] ring-1 ring-white/[0.06] transition-shadow group-hover:ring-white/15">
                      {ex.kind === "video"
                        ? <video src={ex.media} muted loop playsInline autoPlay preload="metadata" className="absolute inset-0 h-full w-full object-cover" />
                        // eslint-disable-next-line @next/next/no-img-element
                        : <img src={ex.media} alt={s.name} loading="lazy" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />}
                      <div className="absolute inset-0 flex flex-col justify-end gap-2 bg-gradient-to-t from-black/80 via-black/20 to-transparent p-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <p className="line-clamp-2 text-xs text-white/85">{s.desc}</p>
                        <div className="flex gap-2">
                          <button className="btn btn-primary btn-sm" data-testid="skill-try" onClick={() => submit(`${s.prompt} ${ex.brief}`)}>Try this example</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setLearn(learn === s.id ? null : s.id)}>Learn more</button>
                        </div>
                      </div>
                    </div>
                    <div className="mt-2.5 flex items-center justify-between px-0.5">
                      <span className="text-sm font-semibold">{s.name}</span>
                      <span className="rounded-md bg-[var(--color-panel2)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-faint)]">Skill</span>
                    </div>
                    {learn === s.id && (
                      <div className="mt-2 rounded-xl bg-[var(--color-panel)] p-3 text-xs text-[var(--color-dim)] ring-1 ring-white/[0.06]">
                        <p>{s.desc}</p>
                        <p className="mt-1.5 text-[var(--color-faint)]">Example brief: “{ex.brief}”</p>
                        <ol className="mt-1.5 list-decimal space-y-0.5 pl-4">{s.steps(ex.brief).map((t, j) => <li key={j}>{t.step} <span className="text-[var(--color-faint)]">· {t.endpoint.replace("motionfield/", "")}</span></li>)}</ol>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex">
      <Suspense fallback={null}><ProjectParamProbe onProject={setWantedProject} /></Suspense>
      {sidebar}
      <div className="mx-auto flex w-full max-w-[820px] flex-1 flex-col px-4" style={{ height: "calc(100vh - 56px)" }}>
        <div className="flex items-center justify-between py-3 text-xs text-[var(--color-dim)]">
          <span className="flex items-center gap-2">AI Assistant {projectChip}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${sessionStatus === "awaiting_input" ? "bg-amber-400/15 text-amber-300" : sessionStatus === "interrupted" ? "bg-red-400/15 text-red-300" : "bg-emerald-400/15 text-emerald-300"}`}>
            {sessionStatus.replaceAll("_", " ")}
          </span>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto pb-4 pr-1">
          {msgs.map((m, i) => (
            <div key={i} className={m.role === "user" ? "text-right" : ""}>
              <div className={`inline-block max-w-[82%] text-left text-sm ${m.role === "user" ? "rounded-2xl bg-[var(--color-accent)] px-4 py-2.5 text-black" : ""}`}>
                {m.tool ? <span className="mr-1.5 rounded bg-[var(--color-line)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--color-dim)]" title={m.tool}>· tool</span> : null}
                {m.text}
                {!!m.options?.length && (
                  <div className="mt-2 flex flex-wrap gap-1.5" data-testid="ask-options">
                    {m.options.map((o, j) => (
                      <button key={j} type="button" data-testid={`ask-option-${j}`}
                        className="rounded-full border border-[var(--color-line)] bg-[var(--color-panel2)] px-3 py-1 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-fg)]"
                        onClick={() => submit(o)}>
                        {o}
                      </button>
                    ))}
                  </div>
                )}
                {m.lines && (
                  <div className="mt-3 space-y-1.5">
                    {m.lines.map((s, j) => (
                      <div key={j} className="flex items-center gap-2 rounded-lg bg-[var(--color-panel2)] px-3 py-2 text-xs">
                        <span className={s.status === "done" ? "text-emerald-300" : s.status === "running" ? "text-amber-300" : "text-[var(--color-dim)]"}>
                          {s.status === "done" ? "✓" : s.status === "running" ? "…" : s.status === "failed" ? "✕" : "○"}
                        </span>
                        {s.label}
                      </div>
                    ))}
                  </div>
                )}
                {(m.runId || m.planSteps) && (
                  <RunTreeCard
                    run={m.runId ? runs.find((r) => r.id === m.runId) : undefined}
                    planSteps={m.planSteps ?? []}
                    jobs={activeJobs}
                    onAct={runAct}
                    onEditStep={editRunStep}
                  />
                )}
                {m.results?.filter((r) => typeof r.url === "string" && r.url).map((r, j) => (
                  <div key={j} className="media-tile mt-3 max-w-md">
                    {r.type === "video" ? <video src={r.url} controls muted autoPlay loop playsInline className="w-full" />
                      : r.type === "audio" ? <audio src={r.url} controls className="w-full" />
                      : r.type === "text" || r.type === "json" ? <OutThumb o={r} />
                      : <img src={r.url} className="w-full" />}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {activeJobs.length > 0 && (
            <div className="space-y-1.5">
              {activeJobs.map((j) => (
                <div key={j.id} className="max-w-md rounded-xl border border-[var(--color-line)] bg-[var(--color-panel2)] px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate">{j.endpointId}</span>
                    <span className="shrink-0 text-[var(--color-dim)]">{j.status === "in_progress" ? `${j.progress ?? 0}%` : j.status.replaceAll("_", " ")}</span>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--color-line)]">
                    <div className="h-full rounded-full bg-[var(--color-accent)] transition-all" style={{ width: `${j.status === "queued" ? 4 : (j.progress ?? 4)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
          <div ref={endRef} />
        </div>

        <div className="pb-4">{checklist}{composer}</div>
      </div>
    </div>
  );
}
