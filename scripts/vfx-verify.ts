/**
 * vfx-verify — the honesty pipeline for the VFX Lab preset grid (ws3 s10,
 *  effect-presence gate s11).
 *
 *  A VFX preset is only offerable when tests/fixtures/vfx-verify.json carries
 *  a `verified` record whose mechanism_hash equals vfxPresetHash() — the hash
 *  pins the prompt, negative, defaults and target text, so editing a preset
 *  drops it out of the grid until a real run re-verifies it.
 *
 *    npx tsx scripts/vfx-verify.ts --list                 # the 20 ids + status
 *    npx tsx scripts/vfx-verify.ts --id a,b,c --engine ltx095 --write
 *    npx tsx scripts/vfx-verify.ts --engine wan --id vfx-ashfall --write
 *
 *  Runs (--write): a real createJob + tickJob per preset (own PGLITE_DIR —
 *  same convention as preset-verify), engine from --engine:
 *    ltx095 — motionfield/ltx-video/vfx-lab-plate · ltx-video-2b-v0.9.5 ckpt
 *    ltx098 — same endpoint on the distilled checkpoint (needs the exact
 *             file installed — the endpoint refuses otherwise)
 *    wan    — motionfield/wan-vace/vfx-lab-alt with the preset's alt_structure
 *             (default depth); images → structure "image"
 *  All renders finish, then each artifact is ffprobe'd (frames/dims/fps/silent
 *  or audio-kept) and a sha256 + side-by-side strip land in the record.
 *  Under GENERATION_PROVIDER=mock nothing is ever written `verified` — mock
 *  proves plumbing, not output.
 *
 *  s11 — completing is not "verified". Before the stamp, effectDiff()
 *  (src/lib/catalog/video/vfx-diff.ts) samples ~6 mid-span frames — past the
 *  pinned HOLD head, before the pinned tail (still runs skip ~9) — and diffs
 *  each against the plate at the same timestamp (or the still) on a 64×36
 *  luma plane. Mean |Δ| under EFFECT_DIFF_MIN stamps `weak`, never
 *  `verified`; the measured metric lands in the record. A plate re-render
 *  sits ~4–8, a landed effect ~40+.
 *  --lock <light|medium|strong|full> overrides the preset's plate lock for a
 *  manual probe (the record note marks the override — keep real records on
 *  preset defaults, or point VFX_VERIFY_FILE at a scratch file).
 *  --steps <n> overrides sampler steps — default 8, the page's own default
 *  (verifying at anything else wouldn't prove what ships).
 *
 *  Env: PGLITE_DIR (default /tmp/of-vfx-verify), GENERATION_PROVIDER (comfy
 *  for --write), VFX_VERIFY_FILE (default tests/fixtures/vfx-verify.json),
 *  COMFY_BASE_URL for the ComfyUI the jobs land on.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, copyFileSync, statSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

process.env.PGLITE_DIR ??= "/tmp/of-vfx-verify";
process.env.GENERATION_PROVIDER ??= flag("write") ? "comfy" : "mock";

import { sql } from "../src/db";
import { createJob, tickJob, cancelJob } from "../src/lib/jobs";
import { probeClip } from "../src/lib/camera/probe";
import { activeProviderName } from "../src/lib/generation";
import { filePathFor } from "../src/lib/storage";
import {
  VFX_PRESETS, vfxPresetHash, vfxVerifyFilePath,
  type VfxPreset, type VfxVerifyRecord,
} from "../src/lib/catalog/presets/vfx-lab";
import {
  VFX_FPS, VFX_ALT_FPS, VFX_LOCK_DENOISE, VFX_LOCK_SIGMAS, VFX_PLATE_LOCKS,
  vfxFrames, vfxDims, vfxAltDims, vfxAltFrames, ltx098Installed,
} from "../src/lib/catalog/video/vfx";
import { effectDiff, EFFECT_DIFF_MIN } from "../src/lib/catalog/video/vfx-diff";

const USER = "of-vfx-verify";
const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "verify");
const VERIFY_FILE = vfxVerifyFilePath();
const ART_DIR = path.join(process.cwd(), "tests", "artifacts");

type Engine = "ltx095" | "ltx098" | "wan";
const ENGINE = (arg("engine") ?? "ltx095") as Engine;
const STRUCTURE = arg("structure");
const USE_IMAGE = flag("image");
/** manual probe override — a record written under it names the lock it ran */
const LOCK = arg("lock");
if (LOCK && !(VFX_PLATE_LOCKS as readonly string[]).includes(LOCK)) {
  console.error(`--lock must be one of ${VFX_PLATE_LOCKS.join("|")}`);
  process.exit(1);
}
/** sampler steps — the page default, unless a manual probe says otherwise */
const STEPS = Number(arg("steps") ?? 8);

