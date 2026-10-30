/**
 * Build ComfyUI "App" workflows (UI format, `extra.linearMode`) from the
 * MotionField API-format graphs in `workflows/`.
 *
 *   npx tsx scripts/comfy-apps/build.ts [--check] [--base URL] [--out DIR]
 *
 * The converter mirrors the app's own submission pipeline: `{{PLACEHOLDER}}`
 * substitution (including `_meta.optional` node drops + `_meta.passthrough`
 * rewiring), `drop_outputs`, and unreachable-node pruning — so the shipped
 * .app.json files stay synchronised with the API graphs by construction.
 * Every class, input name and link is validated against the live
 * `/object_info` of the target ComfyUI (`--base`, default 127.0.0.1:8188).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = resolve(import.meta.dirname, "../..");
const WF_DIR = join(ROOT, "workflows");
const OUT_DIR = join(ROOT, "comfy-nodes/motionfield_nodes/example_workflows");

type ApiGraph = Record<string, { class_type: string; inputs: Record<string, unknown> } | Record<string, unknown>>;
type ObjectInfo = Record<string, {
  input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]>; hidden?: Record<string, unknown[]> };
  input_order?: { required?: string[]; optional?: string[]; hidden?: string[] };
  output?: unknown[];
  output_name?: string[];
  output_is_list?: boolean[];
}>;

interface AppDef {
  file: string;
  app: string;
  out: string;
  /** Placeholder values; `undefined` drops nodes for `_meta.optional` keys. */
  defaults: Record<string, string | number | boolean | undefined>;
  /** [nodeId, inputName, label] — become linearData.inputs. */
  promote: [string, string, string][];
  /** Output node ids — become linearData.outputs. */
  outputs: string[];
  uuid: string;
}

