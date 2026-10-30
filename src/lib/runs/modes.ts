import { z } from "zod";
import { findEndpoint } from "@/lib/catalog/video-models";
import { endpointLicense } from "@/lib/catalog/license-gate";
import { needsOptIn } from "@/lib/catalog/licenses";
import { isLoopbackUrl } from "@/lib/llm/offline";
import { JOB_KIND_OUTPUT } from "@/lib/generation/types";
import type { ParamField, WorkflowDef } from "@/lib/catalog/types";
import { mediaBaseKind, mediaKindOf } from "./media";
import { turnEndpoints } from "./endpoints";
import type { LiveEndpoint } from "./plan";

/**
 * Run modes - the single policy source for auto / offline / custom.
 *
 *   auto - today's behavior: remote+local routes allowed, all live
 *             endpoints; the approval gate is ask-first or estimate > cap.
 *   offline - loopback only: the planner list, the picker and every call
 *             refuse non-loopback LLM routes; heavy (cloud-grade) endpoints
 *             and non-loopback http(s) media refs are refused before any
 *             network call. The Settings Offline lock forces this mode.
 *   custom - every run parks at awaiting_approval whatever it costs; each
 *             step exposes a model picker (same output kind, media inputs
 *             the step can fill, restricted only with opt-in) and an effort
 *             select. Changes go through editStep - no client-only state.
 */

export const RUN_MODES = ["auto", "offline", "custom"] as const;
export type RunMode = (typeof RUN_MODES)[number];
export const EFFORTS = ["draft", "standard", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModePolicy {
  mode: RunMode;
  /** "loopback" = LLM routes must resolve to a loopback http(s) base URL */
  network: "any" | "loopback";
  /** "always" = every run parks at awaiting_approval regardless of cost */
  gate: "cap" | "always";
  /** the endpoint allowlist for the turn (turnEndpoints applies mode rules) */
  endpoints: LiveEndpoint[];
  /** is a resolved LLM route legal in this mode? (offline → loopback, no CLI) */
  llmRouteOk(route: { baseUrl: string; wire: string }): boolean;
}

export async function modePolicy(rawMode: string, userId: string): Promise<ModePolicy> {
  const mode = z.enum(RUN_MODES).catch("auto").parse(rawMode);
  const endpoints = await turnEndpoints(mode, userId);
  const loopback = mode === "offline";
  return {
    mode,
    network: loopback ? "loopback" : "any",
    gate: mode === "custom" ? "always" : "cap",
    endpoints,
    llmRouteOk: loopback
      ? (r) => r.wire !== "cli" && isLoopbackUrl(r.baseUrl)
      : () => true,
  };
}

/* ----------------------------- effort params ----------------------------- */

/** The knobs an effort level owns - quality/cost params only. Never aspect,
 *  prompt, media inputs, output COUNT (batch_size/num_images/scenes - an
 *  effort pick must not multiply a job's cost or outputs) or style semantics
 *  (denoise moves an img2img away from its source - that's a creative
 *  choice, not effort). Exported so editStep's effort-provenance logic can
 *  tell whether a params edit touched an effort-owned field. */
export const EFFORT_PARAMS = new Set([
  "resolution", "duration", "steps", "fps", "num_frames", "clip_duration",
]);

/** Resolution ranks - select enums aren't always numeric or ordered. */
const RES_RANK: Record<string, number> = {
  "320p": 0, "480p": 1, "540p": 2, "576p": 3, "720p": 4, "1K": 5,
  "1080p": 6, "1440p": 7, "2K": 8, "4K": 9, "8K": 10,
};

function rankOf(f: ParamField, v: unknown): number {
  if (f.name === "resolution") return RES_RANK[String(v)] ?? 999;
  const n = Number(v);
  return Number.isFinite(n) ? n : 999; // non-numeric enum values sort last
}

/** A param value the effort may emit: never a banned-license variant, and
 *  restricted variants only with opt-in (licenseVariants carries per-value
 *  classes - e.g. the explainer's motion_model picks). */
function valueAllowed(wf: WorkflowDef, f: ParamField, v: unknown, optIn: boolean): boolean {
  const variants = wf.licenseVariants;
  if (!variants || variants.param !== f.name) return true;
  const info = variants.byValue[String(v)];
  if (!info) return true;
  return info.class !== "banned" && (!needsOptIn(info.class) || optIn);
}

/**
 * The param overrides an effort level derives from the endpoint's own
 * declarations - draft = the lowest declared value, standard = the endpoint
 * default, high = the highest value whose license isn't blocked (restricted
 * needs the opt-in). Only fields validatePlan would accept are emitted:
 * enum membership is checked by construction, numeric bounds come from
 * min/max, and nothing outside EFFORT_PARAMS is touched.
 */
export function effortParams(wf: WorkflowDef, effort: Effort, optIn = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of wf.params) {
    if (!EFFORT_PARAMS.has(f.name) || mediaKindOf(f)) continue;
    if (Array.isArray(f.enum) && f.enum.length) {
      const vals = f.enum.filter((v) => valueAllowed(wf, f, v, optIn));
      if (!vals.length) continue;
      if (effort === "standard") {
        if (f.default !== undefined && vals.some((v) => v === f.default)) out[f.name] = f.default;
        continue;
      }
      out[f.name] = vals.reduce((a, b) =>
        effort === "draft" ? (rankOf(f, b) < rankOf(f, a) ? b : a)
                           : (rankOf(f, b) > rankOf(f, a) ? b : a));
    } else if (["number", "integer", "slider"].includes(f.type)) {
      const v = effort === "draft" ? (f.min ?? f.default)
        : effort === "high" ? numericHigh(f)
        : f.default;
      if (v !== undefined) out[f.name] = v;
    } else if (effort === "standard" && f.default !== undefined) {
      out[f.name] = f.default;
    }
  }
  return out;
}