function loadFile(): { version: number; records: Record<string, VfxVerifyRecord> } {
  try { return JSON.parse(readFileSync(VERIFY_FILE, "utf8")); } catch { return { version: 1, records: {} }; }
}
function saveFile(f: { version: number; records: Record<string, VfxVerifyRecord> }) {
  writeFileSync(VERIFY_FILE, JSON.stringify(f, null, 2) + "\n");
}

async function migrate() {
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], { stdio: "inherit" });
}
async function seed() {
  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'vfx', 'vfx@local.dev', true)
             ON CONFLICT (id) DO NOTHING`, [USER]);
  await sql(`INSERT INTO profiles (user_id, credits) VALUES ($1, 1000000)
             ON CONFLICT (user_id) DO UPDATE SET credits = 1000000`, [USER]);
  // the restricted LTX endpoints need the opt-in the settings page writes
  await sql(`INSERT INTO license_optins (user_id, version) VALUES ($1, 'of-licenses-v1')
             ON CONFLICT (user_id) DO UPDATE SET version = 'of-licenses-v1'`, [USER]);
  await sql(`UPDATE jobs SET status = 'canceled', error = 'killed mid-run'
             WHERE status IN ('queued', 'in_progress')`);
}

const uploads = new Map<string, string>();
async function uploadFixture(name: string): Promise<string> {
  if (uploads.has(name)) return uploads.get(name)!;
  const src = path.join(FIXTURE_DIR, name);
  if (!existsSync(src)) throw new Error(`fixture tests/fixtures/verify/${name} missing`);
  const upDir = path.join(process.cwd(), "public", "files", "uploads");
  mkdirSync(upDir, { recursive: true });
  const upName = `vfxverify-${randomUUID()}${path.extname(name)}`;
  copyFileSync(src, path.join(upDir, upName));
  const url = `/files/uploads/${upName}`;
  const mime = name.endsWith(".mp4") ? "video/mp4" : "image/png";
  await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING`, [USER, url, mime, statSync(src).size, name]);
  uploads.set(name, url);
  return url;
}