const APPS: AppDef[] = [
  {
    file: "zimage-txt2img.json",
    app: "MotionField Image",
    out: "motionfield-image.app.json",
    uuid: "6f6c9b6e-9f8a-4a0a-9a3d-9f9b0f2f0001",
    defaults: {
      PROMPT: "A rain-lit neon alley at night, a lone figure under a flickering sign, cinematic still, shallow depth of field",
      WIDTH: 832, HEIGHT: 480, BATCH: 1, SEED: 42, STEPS: 8,
      PREFIX: "MotionField/Image",
    },
    promote: [
      ["4", "text", "Prompt"],
      ["6", "width", "Width"],
      ["6", "height", "Height"],
      ["8", "steps", "Steps"],
      ["8", "seed", "Seed"],
    ],
    outputs: ["10"],
  },
  {
    file: "director-wan.json",
    app: "MotionField Director",
    out: "motionfield-director.app.json",
    uuid: "6f6c9b6e-9f8a-4a0a-9a3d-9f9b0f2f0002",
    defaults: {
      INPUT_IMAGE: "example.png",
      REF_IMAGE: undefined, REF_IMAGE_2: undefined, REF_IMAGE_3: undefined,
      PROMPT: "A rain-lit neon alley at night — the camera pushes past a waiting figure, cinematic, shallow depth of field",
      NEGATIVE: "",
      MOVES: "dolly-in", STRENGTH: 1.0, DURATION: 5.0, DISTANCE: 4.0, FOV: 40,
      APERTURE: 2.8,
      CAM_W: 832, CAM_H: 480, CAM_FRAMES: 81, FPS: 16, SEED: 42, STEPS: 8,
      PREFIX: "MotionField/Director", REFGRID_PREFIX: "MotionField/Director-refgrid",
    },
    promote: [
      ["6", "image", "Start frame"],
      ["4", "text", "Prompt"],
      ["5", "text", "Negative prompt"],
      ["7", "moves", "Camera move"],
      ["7", "strength", "Move strength"],
      ["7", "distance", "Subject distance (m)"],
      ["7", "fov", "Lens FOV (°)"],
      ["12", "length", "Clip length (frames)"],
      ["13", "steps", "Steps"],
      ["13", "seed", "Seed"],
    ],
    outputs: ["23"],
  },
  {
    file: "reshoot-video.json",
    app: "MotionField Re-shoot",
    out: "motionfield-reshoot.app.json",
    uuid: "6f6c9b6e-9f8a-4a0a-9a3d-9f9b0f2f0003",
    defaults: {
      INPUT_VIDEO: "example.mp4",
      MOVES: "dolly-in", PROMPT: "the same scene re-shot along the new camera path", NEGATIVE: "",
      STRENGTH: 1.0, DISTANCE: 4.0, DURATION: 2.0,
      WIDTH: 832, HEIGHT: 480, FRAMES: 33, PAD_FRAMES: 33,
      DA3_RES: 518, FPS: 16, SEED: 42, STEPS: 8,
      PREFIX: "MotionField/Reshoot",
    },
    promote: [
      ["6", "video", "Source clip"],
      ["10", "moves", "Camera move"],
      ["4", "text", "Prompt"],
      ["5", "text", "Negative prompt"],
      ["10", "strength", "Move strength"],
      ["10", "distance", "Subject distance (m)"],
      ["6", "frame_load_cap", "Frames"],
      ["6", "force_rate", "FPS"],
      ["14", "steps", "Steps"],
      ["14", "seed", "Seed"],
    ],
    outputs: ["18"],
  },
  {
    file: "person-swap-person.json",
    app: "MotionField PersonSwap",
    out: "motionfield-person-swap.app.json",
    uuid: "6f6c9b6e-9f8a-4a0a-9a3d-9f9b0f2f0004",
    defaults: {
      INPUT_VIDEO: "example.mp4",
      REF_IMAGE: "example.png", REF_IMAGE_2: undefined, REF_IMAGE_3: undefined,
      PROMPT: "", NEGATIVE: "",
      WIDTH: 832, HEIGHT: 480, FRAMES: 33, SEED: 42, STEPS: 8,
      PREFIX: "MotionField/PersonSwap",
    },
    promote: [
      ["6", "video", "Source clip"],
      ["7", "image", "Identity reference"],
      ["4", "text", "Prompt"],
      ["5", "text", "Negative prompt"],
      ["18", "steps", "Steps"],
      ["18", "seed", "Seed"],
    ],
    outputs: ["21"],
  },
  {
    file: "vfx-ltx-plate-classic.json",
    app: "MotionField VFX Lab",
    out: "motionfield-vfx-lab.app.json",
    uuid: "6f6c9b6e-9f8a-4a0a-9a3d-9f9b0f2f0005",
    defaults: {
      INPUT_VIDEO: "example.mp4",
      PROMPT: "the scene dissolves into drifting embers and smoke, cinematic VFX plate",
      NEGATIVE: "",
      END_IMAGE: undefined, END_FRAME: undefined,
      TARGET_STRENGTH: 0.8,
      HOLD_FRAMES: 9, HOLD_IDX: 0,
      WIDTH: 832, HEIGHT: 480, FRAMES: 49, FPS: 24,
      STEPS: 20, DENOISE: 0.6, SEED: 42,
      PREFIX: "MotionField/VFX",
    },
    promote: [
      ["6", "video", "Plate clip"],
      ["3", "text", "Effect prompt"],
      ["4", "text", "Negative prompt"],
      ["16", "denoise", "Plate lock (denoise)"],
      ["15", "steps", "Steps"],
      ["17", "noise_seed", "Seed"],
    ],
    outputs: ["20"],
  },
];

const WIDGET_KINDS = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);

/* ---------------- API-graph passes (mirror src/lib/generation/comfy.ts) --- */

const RESERVED = new Set(["PROMPT", "NEGATIVE", "MOVES", "SIGMAS", "PREFIX", "REFGRID_PREFIX", "KEYFRAME_PREFIX"]);

