/**
 * License audit — verifies every weight/component the app can touch and scans
 * the code paths that can auto-pick an endpoint for restricted references.
 *
 *   npx tsx scripts/license-audit.ts                     # repo tree
 *   npx tsx scripts/license-audit.ts --root <dir>        # fixture tree (tests)
 *   npx tsx scripts/license-audit.ts --check             # + generated artifacts freshness
 *                                                        #   (licenses.generated.ts,
 *                                                        #   docs/LICENSES.md, models/manifest.json —
 *                                                        #   all diffed in memory, nothing written)
 *   npx tsx scripts/license-audit.ts --write             # rewrite docs/LICENSES.md
 *   npx tsx scripts/license-audit.ts --live              # + live ComfyUI object_info diff
 *   npx tsx scripts/license-audit.ts --allow-known V2,V3,V4
 *   npx tsx scripts/license-audit.ts --source-check [--source-root <ComfyUI>] [--out <file>]
 *                                                        # greps the trellis2/triposplat sources in a
 *                                                        # ComfyUI checkout for NC rasterizer deps
 *                                                        # (nvdiffrast/nvdiffrec/diff_gaussian… + dynamic
 *                                                        # imports) and writes the evidence JSON —
 *                                                        # exit non-zero on any hit
 *
 * Findings carry a category code:
 *   V1  shipped-graph / catalog violation — unlisted weight, banned weight or
 *       class, API/partner node, malformed node, endpoint class ≠ graph,
 *       recipe without a RECIPE_LICENSES entry, explainer-motion drift —
 *       these must never be allow-listed for shipping
 *   V2  a skill step defaults to a restricted/banned endpoint
 *       (src/lib/catalog/skills.ts)
 *   V3  the agent's tool list or regex fallback names a restricted endpoint
 *       (src/lib/agent.ts)
 *   V4  a canvas default or app tile defaults to a restricted endpoint/model
 *       (src/app/canvas/page.tsx, src/lib/catalog/presets/apps.ts)
 *
 * --allow-known turns the listed categories into warnings. The current tree
 * ships known V2/V3/V4 references pending the restricted→vace defaults swap,
 * so `--allow-known V2,V3,V4` is the green gate; V1 findings always fail.
 */
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  CLASS_COMPONENTS, EXPLAINER_MOTION_ENDPOINTS, RECIPE_LICENSES,
  WEIGHT_LICENSES,
  licenseForWeight, graphLicense, KNOWN_NODES, endpointLicenseFor,
  RED_FLAG_WEIGHTS, RED_FLAG_CLASSES,
} from "../src/lib/catalog/licenses";
import type { LicenseComponent, LicenseInfo } from "../src/lib/catalog/types";
import { WORKFLOW_LICENSES, ENDPOINT_GRAPHS } from "../src/lib/catalog/licenses.generated";
import { ALL_MODELS, findEndpoint } from "../src/lib/catalog/video-models";
import { loadObjectInfo, isApiNode, generatedLicensesText, type ObjectInfoMin } from "./gen-licenses";
import { manifestText, type Manifest } from "./gen-manifest";

export interface Finding { code: string; file: string; message: string }
export interface AuditOptions {
  allowKnown?: string[];
  /** object_info.min.json override (defaults to <root>/tests/fixtures/…, then repo's) */
  objectInfo?: ObjectInfoMin;
  /** repo-level checks (generated-map freshness, catalog↔graph consistency) — default on for repo root */
  catalogChecks?: boolean;
  /** re-check class provenance against a live ComfyUI /object_info (run under gpu-run) */
  live?: boolean;
}

/* The red-flag weight/class tables live in src/lib/catalog/licenses.ts
 * (RED_FLAG_WEIGHTS / RED_FLAG_CLASSES) so the runtime gate and this audit
 * share one list. */

