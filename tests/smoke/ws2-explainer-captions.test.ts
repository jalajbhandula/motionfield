import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * S11 explainer live smoke - the REAL pipeline end to end: Z-Image keyframes
 * → motion clips → Kokoro narration → A/V stitch → burned captions + sidecars.
 * Gated on EXPLAINER_LIVE=1 (COMFY_LIVE=1 tells the vitest no-live-comfy guard
 * to leave COMFY_BASE_URL at the real 8189 proxy); every GPU touch goes
 * through the shared wrapper:
 *
 *   ~/.motionfield/gpu-run ws2-explainer-wan   -- env COMFY_LIVE=1 EXPLAINER_LIVE=1 EXPLAINER_PHASE=wan \
 *     npx vitest run tests/smoke/ws2-explainer-captions.test.ts
 *   ~/.motionfield/gpu-run ws2-explainer-still -- env COMFY_LIVE=1 EXPLAINER_LIVE=1 EXPLAINER_PHASE=still \
 *     npx vitest run tests/smoke/ws2-explainer-captions.test.ts
 *
 * PHASE=all (default) is one hold: the still-motion pair (captioned +
 * uncaptioned, same seed - the deterministic burn-diff pair) runs first,
 * then the Wan VACE attempt runs with whatever of the 25-minute budget
 * the 30-minute hold still has. PHASE=wan or PHASE=still run a single
 * half each for two-hold runs.
 *
 * The spec job: pasted four-sentence script, look flat-2d, captions karaoke,
 * 480p 16:9, scenes=4, clip_duration=2. Evidence lands in
 * /tmp/of-evidence/ws2-explainer-captions/ (mp4 copies + evidence.json) and
 * feeds the docs/SMOKE.md row.
 */

const LIVE = process.env.EXPLAINER_LIVE === "1";
const PHASE = (process.env.EXPLAINER_PHASE ?? "all") as "wan" | "still" | "off" | "eval" | "all";
const OUT = "/tmp/of-evidence/ws2-explainer-captions";
const EVIDENCE = path.join(OUT, "evidence.json");
const WAN_CAP_MS = 25 * 60_000; // the spec's "exceeds 25 minutes" threshold
const FFMPEG = process.env.MOTIONFIELD_FFMPEG || "ffmpeg";
const FFPROBE = process.env.MOTIONFIELD_FFPROBE || "ffprobe";

const SCRIPT = "Batteries store energy as chemical potential. "
  + "Charging pushes ions to the anode and holds them there. "
  + "Discharging lets the ions flow back through the cathode. "
  + "The circuit draws that flow as electric current.";

const SEED = 4242;
/** the proxy holds submitted idempotency keys forever - every attempt gets a
 *  fresh jobId stem or a re-run trips IdempotencyKeyReuse */
const RUN = Date.now().toString(36);

type JobArtifact = {
  jobId: string; motion: string; captions: string; mp4: string; srt?: string; vtt?: string;
  elapsed: number; duration?: number; timing?: string;
};

type Evidence = {
  head: string; date: string;
  wan?: { status: "done" | "timeout" | "failed" | "skipped"; elapsed?: number; cap_ms?: number; error?: string };
  jobs: JobArtifact[];
  timing?: string;
  checks?: Record<string, unknown>;
};

/* env must be set before the @/ imports evaluate - COMFY_BASE_URL stays at the
   code default (the api-proxy on 8189; ComfyUI itself on 8188 has no /api/v2) */
const pgDir = mkdtempSync(path.join(tmpdir(), "of-expl-smoke-pg-"));
process.env.PGLITE_DIR ||= pgDir;
process.env.BETTER_AUTH_SECRET ||= "test-secret-ws2-0123456789abcdef0123456789ab";

function readEvidence(): Evidence {
  try { return JSON.parse(readFileSync(EVIDENCE, "utf8")) as Evidence; }
  catch { return { head: headSha(), date: new Date().toISOString(), jobs: [] }; }
}
function writeEvidence(e: Evidence) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(EVIDENCE, JSON.stringify(e, null, 2));
}
const headSha = () => {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
};