function substitute(graph: ApiGraph, map: Record<string, unknown>, optional: ReadonlySet<string>): ApiGraph {
  const dropNodes = new Set<string>();
  const out: ApiGraph = {};
  for (const [id, node] of Object.entries(graph)) {
    if (id === "_meta") continue;
    const inputs: Record<string, unknown> = {};
    let drop = false;
    for (const [k, v] of Object.entries(node.inputs as Record<string, unknown>)) {
      if (typeof v === "string" && /^\{\{[A-Z_0-9]+\}\}$/.test(v)) {
        const key = v.slice(2, -2);
        const val = map[key];
        if (val === undefined) {
          if (optional.has(key)) { drop = true; break; }
          inputs[k] = v;
          continue;
        }
        inputs[k] = val === "true" || val === "false" ? val === "true"
          : typeof val === "string" && /^\d+(\.\d+)?$/.test(val) && !RESERVED.has(key) ? Number(val) : val;
      } else inputs[k] = v;
    }
    if (!drop) out[id] = { class_type: (node as { class_type: string }).class_type, inputs };
    else dropNodes.add(id);
  }
  if (dropNodes.size) {
    const passthrough = ((graph._meta as { passthrough?: Record<string, string[]> })?.passthrough) ?? {};
    for (const node of Object.values(out)) {
      const n = node as { inputs: Record<string, unknown> };
      for (const [k, v] of Object.entries(n.inputs)) {
        if (Array.isArray(v) && typeof v[0] === "string" && dropNodes.has(v[0])) {
          let link: unknown = v;
          while (Array.isArray(link) && typeof link[0] === "string" && dropNodes.has(link[0])) {
            const input = passthrough[link[0]]?.[Number(link[1])];
            link = input !== undefined ? (graph[link[0]] as { inputs: Record<string, unknown> })?.inputs?.[input] : undefined;
          }
          if (Array.isArray(link)) n.inputs[k] = link;
          else delete n.inputs[k];
        }
      }
    }
  }
  return out;
}

const OUTPUT_CLASSES = new Set(["SaveImage", "PreviewImage", "SaveVideo", "VHS_VideoCombine", "SaveAudio", "SaveGLB", "OF_PlateAudio"]);

function prune(graph: ApiGraph): ApiGraph {
  const used = new Set<string>();
  for (const node of Object.values(graph))
    for (const v of Object.values((node as { inputs: Record<string, unknown> }).inputs))
      if (Array.isArray(v) && typeof v[0] === "string") used.add(v[0]);
  const out: ApiGraph = {};
  for (const [id, node] of Object.entries(graph))
    if (used.has(id) || OUTPUT_CLASSES.has((node as { class_type: string }).class_type)) out[id] = node;
  return Object.keys(out).length === Object.keys(graph).length ? out : prune(out);
}

function assertResolved(graph: ApiGraph, file: string): void {
  const missing = new Set<string>();
  for (const node of Object.values(graph))
    for (const v of Object.values((node as { inputs: Record<string, unknown> }).inputs))
      if (typeof v === "string" && /^\{\{[A-Z_0-9]+\}\}$/.test(v)) missing.add(v.slice(2, -2));
  if (missing.size) throw new Error(`${file}: missing placeholder defaults: ${[...missing].sort().join(", ")}`);
}

/* -------------------------- UI-format conversion ------------------------ */

const enc = (s: string) => encodeURIComponent(s);

function inputSpec(oi: ObjectInfo, cls: string, name: string): { spec: unknown[]; section: "required" | "optional" | "hidden" } | null {
  const inp = oi[cls]?.input;
  for (const section of ["required", "optional", "hidden"] as const) {
    const spec = inp?.[section]?.[name];
    if (spec !== undefined) return { spec: spec as unknown[], section };
  }
  return null;
}

/** A spec is a widget when its type is a primitive/combo rather than a
 *  node-link type string. */
function isWidgetSpec(spec: unknown[]): boolean {
  const t = spec[0];
  return Array.isArray(t) || WIDGET_KINDS.has(String(t));
}

