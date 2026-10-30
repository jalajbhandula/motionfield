/**
 * Regenerate src/lib/catalog/licenses.generated.ts from workflows/*.json:
 * every weight filename found in node inputs plus every weight-loading node
 * class (CLASS_COMPONENTS) is credited; the workflow's license class is the
 * worst component class ("banned-known" components don't promote).
 *
 *   npx tsx scripts/gen-licenses.ts          # write the generated file
 *   npx tsx scripts/gen-licenses.ts --check  # exit 1 if the file is stale
 *
 * Fails on any weight/class it can't attribute — add the entry to
 * src/lib/catalog/licenses.ts (license must come from MODELS.md or the
 * repo's license page; unconfirmable → class "restricted").
 *
 * Also emits:
 *  - KNOWN_NODE_CLASSES — class_types in shipped workflows ∪ CLASS_COMPONENTS
 *    keys ∪ core (non-custom, non-API) classes from
 *    tests/fixtures/object_info.min.json. The runtime gate refuses override
 *    nodes outside this set.
 *  - ENDPOINT_GRAPHS — catalog endpointId → bundled workflow filename, so the
 *    pure license resolver can follow endpoint references (explainer motion).
 */
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  CLASS_COMPONENTS, WORKFLOW_EXTRA_WEIGHTS, RED_FLAG_CLASSES,
  graphLicense, licenseForWeight, worstClass,
} from "../src/lib/catalog/licenses";
import type { ComfyGraph } from "../src/lib/catalog/licenses";
import type { LicenseComponent, LicenseInfo } from "../src/lib/catalog/types";

const WF_DIR = path.join(process.cwd(), "workflows");
const OBJECT_INFO = path.join(process.cwd(), "tests/fixtures/object_info.min.json");
const OUT = path.join(process.cwd(), "src/lib/catalog/licenses.generated.ts");

/** node class → provenance. `custom: true` = loaded from custom_nodes (not a
 *  "core" class); `api_node: true` = a paid API/partner node. */
export type ObjectInfoMin = Record<string, { custom?: boolean; api_node?: boolean; python_module?: string }>;

export async function loadObjectInfo(): Promise<ObjectInfoMin> {
  try {
    return JSON.parse(await fs.readFile(OBJECT_INFO, "utf8")) as ObjectInfoMin;
  } catch {
    return {};
  }
}

/** ComfyUI's hosted API/partner nodes live in the comfy_api_nodes.* python
 *  namespace. The api_node flag is authoritative, but the module prefix is
 *  too — a capture can carry the module before the flag lands. */
export const API_NODE_MODULE_PREFIX = "comfy_api_nodes.";

export function isApiNode(meta?: { api_node?: boolean; python_module?: string }): boolean {
  return !!meta && (meta.api_node === true || (meta.python_module ?? "").startsWith(API_NODE_MODULE_PREFIX));
}

/** Denylist terms (OF_DENYLIST / ~/.motionfield/denylist.txt) as substring
 *  patterns — check-names only matches whole words, so a brand buried in a
 *  camel-case class name would slip through lint. Captured class names
 *  matching any term are skipped entirely. */
export async function denylistPatterns(): Promise<RegExp[]> {
  const p = process.env.OF_DENYLIST || path.join(os.homedir(), ".motionfield", "denylist.txt");
  try {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (await fs.readFile(p, "utf8")).split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.match(/^@allow-in=\S+\s+(.+)$/)?.[1] ?? l)
      .map((t) => new RegExp(esc(t), "i"));
  } catch {
    return [];
  }
}

/** Classes an override graph may legally use: every class shipped in
 *  workflows/, every CLASS_COMPONENTS key, and every core ComfyUI class
 *  (non-custom, non-API) from the captured object_info fixture. Captured
 *  classes matching RED_FLAG_CLASSES or a denylist term are skipped. */
export async function knownNodeClasses(shipped: Iterable<string>, info?: ObjectInfoMin, deny?: RegExp[]): Promise<Set<string>> {
  const set = new Set<string>(shipped);
  for (const k of Object.keys(CLASS_COMPONENTS)) set.add(k);
  const oi = info ?? await loadObjectInfo();
  const denyPatterns = deny ?? await denylistPatterns();
  for (const [cls, meta] of Object.entries(oi))
    // core classes only — custom_nodes and API/partner modules are out, and
    // red-flag or denylisted names never enter the allowed set
    if (!meta.custom && !isApiNode(meta)
      && !RED_FLAG_CLASSES.some((re) => re.test(cls))
      && !denyPatterns.some((re) => re.test(cls))) set.add(cls);
  return set;
}

