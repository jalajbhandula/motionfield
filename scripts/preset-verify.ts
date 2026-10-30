/**
 * preset-verify — the preset-honesty pipeline (ws4 s3b).
 *
 *  Every catalog preset is a PresetSpec with a declared mechanism. This
 *  script is the only thing that may mark one `verified`:
 *
 *    npx tsx scripts/preset-verify.ts --list            # the queue + status
 *    npx tsx scripts/preset-verify.ts --dry             # static checks only
 *    npx tsx scripts/preset-verify.ts --id a,b --seeds 2 --write   # run + record
 *    npx tsx scripts/preset-verify.ts --collection restyle --write
 *    npx tsx scripts/preset-verify.ts --queue [path]    # default /tmp/of-verify/queue-ws4.json
 *    npx tsx scripts/preset-verify.ts --e2e-fixture     # regenerate the e2e verify fixture
 *    flags: --catalog app|effect|style|motion · --include-motion · --budget-min N
 *
 *  Static checks (always, no GPU):
 *    1. mechanism resolves to a real executor — catalog endpoint + bundled
 *       workflow file, catalog trajectory ids, or a registered pipeline
 *    2. the mechanism's inputs line up with inputs the endpoint actually
 *       declares (no dead-control presets)
 *    3. license — a visible spec's endpoint may not be restricted/banned
 *    4. the verify file holds a `verified` record with a matching
 *       mechanism_hash (else the preset is invisible everywhere; the motion
 *       catalog is exempt — WS3's own list gates it)
 *
 *  Runs (--write): submit a real job per seed through createJob+tickJob
 *  (own PGLITE_DIR, like re-edit-smoke). All renders finish FIRST, then
 *  ComfyUI gets POST /free and the checkers run:
 *    signature — resolved params carried the mechanism payload + artifact exists
 *    golden    — FAILS CLOSED (baseline-hash comparison not implemented yet)
 *    ffprobe   — every seed artifact probes as a real image/video
 *    vision    — ffprobe every seed + the judge answers the spec's yes/no
 *                question for EVERY seed (keep_alive:0); verified iff all pass
 *    unit      — static plumbing only (for specs with no GPU path yet)
 *  A per-spec contact sheet lands at /tmp/of-verify/<date>/<id>.png.
 *  Under GENERATION_PROVIDER=mock nothing is ever written `verified` and the
 *  judge is never called — mock proves plumbing, not output.
 *
 *  Env: PGLITE_DIR (default /tmp/of-preset-verify), GENERATION_PROVIDER
 *  (default comfy for --write runs, mock otherwise), PRESET_VERIFY_FILE
 *  (default tests/fixtures/preset-verify.json), COMFY_PORT (default 8188 —
 *  the direct ComfyUI the /free call hits, same convention as gpu-run).
 */
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, copyFileSync, statSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined; // a following flag is not a value
};
const flag = (name: string) => process.argv.includes(`--${name}`);

process.env.PGLITE_DIR ??= "/tmp/of-preset-verify";
process.env.GENERATION_PROVIDER ??= flag("write") && !flag("list") && !flag("dry") ? "comfy" : "mock";

import { sql } from "../src/db";
import { createJob, tickJob, cancelJob, resolveParams } from "../src/lib/jobs";
import { chat } from "../src/lib/llm/index";
import { findEndpoint, findModel } from "../src/lib/catalog/video-models";
import { activeProviderName } from "../src/lib/generation";
import { filePathFor } from "../src/lib/storage";
import { ENDPOINT_GRAPHS, WORKFLOW_LICENSES } from "../src/lib/catalog/licenses.generated";
import {
  allSpecs, mechanismHash, loadVerifyRecords,
  type PresetSpec, type VerifyRecord,
} from "../src/lib/catalog/presets/schema";
import { needsLikenessConsent } from "../src/lib/likeness";
import "../src/lib/catalog/presets/effects"; // register effect specs
import "../src/lib/catalog/presets/styles";  // register style specs
import "../src/lib/catalog/presets/apps";    // register app specs
import type { AppSpec } from "../src/lib/catalog/presets/apps";
import { TRAJECTORIES } from "../src/lib/catalog/presets/trajectories";

const USER = "of-preset-verify";
const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "verify");
const VERIFY_FILE = process.env.PRESET_VERIFY_FILE ?? path.join(process.cwd(), "tests", "fixtures", "preset-verify.json");

/* --------------------------- static checks ---------------------------- */

type Check = { ok: boolean; msg: string };

const TRAJECTORY_IDS = new Set(TRAJECTORIES.map((t) => t.id));

function mechanismEndpoint(m: PresetSpec["mechanism"]): string | null {
  return "endpoint" in m ? m.endpoint : null;
}