const WEIGHT_EXT = /\.(safetensors|sft|pth|pt2|pkl|onnx|bin|ckpt|gguf|pt)$/i;
const ENDPOINT_REF = /["'`](motionfield\/[a-z0-9.-]+\/[a-z0-9._-]+)["'`]/g;

function endpointClass(endpointId: string): LicenseInfo["class"] | "unknown" {
  const found = findEndpoint(endpointId);
  if (!found) return "unknown";
  return endpointLicenseFor(found.workflow).class;
}

/** Scan a source file for literal "motionfield/…" endpoint references. */
function scanEndpoints(src: string): string[] {
  return [...src.matchAll(ENDPOINT_REF)].map((m) => m[1]);
}

async function readMaybe(p: string): Promise<string | null> {
  return fs.readFile(p, "utf8").catch(() => null);
}

export async function auditTree(root: string, opts: AuditOptions = {}): Promise<{ findings: Finding[]; text: string }> {
  const findings: Finding[] = [];
  const push = (code: string, file: string, message: string) => findings.push({ code, file, message });

  const wfDir = path.join(root, "workflows");
  const files = (await fs.readdir(wfDir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort();
  const info = opts.objectInfo
    ?? (await readMaybe(path.join(root, "tests/fixtures/object_info.min.json")).then((s) => (s ? JSON.parse(s) as ObjectInfoMin : null)))
    ?? await loadObjectInfo();

  if (opts.live) {
    // re-check node provenance against the live ComfyUI — run under gpu-run
    const base = (process.env.COMFY_UI_URL || "http://127.0.0.1:8188").replace(/\/$/, "");
    try {
      const live = await (await fetch(`${base}/object_info`, { signal: AbortSignal.timeout(15_000) })).json() as Record<string, { python_module?: string; api_node?: boolean }>;
      for (const cls of Object.keys(info)) {
        if (info[cls].custom || isApiNode(info[cls])) continue;
        if (!live[cls]) console.warn(`object_info drift: core class "${cls}" not present in live ComfyUI`);
        else if (isApiNode(live[cls])) console.warn(`object_info drift: "${cls}" became an API node live`);
      }
      for (const cls of KNOWN_NODES)
        if (!live[cls] && !(cls in CLASS_COMPONENTS)) console.warn(`object_info drift: known class "${cls}" not present in live ComfyUI`);
    } catch (e) {
      push("V1", "live", `could not reach live ComfyUI at ${base} — ${e instanceof Error ? e.message : e}`);
    }
  }

  /* ---------- per-graph checks ---------- */
  const report: { file: string; lic: LicenseInfo }[] = [];
  for (const file of files) {
    const g = JSON.parse(await fs.readFile(path.join(wfDir, file), "utf8")) as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
    for (const [id, node] of Object.entries(g)) {
      if (id === "_meta" || !node || typeof node !== "object") continue;
      const cls = node.class_type;
      if (typeof cls !== "string" || !node.inputs || typeof node.inputs !== "object" || Array.isArray(node.inputs)) {
        push("V1", `workflows/${file}`, `node ${id}: malformed node (no class_type / non-object inputs)`);
        continue;
      }
      if (!KNOWN_NODES.has(cls)) push("V1", `workflows/${file}`, `node ${id}: unlisted node class "${cls}" — not in KNOWN_NODE_CLASSES`);
      if (isApiNode(info[cls])) push("V1", `workflows/${file}`, `node ${id}: "${cls}" is an API/partner node (paid endpoint — no place in a local-first app)`);
      const mod = info[cls]?.python_module ?? "";
      if (/controlnet_aux/i.test(mod)) push("V1", `workflows/${file}`, `node ${id}: "${cls}" comes from comfyui_controlnet_aux — the pack is banned`);
      if (RED_FLAG_CLASSES.some((re) => re.test(cls))) push("V1", `workflows/${file}`, `node ${id}: "${cls}" matches a banned class pattern`);
      for (const v of Object.values(node.inputs)) {
        if (typeof v !== "string" || !WEIGHT_EXT.test(v)) continue;
        if (!licenseForWeight(v)) push("V1", `workflows/${file}`, `node ${id} (${cls}): weight "${v}" has no WEIGHT_LICENSES entry`);
        else if (RED_FLAG_WEIGHTS.some((re) => re.test(v))) push("V1", `workflows/${file}`, `node ${id} (${cls}): weight "${v}" matches a banned weight pattern`);
      }
    }
    const lic = Object.hasOwn(WORKFLOW_LICENSES, file) ? WORKFLOW_LICENSES[file] : graphLicense(g as never);
    if (opts.catalogChecks !== false && !Object.hasOwn(WORKFLOW_LICENSES, file))
      push("V1", `workflows/${file}`, "missing from licenses.generated.ts — rerun `npx tsx scripts/gen-licenses.ts`");
    report.push({ file, lic });
  }

  /* ---------- catalog coherence (repo root only) ---------- */
  if (opts.catalogChecks !== false) {
    for (const m of ALL_MODELS)
      for (const w of m.workflows) {
        const graph = w.providers.comfy?.workflow;
        const recipe = w.providers.recipe?.name;
        if (graph) {
          const mapLic = WORKFLOW_LICENSES[graph];
          if (mapLic && w.license && w.license.class !== mapLic.class)
            push("V1", w.endpointId, `catalog class "${w.license.class}" differs from its graph's "${mapLic.class}"`);
          if (!mapLic) push("V1", w.endpointId, `bundled graph "${graph}" is not in the generated license map`);
        } else if (recipe) {
          if (recipe !== "explainer" && !Object.hasOwn(RECIPE_LICENSES, recipe))
            push("V1", w.endpointId, `recipe "${recipe}" has no RECIPE_LICENSES entry`);
        } else {
          push("V1", w.endpointId, "endpoint has neither a comfy graph nor a recipe — no license surface");
        }
      }
  }

  /* ---------- recipe registry: every registered recipe needs an entry ---------- */
  const registry = await readMaybe(path.join(root, "src/lib/generation/recipes/index.ts"));
  if (registry) {
    const block = registry.match(/RECIPES[^=]*=\s*{([\s\S]*?)};/)?.[1] ?? registry;
    const names = [...block.matchAll(/(?:["'`]([a-z0-9-]+)["'`]|([a-z0-9_]+))\s*:/g)].map((m) => m[1] ?? m[2]);
    for (const name of names)
      if (name !== "explainer" && !Object.hasOwn(RECIPE_LICENSES, name))
        push("V1", "src/lib/generation/recipes/index.ts", `registered recipe "${name}" has no RECIPE_LICENSES entry`);
  }

  /* ---------- the explainer's MOTION table must agree with the catalog map ---------- */
  const explainerSrc = await readMaybe(path.join(root, "src/lib/generation/recipes/explainer.ts"));
  if (explainerSrc) {
    const motionBlock = explainerSrc.match(/MOTION[^=]*=\s*{([\s\S]*?)};/)?.[1] ?? "";
    const motionEps = [...motionBlock.matchAll(/endpoint:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
    const ours = Object.values(EXPLAINER_MOTION_ENDPOINTS).filter((x): x is string => x !== null);
    if (motionEps.length && JSON.stringify([...motionEps].sort()) !== JSON.stringify([...ours].sort()))
      push("V1", "src/lib/generation/recipes/explainer.ts", `MOTION endpoints (${motionEps.join(", ")}) drifted from EXPLAINER_MOTION_ENDPOINTS (${ours.join(", ")})`);
  }

  /* ---------- restricted-default scans ---------- */
  const scans: { code: string; rel: string; label: string }[] = [
    { code: "V2", rel: "src/lib/catalog/skills.ts", label: "skill default" },
    { code: "V3", rel: "src/lib/agent.ts", label: "agent default" },
    { code: "V4", rel: "src/app/canvas/page.tsx", label: "canvas default" },
  ];
  for (const { code, rel, label } of scans) {
    const src = await readMaybe(path.join(root, rel));
    if (!src) continue;
    for (const ep of new Set(scanEndpoints(src))) {
      const cls = endpointClass(ep);
      if (cls === "unknown") push(code, rel, `${label} references unknown endpoint "${ep}"`);
      else if (cls !== "open") push(code, rel, `${label} references ${cls} endpoint "${ep}"`);
    }
  }

  // app tiles deep-link a studio with ?model=<id>(&flow=<wf>) — the linked
  // default must be open (or the tile itself steers to a gated endpoint)
  const apps = await readMaybe(path.join(root, "src/lib/catalog/presets/apps.ts"));
  if (apps) {
    for (const m of apps.matchAll(/["'`]\/ai\/[a-z-]+\?([^"'`]+)["'`]/g)) {
      const q = new URLSearchParams(m[1]);
      const modelId = q.get("model");
      const flow = q.get("flow");
      if (!modelId) continue;
      const model = ALL_MODELS.find((x) => x.id === modelId);
      if (!model) { push("V4", "src/lib/catalog/presets/apps.ts", `app tile references unknown model "${modelId}"`); continue; }
      const w = (flow ? model.workflows.find((x) => x.id === flow) : undefined) ?? model.workflows[0];
      const cls = w ? endpointLicenseFor(w).class : "unknown";
      if (cls !== "open") push("V4", "src/lib/catalog/presets/apps.ts", `app tile deep-links ${cls} endpoint ${w?.endpointId ?? `${modelId}/${flow}`}`);
    }
  }

  /* ---------- test fixtures may only name real endpoints ---------- */
  // a stale/renamed endpoint in a fixture silently stops covering the real
  // route — restricted refs are legal (gating tests exercise them), unknown
  // ones are findings.
  const fxDir = path.join(root, "tests/fixtures");
  for (const f of (await fs.readdir(fxDir).catch(() => [] as string[])).filter((x) => x.endsWith(".json")).sort()) {
    const src = await readMaybe(path.join(fxDir, f));
    if (!src) continue;
    for (const ep of new Set(scanEndpoints(src)))
      if (endpointClass(ep) === "unknown") push("V1", `tests/fixtures/${f}`, `fixture references unknown endpoint "${ep}"`);
  }

  /* ---------- manifest coverage: every credentialed weight has a row ---------- */
  if (opts.catalogChecks !== false) {
    const manifest = await readMaybe(path.join(root, "models/manifest.json"));
    if (!manifest) {
      push("V1", "models/manifest.json", "manifest missing — run `npx tsx scripts/gen-manifest.ts`");
    } else {
      const rows = new Set(((JSON.parse(manifest) as Manifest).weights ?? []).map((r) => r.name));
      const want = new Set<string>();
      for (const name of Object.keys(WEIGHT_LICENSES)) want.add(name);
      for (const comps of Object.values(CLASS_COMPONENTS)) for (const cp of comps) want.add(cp.name);
      for (const lic of Object.values(RECIPE_LICENSES)) for (const cp of lic.components) want.add(cp.name);
      for (const name of want)
        if (!rows.has(name)) push("V1", "models/manifest.json", `component "${name}" has no manifest row — rerun gen-manifest`);
    }
  }

  /* ---------- printable report ---------- */
  const out: string[] = [];
  const byComponent = new Map<string, { c: LicenseComponent; workflows: string[] }>();
  for (const { file, lic } of report)
    for (const c of lic.components) {
      const row = byComponent.get(c.name) ?? { c, workflows: [] };
      row.workflows.push(file);
      byComponent.set(c.name, row);
    }
  for (const { c, workflows } of [...byComponent.values()].sort((a, b) => a.c.class === b.c.class ? a.c.name.localeCompare(b.c.name) : (a.c.class === "banned-known" ? 1 : -1))) {
    out.push(`${c.class.padEnd(13)} ${c.name}`);
    out.push(`${"".padEnd(13)}   ${c.license} — ${c.url}`);
    out.push(`${"".padEnd(13)}   workflows: ${workflows.join(", ")}`);
  }
  const nonOpen = report.filter((r) => r.lic.class !== "open");
  out.push(`\n${report.length} workflows — ${nonOpen.length} non-open:`);
  for (const r of nonOpen) out.push(`  ${r.lic.class.padEnd(10)} ${r.file}`);
  const known = [...byComponent.values()].filter((x) => x.c.class === "banned-known");
  out.push(`banned-known components (run with warning): ${known.map((x) => x.c.name).join("; ") || "none"}`);

  return { findings, text: out.join("\n") };
}

/** docs/LICENSES.md content — the committed file is only rewritten by
 *  --write; --check diffs this text in memory so a stale doc fails. */
export function licensesDocText(): string {
  const lines: string[] = [];
  lines.push(`# License table`);
  lines.push(``);
  lines.push(`Generated by \`scripts/license-audit.ts\` — do not edit by hand.`);
  lines.push(`Every weight/component a shipped workflow or recipe can reach, its license,`);
  lines.push(`and the workflows that use it. "banned-known" = known violation allowed to run`);
  lines.push(`with a warning until its replacement lands (see MODELS.md "License notes").`);
  lines.push(``);
  lines.push(`| Component | License | Class | Used by |`);
  lines.push(`|---|---|---|---|`);

  const rows = new Map<string, { c: LicenseComponent; usedBy: string[] }>();
  const credit = (c: LicenseComponent, via: string) => {
    const r = rows.get(c.name) ?? { c, usedBy: [] };
    if (!r.usedBy.includes(via)) r.usedBy.push(via);
    rows.set(c.name, r);
  };
  for (const [file, lic] of Object.entries(WORKFLOW_LICENSES))
    for (const c of lic.components) credit(c, file);
  for (const [recipe, lic] of Object.entries(RECIPE_LICENSES))
    for (const c of lic.components) credit(c, `recipe:${recipe}`);
  for (const m of ALL_MODELS)
    for (const w of m.workflows)
      if (w.providers.recipe?.name === "explainer")
        for (const c of endpointLicenseFor(w, { motion_model: "wan-vace" }).components) credit(c, w.endpointId);

  const esc = (s: string) => s.replace(/\|/g, "\\|");
  for (const { c, usedBy } of [...rows.values()].sort((a, b) => a.c.name.localeCompare(b.c.name))) {
    const src = c.url ? `[${esc(c.license)}](${c.url})` : esc(c.license);
    lines.push(`| ${esc(c.name)} | ${src} | ${c.class} | ${usedBy.map(esc).join(", ")} |`);
  }
  lines.push(``);
  const nonOpen = Object.entries(WORKFLOW_LICENSES).filter(([, l]) => l.class !== "open");
  lines.push(`## Non-open workflows`);
  lines.push(``);
  for (const [f, l] of nonOpen) lines.push(`- **${f}** — ${l.class}`);
  return lines.join("\n") + "\n";
}

export async function writeLicensesDoc(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "LICENSES.md"), licensesDocText());
}

/** Pure artifact freshness check — rebuilds each generated artifact in memory
 *  and diffs it against the committed file. Writes nothing. */
export async function checkArtifacts(root = "."): Promise<{ ok: boolean; stale: string[] }> {
  const stale: string[] = [];
  const rel = (p: string) => path.join(root, p);
  const same = async (relPath: string, want: string) => {
    const cur = await fs.readFile(rel(relPath), "utf8").catch(() => "");
    if (cur !== want) stale.push(relPath);
  };
  await same("src/lib/catalog/licenses.generated.ts", await generatedLicensesText());
  await same("docs/LICENSES.md", licensesDocText());
  await same("models/manifest.json", await manifestText());
  return { ok: stale.length === 0, stale };
}

/** nvdiffrast-class rasterizers carry non-commercial CUDA licences — the
 *  TRELLIS.2/TripoSplat native path must not touch them, including through a
 *  dynamic import. Scope covers the vendored model dirs, the node entry
 *  files, and the native GLB save/export path a mesh takes to disk. */
const SOURCE_CHECK_SCOPE = [
  "comfy/ldm/trellis2",
  "comfy/ldm/triposplat",
  "comfy_extras/nodes_trellis2.py",
  "comfy_extras/nodes_triposplat.py",
  // native GLB save/export path — the route a 3D mesh takes out of ComfyUI
  "comfy_extras/nodes_mesh_postprocess.py",
  "comfy_extras/nodes_save_3d.py",
  "comfy_extras/nodes_mesh_io.py",
  "comfy_extras/mesh3d",
];
const SOURCE_CHECK_PATTERNS = [
  /nvdiffrast/i, /nvdiffrec/i, /diff_?gaussian/i, /kaolin/i,
  /\bdiso\b/i, /mtldiffrast/i,
  /__import__\s*\(/, /import_module\s*\(/, /importlib/i,
];

export interface SourceHit { file: string; line: number; text: string }
export interface SourceCheckEvidence {
  check: "trellis2-nvdiffrast";
  ranAt: string;
  comfyRoot: string;
  scope: string[];
  patterns: string[];
  filesScanned: string[];
  hits: SourceHit[];
  clean: boolean;
  glbExportPath: string;
}

export async function sourceCheck(comfyRoot: string): Promise<SourceCheckEvidence> {
  const files: string[] = [];
  const walk = async (abs: string) => {
    const st = await fs.stat(abs).catch(() => null);
    if (!st) return;
    if (st.isDirectory()) {
      for (const f of await fs.readdir(abs)) await walk(path.join(abs, f));
    } else if (/\.py$/.test(abs)) files.push(abs);
  };
  for (const rel of SOURCE_CHECK_SCOPE) await walk(path.join(comfyRoot, rel));
  files.sort();

  const hits: SourceHit[] = [];
  for (const abs of files) {
    const lines = (await fs.readFile(abs, "utf8")).split("\n");
    lines.forEach((text, i) => {
      if (SOURCE_CHECK_PATTERNS.some((re) => re.test(text)))
        hits.push({ file: path.relative(comfyRoot, abs), line: i + 1, text: text.trim().slice(0, 200) });
    });
  }
  return {
    check: "trellis2-nvdiffrast",
    ranAt: new Date().toISOString(),
    comfyRoot,
    scope: [...SOURCE_CHECK_SCOPE],
    patterns: SOURCE_CHECK_PATTERNS.map((r) => r.source),
    filesScanned: files.map((f) => path.relative(comfyRoot, f)),
    hits,
    clean: hits.length === 0,
    glbExportPath: "comfy_extras/nodes_save_3d.py + comfy_extras/mesh3d — native GLB save/export path, in scope",
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const root = argv.includes("--root") ? (argv[argv.indexOf("--root") + 1] ?? ".") : ".";
  const allow = argv.includes("--allow-known") ? (argv[argv.indexOf("--allow-known") + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];

  if (argv.includes("--source-check")) {
    const comfyRoot = argv.includes("--source-root")
      ? (argv[argv.indexOf("--source-root") + 1] ?? "")
      : (process.env.COMFYUI_DIR ?? path.join(os.homedir(), "comfy", "ComfyUI"));
    const ev = await sourceCheck(comfyRoot);
    const out = argv.includes("--out")
      ? argv[argv.indexOf("--out") + 1] ?? ""
      : "/tmp/of-evidence/trellis2-nvdiffrast.json";
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(ev, null, 2) + "\n");
    console.log(`source-check: scanned ${ev.filesScanned.length} file(s) under ${comfyRoot}`);
    if (!ev.clean) {
      console.error(`FAIL — ${ev.hits.length} banned-import hit(s):`);
      for (const h of ev.hits) console.error(`  ${h.file}:${h.line}: ${h.text}`);
      process.exit(1);
    }
    console.log(`source-check: clean — evidence at ${out}`);
    if (!argv.includes("--check") && !argv.includes("--root")) process.exit(0);
  }

  if (argv.includes("--check") && root === ".") {
    // every generated artifact must match the committed one — nothing writes
    const { ok, stale } = await checkArtifacts(root);
    if (!ok) {
      for (const f of stale) console.error(`${f} is stale — regenerate it`);
      process.exit(1);
    }
  }

  const { findings, text } = await auditTree(root, { catalogChecks: root === ".", live: argv.includes("--live") });
  console.log(text);

  const allowed = (f: Finding) => allow.includes(f.code);
  const violations = findings.filter((f) => !allowed(f));
  const warnings = findings.filter(allowed);

  if (warnings.length) {
    console.log(`\nallowed-known findings (${warnings.length}):`);
    for (const f of warnings) console.log(`  ${f.code}  ${f.file}: ${f.message}`);
  }
  if (violations.length) {
    console.error(`\nFAIL (${violations.length} violation(s)):`);
    for (const f of violations) console.error(`  ${f.code}  ${f.file}: ${f.message}`);
    process.exit(1);
  }

  if (root === "." && argv.includes("--write")) await writeLicensesDoc(root);
  console.log(`\nlicense audit: ${violations.length === 0 ? "clean" : ""}${warnings.length ? ` (${warnings.length} allowed-known)` : ""}`);
}

if (process.argv[1] && process.argv[1].endsWith("license-audit.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