async function runExplainer(jobId: string, motion: string, captions: string, capMs?: number): Promise<{ url: string; elapsed: number }> {
  const { explainerRecipe } = await import("@/lib/generation/recipes/explainer");
  const { findEndpoint } = await import("@/lib/catalog/video-models");
  const found = findEndpoint("motionfield/explainer/video");
  if (!found) throw new Error("explainer endpoint not in catalog");
  const ac = new AbortController();
  const timer = capMs ? setTimeout(() => ac.abort(new Error(`smoke cap ${Math.round(capMs / 60000)}m reached`)), capMs) : null;
  const t0 = Date.now();
  try {
    const items = await explainerRecipe({
      jobId, appBaseUrl: "", model: found.model, workflow: found.workflow,
      params: {
        prompt: SCRIPT, scenes: 4, look: "flat-2d", captions, motion_model: motion,
        clip_duration: 2, voice: "af_heart", aspect_ratio: "16:9",
        resolution: "480p", fps: 16, seed: SEED, steps: 4,
      },
    }, { signal: ac.signal, progress: (p, s) => console.log(`[${jobId}] ${p}% ${s ?? ""}`) });
    const url = items[0]?.url;
    if (!url) throw new Error("recipe returned no output url");
    return { url, elapsed: Date.now() - t0 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function artifact(jobId: string, motion: string, captions: string, url: string, elapsed: number): Promise<JobArtifact> {
  const { filePathFor } = await import("@/lib/storage");
  const src = filePathFor(url);
  if (!src || !existsSync(src)) throw new Error(`output url ${url} does not resolve to a file`);
  const mp4 = path.join(OUT, `${motion}-${captions}.mp4`);
  copyFileSync(src, mp4);
  const a: JobArtifact = { jobId, motion, captions, mp4, elapsed };
  for (const ext of ["srt", "vtt"] as const) {
    const side = src.replace(/explainer\.mp4$/, `explainer.${ext}`);
    if (existsSync(side)) {
      const dest = `${mp4}.${ext}`;
      copyFileSync(side, dest);
      a[ext] = dest;
    }
  }
  return a;
}

const probe = (file: string) => JSON.parse(
  execFileSync(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { encoding: "utf8" }),
) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };

/** bottom-third raw frame at t seconds */
function bottomThird(mp4: string, t: number, w: number, h: number): Buffer {
  const band = Math.floor(h / 3);
  const raw = execFileSync(FFMPEG, [
    "-v", "error", "-ss", t.toFixed(2), "-i", mp4, "-frames:v", "1",
    "-vf", `crop=${w}:${band}:0:${h - band}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return raw;
}

function topHalf(mp4: string, t: number, w: number, h: number): Buffer {
  const band = Math.floor(h / 2);
  const raw = execFileSync(FFMPEG, [
    "-v", "error", "-ss", t.toFixed(2), "-i", mp4, "-frames:v", "1",
    "-vf", `crop=${w}:${band}:0:0`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return raw;
}

/** fraction of bytes whose |Δ| exceeds tol */
function byteDiffFrac(a: Buffer, b: Buffer, tol = 40): number {
  if (a.length !== b.length) return 1;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tol) diff++;
  return diff / a.length;
}

const cueMids = (srtPath: string): number[] => {
  const cues: number[] = [];
  const re = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g;
  const text = readFileSync(srtPath, "utf8");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = (+m[1] * 3600) + (+m[2] * 60) + (+m[3]) + (+m[4] / 1000);
    const e = (+m[5] * 3600) + (+m[6] * 60) + (+m[7]) + (+m[8] / 1000);
    cues.push((s + e) / 2);
  }
  return cues;
};

/** the Wan budget under the default 30-min hold once the still pair has run -
 *  the spec's 25-min threshold is the cap whenever it's reachable */
const wanCapFor = (elapsedMs: number) => Math.min(WAN_CAP_MS, 29 * 60_000 - elapsedMs - 90_000);

function evaluate(ev: Evidence, captioned: JobArtifact, uncap: JobArtifact) {
  // ffprobe: duration window, short side, ≥1 audio stream
  const info = probe(captioned.mp4);
  const dur = Number(info.format.duration);
  const vStream = info.streams.find((s) => s.codec_type === "video");
  const aStreams = info.streams.filter((s) => s.codec_type === "audio");
  // duration follows Kokoro's narration pace (measured ~11.9 s), not the
  // 4x2 s clip budget - the window absorbs voice-pace variance only
  expect(dur, `duration ${dur}s`).toBeGreaterThanOrEqual(8);
  expect(dur, `duration ${dur}s`).toBeLessThanOrEqual(16);
  expect(Math.min(vStream?.width ?? 0, vStream?.height ?? 0)).toBe(480);
  expect(aStreams.length).toBeGreaterThanOrEqual(1);

  // the .srt sidecar: ≥4 cues whose words come from the script
  expect(captioned.srt, "srt sidecar").toBeTruthy();
  const srtText = readFileSync(captioned.srt!, "utf8");
  const srtWords = new Set(srtText.toLowerCase().split(/[^a-z']+/).filter(Boolean));
  const scriptWords = new Set(SCRIPT.toLowerCase().split(/[^a-z']+/).filter((w) => w.length > 2));
  const hits = [...scriptWords].filter((w) => srtWords.has(w));
  const mids = cueMids(captioned.srt!);
  expect(mids.length, "cue count").toBeGreaterThanOrEqual(4);
  expect(hits.length, `${hits.length}/${scriptWords.size} script words in srt`).toBeGreaterThanOrEqual(4);

  // burn proof - bottom-third pixels at a cue midpoint differ vs the
  // uncaptioned stitch; top half carries no caption band for contrast
  const w = vStream!.width!, h = vStream!.height!;
  const diffs = mids.slice(0, 4).map((t) => ({
    t: +t.toFixed(2),
    bottom: +byteDiffFrac(bottomThird(captioned.mp4, t, w, h), bottomThird(uncap.mp4, t, w, h)).toFixed(4),
    top: +byteDiffFrac(topHalf(captioned.mp4, t, w, h), topHalf(uncap.mp4, t, w, h)).toFixed(4),
  }));
  console.log("[diffs]", JSON.stringify(diffs));
  for (const d of diffs) {
    expect(d.bottom, `bottom-third diff at t=${d.t}`).toBeGreaterThan(0.005);
  }
  return { dur, w, h, audio: aStreams.length, cues: mids.length, hits: hits.length, diffs };
}

/** winning the lock doesn't mean ComfyUI is ready - a neighbour's job can
 *  leave the proxy mid-restart for a few seconds. Wait for a real jobs
 *  response before spending the hold on submissions. */
async function waitForComfy(ms = 120_000) {
  const base = (process.env.COMFY_BASE_URL || "http://127.0.0.1:8189").replace(/\/$/, "");
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/v2/jobs`, { signal: AbortSignal.timeout(5000) });
      const j = await r.json().catch(() => ({})) as { jobs?: unknown; error?: { message?: string } };
      if (Array.isArray(j.jobs)) return;
      last = j.error?.message ?? `http ${r.status}`;
    } catch (e) { last = String(e instanceof Error ? e.message : e); }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`comfy proxy never came up: ${last}`);
}

describe.skipIf(!LIVE)(`ws2 explainer live smoke - phase ${PHASE}`, () => {
  it.runIf(PHASE === "wan")("Wan VACE attempt, 25-minute cap", async () => {
    await waitForComfy();
    mkdirSync(OUT, { recursive: true });
    const ev = readEvidence();
    const t0 = Date.now();
    try {
      const { url, elapsed } = await runExplainer(`smoke-explainer-wan-${RUN}`, "wan-vace", "karaoke", WAN_CAP_MS);
      const a = await artifact(`smoke-explainer-wan-${RUN}`, "wan-vace", "karaoke", url, elapsed);
      ev.jobs = ev.jobs.filter((j) => !(j.motion === "wan-vace" && j.captions === "karaoke"));
      ev.jobs.push(a);
      ev.wan = { status: "done", elapsed };
    } catch (e) {
      const timedOut = Date.now() - t0 >= WAN_CAP_MS - 5_000;
      ev.wan = timedOut
        ? { status: "timeout", elapsed: Date.now() - t0, error: String(e instanceof Error ? e.message : e) }
        : { status: "failed", elapsed: Date.now() - t0, error: String(e instanceof Error ? e.message : e) };
      console.log(`[wan] ${ev.wan.status}: ${ev.wan.error ?? ""} - the still phase still produces evidence`);
    }
    writeEvidence(ev);
    // never fails on its own - the still phase evaluates the whole picture
  }, WAN_CAP_MS + 120_000);

  it.runIf(PHASE === "still" || PHASE === "all")("still-motion captioned job", async () => {
    await waitForComfy();
    mkdirSync(OUT, { recursive: true });
    const ev = readEvidence();
    const needStill = !ev.jobs.some((j) => j.motion === "still" && j.captions === "karaoke");
    if (needStill) {
      const { url, elapsed } = await runExplainer(`smoke-explainer-still-${RUN}`, "still", "karaoke");
      ev.jobs.push(await artifact(`smoke-explainer-still-${RUN}`, "still", "karaoke", url, elapsed));
      writeEvidence(ev);
    }
  }, 28 * 60_000);

  it.runIf(PHASE === "off" || PHASE === "all")("still-motion uncaptioned reference job", async () => {
    await waitForComfy();
    mkdirSync(OUT, { recursive: true });
    const ev = readEvidence();
    const needOff = !ev.jobs.some((j) => j.motion === "still" && j.captions === "off");
    if (needOff) {
      const { url, elapsed } = await runExplainer(`smoke-explainer-stilloff-${RUN}`, "still", "off");
      ev.jobs.push(await artifact(`smoke-explainer-stilloff-${RUN}`, "still", "off", url, elapsed));
      writeEvidence(ev);
    }
  }, 28 * 60_000);

  it.runIf(PHASE === "eval" || PHASE === "all")("evidence evaluation", async () => {
    mkdirSync(OUT, { recursive: true });
    const ev = readEvidence();
    const t0 = Date.now();

    const captioned = ev.jobs.find((j) => j.motion === "wan-vace" && j.captions === "karaoke")
      ?? ev.jobs.find((j) => j.motion === "still" && j.captions === "karaoke");
    const uncap = ev.jobs.find((j) => j.captions === "off");
    expect(captioned, "a captioned job artifact exists").toBeTruthy();
    expect(uncap, "the uncaptioned reference artifact exists").toBeTruthy();
    const res = evaluate(ev, captioned!, uncap!);

    // timing honesty: whisper-cli + the bundled model present → the ASR
    // path ran and timing is real; absent → the recipe flagged estimated
    const whisperHere = ["whisper-cli"].every((b) => {
      try { execFileSync("/usr/bin/which", [b], { stdio: "ignore" }); return true; }
      catch { return false; }
    }) && existsSync(`${process.env.HOME}/.motionfield/models/whisper/ggml-base.en.bin`);
    ev.timing = whisperHere ? "real" : "estimated";
    ev.checks = {
      duration: res.dur, short_side: Math.min(res.w, res.h), audio_streams: res.audio,
      srt_cues: res.cues, srt_word_hits: res.hits, diffs: res.diffs,
      captioned_job: `${captioned!.motion}+${captioned!.captions}`,
      uncaptioned_ref: `${uncap!.motion}+off`,
    };
    writeEvidence(ev);

    // Wan VACE attempt - spec order is Wan-first; under a contended shared
    // lock one hold has to carry everything, so the still pair lands first
    // and Wan runs with whatever of the 25-minute budget the hold still has.
    if (PHASE === "all" && !ev.wan) {
      const cap = wanCapFor(Date.now() - t0);
      if (cap < 60_000) {
        ev.wan = { status: "skipped", error: `still pair left ${Math.round(cap / 1000)}s of the hold - under the Wan floor` };
      } else {
        const wt0 = Date.now();
        try {
          const { url, elapsed } = await runExplainer(`smoke-explainer-wan-${RUN}`, "wan-vace", "karaoke", cap);
          const a = await artifact(`smoke-explainer-wan-${RUN}`, "wan-vace", "karaoke", url, elapsed);
          ev.jobs = ev.jobs.filter((j) => !(j.motion === "wan-vace" && j.captions === "karaoke"));
          ev.jobs.push(a);
          ev.wan = { status: "done", elapsed, cap_ms: cap };
          const wres = evaluate(ev, a, uncap!); // the Wan artifact is honest evidence too
          ev.checks = { ...ev.checks, wan: { duration: wres.dur, cues: wres.cues, hits: wres.hits } };
        } catch (e) {
          const timedOut = Date.now() - wt0 >= cap - 5_000;
          ev.wan = {
            status: timedOut ? "timeout" : "failed",
            elapsed: Date.now() - wt0, cap_ms: cap,
            error: String(e instanceof Error ? e.message : e),
          };
        }
      }
      writeEvidence(ev);
    }
    console.log(`[evidence] ${EVIDENCE}\n${JSON.stringify(ev, null, 2)}`);
  }, 30 * 60_000);
});
