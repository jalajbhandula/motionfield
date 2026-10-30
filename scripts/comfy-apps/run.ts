/**
 * Run a generated `.app.json` through the real ComfyUI `/prompt` path.
 * Converts the UI-format app graph back to API format (the same conversion
 * the frontend performs), applies `--set nodeId.input=value` overrides,
 * submits, waits, and reports output files + wall time.
 *
 *   npx tsx scripts/comfy-apps/run.ts <app.app.json> \
 *     --base http://127.0.0.1:8188 --set 6.video=clip.mp4 --fetch /tmp/outdir
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const file = args[0];
const opt = (n: string, d = "") => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = opt("--base", process.env.COMFY_BASE_URL ?? "http://127.0.0.1:8188").replace(/\/$/, "");
const OUT = opt("--fetch", "");
const overrides: [string, string, string][] = [];
for (let i = 0; i < args.length; i++)
  if (args[i] === "--set") {
    const m = args[++i].match(/^(\w+)\.([\w.]+)=(.*)$/);
    if (!m) throw new Error(`bad --set ${args[i]}`);
    overrides.push([m[1], m[2], m[3]]);
  }

type UiNode = { id: number; type: string; inputs?: { name: string; link?: number }[]; widgets_values?: unknown[] };

main().catch((e) => { console.error(e); process.exit(1); });
async function main() {
const app = JSON.parse(readFileSync(file, "utf8"));
const oi = (await (await fetch(`${BASE}/object_info`)).json()) as Record<string, {
  input_order?: { required?: string[]; optional?: string[]; hidden?: string[] };
  input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]>; hidden?: Record<string, unknown[]> };
}>;

const WIDGET_KINDS = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);
const isWidgetSpec = (s: unknown[]) => Array.isArray(s[0]) || WIDGET_KINDS.has(String(s[0]));

// linkId -> [srcNodeId, srcSlot]
const linkSrc = new Map<number, [number, number]>();
for (const l of app.links as number[][]) linkSrc.set(l[0], [l[1], l[2]]);

const prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
for (const n of app.nodes as UiNode[]) {
  const info = oi[n.type];
  if (!info) throw new Error(`unknown class ${n.type}`);
  const inputs: Record<string, unknown> = {};
  for (const inp of n.inputs ?? [])
    if (inp.link != null) {
      const src = linkSrc.get(inp.link);
      if (!src) throw new Error(`dangling link ${inp.link} on ${n.type}.${inp.name}`);
      inputs[inp.name] = [String(src[0]), src[1]];
    }
  // map widgets_values to input names in class-declared order; link inputs
  // consume no widget slot, control_after_generate adds an extra value
  const order = [
    ...(info.input_order?.required ?? []),
    ...(info.input_order?.optional ?? []),
    ...(info.input_order?.hidden ?? []),
  ];
  const specFor = (name: string) =>
    info.input?.required?.[name] ?? info.input?.optional?.[name] ?? info.input?.hidden?.[name];
  const wvRaw = n.widgets_values ?? [];
  if (!Array.isArray(wvRaw)) {
    // keyed object form (VHS_* nodes) — direct name mapping
    for (const [name, val] of Object.entries(wvRaw)) {
      const key = name === "save_image" ? "save_output" : name;
      if (inputs[key] === undefined) inputs[key] = val;
    }
  } else {
    let wi = 0;
    for (const name of order) {
      const spec = specFor(name);
      if (!spec || !isWidgetSpec(spec) || inputs[name] !== undefined) continue;
      if (wi >= wvRaw.length) break;
      inputs[name] = wvRaw[wi++];
      if ((spec[1] as { control_after_generate?: boolean })?.control_after_generate) wi++; // skip control value
    }
  }
  prompt[String(n.id)] = { class_type: n.type, inputs };
}

for (const [nid, inp, val] of overrides) {
  if (!prompt[nid]) throw new Error(`--set target node ${nid} not in graph`);
  const info = oi[prompt[nid].class_type]?.input;
  const s = info?.required?.[inp] ?? info?.optional?.[inp] ?? info?.hidden?.[inp];
  prompt[nid].inputs[inp] =
    s && Array.isArray(s[0]) ? val
    : s && String(s[0]) === "INT" ? parseInt(val, 10)
    : s && String(s[0]) === "FLOAT" ? parseFloat(val)
    : s && String(s[0]) === "BOOLEAN" ? val === "true"
    : val;
}

const t0 = Date.now();
const r = await fetch(`${BASE}/prompt`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt }),
});
const body = (await r.json()) as { prompt_id?: string };
if (!r.ok || !body.prompt_id) {
  console.error("submit failed", r.status, JSON.stringify(body, null, 2));
  process.exit(1);
}
console.log(`prompt_id ${body.prompt_id} — ${basename(file)}`);

type Hist = Record<string, {
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
  outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[]; gifs?: { filename: string; subfolder: string; type: string }[] }>;
}>;
let done: Hist[string] | null = null;
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  const h = (await (await fetch(`${BASE}/history/${body.prompt_id}`)).json()) as Hist;
  const entry = h[body.prompt_id];
  if (entry?.status?.completed || entry?.status?.status_str === "error") { done = entry; break; }
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
if (!done || done.status?.status_str === "error") {
  console.error(`job errored after ${secs}s`, JSON.stringify(done?.status, null, 2));
  process.exit(1);
}
console.log(`completed in ${secs}s`);
const files: { filename: string; subfolder: string; type: string }[] = [];
for (const o of Object.values(done.outputs ?? {})) files.push(...(o.images ?? []), ...(o.gifs ?? []));
if (OUT) mkdirSync(OUT, { recursive: true });
for (const f of files) {
  const url = `${BASE}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder)}&type=${f.type}`;
  console.log(`  ${f.filename}  ${url}`);
  if (OUT) {
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    writeFileSync(join(OUT, f.filename), buf);
    console.log(`    -> ${join(OUT, f.filename)} (${(buf.length / 1024).toFixed(0)} KB)`);
  }
}
process.exit(0);
}
