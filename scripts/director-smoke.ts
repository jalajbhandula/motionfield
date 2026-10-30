/**
 * Director smoke — submits the REAL catalog workflow (DIRECTOR.workflows[0])
 * so validate → workflowFor → map → substitute run exactly like createJob.
 *
 * Evidence discipline: inputs come from /tmp, upload through the SDK's asset
 * path, outputs download under /tmp/of-evidence/media — nothing ever touches
 * public/files. The evidence JSON (poses spec + job + graded-output sha256)
 * lands next to --out.
 *
 *   npx tsx scripts/director-smoke.ts --image /tmp/of-evidence/seed/frame.png \
 *     --params '{"moves":"dolly-in+pan-left","camera_aperture":"f1.4"}'
 *
 *   # text-only variant (no --image → director-wan-txt.json):
 *   npx tsx scripts/director-smoke.ts "a lighthouse on a cliff at dusk" \
 *     --params '{"moves":"dolly in then pan left","camera_aperture":"f1.4","camera_lens":"wide-24"}' \
 *     --dims 480x272
 *
 * Needs COMFY_BASE_URL reachable (pod tunnel or local proxy). Exits non-zero
 * on failure.
 */
import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { Comfy } from "@comfyorg/sdk";
import { placeholders, prune, remapModels, substitute } from "../src/lib/generation/comfy";
import { DIRECTOR } from "../src/lib/catalog/video/generate";