export async function buildWorkflowLicenses(): Promise<Record<string, LicenseInfo>> {
  const files = (await fs.readdir(WF_DIR)).filter((f) => f.endsWith(".json")).sort();
  const graphs: Record<string, ComfyGraph> = {};
  for (const file of files) graphs[file] = JSON.parse(await fs.readFile(path.join(WF_DIR, file), "utf8")) as ComfyGraph;

  const shipped = new Set<string>();
  for (const g of Object.values(graphs))
    for (const [id, n] of Object.entries(g))
      if (id !== "_meta" && typeof n?.class_type === "string") shipped.add(n.class_type);
  const known = await knownNodeClasses(shipped);

  const out: Record<string, LicenseInfo> = {};
  for (const file of files) {
    // shipping graphs must attribute every weight — unknown ones throw here
    // (the runtime gate's graphLicense default instead marks them restricted)
    const lic = graphLicense(graphs[file], (filename, nodeId, classType) => {
      throw new Error(`${file} node ${nodeId} (${classType}): weight "${filename}" has no WEIGHT_LICENSES entry — verify its license and add it to src/lib/catalog/licenses.ts`);
    }, known);
    const components = new Map<string, LicenseComponent>(lic.components.map((cp) => [cp.name, cp]));
    for (const extra of WORKFLOW_EXTRA_WEIGHTS[file] ?? []) {
      const e = licenseForWeight(extra);
      if (!e) throw new Error(`${file}: WORKFLOW_EXTRA_WEIGHTS entry "${extra}" missing from WEIGHT_LICENSES`);
      if (!components.has(e.name)) components.set(e.name, e);
    }
    const list = [...components.values()];
    out[file] = { class: worstClass(list), components: list };
  }
  return out;
}

/** endpointId → bundled workflow file for every comfy-backed catalog endpoint. */
export async function buildEndpointGraphs(): Promise<Record<string, string>> {
  const { ALL_MODELS } = await import("../src/lib/catalog/video-models");
  const map: Record<string, string> = {};
  for (const m of ALL_MODELS)
    for (const w of m.workflows) {
      const wf = w.providers.comfy?.workflow;
      if (wf) map[w.endpointId] = wf;
    }
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
}

function render(map: Record<string, LicenseInfo>, endpoints: Record<string, string>, known: string[]): string {
  return `// GENERATED by scripts/gen-licenses.ts — do not edit by hand.
// workflow filename -> resolved license info (worst component class wins;
// "banned-known" components are known violations that don't promote).
import type { LicenseInfo } from "./types";

export const WORKFLOW_LICENSES: Record<string, LicenseInfo> = ${JSON.stringify(map, null, 2)};

/** catalog endpointId -> bundled workflow file (comfy providers only) */
export const ENDPOINT_GRAPHS: Record<string, string> = ${JSON.stringify(endpoints, null, 2)};

/** class_types allowed in graphs: shipped classes ∪ CLASS_COMPONENTS ∪ core
 *  ComfyUI classes from tests/fixtures/object_info.min.json */
export const KNOWN_NODE_CLASSES: string[] = ${JSON.stringify(known, null, 2)};
`;
}

/** Rebuild the generated file's parts — the audit's pure artifact check diffs
 *  the rendered text against the committed file without writing. */
export async function buildGenerated(): Promise<{ text: string; map: Record<string, LicenseInfo>; endpoints: Record<string, string>; known: string[] }> {
  const files = (await fs.readdir(WF_DIR)).filter((f) => f.endsWith(".json")).sort();
  const shipped = new Set<string>();
  for (const f of files)
    for (const [id, n] of Object.entries(JSON.parse(await fs.readFile(path.join(WF_DIR, f), "utf8")) as ComfyGraph))
      if (id !== "_meta" && typeof n?.class_type === "string") shipped.add(n.class_type);
  const known = [...(await knownNodeClasses(shipped))].sort();
  const [map, endpoints] = await Promise.all([buildWorkflowLicenses(), buildEndpointGraphs()]);
  return { text: render(map, endpoints, known), map, endpoints, known };
}

/** Rebuild the generated file's text — the audit's pure artifact check diffs
 *  this against the committed file without writing. */
export async function generatedLicensesText(): Promise<string> {
  return (await buildGenerated()).text;
}

async function main() {
  const { text, map, endpoints, known } = await buildGenerated();
  if (process.argv.includes("--check")) {
    const current = await fs.readFile(OUT, "utf8").catch(() => "");
    if (current !== text) {
      console.error("licenses.generated.ts is stale — run `npx tsx scripts/gen-licenses.ts`");
      process.exit(1);
    }
    console.log("licenses.generated.ts is up to date");
    return;
  }
  await fs.writeFile(OUT, text);
  const counts: Record<string, number> = {};
  for (const l of Object.values(map)) counts[l.class] = (counts[l.class] ?? 0) + 1;
  console.log(`wrote ${OUT}: ${Object.keys(map).length} workflows — ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(" ")}; ${endpoints ? Object.keys(endpoints).length : 0} endpoints; ${known.length} known node classes`);
}

// CJS/ESM-agnostic main check (tsx runs this file directly)
if (process.argv[1] && process.argv[1].endsWith("gen-licenses.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
