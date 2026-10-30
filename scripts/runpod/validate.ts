/**
 * Pod validation — submit one workflow JSON to a Comfy deployment through the
 * SDK and write an evidence JSON. The same placeholder engine the provider
 * uses (substitute + prune + remapModels) runs here, so what the pod executes
 * is what the repo graphs declare and what createJob submits.
 *
 *   COMFY_BASE_URL=http://127.0.0.1:18189 \
 *   pnpm exec tsx scripts/runpod/validate.ts \
 *     --workflow wan22a14b-t2v.json \
 *     --params '{"prompt":"a boat on a lake","steps":8,"width":640,"height":352,"frames":33}'
 *
 *   # validate the version on another branch without touching the worktree:
 *   --from public-cleanup:workflows/wan22a14b-t2v.json
 *
 *   # with media (repeatable — name is the placeholder the graph declares):
 *   --ref INPUT_IMAGE=/tmp/frame.png --ref END_IMAGE=/tmp/end.png
 *   # bare path shorthand maps to INPUT_IMAGE:
 *   --ref /tmp/frame.png
 *
 * --workflow names only ever resolve inside workflows/ — a bare safe filename
 * (^[a-z0-9][a-z0-9._-]*\.json$), no directories, no traversal. Error output
 * never echoes file contents and env credentials (COMFY_API_KEY/HF_TOKEN) are
 * scrubbed from everything this script prints.
 *
 * Outputs download under --media-dir (default /tmp/of-evidence/media). Media
 * refs never touch public/files — bytes go through the SDK's asset upload.
 * Evidence lands at --out (default /tmp/of-evidence/<wf>-<ts>.json):
 *   {workflow, source, params, status pass|fail|inconclusive,
 *    outputs+sha256 (+ffprobe duration/frames/size), wall_s, warm_s, cold_s,
 *    vram from /system_stats}
 * wall_s is submit→terminal; cold_s is submit→first-running (queue + weight
 * load); warm_s is first-running→terminal (execution). A timeout cancels the
 * job and records "inconclusive" — never a pass.
 * Exit codes: 0 pass, 1 fail, 2 inconclusive.
 *
 *   # no-submit lint — does the raw graph pass ComfyUI's prompt validation?
 *   # fetch /object_info once, then check graphs offline:
 *   pnpm exec tsx scripts/runpod/validate.ts --lint /tmp/of-object-info.json \
 *     --workflow wan22a14b-t2v.json
 *   Checks: every class_type is known; every required input key is present
 *   (a dynamic/autogrow input is satisfied by "<name>" or any "<name>.<sub>"
 *   key); every link targets an existing node. One line per problem; exit 1
 *   if any. Never contacts COMFY_BASE_URL, never submits.
 */
import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { z } from "zod";
import { Comfy } from "@comfyorg/sdk";
import { prune, remapModels, substitute } from "../../src/lib/generation/comfy";

const execFileP = promisify(execFile);
const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : null;
};
const refs: [string, string][] = []; // [PLACEHOLDER, path]
argv.forEach((a, i) => {
  if (a === "--ref" && argv[i + 1]) {
    const v = argv[i + 1];
    const eq = v.indexOf("=");
    refs.push(eq > 0 ? [v.slice(0, eq), v.slice(eq + 1)] : ["INPUT_IMAGE", v]);
  }
});

const SENTINEL = (k: string) => `__asset_${k}__`;

/** A workflow filename: bare, lowercase, no directories or traversal. */
const WF_NAME = /^[a-z0-9][a-z0-9._-]*\.json$/;
/** A git ref component — execFile passes it verbatim to `git show`, so dots
 *  and slashes are fine but no colons/spaces/option dashes. */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const REF_NAME = /^[A-Z_0-9]+$/;

/** Env credentials never reach stdout/stderr — not on the happy path, not
 *  inside a thrown error. Everything this script prints goes through the
 *  console patch below. */
const SECRETS = [process.env.COMFY_API_KEY, process.env.HF_TOKEN].filter((s): s is string => !!s);
const scrub = (s: string) => SECRETS.reduce((t, k) => t.split(k).join("[redacted]"), s);
for (const m of ["log", "error", "warn", "info"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...a: unknown[]) => orig(...a.map((x) => (typeof x === "string" ? scrub(x) : x)));
}

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
type InputSpec = Record<string, unknown>;
type ObjectInfo = Record<string, { input?: { required?: InputSpec; optional?: InputSpec } }>;