function checkMechanism(spec: PresetSpec): Check[] {
  const out: Check[] = [];
  const m = spec.mechanism;
  const ep = mechanismEndpoint(m);
  if (ep) {
    const wf = findEndpoint(ep);
    out.push(wf
      ? { ok: true, msg: `endpoint ${ep} resolves to ${wf.model.label} / ${wf.workflow.label}` }
      : { ok: false, msg: `endpoint ${ep} not in the catalog` });
    const graph = ENDPOINT_GRAPHS[ep];
    if (wf?.workflow?.providers?.comfy) {
      out.push(graph && existsSync(path.join(process.cwd(), "workflows", graph))
        ? { ok: true, msg: `workflow file workflows/${graph} present` }
        : { ok: false, msg: `no bundled graph for ${ep}` });
    }
  }
  if (m.kind === "trajectory") {
    const missing = m.ids.filter((id) => !TRAJECTORY_IDS.has(id));
    out.push(missing.length === 0
      ? { ok: true, msg: `${m.ids.length} trajectory ids resolve` }
      : { ok: false, msg: `unknown trajectory ids: ${missing.join(", ")}` });
  }
  if (m.kind === "pipeline") {
    const { RECIPES } = require("../src/lib/generation/recipes") as typeof import("../src/lib/generation/recipes");
    const known = new Set([...Object.keys(RECIPES), "ad-lab"]); // recipes + page pipelines
    out.push(known.has(m.pipeline)
      ? { ok: true, msg: `pipeline ${m.pipeline} registered` }
      : { ok: false, msg: `no pipeline named ${m.pipeline}` });
  }
  if (m.kind === "lora") {
    const f = path.join(process.cwd(), "weights", m.weights);
    out.push(existsSync(f)
      ? { ok: true, msg: `weights ${m.weights} present` }
      : { ok: false, msg: `weights file weights/${m.weights} not on disk` });
  }
  return out;
}

/** the endpoint's declared params cover the spec's inputs honestly —
 *  mechanisms without their own endpoint (trajectory/post/lora/pipeline)
 *  ride the verify-run host workflow, so inputs are checked against that
 *  host's params instead */
function checkInputs(spec: PresetSpec): Check[] {
  const out: Check[] = [];
  const m = spec.mechanism;
  const ep = mechanismEndpoint(m);
  const hostEp = ep ?? "motionfield/wan-vace/image-to-video"; // verify-run host
  const wf = findEndpoint(hostEp)?.workflow;
  const names = new Set((wf?.params ?? []).map((p) => p.name));
  const has = (...ns: string[]) => ns.some((n) => names.has(n));
  const at = ep ?? `${m.kind} (host ${hostEp})`;
  for (const input of spec.inputs) {
    if (m.kind === "pipeline" && !ep) {
      out.push({ ok: true, msg: `${input} input consumed inside the pipeline runner` });
      continue;
    }
    if (m.kind === "lora") {
      out.push({ ok: true, msg: `${input} input consumed by the look executor (when wired)` });
      continue;
    }
    if (input === "image")
      out.push(has("image_url", "image_urls", "product_image_url", "pose_image_url", "input_image")
        ? { ok: true, msg: "image input consumed by an image param" }
        : { ok: false, msg: `spec consumes image but ${at} declares no image param` });
    if (input === "video")
      out.push(has("video_url", "vace_source", "input_video")
        ? { ok: true, msg: "video input consumed by a video param" }
        : { ok: false, msg: `spec consumes video but ${at} declares no video param` });
    if (input === "prompt")
      out.push(m.kind === "trajectory" || m.kind === "pipeline" || has("prompt", "instructions")
        ? { ok: true, msg: "prompt input reaches the prompt param" }
        : { ok: false, msg: `spec consumes prompt but ${at} declares no prompt param` });
  }
  // param-layer mechanisms: every key must be a declared workflow param
  if (m.kind === "post") {
    for (const k of Object.keys(m.params))
      out.push(has(k)
        ? { ok: true, msg: `post param ${k} is a declared workflow input on ${hostEp}` }
        : { ok: false, msg: `post param ${k} has no declared input on ${hostEp}` });
  }
  return out;
}

function checkLicense(spec: PresetSpec): Check[] {
  const m = spec.mechanism;
  const ep = mechanismEndpoint(m);
  if (!ep) return [{ ok: true, msg: `mechanism ${m.kind} carries no endpoint license` }];
  const graph = ENDPOINT_GRAPHS[ep];
  const lic = graph ? WORKFLOW_LICENSES[graph] : undefined;
  if (!lic) return [{ ok: true, msg: `no license row for ${ep} (recipe or unmapped)` }];
  const cls = lic.class;
  return [cls === "open"
    ? { ok: true, msg: `${ep} license class open` }
    : spec.hidden
      ? { ok: true, msg: `${ep} is ${cls} — spec carries hidden:{reason}, never offered` }
      : { ok: false, msg: `${ep} is ${cls} — a visible spec may not default to it` }];
}

/** the resolved job params must carry the mechanism payload. Runs against
 *  a synthetic all-verified file (set in main) so the plumbing is checked,
 *  not the gate — hidden specs are expected to throw (that IS the gate). */