function buildUiWorkflow(def: AppDef, apiGraph: ApiGraph, oi: ObjectInfo, problems: string[]) {
  const graphId = def.uuid;
  const nodes: Record<string, unknown>[] = [];
  const links: unknown[][] = [];
  let linkId = 0;

  const ids = Object.keys(apiGraph).filter((k) => k !== "_meta");
  const numericIds = new Map(ids.map((id) => [id, Number(id) || 0]));

  // topo order for the `order` field (Kahn over links)
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const downstream = new Map<string, string[]>();
  for (const id of ids)
    for (const v of Object.values((apiGraph[id] as { inputs: Record<string, unknown> }).inputs))
      if (Array.isArray(v) && typeof v[0] === "string") {
        indeg.set(id, (indeg.get(id) ?? 0) + 1);
        downstream.set(v[0], [...(downstream.get(v[0]) ?? []), id]);
      }
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const topo: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    topo.push(id);
    for (const d of downstream.get(id) ?? []) {
      indeg.set(d, (indeg.get(d) ?? 1) - 1);
      if ((indeg.get(d) ?? 0) === 0) queue.push(d);
    }
  }
  const orderOf = new Map(topo.map((id, i) => [id, i]));

  for (const [i, id] of ids.entries()) {
    const node = apiGraph[id] as { class_type: string; inputs: Record<string, unknown> };
    const cls = node.class_type;
    const info = oi[cls];
    if (!info) { problems.push(`${def.file} node ${id}: unknown class ${cls}`); continue; }

    const order = [
      ...(info.input_order?.required ?? []),
      ...(info.input_order?.optional ?? []),
      ...(info.input_order?.hidden ?? []),
    ];
    // any api inputs the class doesn't declare in input_order keep their api order at the end
    for (const k of Object.keys(node.inputs)) if (!order.includes(k)) order.push(k);

    const uiInputs: Record<string, unknown>[] = [];
    const widgets: unknown[] = [];
    const seen = new Set<string>();

    for (const name of order) {
      const has = Object.prototype.hasOwnProperty.call(node.inputs, name);
      const spec = has ? inputSpec(oi, cls, name) : null;
      const raw = has ? node.inputs[name] : undefined;
      const isLink = Array.isArray(raw) && raw.length === 2;
      if (isLink) {
        const [src, slot] = raw as [string, number];
        const srcNode = apiGraph[src] as { class_type: string } | undefined;
        if (!srcNode) { problems.push(`${def.file} node ${id}.${name}: link to missing node ${src}`); continue; }
        const type = String(oi[srcNode.class_type]?.output?.[Number(slot)] ?? "*");
        uiInputs.push({ name, type, link: ++linkId });
        links.push([linkId, numericIds.get(src), Number(slot), numericIds.get(id), uiInputs.length - 1, type]);
        seen.add(name);
        continue;
      }
      if (spec === null && has) {
        // undeclared scalar input — treat as a trailing widget (e.g. VHS extras)
        widgets.push(raw);
        seen.add(name);
        continue;
      }
      if (spec === null) continue;
      const { spec: s } = spec;
      if (isWidgetSpec(s)) {
        const val = has ? raw : (s[1] as { default?: unknown })?.default;
        if (val === undefined && !has) { seen.add(name); continue; }
        widgets.push(val);
        if ((s[1] as { control_after_generate?: boolean })?.control_after_generate) widgets.push("randomize");
        seen.add(name);
      } else if (has) {
        // declared link-type input left unlinked — serialize the slot empty
        uiInputs.push({ name, type: String(s[0]) });
        seen.add(name);
      }
    }
    // leftover scalar api inputs (class evolved / hidden widgets)
    for (const [name, raw] of Object.entries(node.inputs)) {
      if (seen.has(name) || (Array.isArray(raw) && raw.length === 2)) continue;
      widgets.push(raw);
    }

    // VHS_* nodes serialize widgets_values as a keyed object — their loader
    // migrates legacy arrays via a convList order that differs from
    // input_order, so the keyed form is the only safe write.
    let widgetsValues: unknown = widgets;
    if (cls.startsWith("VHS_")) {
      const wvObj: Record<string, unknown> = {};
      for (const [name, raw] of Object.entries(node.inputs)) {
        const s = inputSpec(oi, cls, name);
        if (Array.isArray(raw) && raw.length === 2) continue;
        if (s && !isWidgetSpec(s.spec)) continue;
        wvObj[name] = raw;
      }
      if (cls === "VHS_VideoCombine" && "save_output" in wvObj) wvObj.save_image = wvObj.save_output;
      widgetsValues = wvObj;
    }

    // outputs with link ids
    const outNames = info.output_name ?? (info.output ?? []).map((_, i) => `output_${i}`);
    const uiOutputs = outNames.map((name, slot) => ({
      name: String(name),
      type: String(info.output?.[slot] ?? "*"),
      slot_index: slot,
      links: links.filter((l) => l[1] === numericIds.get(id) && l[2] === slot).map((l) => l[0]),
    }));
    for (const o of uiOutputs) if (!(o.links as number[]).length) o.links = null as never;

    nodes.push({
      id: numericIds.get(id),
      type: cls,
      pos: [40 + (i % 4) * 440, 40 + Math.floor(i / 4) * 340],
      size: [400, Math.max(120, 60 + widgets.length * 26 + uiInputs.length * 20)],
      flags: {},
      order: orderOf.get(id) ?? i,
      mode: 0,
      inputs: uiInputs,
      outputs: uiOutputs,
      properties: { "Node name for S&R": cls },
      widgets_values: widgetsValues,
    });
  }

  const promoted = def.promote.map(([nid, input, label]) => {
    if (!apiGraph[nid]) { problems.push(`${def.file}: promoted node ${nid} missing after substitution`); return null; }
    return [`${graphId}:${numericIds.get(nid)}:${enc(input)}`, label];
  }).filter(Boolean);

  const missingOut = def.outputs.filter((o) => !apiGraph[o]);
  if (missingOut.length) problems.push(`${def.file}: output nodes missing: ${missingOut.join(", ")}`);

  return {
    id: graphId,
    revision: 0,
    last_node_id: Math.max(...[...numericIds.values()], 0),
    last_link_id: linkId,
    nodes,
    links,
    groups: [],
    definitions: { subgraphs: [] },
    config: {},
    extra: {
      ds: { scale: 1, offset: [0, 0] },
      frontendVersion: "1.55.17",
      linearMode: true,
      linearData: { inputs: promoted, outputs: def.outputs.map((o) => numericIds.get(o)) },
    },
    version: 0.4,
    _meta_app: { name: def.app, source: def.file },
  };
}