/** A node class's accepted input keys: its declared required+optional+hidden
 *  names, plus the conditional children — COMFY_DYNAMICCOMBO_V3 switches
 *  (e.g. DA3Inference.mode, DA3Render.output) serialize the selected option's
 *  inputs as "<parent>.<child>"; COMFY_AUTOGROW_V3 parents (e.g.
 *  BerniniConditioning.reference_images) serialize children as
 *  "<parent>.<child>"; and VHS-style combo metas declare per-choice keys
 *  under "formats" that serialize flat (e.g. pix_fmt on video/h264-mp4). */
function inputContract(spec: NonNullable<ObjectInfo[string]>, inputs: Record<string, unknown>) {
  const req = spec.input?.required ?? {};
  const opt = spec.input?.optional ?? {};
  const hid = (spec.input as { hidden?: InputSpec } | undefined)?.hidden ?? {};
  const declared = new Set([...Object.keys(req), ...Object.keys(opt), ...Object.keys(hid)]);
  const required = new Set(Object.keys(req));
  const dotted = new Set<string>(); // parents whose "<parent>.<child>" keys are legal
  for (const [k, v] of [...Object.entries(req), ...Object.entries(opt)]) {
    if (!Array.isArray(v)) continue;
    const meta = v[1] as {
      options?: { key?: unknown; inputs?: { required?: InputSpec; optional?: InputSpec } }[];
      formats?: Record<string, unknown[][]>;
    } | undefined;
    if (v[0] === "COMFY_AUTOGROW_V3") dotted.add(k);
    if (v[0] === "COMFY_DYNAMICCOMBO_V3") {
      const sel = (meta?.options ?? []).find((o) => o.key === inputs[k]);
      if (!sel) continue;
      for (const ck of Object.keys(sel.inputs?.required ?? {})) {
        declared.add(`${k}.${ck}`);
        required.add(`${k}.${ck}`);
      }
      for (const ck of Object.keys(sel.inputs?.optional ?? {})) declared.add(`${k}.${ck}`);
    }
    const fmt = inputs[k];
    // two "formats" metas exist: VHS_VideoCombine maps the choice to a list of
    // [key, type, meta] child inputs (serialized flat), VHS_LoadVideo maps it
    // to a defaults dict (no extra inputs) — only the list shape adds keys.
    const fmtChildren = typeof fmt === "string" ? meta?.formats?.[fmt] : undefined;
    if (Array.isArray(fmtChildren))
      for (const child of fmtChildren)
        if (Array.isArray(child)) declared.add(String(child[0]));
  }
  return { declared, required, dotted };
}

/** Offline prompt validation against an /object_info dump. The UI hides
 *  "advanced" inputs but ComfyUI still rejects a prompt missing any key in
 *  input.required — dynamic/autogrow inputs serialize their children as
 *  "<name>.<sub>", so either an exact key or a "<name>." prefix counts.
 *  Keys the class does not declare at all (a renamed or dropped input whose
 *  value ComfyUI would silently discard) are reported too. */
function lint(raw: Graph, info: ObjectInfo): string[] {
  const problems: string[] = [];
  const ids = new Set(Object.keys(raw).filter((k) => k !== "_meta"));
  for (const [id, node] of Object.entries(raw)) {
    if (id === "_meta") continue;
    const inputs = node.inputs ?? {};
    const spec = info[node.class_type];
    if (!spec) {
      problems.push(`${id}: unknown class_type "${node.class_type}"`);
    } else {
      const { declared, required, dotted } = inputContract(spec, inputs);
      const keys = Object.keys(inputs);
      for (const name of required) {
        if (!keys.some((k) => k === name || k.startsWith(`${name}.`)))
          problems.push(`${id} ${node.class_type}: missing required input "${name}"`);
      }
      for (const k of keys) {
        if (declared.has(k)) continue;
        const dot = k.indexOf(".");
        if (dot > 0 && dotted.has(k.slice(0, dot))) continue;
        problems.push(`${id} ${node.class_type}: unknown input "${k}"`);
      }
    }
    for (const [k, v] of Object.entries(inputs)) {
      if (Array.isArray(v) && v.length === 2 && (typeof v[0] === "string" || typeof v[0] === "number") && typeof v[1] === "number" && !ids.has(String(v[0])))
        problems.push(`${id} ${node.class_type}: input "${k}" links to missing node "${v[0]}"`);
    }
  }
  return problems;
}