function checkResolution(spec: PresetSpec): Check[] {
  const m = spec.mechanism;
  const p: Record<string, unknown> = { prompt: "x" };
  if (spec.catalog === "motion") p.motion_preset = spec.id;
  else if (spec.catalog === "effect") p.preset_id = spec.id;
  else if (spec.catalog === "style") p.look_id = spec.id;
  else return [{ ok: true, msg: `catalog ${spec.catalog} resolves through app routing, not params` }];
  try {
    const out = resolveParams(p);
    if (spec.hidden) return [{ ok: false, msg: "hidden spec resolved — the gate must refuse it" }];
    if (m.kind === "trajectory") {
      const ids = (out.trajectory as string[] | undefined) ?? [];
      return [m.ids.every((id) => ids.includes(id))
        ? { ok: true, msg: `trajectory stack lands on params (${ids.length} ids)` }
        : { ok: false, msg: `resolved params lack the trajectory stack` }];
    }
    if (m.kind === "post") {
      const missing = Object.keys(m.params).filter((k) => out[k] === undefined);
      return [missing.length === 0
        ? { ok: true, msg: `post params merge (${Object.keys(m.params).join(", ")})` }
        : { ok: false, msg: `post params missing after resolve: ${missing.join(", ")}` }];
    }
    return [{ ok: true, msg: `preset resolves — fragment applied: ${Boolean(String(out.prompt ?? "").length > 1)}` }];
  } catch (e) {
    return [spec.hidden && /preset not available/.test((e as Error).message)
      ? { ok: true, msg: "gate correctly refuses the hidden spec" }
      : { ok: false, msg: `resolveParams threw: ${(e as Error).message}` }];
  }
}

/* ----------------------------- run phase ------------------------------ */

async function migrate() {
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], { stdio: "inherit" });
}
async function seed() {
  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'verify', 'verify@local.dev', true)
             ON CONFLICT (id) DO NOTHING`, [USER]);
  await sql(`INSERT INTO profiles (user_id, credits) VALUES ($1, 1000000)
             ON CONFLICT (user_id) DO UPDATE SET credits = 1000000`, [USER]);
  // this scratch DB survives killed runs — reclaim anything left active or
  // the 1-active-job gate eats the first real job
  await sql(`UPDATE jobs SET status = 'canceled', error = 'killed mid-run'
             WHERE status IN ('queued', 'in_progress')`);
}

const uploads = new Map<string, string>();
function uploadFixture(name: string): string {
  if (uploads.has(name)) return uploads.get(name)!;
  const src = path.join(FIXTURE_DIR, name);
  if (!existsSync(src)) throw new Error(`fixture tests/fixtures/verify/${name} missing`);
  const upDir = path.join(process.cwd(), "public", "files", "uploads");
  mkdirSync(upDir, { recursive: true });
  const upName = `verify-${randomUUID()}${path.extname(name)}`;
  copyFileSync(src, path.join(upDir, upName));
  const url = `/files/uploads/${upName}`;
  uploads.set(name, url);
  return url;
}
async function registerUpload(url: string, mime: string) {
  const file = filePathFor(url)!;
  await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING`,
    [USER, url, mime, statSync(file).size, path.basename(url)]);
}

/** Prompt text a spec's own mechanism carries (what the tile/studio prefill
 *  puts in the prompt field) — the honest prompt for its verify run. */
function mechanismPrompt(spec: PresetSpec): string {
  const m = spec.mechanism;
  if (m.kind === "edit_recipe") return m.instruction;
  if (m.kind === "template") return m.template.replace("{input}", spec.label);
  return spec.description ?? spec.label;
}

/** Smoke sizing for Wan/VACE video verify jobs — the run proves the
 *  mechanism end-to-end, not production quality: 1 s @ 16 fps @ 480p is 17
 *  frames at 4 steps (a bare submit lets the provider pick 5 s/25 fps/30
 *  steps — ~7× the frames). `??=` throughout: the spec's own apply keys and
 *  href prefill params always win. */
function smokeSize(endpointId: string, params: Record<string, unknown>): void {
  if (!/wan/.test(endpointId)) return;
  params.duration ??= 1;
  params.fps ??= 16;
  params.steps ??= 4;
  params.resolution ??= "480p";
}

/** AppSpec carries the deep link; every other catalog resolves through
 *  job params instead — the verify run only follows /ai/ links. */
const isAppSpec = (s: PresetSpec): s is AppSpec =>
  s.catalog === "app" && typeof (s as Partial<AppSpec>).href === "string";

/** An app tile's verify job is EXACTLY the endpoint + params its deep link
 *  submits — parse model/flow/preset/params out of spec.href and fill the
 *  endpoint's required inputs from the fixtures a user would upload. */
