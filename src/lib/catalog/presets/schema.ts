/**
 * presets/schema.ts - the spec layer behind every catalog preset.
 *
 *  A PresetSpec declares what a preset IS and how it runs:
 *   - mechanism: the real executor that consumes the preset's inputs
 *     (never "just a prompt fragment" - a fragment may ride along, but the
 *     mechanism names the endpoint/pipeline/param-layer that does the work)
 *   - inputs:    what the mechanism consumes (image / video / prompt)
 *   - verify:    how `scripts/preset-verify.ts` proves it end-to-end
 *   - hidden:    when no honest executor exists on trunk, the spec carries
 *                the reason instead of pretending - hidden presets are not
 *                offered and cannot be submitted
 *
 *  Visibility rule (the display gate): a spec is visible iff it is not
 *  `hidden` AND -
 *   - catalog "motion": nothing further. Motion presets are WS3's own
 *     catalog (presets/trajectories.ts is read-only here) - their list is
 *     the gate; no ws4 verify record is required or consulted.
 *   - every other catalog: tests/fixtures/preset-verify.json (override:
 *     PRESET_VERIFY_FILE) holds a `verified` record whose mechanism_hash
 *     equals mechanismHash(spec) - the hash covers everything
 *     resolveParams merges ({mechanism, apply, promptFragment}), so editing
 *     a preset's style text or params invalidates its record.
 *  Every surface - /apps, /effects, the re-edit pickers, and the job APIs -
 *  reads this one source of truth. WS4's own trajectory APP tiles stay
 *  verify-gated (they are catalog "app", not "motion").
 *
 *  This module stays dependency-light and client-safe: no top-level fs/db
 *  imports (the verify store loads `node:fs` lazily via getBuiltinModule).
 */

/* ------------------------------------------------------------------ */
/* mechanism                                                           */
/* ------------------------------------------------------------------ */

export type Mechanism =
  /** a catalog trajectory stack (src/lib/camera/trajectory.ts ids). Today it
   *  executes prompt-guided on the i2v/t2v workflows - the stack is stored on
   *  the job and its fragment steers the move; the graph rig lands with WS3. */
  | { kind: "trajectory"; ids: readonly string[] }
  /** a structured param layer merged into the job's own workflow params
   *  (negative_prompt, steps, …) - every key must be a real workflow input */
  | { kind: "post"; params: Record<string, unknown> }
  /** media compositing via a dedicated endpoint (character/product swaps) */
  | { kind: "composite"; endpoint: string }
  /** a prompt scaffold on a t2i endpoint - `{input}` holds the user's text */
  | { kind: "template"; endpoint: string; template: string }
  /** first/last-keyframe guided edit (ltx-vfx family) */
  | { kind: "keyframe_edit"; endpoint: string; recipe: string }
  /** depth-controlled video restyle on motionfield/wan-vace/restyle */
  | { kind: "restyle"; endpoint: string; control: "depth" }
  /** instruction-driven edit endpoint (qwen edit / vace i2v / …) */
  | { kind: "edit_recipe"; endpoint: string; instruction: string }
  /** a dedicated image-edit endpoint whose whole graph IS the mechanism
   *  (klein face swap - the mask + composite live inside the workflow) */
  | { kind: "image_edit"; endpoint: string }
  /** LoRA/adapter application - no LoRA pipeline exists on trunk yet */
  | { kind: "lora"; weights: string; strength?: number }
  /** a multi-step server pipeline (ad-lab, re-edit-assemble, explainer, …) */
  | { kind: "pipeline"; pipeline: string };

export type MechanismKind = Mechanism["kind"];

/** Mechanisms that layer onto a job alongside others. Everything else owns
 *  the job outright and may never combine (OF-0146). */
export const COMBINABLE_KINDS: ReadonlySet<MechanismKind> = new Set(["trajectory", "post", "composite"]);

/* ------------------------------------------------------------------ */
/* spec                                                                */
/* ------------------------------------------------------------------ */