const execFileP = promisify(execFile);
const wf = DIRECTOR.workflows[0];
const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : null;
};
const positional = argv.filter((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--params");
const prompt = positional.find((a) => ![".png", ".jpg", ".webp", ".mp4"].includes(path.extname(a))) ?? "";

/** Sentinel → asset swap: the param carries a marker so the real placeholder
 *  map produces the media placeholder, then the loader input gets the SDK
 *  asset handle — bytes upload through the SDK, not public/files. */
const sentinelOf = (k: string) => `__asset_${k}__`;
const SENT_RE = /^__asset_([A-Z_0-9]+)__$/;

/** Reproduce the poses_json OF_Trajectory emits inside ComfyUI — the same
 *  camera_trajectory.compose_trajectory the node pack calls. */
async function posesJson(params: Record<string, unknown>, out: string): Promise<Record<string, unknown>> {
  const map = wf.providers.comfy!.map!(params);
  const spec = {
    moves: String(map.MOVES ?? "locked-off").split("+"),
    strength: Number(map.STRENGTH ?? 1),
    duration: Number(map.DURATION ?? 1),
    fps: Number(map.FPS ?? 16),
    seed: Number(map.SEED ?? 42),
    distance: Number(map.DISTANCE ?? 4),
    fov: Number(map.FOV ?? 40),
    subjectClass: "person",
    target: "auto",
    layer: "auto",
    post: "auto",
  };
  const py = [
    "import json,sys,importlib.util",
    "spec = json.loads(sys.argv[1])",
    "m = importlib.util.spec_from_file_location('ct', 'comfy-nodes/motionfield_nodes/core/camera_trajectory.py')",
    "ct = importlib.util.module_from_spec(m); m.loader.exec_module(ct)",
    "print(json.dumps(ct.compose_trajectory(spec), separators=(',',':')))",
  ].join("\n");
  const { stdout } = await execFileP("python3", ["-c", py, JSON.stringify(spec)]);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, stdout.trim() + "\n");
  return JSON.parse(stdout.trim());
}

async function main() {
  const raw = arg("params") ? (JSON.parse(arg("params")!) as Record<string, unknown>) : {};
  const params: Record<string, unknown> = {
    prompt,
    duration: 1,
    aspect_ratio: "16:9",
    seed: 42,
    steps: 6,
    fps: 16,
    ...raw,
  };
  // media refs → sentinels so placeholders() produces the same placeholder the
  // job path would, then the loader input gets the SDK asset handle instead
  const assets: Record<string, string> = {};
  if (arg("image")) { params.image_url = sentinelOf("INPUT_IMAGE"); assets.INPUT_IMAGE = arg("image")!; }
  const refFiles = [arg("ref"), arg("ref2"), arg("ref3")].filter(Boolean) as string[];
  if (refFiles.length) {
    const keys = ["REF_IMAGE", "REF_IMAGE_2", "REF_IMAGE_3"];
    params.image_urls = refFiles.map((p, i) => { assets[keys[i]] = p; return sentinelOf(keys[i]); });
  }
  for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];

  // --dims WxH pins CAM_W/CAM_H (and the 2x keyframe) smaller than any
  // catalog aspect — the review's 480×272 render cap for the GPU smokes.
  // It patches only the placeholder map; the rest of the real path stands.
  const dims = arg("dims");
  if (dims) {
    const m = /^(\d+)x(\d+)$/.exec(dims);
    if (!m) { console.error("--dims wants WxH (e.g. --dims 480x272)"); process.exit(1); }
    const [w, h] = [Number(m[1]), Number(m[2])];
    const orig = wf.providers.comfy!.map!;
    wf.providers.comfy!.map = (p) => ({
      ...orig(p), CAM_W: String(w), CAM_H: String(h), KF_W: String(w * 2), KF_H: String(h * 2),
    });
  }

  const jobId = `smoke-${crypto.randomUUID()}`;
  const bad = wf.validate?.(params);
  if (bad) { console.error(`validate: ${bad}`); process.exit(1); }

  const graphName = wf.providers.comfy!.workflowFor?.(params) ?? wf.providers.comfy!.workflow;
  const rawGraph = JSON.parse(await fs.readFile(path.join("workflows", graphName), "utf8"));
  const optional = new Set<string>(
    Array.isArray(rawGraph._meta?.optional) ? rawGraph._meta.optional.filter((x: unknown) => typeof x === "string") : [],
  );
  const graph = remapModels(prune(substitute(rawGraph, placeholders({ jobId, model: DIRECTOR, workflow: wf, params, appBaseUrl: "http://localhost:3000" }), optional)));

  const comfy = new Comfy({ clientInfo: "motionfield-director-smoke" });
  const handles = new Map<string, ReturnType<Comfy["assets"]["fromFile"]>>();
  for (const node of Object.values(graph) as { inputs: Record<string, unknown> }[])
    for (const [k, v] of Object.entries(node.inputs)) {
      const m = typeof v === "string" ? SENT_RE.exec(v) : null;
      if (!m) continue;
      const file = assets[m[1]];
      if (!file) throw new Error(`sentinel ${m[1]} has no file`);
      if (!handles.has(m[1])) handles.set(m[1], comfy.assets.fromFile(file));
      node.inputs[k] = handles.get(m[1]);
    }

  const t0 = Date.now();
  const timeoutMs = (Number(arg("timeout")) || 900) * 1000;
  const job = await comfy.submit(comfy.workflows.fromJson(graph), { idempotencyKey: jobId });
  console.log(`submitted ${graphName} -> ${job.id}`);

  let cur = job;
  for (;;) {
    cur = await comfy.jobs.get(job.id);
    const secs = Math.round((Date.now() - t0) / 1000);
    if (cur.status === "queued" || cur.status === "running" || cur.status === "canceling") {
      if (Date.now() - t0 > timeoutMs) {
        console.error(`timeout after ${secs}s — cancelling`);
        await cur.cancel().catch(() => {});
        process.exit(2);
      }
      await new Promise((r) => setTimeout(r, 2500));
      continue;
    }
    console.log(`${cur.status} after ${secs}s`);
    break;
  }

  // outputs under /tmp/of-evidence/media — the grade runs host-side on the
  // video bytes (postSpecFor → ffmpegVideo), never near public/files
  const mediaDir = arg("media-dir") ?? "/tmp/of-evidence/media";
  const outDir = arg("out-dir") ?? "/tmp/of-evidence";
  const outputs: Record<string, unknown>[] = [];
  if (cur.status === "succeeded") {
    await fs.mkdir(mediaDir, { recursive: true });
    const post = await wf.providers.comfy?.post?.(params);
    const postVf = post
      ? (await (await import("../src/lib/grade/post")).postSpecFor(params)).vf
      : null;
    for (const out of cur.outputs) {
      const dest = path.join(mediaDir, out.name);
      await out.toFile(dest);
      const isVideo = out.type === "video" || /\.(mp4|webm|mov)$/i.test(out.name);
      let graded = dest;
      if (isVideo && postVf) {
        const bytes = new Uint8Array(await fs.readFile(dest));
        const { ffmpegVideo } = await import("../src/lib/grade/post");
        const gradedBytes = await ffmpegVideo(bytes, postVf);
        graded = dest.replace(/(\.[^.]+)$/, ".graded$1");
        await fs.writeFile(graded, gradedBytes);
      }
      const { size } = await fs.stat(graded);
      const { stdout } = await execFileP("shasum", ["-a", "256", graded]).catch(() => ({ stdout: "" }));
      outputs.push({ nodeId: out.nodeId, name: path.basename(graded), type: out.type, bytes: size, path: graded, sha256: stdout.split(" ")[0] || undefined, graded: graded !== dest });
      console.log(`  ${out.type}: ${path.basename(graded)} (${size}B)`);
    }
  }

  // poses replay the OF_Trajectory math host-side — runs for every variant
  const poses = await posesJson(params, path.join(outDir, `director-poses-${job.id.slice(0, 8)}.json`)).catch((e) => { console.error(`poses: ${e}`); return null; });

  const evidence = {
    ok: cur.status === "succeeded",
    workflow: graphName,
    params,
    job_id: job.id,
    status: cur.status,
    error: cur.error ? `${cur.error.class_type ?? ""}: ${cur.error.message}` : undefined,
    elapsed_s: Math.round((Date.now() - t0) / 1000),
    metrics: cur.metrics,
    base_url: process.env.COMFY_BASE_URL ?? "(sdk default)",
    ran_at: new Date().toISOString(),
    outputs,
    poses,
  };
  const text = JSON.stringify(evidence, null, 2) + "\n";
  const outPath = arg("out");
  if (outPath) {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, text);
    console.log(`evidence: ${outPath}`);
  } else console.log(text);
  process.exit(cur.status === "succeeded" ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