/** "high" on an unbounded numeric: 2× the endpoint default, clamped inside
 *  its declared [min..max] - the declared bound is a hard ceiling, not a
 *  quality target (a 50-cap on sampler steps would mean "high" = 50). */
function numericHigh(f: ParamField): number | undefined {
  const def = typeof f.default === "number" && Number.isFinite(f.default) ? f.default : undefined;
  let v: number | undefined = def !== undefined ? def * 2 : f.max;
  if (v === undefined) return undefined;
  if (f.max !== undefined && v > f.max) v = f.max;
  if (f.min !== undefined && v < f.min) v = f.min;
  return f.type === "integer" ? Math.round(v) : v;
}

/** True when a step's effort-knob values differ from the endpoint's declared
 *  defaults - its ETA then honestly reads "unknown" (the endpoint median
 *  only describes default-spec jobs). Stored params are coerceParams'd. */
export function effortDiffers(wf: WorkflowDef, params: Record<string, unknown>): boolean {
  for (const f of wf.params) {
    if (!EFFORT_PARAMS.has(f.name) || mediaKindOf(f)) continue;
    const v = params[f.name];
    if (v === undefined || v === null || v === "") continue;
    if (f.default === undefined || String(v) !== String(f.default)) return true;
  }
  return false;
}

/* ---------------------------- model options ------------------------------ */

export interface StepModelOption {
  endpoint_id: string;
  /** "Wan 2.1 · Text to video" */
  label: string;
  restricted: boolean;
  heavy: boolean;
}

/** Transitive depends_on closure over step ids. */
function transitiveDeps(stepId: string, byStepId: Map<string, { step_id: string; depends_on: string[] }>): Set<string> {
  const out = new Set<string>();
  const seed = byStepId.get(stepId);
  for (const d of seed?.depends_on ?? []) out.add(d);
  for (let grew = true; grew;) {
    grew = false;
    for (const s of byStepId.values())
      if (!out.has(s.step_id) && s.step_id !== stepId && s.depends_on.some((d) => out.has(d))) { out.add(s.step_id); grew = true; }
  }
  return out;
}

/** The first (deepest) transitive dep of `step` whose output kind is `base`,
 *  nearest to the step in plan order - what a $step ref should point at. */
export function nearestDepOfKind(
  step: { step_id: string; depends_on: string[] },
  all: { step_id: string; endpoint_id: string; depends_on: string[] }[],
  base: "image" | "video" | "audio",
): string | null {
  const byStepId = new Map(all.map((s) => [s.step_id, s]));
  const deps = transitiveDeps(step.step_id, byStepId);
  for (let i = all.length - 1; i >= 0; i--) {
    const s = all[i];
    if (!deps.has(s.step_id)) continue;
    const w = findEndpoint(s.endpoint_id)?.workflow;
    if (w && JOB_KIND_OUTPUT[w.kind] === base) return s.step_id;
  }
  return null;
}

/**
 * The Custom-mode model picker for one step: endpoints from the mode's own
 * allowlist with the SAME output kind as the current endpoint, restricted
 * only while the opt-in holds, and every required param fillable - already
 * present in the step's params, or a media param a transitive dep can feed
 * via "$step:<dep>.outputs[0]". Anything else is a dead pick the picker
 * never offers.
 */
export function stepModelOptions(
  step: { step_id: string; endpoint_id: string; params: Record<string, unknown>; depends_on: string[] },
  all: { step_id: string; endpoint_id: string; depends_on: string[] }[],
  eps: LiveEndpoint[],
  optIn: boolean,
): StepModelOption[] {
  const cur = findEndpoint(step.endpoint_id)?.workflow;
  const outKind = cur ? JOB_KIND_OUTPUT[cur.kind] : null;
  if (!outKind) return [];
  const byStepId = new Map(all.map((s) => [s.step_id, s]));
  const deps = transitiveDeps(step.step_id, byStepId);

  const out: StepModelOption[] = [];
  for (const e of eps) {
    const w = e.workflow;
    if (w.endpointId === step.endpoint_id) continue; // current model isn't a "pick"
    if (JOB_KIND_OUTPUT[w.kind] !== outKind) continue;
    const cls = endpointLicense(w).class;
    if (cls === "banned") continue;
    if (needsOptIn(cls) && !optIn) continue;
    let fillable = true;
    for (const f of w.params) {
      if (!f.required) continue;
      const v = step.params[f.name];
      if (v !== undefined && v !== "" && v !== null) continue;
      const kind = mediaKindOf(f);
      if (!kind) { fillable = false; break; }
      const base = mediaBaseKind(kind);
      const depOk = [...deps].some((d) => {
        const dep = byStepId.get(d);
        const dw = dep ? findEndpoint(dep.endpoint_id)?.workflow : undefined;
        return dw && JOB_KIND_OUTPUT[dw.kind] === base;
      });
      if (!depOk) { fillable = false; break; }
    }
    if (!fillable) continue;
    out.push({
      endpoint_id: w.endpointId,
      label: `${e.model.label} · ${w.label}`,
      restricted: needsOptIn(cls),
      heavy: !!w.heavy,
    });
  }
  return out;
}