export type PresetCatalog = "app" | "effect" | "style" | "motion";
export type PresetInput = "image" | "video" | "prompt" | "audio";

export type CheckerKind = "signature" | "golden" | "vision" | "ffprobe" | "unit";

export interface VerifySpec {
  checker: CheckerKind;
  /** yes/no question the vision checker asks the judge model */
  question?: string;
  /** fixture name under tests/fixtures/verify/ */
  fixture?: string;
}

export interface PresetSpec {
  id: string;
  /** display label */
  label: string;
  catalog: PresetCatalog;
  /** collections.ts hub id */
  collection?: string;
  /** what the mechanism consumes */
  inputs: readonly PresetInput[];
  mechanism: Mechanism;
  /** extra params the preset merges into the job (post-layer params,
   *  look_id, camera_movement…) - part of the hashed verify payload */
  apply?: Record<string, unknown>;
  /** prompt line the preset merges into the job's prompt - part of the
   *  hashed verify payload */
  promptFragment?: string;
  /** default: derived from mechanism.kind (trajectory/post/composite) */
  combinable?: boolean;
  /** where the mechanism runs - most are local GPU, heavy/cloud ones say so */
  tier: "local" | "cloud";
  verify: VerifySpec;
  /** ledger row id (OF-xxxx) */
  ledger?: string;
  /** no honest executor on trunk - carried with the reason, never offered */
  hidden?: { reason: string };
  /** picker/marketing copy - derived into the legacy PresetDef description */
  description?: string;
}

export const specCombinable = (s: PresetSpec): boolean =>
  s.combinable ?? COMBINABLE_KINDS.has(s.mechanism.kind);

/* ------------------------------------------------------------------ */
/* canonical JSON + mechanism hash                                     */
/* ------------------------------------------------------------------ */

/** Canonical JSON: object keys sorted recursively, undefined dropped. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

const cryptoMod = () =>
  (globalThis.process?.getBuiltinModule?.("node:crypto") ??
    undefined) as typeof import("node:crypto") | undefined;

/** sha256 of the canonical merge payload {mechanism, apply, promptFragment,
 *  href} - the verify record pins everything resolveParams merges, so a
 *  preset whose style text or apply params drift loses its verified status.
 *  App specs also pin their deep link: an app tile's `?params=` prefill IS
 *  the mechanism a click runs, so an href edit must invalidate the record
 *  (undefined keys drop out of the canonical form - non-app hashes are
 *  unchanged). */
export function mechanismHash(s: {
  mechanism: Mechanism;
  apply?: Record<string, unknown>;
  promptFragment?: string;
  href?: string;
}): string {
  const c = cryptoMod();
  if (!c) throw new Error("mechanismHash needs node:crypto (server-side only)");
  return c.createHash("sha256")
    .update(canonicalJson({ mechanism: s.mechanism, apply: s.apply, promptFragment: s.promptFragment, href: s.href }))
    .digest("hex");
}

/* ------------------------------------------------------------------ */
/* spec registry - each catalog file registers its specs               */
/* ------------------------------------------------------------------ */

const registries = new Map<PresetCatalog, () => readonly PresetSpec[]>();

export function registerCatalog(catalog: PresetCatalog, get: () => readonly PresetSpec[]): void {
  registries.set(catalog, get);
}

export function catalogSpecs(catalog: PresetCatalog): readonly PresetSpec[] {
  return registries.get(catalog)?.() ?? [];
}

export function allSpecs(): readonly PresetSpec[] {
  return (["app", "effect", "style", "motion"] as const).flatMap((c) => catalogSpecs(c));
}

/** specById - a preset id names exactly one spec across all catalogs. */
export function specById(id: string): PresetSpec | undefined {
  return allSpecs().find((s) => s.id === id);
}

/* ------------------------------------------------------------------ */
/* verify records - tests/fixtures/preset-verify.json                   */
/* ------------------------------------------------------------------ */

