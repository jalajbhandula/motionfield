/**
 * Generate models/manifest.json — every weight/component the catalog can run,
 * with its license, class, source URL, the workflows that credit it, and the
 * remote byte size when known. Sizes come from the committed HF cache
 * (models/hf-sizes.json) populated by --refresh-hf via the Hugging Face
 * paths-info API; content hashes come from the committed models/sha256.json
 * (verified against the downloaded weight). The tracked file never carries a
 * local path or a local install flag.
 *
 *   npx tsx scripts/gen-manifest.ts              # write models/manifest.json
 *   npx tsx scripts/gen-manifest.ts --check      # exit 1 if the file is stale
 *   npx tsx scripts/gen-manifest.ts --refresh-hf # refetch HF sizes, then write
 */
import { promises as fs } from "fs";
import path from "path";
import { WEIGHT_LICENSES, CLASS_COMPONENTS, RECIPE_LICENSES, LICENSE_VERSION } from "../src/lib/catalog/licenses";
import { WORKFLOW_LICENSES } from "../src/lib/catalog/licenses.generated";
import type { LicenseComponent } from "../src/lib/catalog/types";

const OUT = path.join(process.cwd(), "models", "manifest.json");
const HF_CACHE = path.join(process.cwd(), "models", "hf-sizes.json");
const SHA_CACHE = path.join(process.cwd(), "models", "sha256.json");
const WEIGHT_EXT = /\.(safetensors|sft|pth|pt2|pkl|onnx|bin|ckpt|gguf|pt)$/i;

export interface ManifestRow {
  /** display name (component name or weight filename) */
  name: string;
  /** weight filename when the component maps to a file, else null */
  file: string | null;
  license: string;
  class: string;
  url: string;
  /** remote size from the HF paths-info cache — null when unverified */
  bytes: number | null;
  /** sha256 of the verified weight bytes — present only when verified */
  sha256?: string;
  workflows: string[];
}

export interface Manifest {
  version: string;
  generated_by: string;
  totals: { count: number; bytes: number };
  weights: ManifestRow[];
  recipes: { name: string; class: string }[];
}

/** workflows that credit this component name in the generated license map */
function workflowsFor(name: string): string[] {
  const out: string[] = [];
  for (const [file, lic] of Object.entries(WORKFLOW_LICENSES))
    if (lic.components.some((c) => c.name === name)) out.push(file);
  for (const [recipe, lic] of Object.entries(RECIPE_LICENSES))
    if (lic.components.some((c) => c.name === name)) out.push(`recipe:${recipe}`);
  return out.sort();
}

/** Best-effort weight filename for a component (e.g. the "(…/x.safetensors)"
 *  suffix inside a CLASS_COMPONENTS name, else the name itself if it looks
 *  like a filename). */
function fileFor(name: string): string | null {
  const m = name.match(/([\w./-]+\.(?:safetensors|sft|pth|pt2|pkl|onnx|bin|ckpt|gguf|pt))/i);
  return m ? path.basename(m[1]) : null;
}

/** huggingface.co/{org}/{repo}[…] → "org/repo" */
export function hfRepo(url: string): string | null {
  const m = url.match(/huggingface\.co\/([\w.-]+\/[\w.-]+)/);
  return m ? m[1] : null;
}

export async function buildManifest(
  sizes: Record<string, number> = {},
  shas: Record<string, string> = {},
): Promise<Manifest> {
  const rows = new Map<string, ManifestRow>();

  const addComponent = (c: LicenseComponent) => {
    const file = fileFor(c.name);
    const row = rows.get(c.name) ?? {
      name: c.name, file, license: c.license, class: c.class, url: c.url,
      bytes: null, sha256: undefined, workflows: [],
    };
    const bytes = file ? sizes[file] : undefined;
    if (bytes != null) row.bytes = bytes;
    const sha = file ? shas[file] : undefined;
    if (sha) row.sha256 = sha;
    for (const wf of workflowsFor(c.name)) if (!row.workflows.includes(wf)) row.workflows.push(wf);
    row.workflows.sort();
    rows.set(c.name, row);
  };

  for (const [name, e] of Object.entries(WEIGHT_LICENSES))
    addComponent({ name, license: e.license, url: e.url, class: e.class });
  for (const comps of Object.values(CLASS_COMPONENTS)) for (const c of comps) addComponent(c);
  for (const lic of Object.values(RECIPE_LICENSES)) for (const c of lic.components) addComponent(c);

  const list = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    version: LICENSE_VERSION,
    generated_by: "scripts/gen-manifest.ts",
    totals: { count: list.length, bytes: list.reduce((s, r) => s + (r.bytes ?? 0), 0) },
    weights: list,
    recipes: Object.keys(RECIPE_LICENSES).sort().map((name) => ({ name, class: RECIPE_LICENSES[name].class })),
  };
}

export function renderManifest(m: Manifest): string {
  return JSON.stringify(m, null, 2) + "\n";
}

/** Manifest text for the committed file — reads the committed HF size and
 *  sha256 caches. */
export async function manifestText(): Promise<string> {
  const sizes = JSON.parse(await fs.readFile(HF_CACHE, "utf8").catch(() => "{}")) as Record<string, number>;
  const shas = JSON.parse(await fs.readFile(SHA_CACHE, "utf8").catch(() => "{}")) as Record<string, string>;
  return renderManifest(await buildManifest(sizes, shas));
}

/** Refresh models/hf-sizes.json from the HF paths-info API — batch POSTs one
 *  request per repo covering every file the manifest references there. */
export async function refreshHfSizes(): Promise<Record<string, number>> {
  const byRepo = new Map<string, Set<string>>();
  const want = (url: string, file: string) => {
    const repo = hfRepo(url);
    if (!repo) return;
    if (!byRepo.has(repo)) byRepo.set(repo, new Set());
    byRepo.get(repo)!.add(file);
  };
  for (const [name, e] of Object.entries(WEIGHT_LICENSES)) want(e.url, name);
  for (const comps of Object.values(CLASS_COMPONENTS))
    for (const c of comps) { const f = fileFor(c.name); if (f) want(c.url, f); }

  const sizes: Record<string, number> = {};
  for (const [repo, files] of byRepo) {
    const r = await fetch(`https://huggingface.co/api/models/${repo}/paths-info/main`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [...files] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) { console.warn(`hf paths-info ${repo}: HTTP ${r.status} — sizes skipped`); continue; }
    const entries = await r.json() as { path: string; size?: number }[];
    for (const e of entries) if (e.size != null) sizes[path.basename(e.path)] = e.size;
  }
  await fs.mkdir(path.dirname(HF_CACHE), { recursive: true });
  await fs.writeFile(HF_CACHE, JSON.stringify(sizes, null, 2) + "\n");
  return sizes;
}

async function main() {
  if (process.argv.includes("--refresh-hf")) await refreshHfSizes();
  const text = await manifestText();
  if (process.argv.includes("--check")) {
    const cur = await fs.readFile(OUT, "utf8").catch(() => "");
    if (cur !== text) { console.error("models/manifest.json is stale — run `npx tsx scripts/gen-manifest.ts`"); process.exit(1); }
    console.log("models/manifest.json is up to date");
    return;
  }
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, text);
  const m = JSON.parse(text) as Manifest;
  const gb = (m.totals.bytes / 1e9).toFixed(1);
  console.log(`wrote ${OUT}: ${m.totals.count} components (${gb} GB known remote sizes); non-open: ${m.weights.filter((r) => r.class !== "open").map((r) => `${r.name} (${r.class})`).join("; ") || "none"}`);
}

if (process.argv[1] && process.argv[1].endsWith("gen-manifest.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
