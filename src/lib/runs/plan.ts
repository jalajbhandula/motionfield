import { z } from "zod";
import { coerceParams, JobError } from "@/lib/jobs";
import { findEndpoint } from "@/lib/catalog/video-models";
import { endpointLicense } from "@/lib/catalog/license-gate";
import { needsOptIn } from "@/lib/catalog/licenses";
import type { ModelDef, WorkflowDef } from "@/lib/catalog/types";
import { JOB_KIND_OUTPUT } from "@/lib/generation/types";
import { isLoopbackUrl } from "@/lib/llm/offline";
import { toolForEndpoint, type AgentTool } from "@/lib/agent/tools/registry";
import { isPresetParam, presetGate } from "@/lib/agent/tools/catalog";

/**
 * The run-engine plan schema + validation.
 *
 * A Plan is an ordered list of catalog-endpoint steps. Steps execute in plan
 * order; `depends_on` (backward refs only, so the order is topological) gates
 * a step until its upstream steps finish. A step consumes upstream output
 * through `"$step:<id>.outputs[<n>]"` values in media params - resolved at
 * submit time, never invented.
 *
 * validatePlan throws JobError(422) with plain wording - every refusal is
 * visible, no silent fallbacks.
 */

/** `"$step:s1.outputs[0]"` - a whole-value ref to an upstream step's nth output. */
export const STEP_REF = /^\$step:([A-Za-z0-9_-]{1,40})\.outputs\[(\d{1,2})\]$/;

export const PLAN_STEP = z.object({
  id: z.string().min(1).max(40),
  title: z.string().min(1).max(160),
  endpoint_id: z.string().min(1).max(160),
  params: z.record(z.string(), z.unknown()).default({}),
  depends_on: z.array(z.string().min(1).max(40)).max(24).default([]),
});
export const PLAN = z.object({
  title: z.string().min(1).max(200).optional(),
  steps: z.array(PLAN_STEP).min(1).max(12),
});
export type Plan = z.infer<typeof PLAN>;
export type PlanStep = z.infer<typeof PLAN_STEP>;

/** A catalog endpoint the turn may submit - planner listing and validator share this. */
export interface LiveEndpoint {
  model: ModelDef;
  workflow: WorkflowDef;
}

export interface NormalizedStep {
  stepId: string;
  title: string;
  endpointId: string;
  /** Declared params - may carry $step refs, resolved at submit. */
  params: Record<string, unknown>;
  dependsOn: string[];
  /** null for builtin agent/* steps (job-less: text/json leaves, 0 cr). */
  workflow: WorkflowDef | null;
  /** the builtin tool a agent/* step runs - set exactly when workflow is null */
  tool?: AgentTool;
  cost: number;
}

/** What a normalized step produces - catalog output kind, or the builtin
 *  tool's declared output (text/json - never a media kind). */
export function stepOutputKind(s: Pick<NormalizedStep, "workflow" | "tool">): string {
  if (s.workflow) return JOB_KIND_OUTPUT[s.workflow.kind];
  return s.tool?.output ?? "json";
}

/* ---- media params (shared helpers live in ./media - client-importable) ---- */

export { MEDIA_TYPES, MEDIA_PARAM_KIND, mediaKindOf, mediaBaseKind } from "./media";
import { attachmentKind, mediaBaseKind, mediaKindOf, type MediaBase } from "./media";

/* ---- $step refs ---- */

export interface StepRef {
  stepId: string;
  index: number;
  /** the params key carrying the ref (top-level name, array root or dotted path) */
  where: string;
}

/** All $step refs anywhere inside a params object. */
export function collectRefs(v: unknown, out: StepRef[] = [], path = ""): StepRef[] {
  if (typeof v === "string") {
    const m = STEP_REF.exec(v);
    if (m) out.push({ stepId: m[1], index: parseInt(m[2], 10), where: path });
    return out;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => collectRefs(x, out, `${path}[${i}]`));
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) collectRefs(x, out, path ? `${path}.${k}` : k);
  }
  return out;
}