export interface VerifyRecord {
  mechanism_hash: string;
  status: "verified" | "failed" | "pending";
  seeds?: number[];
  runs?: { seed: number; ok: boolean; msg?: string; wall_s?: number }[];
  checker?: string;
  /** why a record is what it is (e.g. "golden checker not implemented") */
  note?: string;
  judge?: boolean | null;
  artifact_sha256?: string;
  /** artifact paths captured on the mid-run "pending" flush - a killed batch
   *  keeps them so a human can still inspect what rendered (deleted once the
   *  final record + sha256 land, so the field is absent on final records) */
  artifacts?: string[];
  /** per-spec contact sheet under /tmp/of-verify/<date>/ */
  contact_sheet?: string;
  date?: string;
}

interface VerifyFile { version?: number; records?: Record<string, VerifyRecord> }

export const VERIFY_FILE_ENV = "PRESET_VERIFY_FILE";
export const VERIFY_FILE_DEFAULT = "tests/fixtures/preset-verify.json";

export function verifyFilePath(): string {
  const p = process.env[VERIFY_FILE_ENV];
  return p && p.trim() ? p : `${process.cwd()}/${VERIFY_FILE_DEFAULT}`;
}

let cache: { file: string; mtimeMs: number; records: Record<string, VerifyRecord> } | null = null;

/** Synchronous, memoised-by-mtime read. Missing/unreadable file → {} (fail
 *  closed: nothing is treated as verified). Client bundles get {} too. */
export function loadVerifyRecords(): Record<string, VerifyRecord> {
  const get = globalThis.process?.getBuiltinModule?.bind(globalThis.process);
  if (!get) return {};
  const fs = get("node:fs") as typeof import("node:fs");
  const file = verifyFilePath();
  try {
    const mtimeMs = fs.statSync(file).mtimeMs;
    if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.records;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as VerifyFile;
    const records = parsed?.records && typeof parsed.records === "object" ? parsed.records : {};
    cache = { file, mtimeMs, records };
    return records;
  } catch {
    return {};
  }
}

export { posterFor } from "./poster";

/** The display rule: not hidden AND (motion → WS3's catalog is itself the
 *  gate | other catalogs → a verified record with a matching merge-payload
 *  hash). */
export function specVisible(spec: PresetSpec, records = loadVerifyRecords()): boolean {
  if (spec.hidden) return false;
  if (spec.catalog === "motion") return true;
  const r = records[spec.id];
  return !!r && r.status === "verified" && r.mechanism_hash === mechanismHash(spec);
}

export function visibleSpecs(specs: readonly PresetSpec[], records = loadVerifyRecords()): PresetSpec[] {
  return specs.filter((s) => specVisible(s, records));
}

export function visibleSpecIds(specs: readonly PresetSpec[], records = loadVerifyRecords()): Set<string> {
  return new Set(visibleSpecs(specs, records).map((s) => s.id));
}

/** The ids the restyle/ReCut pickers may offer right now. */
export function visibleRestyleSpecs(records = loadVerifyRecords()): PresetSpec[] {
  return catalogSpecs("effect").filter((s) => s.mechanism.kind === "restyle" && specVisible(s, records));
}

/* ------------------------------------------------------------------ */
/* motion presets - WS3 owns presets/trajectories.ts; their specs are  */
/* derived here (read-only) so specById/resolveParams see them. They   */
/* are exempt from the verify gate: WS3's catalog list is their gate.  */
/* ------------------------------------------------------------------ */

import { MOTION_PRESETS, presetTrajectories } from "./trajectories";

export const MOTION_SPECS: readonly PresetSpec[] = MOTION_PRESETS.map((p) => ({
  id: p.id,
  label: p.title,
  catalog: "motion" as const,
  collection: "camera",
  inputs: ["image", "prompt"] as const,
  mechanism: { kind: "trajectory" as const, ids: presetTrajectories(p) },
  apply: p.apply,
  promptFragment: p.promptFragment,
  tier: "local" as const,
  verify: {
    checker: "vision" as const,
    question: `does the clip's camera execute this move - ${p.title}?`,
    fixture: "portrait.png",
  },
  description: p.description,
}));

registerCatalog("motion", () => MOTION_SPECS);