interface Evidence {
  workflow: string;
  source: string;
  params: Record<string, unknown>;
  refs: { placeholder: string; path: string }[];
  job_id?: string;
  status: "pass" | "fail" | "inconclusive";
  error?: string;
  wall_s?: number;
  cold_s?: number | null;
  warm_s?: number | null;
  vram?: unknown;
  metrics?: unknown;
  base_url: string;
  ran_at: string;
  outputs: Record<string, unknown>[];
}

/** The workflow's raw graph plus where it came from — a workflows/ file in
 *  the worktree, or a `branch:workflows/name` blob read via `git show`
 *  (never a checkout). */
async function readWorkflow(): Promise<{ name: string; source: string; raw: Graph }> {
  const wfFile = arg("workflow");
  const from = arg("from");
  if (wfFile && from) throw new Error("pick --workflow or --from, not both");
  if (!wfFile && !from)
    throw new Error("usage: --workflow <name>.json | --from <branch>:workflows/<name>.json [--ref PLACEHOLDER=path]... [--params '{...}'] [--out evidence.json] [--media-dir dir] [--timeout s]");
  if (wfFile) {
    if (!WF_NAME.test(wfFile)) throw new Error(`--workflow: unsafe name (want ${WF_NAME})`);
    const file = path.join("workflows", wfFile);
    const text = await fs.readFile(file, "utf8").catch(() => { throw new Error(`--workflow: ${wfFile} not found under workflows/`); });
    let raw: Graph;
    try {
      raw = JSON.parse(text) as Graph;
    } catch {
      throw new Error(`--workflow: ${wfFile} is not a workflow JSON`);
    }
    return { name: wfFile, source: `workflows/${wfFile}`, raw };
  }
  const spec = from!;
  const sep = spec.indexOf(":");
  const branch = sep > 0 ? spec.slice(0, sep) : "";
  const wfPath = sep > 0 ? spec.slice(sep + 1) : "";
  const wfName = wfPath.startsWith("workflows/") ? wfPath.slice("workflows/".length) : "";
  if (!BRANCH.test(branch) || branch.includes("..")) throw new Error("--from: unsafe branch name");
  if (!WF_NAME.test(wfName)) throw new Error(`--from: want <branch>:workflows/<name>.json with a safe name (${WF_NAME})`);
  let stdout: string;
  try {
    ({ stdout } = await execFileP("git", ["show", `${branch}:workflows/${wfName}`], { maxBuffer: 8 << 20 }));
  } catch {
    throw new Error(`--from: git could not read ${branch}:workflows/${wfName}`);
  }
  try {
    return { name: wfName, source: `${branch}:workflows/${wfName}`, raw: JSON.parse(stdout) as Graph };
  } catch {
    throw new Error(`--from: ${branch}:workflows/${wfName} is not a workflow JSON`);
  }
}