function linkJob(spec: PresetSpec): { endpointId: string; params: Record<string, unknown> } | null {
  if (!isAppSpec(spec)) return null;
  const href = spec.href;
  if (!href.startsWith("/ai/")) return null;
  const u = new URL(href, "http://verify.local");
  const model = u.searchParams.get("model") ? findModel(u.searchParams.get("model")!) : undefined;
  if (!model) return null;
  const flowId = u.searchParams.get("flow");
  const wf = model.workflows.find((w) => w.id === flowId) ?? model.workflows[0];
  if (!wf?.endpointId) return null;

  const params: Record<string, unknown> = {};
  const raw = u.searchParams.get("params");
  if (raw) { try { Object.assign(params, JSON.parse(raw)); } catch { /* bad prefill */ } }
  if (typeof params.prompt === "string")
    params.prompt = (params.prompt as string).replace("{input}", spec.label); // the user "fills" the slot
  const img = () => uploadFixture(spec.verify.fixture?.endsWith(".png") ? spec.verify.fixture : "portrait.png");
  const vid = () => uploadFixture("clip-2s.mp4");
  for (const f of wf.params ?? []) {
    if (params[f.name] !== undefined || !f.required) continue;
    if (f.type === "video") params[f.name] = vid();
    else if (f.type === "image") params[f.name] = img();
    else if (f.type === "images") params[f.name] = [img()];
    else if (f.type === "media") params[f.name] = [img()];
    else if (f.type === "prompt" || f.type === "textarea" || f.type === "text") params[f.name] = mechanismPrompt(spec);
    else if (f.type === "select" && Array.isArray(f.enum) && f.enum.length) params[f.name] = f.default ?? f.enum[0];
    else if (f.type === "integer" || f.type === "number") params[f.name] = f.default ?? f.min ?? 1;
  }
  // smoke sizing — verification proves the mechanism end-to-end, not
  // production quality (SMOKE.md convention); a prefill param still wins
  smokeSize(wf.endpointId, params);
  // a ?preset= link picks a WS3 motion preset — the studio submits it as
  // preset_kind=motion; resolveParams' motion_preset is the same surface
  const preset = u.searchParams.get("preset");
  if (preset) params.motion_preset = preset;
  // a trajectory app tile with no preset in its link exercises its own stack
  else if (spec.mechanism.kind === "trajectory" && spec.mechanism.ids.length)
    params.trajectory = [spec.mechanism.ids[0]];
  return { endpointId: wf.endpointId, params };
}

/** job params for one spec run — mirrors exactly what the studio/route would
 *  send so the resolved params are the honest surface */
function runParams(spec: PresetSpec): { endpointId: string; params: Record<string, unknown> } | null {
  const rp = runParamsInner(spec);
  if (!rp) return rp;
  smokeSize(rp.endpointId, rp.params); // linkJob already sized — ??= is a no-op there
  // identity endpoints (lead-swap → wan-vace/character-swap, etc.) 400
  // "likeness consent required" without the flag; the verify fixtures are
  // our own Z-Image synthetics (tests/fixtures/verify/) — no real person,
  // so the run asserts the right itself rather than silently 400ing
  if (needsLikenessConsent(rp.endpointId, rp.params)) rp.params.likeness_consent = true;
  return rp;
}

function runParamsInner(spec: PresetSpec): { endpointId: string; params: Record<string, unknown> } | null {
  const m = spec.mechanism;
  if (spec.catalog === "app") return linkJob(spec);
  const fx = spec.verify.fixture ?? "portrait.png";
  const img = () => uploadFixture(fx.endsWith(".mp4") ? "portrait.png" : fx);
  const vid = () => uploadFixture(fx.endsWith(".mp4") ? fx : "clip-2s.mp4");
  switch (m.kind) {
    case "trajectory":
      return { endpointId: "motionfield/wan-vace/image-to-video",
        params: { image_url: img(), prompt: spec.label, motion_preset: spec.id } };
    case "restyle":
      return { endpointId: "motionfield/wan-vace/restyle",
        params: { video_url: vid(), preset_id: spec.id } };
    case "post":
      // post layers ride the host i2v job — the verify run submits the preset
      // on its own VACE i2v endpoint so the whole stack is exercised
      return { endpointId: "motionfield/wan-vace/image-to-video",
        params: { image_url: img(), prompt: spec.label, preset_id: spec.id } };
    case "edit_recipe":
      return m.endpoint.includes("wan-vace")
        ? { endpointId: m.endpoint,
            params: { image_url: img(), prompt: spec.label, preset_id: spec.id } }
        : { endpointId: m.endpoint,
            params: { image_url: img(), prompt: m.instruction } };
    case "template":
      return { endpointId: m.endpoint,
        params: { prompt: m.template.replace("{input}", spec.label), resolution: "720p" } };
    default:
      return null; // keyframe_edit / lora / pipeline / composite-non-app — no direct job path
  }
}

async function runJob(spec: PresetSpec, seed: number, timeoutMs: number) {
  try {
    const rp = runParams(spec);
    if (!rp) return { ok: false, msg: `no job path for mechanism ${spec.mechanism.kind}`, artifact: null as string | null };
    for (const url of Object.values(rp.params).flat().filter((v): v is string => typeof v === "string" && v.startsWith("/files/")))
      await registerUpload(url, url.endsWith(".mp4") ? "video/mp4" : "image/png");
    const job = await createJob(USER, { endpointId: rp.endpointId, title: `verify ${spec.id} · seed ${seed}`,
      params: { ...rp.params, seed } });
    return await drainJob(job.id, timeoutMs);
  } catch (e) {
    // one bad spec must never kill the batch — it lands as a failed run
    return { ok: false, msg: `run error: ${String((e as Error).message ?? e).slice(0, 200)}`, artifact: null as string | null };
  }
}

