import type { ParamField } from "@/lib/catalog/types";
import { endpointLicense } from "@/lib/catalog/license-gate";
import { needsOptIn } from "@/lib/catalog/licenses";
import "@/lib/catalog/presets"; // side-effect: registers every preset spec catalog
import { allSpecs, specById, specVisible, type PresetSpec } from "@/lib/catalog/presets/schema";
import { JOB_KIND_OUTPUT } from "@/lib/generation/types";
import { mediaBaseKind, mediaKindOf } from "@/lib/runs/media";
import type { LiveEndpoint } from "@/lib/runs/plan";
import { AGENT_TOOL_PREFIX, BUILTIN_TOOLS, toolArgsSchema, type AgentTool } from "./registry";

/**
 * Catalog tools - one tool per endpoint the turn may name (the same
 * turnEndpoints() allowlist the planner uses: live workflows, license/mode
 * applied upstream). Tool descriptions carry model · workflow · license
 * class; media params are described as url | $step ref | @ref name. The
 * preset enum on a preset-bearing param is filtered to specs that are
 * specVisible() right now - hidden, unverified, stale-hash or failed presets
 * never appear in a tool schema.
 */

/** Param names whose values name a catalog preset (same set resolveParams honors). */
export const PRESET_PARAM_NAMES: ReadonlySet<string> = new Set([
  "motion_preset", "effect_preset", "style_preset", "preset_id", "look_id",
]);

export const isPresetParam = (name: string): boolean => PRESET_PARAM_NAMES.has(name);

/** Every spec id currently specVisible() - one verify-file read per call. */
export function visiblePresetIds(): Set<string> {
  const ids = new Set<string>();
  for (const s of allSpecs()) if (specVisible(s)) ids.add(s.id);
  return ids;
}

/** Enum values for the schema/prompt: preset params keep only visible ids. */
function fieldEnum(f: ParamField, visible: Set<string>): readonly unknown[] | undefined {
  if (!Array.isArray(f.enum) || !f.enum.length) return f.enum;
  if (!isPresetParam(f.name)) return f.enum;
  return f.enum.filter((v) => typeof v !== "string" || visible.has(v));
}

/** The media kind a param consumes as the tool's "input" hint, or null. */
function inputKindOf(params: ParamField[]): AgentTool["input"] {
  for (const f of params) {
    if (!f.required) continue;
    const k = mediaKindOf(f);
    if (k) return mediaBaseKind(k);
  }
  return "text";
}

function fieldJsonSchema(f: ParamField, visible: Set<string>): Record<string, unknown> {
  const mediaK = mediaKindOf(f);
  if (mediaK) {
    const item = {
      type: "string",
      description: "a /files/ media url, \"$step:<step>.outputs[n]\" ref, or \"@<ref-name>\"",
    };
    return f.type === "images" || f.type === "media"
      ? { type: "array", items: item, ...(f.maxItems ? { maxItems: f.maxItems } : {}) }
      : item;
  }
  const bounds = {
    ...(f.min !== undefined ? { minimum: f.min } : {}),
    ...(f.max !== undefined ? { maximum: f.max } : {}),
  };
  if (f.type === "number" || f.type === "slider") return { type: "number", ...bounds };
  if (f.type === "integer") return { type: "integer", ...bounds };
  if (f.type === "boolean") return { type: "boolean" };
  const e = fieldEnum(f, visible);
  if (Array.isArray(e)) return e.length ? { enum: e } : { type: "string", enum: [] };
  return { type: "string" };
}

/** JSON Schema for a catalog endpoint's params (declared fields only). */
export function endpointJsonSchema(params: ParamField[], visible?: Set<string>): Record<string, unknown> {
  const vis = visible ?? visiblePresetIds();
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of params) {
    properties[f.name] = fieldJsonSchema(f, vis);
    if (f.required) required.push(f.name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/** One tool per offered endpoint - preset-bearing params carry only the
 *  verified-and-plannable spec subset (hidden/stale never surface). */
export function catalogTools(eps: LiveEndpoint[]): AgentTool[] {
  const plannable = new Map<string, { paramName: string; spec: PresetSpec }[]>();
  for (const p of plannablePresets(eps)) {
    plannable.set(p.endpointId, [...(plannable.get(p.endpointId) ?? []), { paramName: p.paramName, spec: p.spec }]);
  }
  return eps.map(({ model: m, workflow: w }) => {
    const cls = endpointLicense(w).class;
    return {
      name: w.endpointId,
      endpointId: w.endpointId,
      description: `${m.label} · ${w.label} - license ${cls}${w.heavy ? " · heavy" : ""}`,
      input: inputKindOf(w.params),
      output: JOB_KIND_OUTPUT[w.kind],
      restricted: needsOptIn(cls),
      planner: true,
      available: true,
      params: w.params,
      presets: plannable.get(w.endpointId) ?? [],
    };
  });
}

/* ------------------------- planner-facing helpers ----------------------- */

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "these", "those", "make", "into",
  "your", "you", "are", "out", "get", "can", "from", "have", "has", "all",
]);

export function toolTokens(text: string): string[] {
  return text.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

function haystack(t: AgentTool): string {
  return `${t.name} ${t.endpointId} ${t.description}`.toLowerCase();
}

/** Keyword match used by both the planner's compact subset and catalog_search. */
export function searchTools(query: string, tools: AgentTool[], limit = 8): AgentTool[] {
  const toks = toolTokens(query);
  if (!toks.length) return tools.slice(0, limit);
  const scored = tools.map((t) => {
    const h = haystack(t);
    let s = 0;
    for (const tok of toks) if (h.includes(tok)) s += tok.length > 5 ? 2 : 1;
    return { t, s };
  }).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s || a.t.endpointId.localeCompare(b.t.endpointId));
  return scored.slice(0, limit).map((x) => x.t);
}

