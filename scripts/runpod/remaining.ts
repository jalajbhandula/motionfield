/** Prepare the remaining acceptance queue without contacting or starting a pod.
 * pnpm exec tsx scripts/runpod/remaining.ts
 * Execute only after the pod is ready:
 * pnpm exec tsx scripts/runpod/remaining.ts --execute --minutes 25
 * --only id,id selects exact entries; --cameras permits the optional preview queue.
 * This limits inference, NOT RunPod billing. Stop the pod in its console afterward.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { MOTION_PRESETS, presetTrajectories, isCoreTrajectory } from "../../src/lib/catalog/presets/trajectories";
import { findEndpoint } from "../../src/lib/catalog/video-models";
import { ENDPOINT_GRAPHS } from "../../src/lib/catalog/licenses.generated";

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => {
  const i = args.indexOf(key);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${key} needs a value`);
  return args[i + 1];
};
const root = path.resolve(option("--out", "../of-reports/remaining-gpu"));
const inputs = path.join(root, "inputs");
const source = path.resolve("../of-reports/evidence/final/inputs");
type Entry = { id: string; endpoint: string; params: Record<string, unknown>; refs: Record<string, string>; reserveSeconds: number; accept: string; diagnostic?: boolean; preview?: string };
const jobs: Entry[] = [];
const ensure = (file: string) => { if (!fs.existsSync(file)) throw new Error(`Missing local input: ${file}`); return file; };
function prepare() {
  fs.mkdirSync(inputs, { recursive: true });
  for (const name of ["man-ref.jpg", "draw_t1.png", "person.png", "product.png", "ref.png"]) {
    fs.copyFileSync(ensure(path.join(source, name)), path.join(inputs, name));
  }
  const clip = path.join(inputs, "source-2s.mp4");
  if (!fs.existsSync(clip)) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", ensure(path.join(source, "src.mp4")), "-vf", "fps=16", "-frames:v", "33", "-an", "-c:v", "libx264", "-crf", "16", clip]);
  // the swap endpoints gate on video_url >= 4s (vaceSource minSeconds) - the
  // 2s draw clip cannot double as the swap source
  fs.copyFileSync(ensure(path.join(source, "src45.mp4")), path.join(inputs, "source-4s.mp4"));
  jobs.push(
    { id: "character", endpoint: "motionfield/character/generate", params: { prompt: "The same man from the reference, whole head and feet visible, sitting on a wooden bench in a green park in daylight.", aspect_ratio: "3:4", resolution: "480p", batch_size: 1, steps: 16, seed: 731 }, refs: { image_urls: "man-ref.jpg" }, reserveSeconds: 240, accept: "Full reference framing; recognizable identity; actual park bench and outdoor scene. Decode alone is not a pass." },
    { id: "draw", endpoint: "motionfield/draw-to-video/v1.0", params: { timestamp: 1, prompt: "A small glowing red paper lantern floats beside the woman's head.", steps: 16, finish: false, seed: 731 }, refs: { video_url: "source-2s.mp4", image_url: "draw_t1.png" }, reserveSeconds: 360, accept: "Requested lantern appears in the drawn area; source outside the stroke mask is preserved; inspect start/middle/end for face drift." },
    { id: "explainer", endpoint: "motionfield/explainer/video", params: { prompt: "A seed sprouts in warm soil. Its roots take up water.", scenes: 2, look: "flat-2d", captions: "karaoke", motion_model: "wan-vace", voice: "af_heart", clip_duration: 1, steps: 8, finish: false }, refs: {}, reserveSeconds: 420, accept: "Two distinct scenes, audible narration, last spoken words captioned; every ASS/SRT/VTT cue ends within video duration." },
    { id: "reedit-candidate", endpoint: "motionfield/wan-animate/character-swap", params: { prompt: "The man in the reference photo walks naturally, navy bomber jacket and white shirt. Preserve the source background.", resolution: "480p", steps: 16, finish: false, likeness_consent: true }, refs: { video_url: "source-4s.mp4", image_urls: "man-ref.jpg" }, reserveSeconds: 480, diagnostic: true, accept: "Candidate only: no pose skeleton, stable identity, coherent movement. This does NOT pass Re-edit; integration plus an end-to-end Re-edit run are still required." },
  );
  for (const preset of MOTION_PRESETS) {
    if (preset.poster) continue;
    const moves = presetTrajectories(preset);
    const core = moves.every(isCoreTrajectory);
    jobs.push({ id: `camera-${preset.id}`, endpoint: core ? "motionfield/camera/image-to-video" : "motionfield/wan-2.2/image-to-video", params: { prompt: `Cinematic shot of the subject. ${preset.promptFragment}.`, ...(core ? { moves: moves.join("+"), strength: 0.65, distance: 4, fov: 40 } : {}), duration: 2, aspect_ratio: "16:9", resolution: "480p", steps: 8, seed: 731, finish: false }, refs: { image_url: ["pov", "body-mount", "tracking", "shoulder-follow"].includes(preset.id) ? "person.png" : "product.png" }, reserveSeconds: 420, preview: preset.id, accept: `${preset.title}: visually verify the claimed move. ${core ? "Rig executes the trajectory." : "Prompt-guided only; no rig execution claimed."} Keep as pending until reviewed.` });
  }
  for (const job of jobs) {
    if (!findEndpoint(job.endpoint)) throw new Error(`Unknown endpoint: ${job.endpoint}`);
    for (const name of Object.values(job.refs)) ensure(path.join(inputs, name));
  }
  const files = fs.readdirSync(inputs).map((name) => ({ name, sha256: createHash("sha256").update(fs.readFileSync(path.join(inputs, name))).digest("hex") }));
  fs.writeFileSync(path.join(root, "queue.json"), JSON.stringify({ hourlyUsd: 1.79, minutes: 25, estimatedComputeUsd: 1.79 * 25 / 60, billingStop: "manual console Stop Pod required", files, jobs }, null, 2));
  console.log(`Prepared ${jobs.length} jobs (${jobs.filter(j => j.preview).length} optional camera previews). No network calls or submissions.`);
}

async function execute() {
  const minutes = Number(option("--minutes", "25"));
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 25) throw new Error("--minutes must be >0 and <=25; includes this runner's preflight, not pod boot time");
  const only = option("--only", "").split(",").filter(Boolean);
  for (const id of only) if (!jobs.some(j => j.id === id)) throw new Error(`Unknown job id: ${id}`);
  const selected = jobs.filter(j => (!j.preview || args.includes("--cameras")) && (!only.length || only.includes(j.id)));
  if (!selected.length) throw new Error("No selected jobs (camera jobs also require --cameras)");
  try { process.loadEnvFile(".env"); } catch { /* all configuration may come from the shell */ }
  const base = new URL(process.env.COMFY_BASE_URL || "http://127.0.0.1:18189");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("COMFY_BASE_URL must use the local SSH tunnel");
  const direct = process.env.COMFY_DIRECT_URL || "http://127.0.0.1:18188";
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(direct).hostname)) throw new Error("COMFY_DIRECT_URL must use the local SSH tunnel");
  const began = Date.now();
  const deadline = began + minutes * 60_000;
  const headers: Record<string, string> = process.env.COMFY_API_KEY ? { authorization: `Bearer ${process.env.COMFY_API_KEY}` } : {};
  async function get(url: string, authenticated = false) {
    const r = await fetch(url, { headers: authenticated ? headers : {}, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`Preflight HTTP ${r.status} at ${new URL(url).pathname}`);
    return r.json();
  }
  await get(`${base.toString().replace(/\/$/, "")}/api/v2/health`, true);
  // the explainer's caption burn shells out to the render page at appBaseUrl -
  // a dead base fails the job AFTER its pod-side scenes and TTS already ran
  if (selected.some((j) => j.id === "explainer" && j.params.captions !== "off")) {
    const appBase = (process.env.PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
    try {
      const r = await fetch(`${appBase}/render/motion`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      throw new Error(`Explainer captions need the render page - start a dev server and set PUBLIC_BASE_URL (${appBase}/render/motion unreachable: ${e instanceof Error ? e.message : e})`);
    }
  }
  const queue = await get(`${direct}/queue`);
  if (queue.queue_running?.length || queue.queue_pending?.length) throw new Error("Comfy queue is busy; refusing to mix this bounded run with other work");
  const objects = await get(`${direct}/object_info`) as Record<string, { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }>;
  const modelMap = JSON.parse(process.env.COMFY_MODEL_MAP || "{}");
  for (const job of selected) {
    const graphName = ENDPOINT_GRAPHS[job.endpoint];
    if (!graphName) continue; // recipe submodels are checked when its provider submits
    const graph = JSON.parse(fs.readFileSync(path.join("workflows", graphName), "utf8"));
    for (const [id, node] of Object.entries(graph) as [string, { class_type: string; inputs: Record<string, unknown> }][]) {
      if (id === "_meta") continue;
      const contract = objects[node.class_type];
      if (!contract) throw new Error(`Missing node ${node.class_type}; stop pod rather than installing while billed`);
      for (const [key, value] of Object.entries(node.inputs)) {
        if (typeof value !== "string" || !/\.(safetensors|ckpt|pt|pth|bin)$/.test(value)) continue;
        const spec = contract.input?.required?.[key] || contract.input?.optional?.[key];
        const choices = Array.isArray(spec) && Array.isArray(spec[0]) ? spec[0] : null;
        if (choices && !choices.includes(modelMap[value] || value)) throw new Error(`Missing required model ${value}; stop pod, no automatic downloads`);
      }
    }
  }
  process.env.DATABASE_URL = "";
  process.env.PGLITE_DIR = path.join(root, "db");
  process.env.GENERATION_PROVIDER = "comfy";
  process.env.OF_ENABLE_UNVERIFIED = "1";
  // A pasted script is sufficient; avoid writer-model loading and local inference.
  for (const key of Object.keys(process.env)) if (key.startsWith("LLM_")) process.env[key] = "";
  execFileSync(process.execPath, ["--experimental-strip-types", "scripts/migrate.ts"], { stdio: "pipe", env: process.env });
  const { sql } = await import("../../src/db");
  const { createJob, tickJob, cancelJob } = await import("../../src/lib/jobs");
  const { filePathFor } = await import("../../src/lib/storage");
  const user = "remaining-gpu-acceptance";
  await sql(`INSERT INTO "user" (id,name,email,email_verified) VALUES ($1,'GPU acceptance','remaining-gpu@local.dev',true) ON CONFLICT DO NOTHING`, [user]);
  await sql(`INSERT INTO profiles (user_id,credits) VALUES ($1,100000) ON CONFLICT (user_id) DO UPDATE SET credits=100000`, [user]);
  const active = await sql<{ id: string }>(`SELECT id FROM jobs WHERE user_id=$1 AND status IN ('queued','in_progress')`, [user]);
  for (const row of active) await cancelJob(user, row.id);
  let activeId: string | null = null;
  const watchdog = setTimeout(() => {
    console.error("Inference deadline reached. Canceling current work. STOP POD IN RUNPOD NOW.");
    if (activeId) void cancelJob(user, activeId).catch(() => {});
    setTimeout(() => process.exit(2), 5000).unref();
  }, Math.max(1, deadline - Date.now()));
  try {
    for (const job of selected) {
      const resultFile = path.join(root, `${job.id}.json`);
      if (fs.existsSync(resultFile) && JSON.parse(fs.readFileSync(resultFile, "utf8")).status === "completed") continue;
      if (Date.now() + (job.reserveSeconds + 60) * 1000 > deadline) { console.log(`Not admitting ${job.id}: insufficient reserved time. STOP POD when this runner exits.`); break; }
      const params = { ...job.params };
      for (const [key, name] of Object.entries(job.refs)) {
        const filename = `remaining-${randomUUID()}${path.extname(name)}`;
        fs.mkdirSync("public/files/uploads", { recursive: true });
        fs.copyFileSync(path.join(inputs, name), path.join("public/files/uploads", filename));
        const url = `/files/uploads/${filename}`;
        const mime = /\.mp4$/.test(name) ? "video/mp4" : /\.jpg$/.test(name) ? "image/jpeg" : "image/png";
        await sql(`INSERT INTO uploads (user_id,url,mime,bytes,name) VALUES ($1,$2,$3,$4,$5)`, [user, url, mime, fs.statSync(path.join(inputs, name)).size, name]);
        params[key] = key === "image_urls" ? [url] : url;
      }
      const started = Date.now();
      const created = await createJob(user, { endpointId: job.endpoint, params, title: `Acceptance ${job.id}`, visibility: "private" });
      activeId = created.id;
      let row: { status: string; error: string | null; outputs: { url: string }[] } | undefined;
      while (Date.now() < Math.min(deadline, started + job.reserveSeconds * 1000)) {
        await tickJob(created.id);
        [row] = await sql<typeof row & object>(`SELECT status,error,outputs FROM jobs WHERE id=$1`, [created.id]);
        if (row && !["queued", "in_progress"].includes(row.status)) break;
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      if (!row || ["queued", "in_progress"].includes(row.status)) {
        await cancelJob(user, created.id);
        row = { status: "timeout", error: "Reserved job runtime exhausted", outputs: [] };
      }
      activeId = null;
      const saved: string[] = [];
      for (const [i, output] of (row.outputs || []).entries()) {
        const file = filePathFor(output.url);
        if (!file) continue;
        const dest = path.join(root, `${job.id}-${i}${path.extname(file)}`);
        fs.copyFileSync(file, dest);
        saved.push(dest);
      }
      fs.writeFileSync(resultFile, JSON.stringify({ ...row, id: created.id, seconds: (Date.now() - started) / 1000, saved, acceptance: "pending visual/audio review", diagnostic: job.diagnostic || false, criteria: job.accept }, null, 2));
      console.log(`${job.id}: ${row.status}; quality remains pending review`);
      if (row.status !== "completed") break; // investigate offline; do not burn credit retrying
    }
  } finally {
    clearTimeout(watchdog);
    if (activeId) await cancelJob(user, activeId).catch(() => {});
    console.log("Finished. STOP POD in RunPod now; inference cancellation does not stop billing.");
  }
}

async function main() {
  prepare();
  if (args.includes("--execute")) await execute();
}
main().then(() => process.exit(0)).catch((e) => {
  // Provider errors can contain credentials. Detailed private rows stay in the scratch DB.
  console.error("Preparation/execution failed. No automatic retries/downloads. Inspect local inputs and provider state; STOP POD if running.");
  if (e instanceof Error && !/(key|token|secret|bearer)/i.test(e.message)) console.error(`detail: ${e.message}`);
  process.exit(1);
});