/** The params the submit route would build — the same fields, probe-derived. */
async function runParams(p: VfxPreset, engine: Engine): Promise<{ endpointId: string; params: Record<string, unknown> }> {
  const fxVideo = await uploadFixture("clip-2s.mp4");
  const fxImage = await uploadFixture("street.png");
  const lock = (LOCK ?? p.defaults.lock ?? "medium") as NonNullable<VfxPreset["defaults"]["lock"]>;
  if (engine === "wan") {
    const structure = (STRUCTURE ?? p.defaults.alt_structure ?? "depth") as typeof p.defaults.alt_structure;
    const useImage = structure === "image";
    const probe = await probeClip(filePathFor(fxVideo)!);
    const dur = useImage ? 3 : probe.frames / probe.fps;
    const frames = vfxAltFrames(dur, "preview");
    const [width, height] = useImage
      ? vfxAltDims(...imageDims(filePathFor(fxImage)!))
      : vfxAltDims(probe.width, probe.height);
    const params: Record<string, unknown> = {
      prompt: p.prompt, negative_prompt: p.negative ?? "",
      structure, alt_length: "preview",
      frames, fps: VFX_ALT_FPS, duration: frames / VFX_ALT_FPS,
      width, height, seed: 7,
      // no vfx_preset here — the gate that guards user submits must not block
      // the run that verifies the preset; the job carries the preset's own
      // prompt/defaults verbatim so the hash's claim stays true
    };
    if (useImage) params.image_url = fxImage; else params.video_url = fxVideo;
    return { endpointId: "motionfield/wan-vace/vfx-lab-alt", params };
  }
  // ltx engine — image or video plate
  const probe = await probeClip(filePathFor(fxVideo)!);
  const dur = USE_IMAGE ? Number(p.defaults.duration ?? 3) : probe.frames / probe.fps;
  const frames = vfxFrames(dur);
  const [width, height] = USE_IMAGE
    ? vfxDims(...imageDims(filePathFor(fxImage)!), "480p", frames)
    : vfxDims(probe.width, probe.height, "480p", frames);
  return {
    endpointId: USE_IMAGE ? "motionfield/ltx-video/vfx-lab-image" : "motionfield/ltx-video/vfx-lab-plate",
    params: {
      ...(USE_IMAGE ? { image_url: fxImage } : { video_url: fxVideo }),
      prompt: p.prompt, negative_prompt: p.negative ?? "",
      engine, ...(USE_IMAGE ? {} : { plate_lock: lock, hold: p.defaults.hold ?? 9 }),
      resolution: "480p", steps: STEPS, seed: 7,
      frames, fps: VFX_FPS, duration: dur, width, height,
      // image plates take the implicit full-strength tail — the endpoint
      // validates denoise/sigmas against lock "full" (no lock field on it)
      denoise: USE_IMAGE ? VFX_LOCK_DENOISE.full : VFX_LOCK_DENOISE[lock],
      sigmas: USE_IMAGE ? VFX_LOCK_SIGMAS.full.join(", ") : VFX_LOCK_SIGMAS[lock].join(", "),
    },
  };
}

const fpsRate = (s?: string) => {
  const [a, b] = (s ?? "0/1").split("/").map(Number);
  return b ? a / b : 0;
};

/** Still plates — dims only (a still has no duration to probe). */
function imageDims(file: string): [number, number] {
  const m = ffprobe(file);
  const v = (m.streams ?? []).find((s) => s.codec_type === "video");
  if (!v?.width || !v.height) throw new Error("no readable image dims");
  return [v.width, v.height];
}

const ffprobe = (file: string) => JSON.parse(execFileSync("ffprobe", [
  "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-count_packets", file,
]).toString()) as {
  format?: { duration?: string };
  streams?: { codec_type?: string; width?: number; height?: number; nb_read_packets?: string; avg_frame_rate?: string }[];
};

/** side-by-side evidence: the sampled mid span — output frames on top, the
 *  plate at the same times underneath — the strip shows exactly what
 *  effectDiff measured (a head-frame single pair could hide a late-landing
 *  effect, and a still plate has no head frames worth showing). */
function sheet(plateFile: string, outFile: string, id: string,
  diff?: { frames: number[] } | null, outFps = 0): string | undefined {
  try {
    mkdirSync(ART_DIR, { recursive: true });
    const a = path.join(ART_DIR, `${id}-src.png`);
    const b = path.join(ART_DIR, `${id}-out.png`);
    const dst = path.join(ART_DIR, `${id}-side.png`);
    const pick = (ns: number[]) => `select='${ns.map((n) => `eq(n\\,${n})`).join("+")}'`;
    const tile = (n: number) => `scale=160:-1,tile=${n}x1`;
    // a still probes as a one-packet stream — then the bottom row repeats it
    const pm = ffprobe(plateFile);
    const pv = (pm.streams ?? []).find((s) => s.codec_type === "video");
    const plateIsVideo = !!pv && Number(pv.nb_read_packets ?? 0) > 1;
    const frames = diff?.frames?.length ? diff.frames : [4];
    if (plateIsVideo && outFps > 0) {
      const pfps = pv?.avg_frame_rate ? fpsRate(pv.avg_frame_rate) : outFps;
      const pSel = pick(frames.map((n) => Math.round((n * pfps) / outFps)));
      execFileSync("ffmpeg", ["-y", "-v", "error", "-i", plateFile, "-vf", `${pSel},${tile(frames.length)}`, "-frames:v", "1", a]);
    } else {
      // still plate — repeat it across the row so the stack aligns
      execFileSync("ffmpeg", ["-y", "-v", "error", "-loop", "1", "-t", "0.5", "-i", plateFile,
        "-vf", tile(frames.length), "-frames:v", "1", a]);
    }
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", outFile, "-vf", `${pick(frames)},${tile(frames.length)}`, "-frames:v", "1", b]);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", b, "-i", a,
      "-filter_complex", "vstack=inputs=2", "-frames:v", "1", dst]);
    for (const t of [a, b]) execFileSync("rm", ["-f", t]);
    return `tests/artifacts/${id}-side.png`;
  } catch { return undefined; }
}