/** The compact subset the LLM planner sees: brief-matching endpoints plus the
 *  built-in tools. When nothing matches, a small default spread (image /
 *  video / i2v / tts) keeps the prompt honest and small. */
export function plannerTools(text: string, tools: AgentTool[], limit = 8): AgentTool[] {
  const hits = searchTools(text, tools, limit);
  const builtins = tools.filter((t) => t.builtin && t.planner);
  const defaults = ["text-to-image", "text-to-video", "image-to-video", "text-to-speech"];
  // hits alone can crowd out a generation primitive entirely - near-miss
  // tools tie on a shared token and alphabetically push every text-to-video
  // endpoint off the list. Backfill only the kinds the hits actually missed,
  // appended after the hits so the brief's own best matches keep their ranks.
  const picked = defaults
    .filter((d) => !hits.some((t) => !t.builtin && t.endpointId.endsWith(d)))
    .map((d) => tools.find((t) => !t.builtin && t.endpointId.endsWith(d)))
    .filter((t): t is AgentTool => !!t);
  return dedupeTools([...hits, ...picked, ...builtins]);
}

function dedupeTools(tools: AgentTool[]): AgentTool[] {
  const seen = new Set<string>();
  return tools.filter((t) => (seen.has(t.endpointId) ? false : (seen.add(t.endpointId), true)));
}

/** Up to `limit` suggested briefs for an ambiguous turn - each is a tool the
 *  session can actually run, phrased as something the user might type. */
export function suggestedBriefs(tools: AgentTool[], limit = 3): string[] {
  const hints: [suffix: string, brief: string][] = [
    ["text-to-image", "Generate an image of a neon city at night"],
    ["text-to-video", "Make a short video of a lighthouse at dusk"],
    ["image-to-video", "Animate this image into a short cinematic video"],
    ["text-to-speech", "Read this aloud: the quick brown fox jumps over the lazy dog"],
    ["explainer", "Make an explainer about how rainbows form"],
  ];
  const out: string[] = [];
  for (const [suffix, brief] of hints) {
    if (out.length >= limit) break;
    if (tools.some((t) => t.endpointId.includes(suffix) && t.available)) out.push(brief);
  }
  return out.length ? out : ["Generate an image"];
}

/* ------------------------- preset-aware planning ------------------------ */

export interface PlannablePreset {
  spec: PresetSpec;
  /** the endpoint that carries this preset as a param value */
  endpointId: string;
  /** the preset-bearing param (preset_id, look_id, …) */
  paramName: string;
  /** media input the mechanism needs (first required media param's kind) */
  needsMedia: "image" | "video" | "audio" | null;
}

/** Endpoints a spec's mechanism can run through - only where the endpoint is
 *  offered AND declares a preset param whose enum names the spec. This is the
 *  single place presets reach the planner: specVisible() is the gate. */
export function plannablePresets(eps: LiveEndpoint[]): PlannablePreset[] {
  const out: PlannablePreset[] = [];
  for (const spec of allSpecs()) {
    if (!specVisible(spec)) continue;
    const mech = spec.mechanism;
    const endpointId = "endpoint" in mech ? mech.endpoint : null;
    if (!endpointId) continue;
    const ep = eps.find((e) => e.workflow.endpointId === endpointId);
    if (!ep) continue;
    for (const f of ep.workflow.params) {
      if (!isPresetParam(f.name)) continue;
      if (!Array.isArray(f.enum) || !f.enum.includes(spec.id)) continue;
      const media = ep.workflow.params.find((p) => p.required && mediaKindOf(p));
      const k = media ? mediaKindOf(media) : null;
      out.push({ spec, endpointId, paramName: f.name, needsMedia: k ? mediaBaseKind(k) : null });
      break;
    }
  }
  return out;
}

/** A visible preset named in the brief - matched on its id or its label
 *  (case-insensitive, words/dashes interchangeable). Hidden/unverified/stale
 *  specs can never match: they aren't in plannablePresets. */
export function presetNamedIn(text: string, eps: LiveEndpoint[]): PlannablePreset | null {
  const low = text.toLowerCase();
  for (const p of plannablePresets(eps)) {
    const id = p.spec.id.toLowerCase();
    if (low.includes(id) || low.includes(id.replace(/-/g, " "))) return p;
    const words = p.spec.label.toLowerCase().split(/[\s-]+/).filter((w) => w.length > 2);
    if (words.length && words.every((w) => low.includes(w))) return p;
  }
  return null;
}

/** The spec a preset-bearing value names, when it's visible - the plan-time
 *  mirror of resolveParams' submit-time gate ("preset not available"). */
export function presetGate(value: unknown): "ok" | "absent" | "not_a_preset" {
  if (typeof value !== "string" || !value) return "not_a_preset";
  const spec = specById(value);
  if (!spec) return "not_a_preset";
  return specVisible(spec) && !spec.hidden ? "ok" : "absent";
}

/** catalog_search: keyword hits mapped back onto the endpoint rows - for the
 *  prompt-expansion reply in llmPlan (eps stays the authoritative allowlist). */
export function searchCatalog(query: string, eps: LiveEndpoint[], limit = 8): { ep: LiveEndpoint; endpointId: string }[] {
  const byId = new Map(eps.map((e) => [e.workflow.endpointId, e]));
  return searchTools(query, catalogTools(eps), limit)
    .flatMap((t) => { const ep = byId.get(t.endpointId); return ep ? [{ ep, endpointId: t.endpointId }] : []; });
}

export { AGENT_TOOL_PREFIX, BUILTIN_TOOLS, toolArgsSchema };
export type { AgentTool };