/** ffprobe the downloaded output — duration/frames/size recorded per output. */
async function probe(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error", "-count_frames",
      "-show_entries", "stream=codec_type,nb_read_frames,nb_frames,width,height:format=duration,size",
      "-of", "json", file,
    ]);
    const j = JSON.parse(stdout) as { streams?: Record<string, unknown>[]; format?: Record<string, unknown> };
    const v = j.streams?.find((s) => s.codec_type === "video");
    return {
      duration_s: j.format?.duration !== undefined ? Number(j.format.duration) : undefined,
      frames: Number(v?.nb_read_frames ?? v?.nb_frames ?? 0) || undefined,
      width: Number(v?.width ?? 0) || undefined,
      height: Number(v?.height ?? 0) || undefined,
      size: j.format?.size !== undefined ? Number(j.format.size) : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Device VRAM from ComfyUI's /system_stats. The API proxy serves only the
 *  /api/v2 surface, so the stats URL is discovered via /api/v2/health's
 *  `upstream` — reachable on the pod's loopback and on a dev box; a tunnel
 *  that maps only the proxy reports vram:null honestly. The API key is sent
 *  same-origin only (never to the upstream host). */
async function systemStats(): Promise<unknown> {
  const base = (process.env.COMFY_BASE_URL || "http://127.0.0.1:8189").replace(/\/+$/, "");
  const key = process.env.COMFY_API_KEY;
  const get = async (url: string, auth: boolean) => {
    const r = await fetch(url, {
      headers: auth && key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(String(r.status));
    return r.json() as Promise<Record<string, unknown>>;
  };
  let stats: Record<string, unknown> | null = null;
  try {
    stats = await get(`${base}/system_stats`, true);
  } catch {
    try {
      const health = await get(`${base}/api/v2/health`, true);
      const up = typeof health?.upstream === "string" ? health.upstream.replace(/\/+$/, "") : "";
      if (up) stats = await get(`${up}/system_stats`, false);
    } catch { /* stats stay null */ }
  }
  const devices = stats?.devices;
  if (!Array.isArray(devices)) return null;
  return devices.map((d) => {
    const dev = d as Record<string, unknown>;
    return { name: dev.name, type: dev.type, vram_total: dev.vram_total, vram_free: dev.vram_free };
  });
}

async function main() {
  const { name: wfName, source, raw } = await readWorkflow();
  const lintFile = arg("lint");
  if (argv.includes("--lint") && (!lintFile || lintFile.startsWith("-")))
    throw new Error("--lint: want a path to an /object_info dump");
  if (lintFile) {
    const lintText = await fs.readFile(lintFile, "utf8").catch(() => { throw new Error(`--lint: ${lintFile} not readable`); });
    let info: ObjectInfo;
    try {
      info = JSON.parse(lintText) as ObjectInfo;
    } catch {
      throw new Error(`--lint: ${lintFile} is not an object_info JSON`);
    }
    const problems = lint(raw, info);
    for (const p of problems) console.log(p);
    console.log(problems.length ? `${source}: ${problems.length} problem(s)` : `${source}: clean`);
    process.exit(problems.length ? 1 : 0);
  }
  const rawParams = arg("params");
  let params: Record<string, unknown> = {};
  if (rawParams !== null) {
    let json: unknown;
    try {
      json = JSON.parse(rawParams);
    } catch {
      throw new Error("--params: not valid JSON");
    }
    const parsed = z.record(z.string(), z.unknown()).refine((v) => !Array.isArray(v)).safeParse(json);
    if (!parsed.success) throw new Error("--params: want a JSON object with string keys");
    params = parsed.data;
  }
  for (const [k] of refs) if (!REF_NAME.test(k)) throw new Error(`--ref: unsafe placeholder name (want ${REF_NAME})`);

  // placeholder map: params → UPPER_SNAKE, defaults for PREFIX/SEED — media
  // placeholders get a sentinel the asset swap replaces after substitution
  const map: Record<string, string> = {
    PREFIX: `of_val_${crypto.randomUUID().slice(0, 8)}`,
    SEED: String(params.seed ?? Math.floor(Math.random() * 1e9)),
    STEPS: String(params.steps ?? 20),
  };
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || typeof v === "object") continue;
    map[k.toUpperCase()] = String(v);
  }
  for (const [k] of refs) map[k] = SENTINEL(k);

  const optional = new Set<string>(
    Array.isArray((raw._meta as { optional?: unknown } | undefined)?.optional)
      ? ((raw._meta as { optional?: string[] }).optional!).filter((x) => typeof x === "string")
      : [],
  );
  // identical to createJob's non-override path: substitute → prune → remapModels
  const graph = remapModels(prune(substitute(raw, map, optional)));

  // sentinel → lazy SDK asset handles on media-input fields only — a loader
  // input that still carries {{X}} at this point already failed inside
  // substitute's assertResolved
  const comfy = new Comfy({ clientInfo: "motionfield-validate" });
  const uploaded = new Map<string, ReturnType<Comfy["assets"]["fromFile"]>>();
  for (const [id, node] of Object.entries(graph)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (typeof v === "string" && /^__asset_[A-Z_0-9]+__$/.test(v)) {
        const key = v.slice(8, -2);
        const file = refs.find(([r]) => r === key)?.[1];
        if (!file) throw new Error(`no --ref supplied for ${key}`);
        if (!uploaded.has(key)) uploaded.set(key, comfy.assets.fromFile(file));
        node.inputs[k] = uploaded.get(key);
      }
    }
  }

  const evidence: Evidence = {
    workflow: wfName,
    source,
    params,
    refs: refs.map(([k, p]) => ({ placeholder: k, path: p })),
    status: "inconclusive",
    base_url: process.env.COMFY_BASE_URL ?? "(sdk default)",
    ran_at: new Date().toISOString(),
    outputs: [],
  };

  const t0 = Date.now();
  let jobId: string | undefined;
  let timedOut = false;
  try {
    const job = await comfy.submit(comfy.workflows.fromJson(graph), {
      idempotencyKey: `val-${crypto.randomUUID()}`,
      // the proxy insists metadata be a string label; the SDK type narrows it
      // to Record<string,string> — the wire accepts the wider form, cast past
      metadata: `pod-validation:${wfName.replace(/\.json$/, "")}` as unknown as Record<string, string>,
    });
    jobId = job.id;
    evidence.job_id = job.id;
    console.log(`submitted ${source} -> ${job.id}`);

    const timeoutMs = (Number(arg("timeout")) || 1800) * 1000;
    let cur = job;
    let tRunning = 0;
    for (;;) {
      cur = await comfy.jobs.get(job.id);
      const secs = Math.round((Date.now() - t0) / 1000);
      if (cur.status === "queued" || cur.status === "running" || cur.status === "canceling") {
        if (cur.status === "running" && !tRunning) tRunning = Date.now();
        if (Date.now() - t0 > timeoutMs) {
          console.error(`timeout after ${secs}s — cancelling`);
          timedOut = true;
          await cur.cancel().catch(() => {});
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      console.log(`${cur.status} after ${secs}s`);
      const tEnd = Date.now();
      evidence.wall_s = Math.round((tEnd - t0) / 1000);
      // the proxy fills no started/completed timestamps, so the split is
      // measured client-side: cold = submit→first-running, warm = running→end
      evidence.cold_s = tRunning ? Math.round((tRunning - t0) / 1000) : null;
      evidence.warm_s = tRunning ? Math.round((tEnd - tRunning) / 1000) : null;
      evidence.status = cur.status === "succeeded" ? "pass" : cur.status === "canceled" ? "inconclusive" : "fail";
      evidence.error = cur.error ? `${cur.error.class_type ?? ""}: ${cur.error.message}` : undefined;
      evidence.metrics = cur.metrics;

      // collect outputs to the media dir — /tmp by default, never public/files
      const mediaDir = arg("media-dir") ?? "/tmp/of-evidence/media";
      if (cur.status === "succeeded") {
        await fs.mkdir(mediaDir, { recursive: true });
        for (const out of cur.outputs) {
          const base = path.basename(out.name);
          if (!base || base === "." || base === "..")
            throw new Error(`unsafe output name (${out.name.length} chars)`);
          const dest = path.join(mediaDir, base);
          await out.toFile(dest);
          const { size } = await fs.stat(dest);
          const { stdout } = await execFileP("shasum", ["-a", "256", dest]).catch(() => ({ stdout: "" }));
          evidence.outputs.push({
            nodeId: out.nodeId, name: out.name, type: out.type, contentType: out.contentType,
            bytes: size, path: dest, sha256: stdout.split(" ")[0] || undefined,
            ffprobe: await probe(dest),
          });
          console.log(`  ${out.type}: ${out.name} (${size}B)`);
        }
      }
      break;
    }
    if (timedOut) {
      evidence.status = "inconclusive";
      evidence.wall_s = Math.round((Date.now() - t0) / 1000);
      evidence.error = `timeout after ${evidence.wall_s}s — job cancelled`;
    }
  } catch (e) {
    evidence.status = timedOut ? "inconclusive" : "fail";
    evidence.wall_s = Math.round((Date.now() - t0) / 1000);
    evidence.error = e instanceof Error ? e.message : String(e);
  }
  evidence.vram = await systemStats().catch(() => null);

  const outPath = arg("out") ?? `/tmp/of-evidence/${wfName.replace(/\.json$/, "")}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const text = scrub(JSON.stringify(evidence, null, 2) + "\n");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, text);
  console.log(`evidence: ${outPath}`);
  process.exit(evidence.status === "pass" ? 0 : evidence.status === "inconclusive" ? 2 : 1);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