/* --------------------------------- main --------------------------------- */

async function main() {
  const args = process.argv.slice(2);
  const flag = (n: string) => args.includes(n);
  const opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const base = opt("--base", process.env.COMFY_BASE_URL ?? "http://127.0.0.1:8188").replace(/\/$/, "");
  const outDir = opt("--out", OUT_DIR);
  const check = flag("--check");
  const only = opt("--apps", "").split(",").filter(Boolean);

  const res = await fetch(`${base}/object_info`);
  if (!res.ok) throw new Error(`object_info ${res.status} from ${base}`);
  const oi = (await res.json()) as ObjectInfo;
  console.log(`object_info: ${Object.keys(oi).length} classes from ${base}`);

  mkdirSync(outDir, { recursive: true });
  const problems: string[] = [];

  for (const def of APPS) {
    if (only.length && !only.includes(def.out) && !only.includes(def.app)) continue;
    const raw = JSON.parse(readFileSync(join(WF_DIR, def.file), "utf8")) as ApiGraph;
    const meta = (raw._meta ?? {}) as { optional?: string[]; drop_outputs?: string[] };
    const optional = new Set(meta.optional ?? []);
    const map: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(def.defaults)) if (v !== undefined) map[k] = String(v);

    let graph = substitute(raw, map, optional);
    // drop_outputs mirrors the provider's runtime save-node removal
    for (const id of meta.drop_outputs ?? []) delete graph[id];
    graph = prune(graph);
    assertResolved(graph, def.file);

    const wf = buildUiWorkflow(def, graph, oi, problems);
    const appMeta = wf._meta_app as { name: string; source: string };
    delete (wf as Record<string, unknown>)._meta_app;
    const path = join(outDir, def.out);
    writeFileSync(path, JSON.stringify(wf, null, 2) + "\n");
    console.log(`${def.out}  ${appMeta.name}  nodes=${wf.nodes.length} links=${wf.links.length} inputs=${wf.extra.linearData.inputs.length}`);
    if (!check) continue;
  }

  if (problems.length) {
    for (const p of problems) console.error(`  INVALID  ${p}`);
    process.exit(1);
  }
  console.log("all apps valid against /object_info");
}

main().catch((e) => { console.error(e); process.exit(1); });