async function drainJob(jobId: string, timeoutMs: number) {
  const t0 = Date.now();
  for (;;) {
    await tickJob(jobId);
    const [row] = await sql<{ status: string; outputs: { url: string }[] | null; error: string | null }>(
      `SELECT status, outputs, error FROM jobs WHERE id = $1`, [jobId]);
    if (!row) return { ok: false, msg: "job row missing", artifact: null as string | null };
    if (!["queued", "in_progress"].includes(row.status)) {
      const artifact = row.outputs?.[0]?.url ? (filePathFor(row.outputs[0].url) ?? null) : null;
      return row.status === "completed" && artifact
        ? { ok: true, msg: `job completed → ${row.outputs![0].url}`, artifact }
        : { ok: false, msg: `job ${row.status}: ${row.error ?? "?"}`, artifact };
    }
    if (Date.now() - t0 > timeoutMs) {
      await cancelJob(USER, jobId).catch(() => {});
      return { ok: false, msg: "job timed out", artifact: null };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const ffprobe = (file: string) => JSON.parse(execFileSync("ffprobe", [
  "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
]).toString()) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number }[] };

/** A still for video artifacts — the clip's middle frame. */
function middleFrame(artifact: string): string {
  if (!/\.(mp4|webm|mov)$/i.test(artifact)) return artifact;
  const img = `${artifact}.frame.png`;
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", artifact, "-vf", "select=eq(n\\,2)", "-frames:v", "1", img]);
  return img;
}

/** Judge input for motion claims — three frames (~15/50/85%) tiled
 *  left-to-right so the judge sees change over time; a single middle frame
 *  can't prove motion. Stills pass through untouched. Returns the strip path
 *  and how many frames were actually tiled — the judge text must report that
 *  real count (never claim "3 frames" when fewer made the tile). */
function motionStrip(artifact: string): { img: string; tiled: number } {
  if (!/\.(mp4|webm|mov)$/i.test(artifact)) return { img: artifact, tiled: 0 };
  // nb_frames is unreliable on some containers — fall back to an actual
  // frame count, then to duration × fps before giving up at 1.
  const probe = (args: string[]) => parseFloat(execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", ...args, artifact]).toString().trim());
  const n = (() => {
    const frames = probe(["-show_entries", "stream=nb_frames", "-of", "csv=p=0"]);
    if (Number.isFinite(frames) && frames > 0) return Math.round(frames);
    try {
      const counted = probe(["-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0"]);
      if (Number.isFinite(counted) && counted > 0) return Math.round(counted);
    } catch { /* counted pass unavailable — estimate below */ }
    try {
      const meta = JSON.parse(execFileSync("ffprobe", [
        "-v", "error", "-print_format", "json", "-show_format", "-show_streams", artifact]).toString()) as {
        format?: { duration?: string };
        streams?: { codec_type?: string; avg_frame_rate?: string; r_frame_rate?: string }[];
      };
      const v = (meta.streams ?? []).find((s) => s.codec_type === "video");
      const rate = (v?.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v?.r_frame_rate) ?? "0/1";
      const [rn, rd] = rate.split("/").map(Number);
      const est = Number(meta.format?.duration) * (rd ? rn / rd : 0);
      if (Number.isFinite(est) && est > 0) return Math.round(est);
    } catch { /* fall through */ }
    return 1;
  })();
  const picks = [...new Set([0.15, 0.5, 0.85].map((f) => Math.min(n - 1, Math.round(f * (n - 1)))))];
  const img = `${artifact}.strip.png`;
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", artifact, "-vf",
    `select='${picks.map((i) => `eq(n\\,${i})`).join("+")}',scale=-2:320,tile=${picks.length}x1`,
    "-frames:v", "1", img]);
  return { img, tiled: picks.length };
}

/** POST /free to the direct ComfyUI — drops the render models from VRAM so
 *  the judge's model can load. Runs once between the render phase and the
 *  judge phase; failures are warnings, never verdicts. */
async function freeComfy() {
  const base = `http://127.0.0.1:${process.env.COMFY_PORT ?? "8188"}`;
  await fetch(`${base}/free`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
    signal: AbortSignal.timeout(15_000),
  }).then((r) => console.log(`  ${base}/free → ${r.status}`))
    .catch((e) => console.warn(`  /free failed: ${(e as Error).message}`));
}

/** Only the FIRST WORD of the judge's answer counts — a "no…" trailing a
 *  "yes" mid-sentence, or prose with no verdict, is not a pass. */
function verdictOf(text: string): boolean | null {
  const first = text.trim().toLowerCase().split(/\s+/)[0]?.replace(/[^a-z]/g, "");
  return first === "yes" ? true : first === "no" ? false : null;
}

async function visionJudge(question: string, artifact: string): Promise<boolean | null> {
  try {
    const strip = motionStrip(artifact);
    const b64 = readFileSync(strip.img).toString("base64");
    const stripNote = strip.tiled > 1 ? `The image tiles ${strip.tiled} frames of the clip left-to-right.\n`
      : strip.tiled === 1 ? "The image is a single frame of the clip.\n" : "";
    const res = await chat("judge", { messages: [{ role: "user", content: [
      { type: "image", mime: "image/png", base64: b64 },
      { type: "text", text: `${stripNote}${question}\nAnswer strictly yes or no.` },
    ] }], unload: true }); // keep_alive:0 — drop the judge model after the reply
    return verdictOf(res.text);
  } catch (e) {
    console.warn(`  judge unavailable: ${(e as Error).message?.slice(0, 120)}`);
    return null;
  }
}