/** Plan-shape issues / refused steps → 422 JobError with plain wording. */
export function planRefuse(msg: string): never {
  throw new JobError(msg, 422);
}

/** What a literal media value's file kind actually is - an attached brief
 *  file reports its own kind through attKind semantics (mime, then ext), a
 *  session's lastOutputs bucket knows the url it produced, a known file
 *  extension is the fallback. null = undetermined - never refused. */
const URL_EXT_KIND: [RegExp, MediaBase][] = [
  [/\.(mp4|webm|mov|mkv|m4v|avi)(?:[?#].*)?$/i, "video"],
  [/\.(wav|mp3|flac|ogg|m4a|aac)(?:[?#].*)?$/i, "audio"],
  [/\.(png|jpe?g|webp|gif|avif|bmp|tiff?|svg)(?:[?#].*)?$/i, "image"],
];

/** The file context a literal media value may resolve against. */
export interface LiteralFileCtx {
  /** the brief's attachments - a matching url takes the file's own kind */
  atts?: { url: string; mime?: string; name?: string }[];
  /** the session's last output url per kind - the bucket is the kind */
  lastOutputs?: Partial<Record<MediaBase, string>>;
}

function literalMediaKind(v: string, ctx: LiteralFileCtx): MediaBase | null {
  const att = ctx.atts?.find((a) => a.url === v);
  if (att) return attachmentKind(att);
  for (const k of ["image", "video", "audio"] as const)
    if (ctx.lastOutputs?.[k] === v) return k;
  for (const [re, k] of URL_EXT_KIND) if (re.test(v)) return k;
  return null;
}

/**
 * Validate a parsed-or-raw plan against the turn's endpoint allowlist:
 * ids unique, endpoints named + allowed + licensed, depends_on backward-only,
 * $step refs inside a media param that the referenced (transitively depended
 * on) step actually feeds, required params present or ref-backed.
 * Returns normalized steps in execution order, with each step's credit cost.
 */
export function validatePlan(
  raw: unknown,
  eps: LiveEndpoint[],
  opts: { mode: "auto" | "offline" | "custom"; optIn: boolean } & LiteralFileCtx,
): NormalizedStep[] {
  const parsed = PLAN.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    planRefuse(`the plan is malformed - ${issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "bad shape"}`);
  }
  const plan = parsed.data;
  const allowed = new Map(eps.map((e) => [e.workflow.endpointId, e]));

  const steps: NormalizedStep[] = [];
  const byStepId = new Map<string, NormalizedStep>();
  const transMap = new Map<string, Set<string>>();
  const ids = new Set<string>();
  for (const s of plan.steps) {
    if (ids.has(s.id)) planRefuse(`the plan repeats step id "${s.id}"`);

    const found = findEndpoint(s.endpoint_id);
    const tool = found ? null : toolForEndpoint(s.endpoint_id);
    if (!found && !tool) planRefuse(`That endpoint isn't installed on this machine - "${s.endpoint_id}"`);

    /* builtin agent/* step - job-less: its zod args schema is the whole
     * contract; offline mode still forbids non-loopback target urls.
     * step:false tools (ask_user) are planner replies, never steps. */
    if (tool) {
      if (tool.step === false) planRefuse(`${tool.name} is a planner reply, not a run step`);
      const args = tool.args ? tool.args.safeParse(s.params) : { success: true as const, data: s.params };
      if (!args.success) {
        const issue = args.error.issues[0];
        planRefuse(`step "${s.id}" - ${issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "bad tool arguments"}`);
      }
      const params = args.data;
      for (const ref of collectRefs(params))
        planRefuse(`step "${s.id}" uses $step output in "${ref.where}" - tool steps take no chained media`);
      if (opts.mode === "offline") {
        for (const name of tool.urlParams ?? []) {
          const v = params[name];
          if (typeof v === "string" && /^https?:\/\//i.test(v) && !isLoopbackUrl(v))
            planRefuse(`step "${s.id}" targets a remote URL - Offline only runs on this machine`);
        }
      }
      const depSet = new Set<string>();
      for (const d of s.depends_on) {
        if (d === s.id) planRefuse(`step "${s.id}" can't depend on itself`);
        if (!ids.has(d)) planRefuse(`step "${s.id}" depends on "${d}" - dependencies must come earlier in the plan`);
        depSet.add(d);
      }
      steps.push({
        stepId: s.id,
        title: s.title,
        endpointId: s.endpoint_id,
        params,
        dependsOn: s.depends_on,
        workflow: null,
        tool,
        cost: 0,
      });
      byStepId.set(s.id, steps[steps.length - 1]);
      transMap.set(s.id, depSet);
      ids.add(s.id);
      continue;
    }

    // license + mode gates hold regardless of how the caller built the
    // allowlist - validatePlan is the last line before a job can exist
    if (!found) planRefuse(`That endpoint isn't installed on this machine - "${s.endpoint_id}"`);
    const licCls = endpointLicense(found.workflow).class;
    if (licCls === "banned") planRefuse("That model can't run - its license is blocked.");
    if (needsOptIn(licCls) && !opts.optIn)
      planRefuse("That model needs the license opt-in - turn it on in Settings → Licenses, then ask again.");
    if (opts.mode === "offline" && found.workflow.heavy) planRefuse("That model isn't available in Offline mode.");
    const live = allowed.get(s.endpoint_id);
    if (!live) planRefuse("That endpoint isn't available in this session.");
    const { workflow } = live;

    // param-level license (e.g. explainer's motion_model) - same gate createJob
    // applies, checked before any job can exist
    const paramLicense = endpointLicense(workflow, s.params).class;
    if (paramLicense === "banned") planRefuse("That option can't run - its license is blocked.");
    if (needsOptIn(paramLicense) && !opts.optIn)
      planRefuse("That option needs the license opt-in - see Settings → Licenses.");

    // offline media inputs: a plan that fetches remote media would make a
    // network call offline mode exists to prevent - refuse before any job
    // exists (loopback http(s) and /files/ paths are local, they pass)
    if (opts.mode === "offline") {
      for (const f of workflow.params) {
        if (!mediaKindOf(f)) continue;
        const raw = s.params[f.name];
        for (const v of Array.isArray(raw) ? raw : [raw]) {
          if (typeof v === "string" && /^https?:\/\//i.test(v) && !isLoopbackUrl(v))
            planRefuse(`step "${s.id}" takes "${f.name}" from a remote URL - Offline only runs files on this machine`);
        }
      }
    }

    // a literal media value must be the kind the param consumes - known by
    // the file's extension, by the brief attachment carrying that exact
    // url, or by the session's lastOutputs bucket. A wrong base kind would
    // only fail at the worker after a job exists; refuse here. $step refs
    // are kind-checked below; undetermined urls pass.
    for (const f of workflow.params) {
      const kind = mediaKindOf(f);
      if (!kind) continue;
      const need = mediaBaseKind(kind);
      const pv = s.params[f.name];
      for (const v of Array.isArray(pv) ? pv : [pv]) {
        if (typeof v !== "string" || STEP_REF.test(v) || v.startsWith("@")) continue;
        const got = literalMediaKind(v, opts);
        if (got && got !== need)
          planRefuse(`step "${s.id}" needs a ${need} for "${f.name}", but the attached file is a ${got}`);
      }
    }

    // depends_on: existing earlier steps only - execution order is then
    // automatically topological and cycles are impossible
    const depSet = new Set<string>();
    for (const d of s.depends_on) {
      if (d === s.id) planRefuse(`step "${s.id}" can't depend on itself`);
      if (!ids.has(d)) planRefuse(`step "${s.id}" depends on "${d}" - dependencies must come earlier in the plan`);
      depSet.add(d);
    }

    // $step refs: inside a media param, pointing at a transitively-depended
    // step whose output type feeds that param. Backward-only deps mean each
    // dep's transitive set is already in transMap - no recursion needed.
    const transDeps = new Set<string>();
    for (const d of depSet) {
      transDeps.add(d);
      for (const t of transMap.get(d) ?? []) transDeps.add(t);
    }
    transMap.set(s.id, transDeps);
    for (const ref of collectRefs(s.params)) {
      const paramName = ref.where.split(/[.\[]/)[0];
      const field = workflow.params.find((f) => f.name === paramName);
      const kind = field ? mediaKindOf(field) : null;
      if (!kind) planRefuse(`step "${s.id}" uses $step output in "${paramName}" - only media params can chain steps`);
      if (!transDeps.has(ref.stepId))
        planRefuse(`step "${s.id}" uses $step:${ref.stepId} but doesn't depend on it`);
      const outType = stepOutputKind(byStepId.get(ref.stepId)!);
      if (outType !== mediaBaseKind(kind))
        planRefuse(`step "${s.id}" needs a ${mediaBaseKind(kind)} for "${paramName}", but step "${ref.stepId}" outputs ${outType}`);
    }

    // required params - a value or a $step ref in place is fine; nothing else
    for (const f of workflow.params) {
      if (!f.required) continue;
      const v = s.params[f.name];
      const filled = v !== undefined && v !== "" && v !== null;
      if (!filled) planRefuse(`step "${s.id}" (${s.title}) is missing required input "${f.name}"`);
    }

    const params = coerceParams(workflow, { ...s.params });
    // declared params only, and values must honestly fit their field - after
    // coercion a select must sit in its enum, a number must be finite, a
    // boolean must be a boolean. ($step refs never reach this: a non-media
    // param holding one was refused above, and media types aren't checked.)
    for (const [k, v] of Object.entries(s.params)) {
      const f = workflow.params.find((p) => p.name === k);
      if (!f) planRefuse(`step "${s.id}" sets "${k}", which ${workflow.label} doesn't take`);
      if (v === undefined || v === null || v === "") continue;
      const cv = params[k];
      if (Array.isArray(f.enum) && f.enum.length && !(f.enum as unknown[]).includes(cv))
        planRefuse(`step "${s.id}" sets "${k}" to ${JSON.stringify(v)}, which ${workflow.label} doesn't allow - pick one of ${f.enum.join(", ")}`);
      if (["number", "integer", "slider"].includes(f.type) && (typeof cv !== "number" || !Number.isFinite(cv)))
        planRefuse(`step "${s.id}" sets "${k}" to ${JSON.stringify(v)}, which ${workflow.label} needs as a number`);
      if (typeof cv === "number" && Number.isFinite(cv)) {
        if (f.min !== undefined && cv < f.min)
          planRefuse(`step "${s.id}" sets "${k}" to ${JSON.stringify(v)} - ${workflow.label} needs ${k} ≥ ${f.min}`);
        if (f.max !== undefined && cv > f.max)
          planRefuse(`step "${s.id}" sets "${k}" to ${JSON.stringify(v)} - ${workflow.label} allows up to ${f.max} for ${k}`);
      }
      if (f.type === "boolean" && typeof cv !== "boolean")
        planRefuse(`step "${s.id}" sets "${k}" to ${JSON.stringify(v)}, which ${workflow.label} takes as true or false`);
      // preset params may only name a specVisible preset - hidden,
      // unverified, stale-hash or failed presets are refused exactly like
      // resolveParams refuses them at job submit: "preset not available"
      if (isPresetParam(k) && typeof cv === "string" && cv && presetGate(cv) !== "ok")
        planRefuse(`step "${s.id}" names preset "${JSON.stringify(v)}" - preset not available`);
    }
    steps.push({
      stepId: s.id,
      title: s.title,
      endpointId: s.endpoint_id,
      params,
      dependsOn: s.depends_on,
      workflow,
      cost: Math.max(0, workflow.cost(params)),
    });
    byStepId.set(s.id, steps[steps.length - 1]);
    ids.add(s.id);
  }
  return steps;
}