async function runOnce(p: VfxPreset, engine: Engine) {
  const rp = await runParams(p, engine);
  const t0 = Date.now();
  const job = await createJob(USER, {
    endpointId: rp.endpointId,
    title: `vfx-verify ${p.id}`,
    params: rp.params,
  });
  for (;;) {
    await tickJob(job.id);
    const [row] = await sql<{ status: string; outputs: { url: string }[] | null; error: string | null }>(
      `SELECT status, outputs, error FROM jobs WHERE id = $1`, [job.id]);
    if (!row) return { ok: false, msg: "job row missing" as const };
    if (!["queued", "in_progress"].includes(row.status)) {
      const wall = (Date.now() - t0) / 1000;
      if (row.status !== "completed" || !row.outputs?.[0]?.url)
        return { ok: false, msg: `job ${row.status}: ${row.error ?? "?"}`, wall };
      const artifact = filePathFor(row.outputs[0].url);
      if (!artifact) return { ok: false, msg: "artifact not on disk", wall };
      const m = ffprobe(artifact);
      const v = (m.streams ?? []).find((s) => s.codec_type === "video");
      const plate = rp.params.image_url ?? rp.params.video_url;
      const plateFile = plate ? filePathFor(String(plate)) : null;
      // the s11 effect gate — mid-span frames vs the plate at the same
      // timestamps; a re-rendered plate stays under EFFECT_DIFF_MIN
      const outFrames = Number(v?.nb_read_packets) || Number(rp.params.frames) || 0;
      const outFps = (v?.avg_frame_rate ? fpsRate(v.avg_frame_rate) : 0) || Number(rp.params.fps) || VFX_FPS;
      const diff = plateFile && outFrames > 2
        ? effectDiff({
            outFile: artifact, outFrames, outFps,
            plateFile, plateIsStill: !rp.params.video_url,
            skipHead: Number(rp.params.hold ?? 0),
          })
        : null;
      return {
        ok: true, msg: `completed → ${row.outputs[0].url}`, wall,
        artifact, diff,
        route: `${rp.endpointId.split("/").pop()}${rp.params.structure ? `/${rp.params.structure}` : ""}`,
        out: {
          width: v?.width, height: v?.height,
          frames: outFrames || undefined,
          fps: v?.avg_frame_rate ? fpsRate(v.avg_frame_rate) : undefined,
          wall_s: Math.round(wall),
        },
        sheet: plateFile ? sheet(plateFile, artifact, p.id, diff, outFps) : undefined,
        sha: createHash("sha256").update(readFileSync(artifact)).digest("hex"),
      };
    }
    if (Date.now() - t0 > 45 * 60_000) {
      await cancelJob(USER, job.id).catch(() => {});
      return { ok: false, msg: "job timed out (45 min)" };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function main() {
  const ids = arg("id")?.split(",").map((s) => s.trim()).filter(Boolean);
  const queue = VFX_PRESETS.filter((p) => !ids || ids.includes(p.id));
  if (!queue.length) { console.error("no presets matched"); process.exit(1); }

  // --sheet: rebuild the evidence strips for recorded runs — no GPU, no
  // record writes; the artifact URL lives in the record's note
  if (flag("sheet")) {
    const plateFile = path.join(FIXTURE_DIR, USE_IMAGE ? "street.png" : "clip-2s.mp4");
    const file = loadFile();
    for (const p of queue) {
      const r = file.records[p.id];
      const url = r?.note?.match(/\/files\/\S+/)?.[0];
      const artifact = url ? filePathFor(url) : null;
      if (!artifact || !existsSync(artifact)) { console.log(`· ${p.id}: no artifact on disk`); continue; }
      const m = ffprobe(artifact);
      const v = (m.streams ?? []).find((s) => s.codec_type === "video");
      const s = sheet(plateFile, artifact, p.id, r?.effect_diff ?? null,
        v?.avg_frame_rate ? fpsRate(v.avg_frame_rate) : 0);
      console.log(`${s ? "✓" : "✗"} ${p.id} → ${s ?? "sheet failed"}`);
    }
    return;
  }

  if (flag("list") || !flag("write")) {
    const file = loadFile();
    const want = Object.fromEntries(VFX_PRESETS.map((p) => [p.id, vfxPresetHash(p)]));
    for (const p of queue) {
      const r = file.records[p.id];
      const ok = r?.status === "verified" && r.mechanism_hash === want[p.id];
      const diff = r?.effect_diff ? ` Δ${r.effect_diff.mean}` : "";
      console.log(`${ok ? "✓ verified " : r ? `· ${r.status.padEnd(8)}` : "  missing "} ${p.id}  ${p.label}${diff}`);
    }
    if (!flag("write")) return;
  }

  if (ENGINE === "ltx098" && !ltx098Installed())
    { console.error("ltx098 not installed — engine refused"); process.exit(1); }
  console.log(`provider=${activeProviderName()} engine=${ENGINE} verify=${VERIFY_FILE}`);
  await migrate();
  await seed();

  const file = loadFile();
  for (const p of queue) {
    const hash = vfxPresetHash(p);
    const t0 = Date.now();
    const res = await runOnce(p, ENGINE).catch((e) => ({ ok: false, msg: `run error: ${e}` }));
    const mock = activeProviderName() === "mock";
    // one verified run proves the mechanism — a later failing re-run (an
    // engine/queue hiccup, a tuned-away default) must not erase it
    if (!res.ok && file.records[p.id]?.status === "verified") {
      console.log(`· kept verified record — this run failed: ${res.msg}`);
      continue;
    }
    // s11 — a completed run still isn't "verified" until the mid span is
    // measurably off the plate; under the floor it's `weak`, which never
    // satisfies vfxPresetVerified
    const diff = "diff" in res ? res.diff : null;
    const weak = res.ok && !mock && !(diff && diff.mean >= EFFECT_DIFF_MIN);
    file.records[p.id] = {
      mechanism_hash: hash,
      // mock proves plumbing, never output — no verified row under it
      status: res.ok ? (mock ? "pending" : weak ? "weak" : "verified") : "failed",
      out: "out" in res ? res.out : undefined,
      effect_diff: diff ?? undefined,
      artifact_sha256: "sha" in res ? res.sha : undefined,
      sheet: "sheet" in res ? res.sheet : undefined,
      note: res.msg + ("route" in res && res.route ? ` · ${res.route}` : "")
        + (LOCK ? ` (lock override: ${LOCK})` : "")
        + (diff ? ` · effect-diff ${diff.mean} over ${diff.frames.join(",")}` : ""),
      date: new Date().toISOString().slice(0, 10),
    };
    console.log(`${res.ok ? (mock ? "· ran (mock — recorded pending)" : weak ? "~ weak" : "✓ verified") : "✗ failed"} ${p.id} ${res.msg}${diff ? ` Δ${diff.mean}` : ""} ${Math.round((Date.now() - t0) / 1000)}s`);
    saveFile(file);
  }
  console.log(`wrote ${VERIFY_FILE}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