/** Verify artifacts are job outputs under public/files/generated — deletes
 *  resolve under that root only (a /files path is data, never a trusted
 *  delete target), the derived judge-frame pngs alongside go too. */
const GENERATED_ROOT = path.resolve(process.cwd(), "public", "files", "generated") + path.sep;
function deleteVerifyArtifact(artifact: string): void {
  for (const f of [artifact, `${artifact}.frame.png`, `${artifact}.strip.png`]) {
    const r = path.resolve(f);
    if (!r.startsWith(GENERATED_ROOT)) continue;
    try { rmSync(r); } catch { /* already gone */ }
  }
}

/** Contact sheet of the spec's seed artifacts → /tmp/of-verify/<date>/<id>.png */
function contactSheet(specId: string, artifacts: string[]): string | null {
  if (!artifacts.length) return null;
  const frames = artifacts.map((a) => middleFrame(a));
  const dir = `/tmp/of-verify/${new Date().toISOString().slice(0, 10)}`;
  mkdirSync(dir, { recursive: true });
  const out = `${dir}/${specId}.png`;
  try {
    if (frames.length === 1) {
      execFileSync("ffmpeg", ["-y", "-v", "error", "-i", frames[0], "-vf", "scale=-2:320", "-frames:v", "1", out]);
    } else {
      const fc = frames.map((_, i) => `[${i}:v]scale=-2:320[f${i}]`).join(";")
        + `;${frames.map((_, i) => `[f${i}]`).join("")}hstack=inputs=${frames.length}[out]`;
      execFileSync("ffmpeg", ["-y", "-v", "error",
        ...frames.flatMap((f) => ["-i", f]),
        "-filter_complex", fc, "-map", "[out]", "-frames:v", "1", out]);
    }
    return out;
  } catch (e) {
    console.warn(`  contact sheet failed: ${(e as Error).message}`);
    return null;
  }
}

/* ------------------------------- driver -------------------------------- */

/** Night-batch order: restyle effects → post effects → camera app tiles →
 *  lead-swap → fx (edit_recipe) effects → everything else → cloud last. */
function queueRank(s: PresetSpec): number {
  if (s.tier === "cloud") return 60;
  if (s.mechanism.kind === "restyle") return 0;
  if (s.mechanism.kind === "post") return 1;
  if (s.collection === "camera" && s.catalog === "app") return 2;
  if (s.id === "lead-swap") return 3;
  if (s.mechanism.kind === "edit_recipe" || s.mechanism.kind === "template") return 4;
  return 5;
}

/** Rough per-seed wall time on the local box (minutes) at smoke sizing —
 *  a Wan/VACE i2v seed runs ≈7 min here, video-in flows (restyle, swaps,
 *  motion transfer) ≈8. Image endpoints keep their estimate; cloud/pod work
 *  is 0 (it doesn't burn this GPU). */
function estSeedMinutes(s: PresetSpec): number {
  if (s.tier === "cloud") return 0;
  const e = "endpoint" in s.mechanism ? s.mechanism.endpoint : "";
  if (e.includes("qwen") || e.includes("flux")) return 8;
  return s.inputs.includes("video") ? 8 : 7;
}

/** Regenerate the e2e verify fixture — the only writer of
 *  tests/fixtures/preset-verify-e2e.json; hashes are computed, never typed. */
function writeE2eFixture() {
  const VERIFIED = ["lead-swap", "dolly-in", "candid-take", "comic-panel"];
  const STALE = "marble-gold";
  const date = new Date().toISOString().slice(0, 10);
  const records: Record<string, VerifyRecord> = {};
  for (const id of VERIFIED) {
    const s = allSpecs().find((x) => x.id === id);
    if (!s) throw new Error(`e2e fixture spec missing from registry: ${id}`);
    records[id] = {
      mechanism_hash: mechanismHash(s), status: "verified",
      seeds: [7], runs: [{ seed: 7, ok: true, msg: "fabricated e2e record — hash is real, artifact is not" }],
      checker: s.verify.checker, note: "fabricated e2e record",
      artifact_sha256: "0".repeat(64), date,
    };
  }
  records[STALE] = {
    mechanism_hash: "f".repeat(64), status: "verified",
    seeds: [7], runs: [{ seed: 7, ok: true }],
    checker: "vision", note: "hash predates a mechanism edit — record must be treated as stale",
    artifact_sha256: "0".repeat(64), date,
  };
  const out = path.join(process.cwd(), "tests/fixtures/preset-verify-e2e.json");
  writeFileSync(out, JSON.stringify({ version: 1, generated: new Date().toISOString(), records }, null, 2) + "\n");
  console.log(`e2e fixture → ${out} (${VERIFIED.length} verified + ${STALE} stale)`);
}

async function main() {
  if (flag("e2e-fixture")) { writeE2eFixture(); return; }

  // real records first (from VERIFY_FILE — env is still the real path)
  const records: Record<string, VerifyRecord> =
    existsSync(VERIFY_FILE) ? (JSON.parse(readFileSync(VERIFY_FILE, "utf8")).records ?? {}) : {};

  // checkResolution needs every spec past the verify gate — a synthetic
  // file makes plumbing checks independent of the real records
  const synthetic = path.join(process.env.PGLITE_DIR ?? "/tmp", "preset-verify-synthetic.json");
  mkdirSync(path.dirname(synthetic), { recursive: true });
  writeFileSync(synthetic, JSON.stringify({ records: Object.fromEntries(
    allSpecs().map((s) => [s.id, { mechanism_hash: mechanismHash(s), status: "verified" }])) }));
  process.env.PRESET_VERIFY_FILE = synthetic;
  const specs = allSpecs().filter((s) => {
    if (flag("id") || arg("id")) {
      const ids = (arg("id") ?? "").split(",").map((x) => x.trim());
      if (!ids.includes(s.id)) return false;
    }
    // motion presets are WS3's catalog — ws4's verify queue doesn't cover
    // them (they need no record to display) unless explicitly asked
    if (s.catalog === "motion" && !flag("include-motion")) return false;
    if (arg("catalog") && s.catalog !== arg("catalog")) return false;
    if (arg("collection") && s.collection !== arg("collection")) return false;
    if (arg("tier") && s.tier !== arg("tier")) return false;
    if (s.hidden && !flag("hidden")) return false;
    if (!flag("all") && records[s.id]?.status === "verified"
        && records[s.id]?.mechanism_hash === mechanismHash(s)) return false;
    return true;
  });

  console.log(`preset-verify — ${specs.length} candidate(s)`);
  if (flag("queue") || arg("queue") !== undefined) {
    const q = specs
      .map((s) => ({
        id: s.id, catalog: s.catalog, mechanism: s.mechanism,
        mechanism_hash: mechanismHash(s), checker: s.verify.checker,
        fixture: s.verify.fixture ?? null, tier: s.tier,
        priority: queueRank(s),
        est_minutes: estSeedMinutes(s) * Math.max(1, Number(arg("seeds") ?? 2)),
        pod: s.tier === "cloud",
        record: records[s.id] ?? null,
      }))
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    const out = arg("queue") ?? "/tmp/of-verify/queue-ws4.json";
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ version: 1, generated: new Date().toISOString(), queue: q }, null, 2));
    console.log(`queue → ${out} (${q.length} specs, ~${q.reduce((a, x) => a + x.est_minutes, 0)} est min)`);
  }

  // static pass
  let staticFail = 0;
  for (const s of specs) {
    const checks = [...checkMechanism(s), ...checkInputs(s), ...checkLicense(s), ...checkResolution(s)];
    const bad = checks.filter((c) => !c.ok);
    const rec = records[s.id];
    const state = s.hidden ? "hidden" : rec ? `${rec.status}${rec.mechanism_hash === mechanismHash(s) ? "" : " (stale hash)"}` : "unverified";
    console.log(`${bad.length ? "✗" : "✓"} ${s.id}  [${s.mechanism.kind}${s.hidden ? ", hidden" : ""}]  ${state}`);
    for (const c of checks) console.log(`    ${c.ok ? "·" : "FAIL"} ${c.msg}`);
    staticFail += bad.length;
  }
  if (flag("list") || flag("dry") || !flag("write")) {
    console.log(`\n${specs.length} specs, ${staticFail} failing static check(s)` +
      (flag("write") ? "" : "  (pass --write to run jobs and record)"));
    if (!flag("write")) process.exit(staticFail ? 1 : 0);
  }

  if (staticFail) {
    console.error(`static failures block the run — fix the mechanisms first`);
    process.exit(1);
  }
  await migrate();
  await seed();

  const seeds = Math.max(1, Number(arg("seeds") ?? 2));
  const timeoutMs = (Number(arg("timeout")) || 900) * 1000;
  const budgetMin = Math.max(0, Number(arg("budget-min") ?? 0));
  const MOCK = activeProviderName() === "mock";
  const file: { version: number; records: Record<string, VerifyRecord> } =
    existsSync(VERIFY_FILE) ? JSON.parse(readFileSync(VERIFY_FILE, "utf8"))
    : { version: 1, records: {} };
  const flush = () => {
    mkdirSync(path.dirname(VERIFY_FILE), { recursive: true });
    writeFileSync(VERIFY_FILE, JSON.stringify(file, null, 2) + "\n");
  };

  // phase 1 — every render first (ComfyUI holds the render models); a bad
  // seed lands as a failed run and never stops the batch. Specs run in
  // queueRank order — the same order the queue file writes — so a
  // --budget-min stop drops the tail, never the head.
  const runnable = specs
    .filter((x) => !x.hidden)
    .sort((a, b) => queueRank(a) - queueRank(b) || a.id.localeCompare(b.id));
  type Run = { ok: boolean; msg: string; artifact: string | null; wall_s: number };
  const results = new Map<string, Run[]>();
  const sheets = new Map<string, string>();
  const t0 = Date.now();
  for (const s of runnable) {
    if (budgetMin > 0 && results.size > 0 && (Date.now() - t0) / 60_000 >= budgetMin) {
      console.log(`--budget-min ${budgetMin} reached — ${runnable.length - results.size} spec(s) left unstarted`);
      break;
    }
    // a slow spec gets the longer leash its est_minutes predicts — never less
    // than the --timeout floor
    const seedTimeoutMs = Math.max(timeoutMs, estSeedMinutes(s) * 150_000);
    const runs: Run[] = [];
    for (let i = 0; i < seeds; i++) {
      const seed = 1000 + i;
      process.stdout.write(`run ${s.id} seed=${seed} … `);
      const rt = Date.now();
      const r = await runJob(s, seed, seedTimeoutMs);
      runs.push({ ...r, wall_s: Math.round((Date.now() - rt) / 1000) });
      console.log(runs.at(-1)!.ok ? `ok (${runs.at(-1)!.wall_s}s)` : `FAIL (${runs.at(-1)!.msg})`);
    }
    results.set(s.id, runs);
    const sheet = contactSheet(s.id, runs.map((r) => r.artifact).filter((a): a is string => !!a));
    if (sheet) { sheets.set(s.id, sheet); console.log(`  contact sheet → ${sheet}`); }
    // durable progress: flush a "pending" record right after the renders —
    // a killed batch keeps the artifact paths for inspection, and nothing
    // is ever written `verified` before the judge phase actually runs
    file.records[s.id] = {
      mechanism_hash: mechanismHash(s),
      status: "pending",
      seeds: runs.map((_, i) => 1000 + i),
      runs: runs.map((r, i) => ({ seed: 1000 + i, ok: r.ok, msg: r.msg.slice(0, 200), wall_s: r.wall_s })),
      checker: s.verify.checker,
      note: "rendered, awaiting judge",
      artifacts: runs.map((r) => r.artifact).filter((a): a is string => !!a),
      ...(sheet ? { contact_sheet: sheet } : {}),
      date: new Date().toISOString().slice(0, 10),
    };
    flush();
  }

  // drop the render models before the judge loads its weights
  if (!MOCK && results.size) await freeComfy();

  // phase 2 — checkers judge EVERY seed's artifact; verified needs all of them
  for (const s of runnable) {
    const runs = results.get(s.id);
    if (!runs) continue; // budget-skipped specs get no record this pass
    const artifacts = runs.filter((r) => r.ok && r.artifact).map((r) => r.artifact!);
    const checker = s.verify.checker;
    let status: VerifyRecord["status"] = "failed";
    let judge: boolean | null = null;
    let note: string | undefined;
    if (checker === "golden") {
      note = "golden checker not implemented — fails closed";
      status = "failed";
    } else if (artifacts.length === seeds) {
      const sane = artifacts.every((a) => {
        try { return (ffprobe(a).streams?.length ?? 0) > 0; } catch { return false; }
      });
      if (checker === "vision" && s.verify.question) {
        if (MOCK) {
          // mock proves plumbing, never output — no judge, no verdict
          status = sane ? "pending" : "failed";
          note = "mock provider — render judged by plumbing only, never verified";
        } else {
          const verdicts: (boolean | null)[] = [];
          for (const a of artifacts) verdicts.push(await visionJudge(s.verify.question, a));
          judge = verdicts.every((v) => v === true) ? true : verdicts.some((v) => v === false) ? false : null;
          status = sane && judge === true ? "verified" : sane && judge === null ? "pending" : "failed";
        }
      } else {
        status = sane ? "verified" : "failed";
      }
    }
    if (MOCK && status === "verified") { status = "pending"; note = "mock provider — never verified"; }
    const artifact = artifacts[0];
    const sheet = sheets.get(s.id);
    file.records[s.id] = {
      mechanism_hash: mechanismHash(s),
      status,
      seeds: runs.map((_, i) => 1000 + i),
      runs: runs.map((r, i) => ({ seed: 1000 + i, ok: r.ok, msg: r.msg.slice(0, 200), wall_s: r.wall_s })),
      checker,
      ...(note ? { note } : {}),
      ...(judge !== null ? { judge } : {}),
      ...(artifact ? { artifact_sha256: createHash("sha256").update(readFileSync(artifact)).digest("hex") } : {}),
      ...(sheet ? { contact_sheet: sheet } : {}),
      date: new Date().toISOString().slice(0, 10),
    };
    console.log(`  → ${s.id}: ${status}`);
    // flush after every spec — a completed spec is durable even if the
    // session dies mid-queue
    flush();
    // sha256 + contact sheet are on record now — the raw artifacts under
    // public/files/generated go, or a full-batch run fills the disk
    for (const a of artifacts) deleteVerifyArtifact(a);
  }

  console.log(`records → ${VERIFY_FILE} (${Object.keys(file.records).length} entries)`);
  // PGlite holds the loop open — exit explicitly or the batch "hangs" after
  // its last record lands
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
