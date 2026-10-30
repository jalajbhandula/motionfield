import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { z } from "zod";
import { filePathFor, saveBytes } from "@/lib/storage";
import { chatJson } from "@/lib/llm";
import { llmConfigured, resolveRoute, unloadLocalModel } from "@/lib/llm/index";
import { findEndpoint } from "@/lib/catalog/video-models";
import { assertLicenseAllowed, endpointLicense, RestrictedLicenseError } from "@/lib/catalog/license-gate";
import { EXPLAINER_LOOKS, LOOK_VALUES, CAPTION_VALUES } from "@/lib/catalog/presets/explainer";
import type { ParamField } from "@/lib/catalog/types";
import {
  AsrError, burnCaptions, transcribeWords, wordsFromScript, type Word,
} from "@/lib/captions";
import { sql } from "@/db";
import { comfyProvider } from "../comfy";
import type { RecipeCtx } from "../recipe";
import type { ProviderOutputItem, SubmitInput } from "../types";

/**
 * Explainer recipe - one provider job that produces a narrated explainer video:
 * scene plan (local LLM, or chunked from a pasted script) → Z-Image-Turbo
 * keyframes → motion clips (Wan 2.1 VACE 1.3B first-frame image-to-video by
 * default - Apache-2.0; LTX-Video only when explicitly selected; ffmpeg
 * pan/zoom as the no-model option) → Kokoro narration → ffmpeg A/V stitch →
 * real burned-in captions (whisper ASR timing, or script-estimated timing
 * flagged `captions_timing:"estimated"` in job meta - never an uncaptioned
 * video labelled as captioned).
 *
 * Sub-job artifacts (keyframes, clips, narration wavs) are tracked and deleted
 * after the stitch - only the final mp4 plus its caption sidecars land in
 * public/files/generated.
 */

export type Scene = { title: string; narration: string; visual: string };
const SceneSchema = z.strictObject({ title: z.string(), narration: z.string().max(300), visual: z.string().max(300) });

/** sentence-ish chunks; >= 2 chunks means the caller pasted a script, not a topic */
const sentences = (text: string) =>
  text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length >= 12);
const looksLikeScript = (text: string) => sentences(text).length >= 2;

const NEEDS_LLM = "Explainer needs an LLM - set LLM_PROVIDER (+LLM_MODEL), or pick a writer model in Settings → Models & LLMs";

/** Scene plan from the LLM - zod-validated, one repair attempt inside chatJson.
 *  `byLlm` tells the caller the writer model wrote the script (vs a pasted
 *  script chunked deterministically) so its VRAM can be released before the
 *  media stages spin up. */
async function planScenes(brief: string, n: number, signal: AbortSignal, userId?: string): Promise<{ scenes: Scene[]; byLlm: boolean }> {
  signal.throwIfAborted();
  if (await llmConfigured(userId, "writer")) {
    try {
      const scenes = await chatJson(
        z.array(SceneSchema).min(1).max(n),
        [
          { role: "system", content:
            `You write scripts for ${n}-scene narrated explainer videos. ` +
            `Reply with ONLY a JSON array of ${n} objects, each {"title": "3-5 words", "narration": "1-2 spoken sentences", "visual": "one vivid scene description for an image model"}. ` +
            `Narration should total ~${n * 12} seconds spoken. No commentary, no markdown.` },
          { role: "user", content: `Topic or script: ${brief}\n\nWrite the ${n}-scene explainer script.` },
        ],
        { signal, temperature: 0.7, userId, think: false }, // reasoning burned the 120 s budget
      );
      // accept fewer scenes when the LLM writes fewer - never pad with a duplicate tail
      return {
        scenes: scenes.map((s) => ({
          title: s.title.trim() || "Scene",
          narration: s.narration.trim(),
          visual: s.visual.trim() || s.title.trim(),
        })),
        byLlm: true,
      };
    } catch (e) {
      signal.throwIfAborted();
      if (!looksLikeScript(brief))
        throw new Error(`${NEEDS_LLM} - the LLM failed (${e instanceof Error ? e.message : e}) and the prompt is a topic, not a pasted script`);
      // pasted script → fall through to deterministic chunking
    }
  }
  if (!looksLikeScript(brief)) throw new Error(`${NEEDS_LLM} - set both env vars, or paste a script instead of a topic`);
  return { scenes: chunkScript(brief, n), byLlm: false };
}

/** No-LLM path for a pasted script: split it into n narration chunks. */
function chunkScript(brief: string, n: number): Scene[] {
  const parts = sentences(brief);
  const scenes: Scene[] = [];
  const per = Math.ceil(parts.length / n);
  for (let i = 0; i < n && i * per < parts.length; i++) {
    const chunk = parts.slice(i * per, (i + 1) * per).join(" ");
    scenes.push({ title: `Part ${i + 1}`, narration: chunk, visual: `${chunk.slice(0, 80)} - explainer illustration` });
  }
  return scenes;
}

const num = (v: unknown, d: number) => Number.isFinite(Number(v)) ? Number(v) : d;

/** Keep only fields the target endpoint declares (plus `seed`, which the
 *  comfy placeholder layer reads even when unlisted) and snap select values
 *  onto the declared enum. Undeclared params never reach the wire. */
export function fitToSchema(fields: ParamField[], params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const declared = new Map(fields.map((f) => [f.name, f]));
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    const f = declared.get(k);
    if (!f) {
      if (k === "seed") out[k] = v;
      continue;
    }
    if (Array.isArray(f.enum) && f.enum.length) {
      const list = f.enum as (string | number)[];
      if ((list as unknown[]).includes(v)) { out[k] = v; continue; }
      const n = Number(v);
      if (!Number.isNaN(n) && list.every((x) => typeof x === "number")) {
        out[k] = list.reduce((a, b) => (Math.abs(Number(b) - n) < Math.abs(Number(a) - n) ? b : a));
        continue;
      }
      out[k] = f.default ?? list[0];
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** Abortable sleep - a recipe cancel interrupts the wait, not just the next poll. */
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("canceled")); }, { once: true });
});

/** cap on a sub-job's wait in the GPU queue (work time has its own budget) */
export const QUEUE_MAX_MS = 3 * 60 * 60_000;

/** One provider sub-job through the catalog, polled to completion. */
async function comfyStep(
  input: SubmitInput, ctx: RecipeCtx, stepId: string,
  endpointId: string, params: Record<string, unknown>, label: string, timeoutMs: number,
): Promise<ProviderOutputItem> {
  ctx.signal.throwIfAborted();
  const found = findEndpoint(endpointId);
  const wf = found?.workflow;
  if (!found || !wf?.providers.comfy?.workflow) throw new Error(`endpoint "${endpointId}" has no bundled Comfy graph`);
  // sub-jobs bypass createJob - gate them on their own license and fit the
  // params onto the endpoint's declared schema before they hit the wire.
  if (input.userId) await assertLicenseAllowed(wf, input.userId, params);
  else requireOpenLicense(wf, params);
  const cleanParams = fitToSchema(wf.params, params);
  // distinct jobId per sub-step - the SDK treats a reused idempotency key as a rejected resend
  let sub = await comfyProvider.submit({
    jobId: `${input.jobId}:${stepId}`, model: found.model, workflow: wf, params: cleanParams, appBaseUrl: input.appBaseUrl,
  });
  // two budgets: queue starvation gets its own cap (a shared box can park a
  // prompt behind a neighbour's orphan), and the real timeout only arms once
  // the job leaves "queued" - queue wait isn't work.
  // 3 h like re-edit's window queue cap: 20 min failed healthy runs whenever
  // a few long VACE jobs sat ahead of a scene image on a busy box
  let queuedDeadline = Date.now() + QUEUE_MAX_MS;
  let deadline: number | null = null;
  // a 'canceled' provider state while OUR signal is quiet means the kill came
  // from outside - a shared-GPU neighbour purging the queue, a proxy-side GC -
  // never from this run's own cancel path (that aborts ctx.signal first).
  // Resubmit once under a fresh sub-job id; a second cancel fails honestly.
  let resubmitted = false;
  try {
    for (;;) {
      ctx.signal.throwIfAborted();
      const st = await comfyProvider.poll(sub.providerJobId, sub.meta ?? {});
      if (st.state === "completed") {
        const out = st.output.items[0];
        if (!out?.url) throw new Error(`${label}: no output`);
        return out;
      }
      if (st.state === "failed" || st.state === "nsfw") throw new Error(`${label}: ${st.error ?? st.state}`);
      if (st.state === "canceled") {
        if (ctx.signal.aborted || resubmitted) throw new Error(`${label}: canceled`);
        resubmitted = true;
        console.log(`[${input.jobId}] ${label}: sub-job canceled externally - resubmitting once`);
        sub = await comfyProvider.submit({
          jobId: `${input.jobId}:${stepId}:r1`, model: found.model, workflow: wf, params: cleanParams, appBaseUrl: input.appBaseUrl,
        });
        deadline = null; // re-arm when the resubmitted job leaves the queue
        queuedDeadline = Date.now() + QUEUE_MAX_MS;
        continue;
      }
      if (deadline === null && st.state !== "queued") deadline = Date.now() + timeoutMs;
      if (Date.now() > (deadline ?? queuedDeadline)) {
        // same orphan guard as the abort path - a timed-out sub-job keeps
        // running inside ComfyUI and saves an untracked output otherwise
        await comfyProvider.cancel(sub.providerJobId, sub.meta ?? {}).catch(() => {});
        throw new Error(deadline === null
          ? `${label}: still queued after ${Math.round(QUEUE_MAX_MS / 60000)}m - the GPU queue is backed up`
          : `${label}: timed out after ${Math.round(timeoutMs / 60000)}m`);
      }
      await sleep(2500, ctx.signal);
    }
  } catch (e) {
    // aborting leaves the ComfyUI sub-job orphaned - interrupt it so it can't
    // save an untracked output into public/files/generated
    if (ctx.signal.aborted) await comfyProvider.cancel(sub.providerJobId, sub.meta ?? {}).catch(() => {});
    throw e;
  }
}

const ffmpegBin = () => process.env.FFMPEG_BIN || "ffmpeg";

function execFile(cmd: string, args: string[]): Promise<void> {
  return import("child_process").then(({ execFile: xf }) =>
    new Promise<void>((res, rej) => xf(cmd, args, (e) => e ? rej(new Error(e.message)) : res())));
}

async function audioDurationSeconds(file: string): Promise<number> {
  const probe = process.env.FFPROBE_BIN || "ffprobe";
  return import("child_process").then(({ execFile: xf }) =>
    new Promise<number>((res) => {
      xf(probe, ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", file],
        (e, out) => res(e ? 0 : Number.parseFloat(out.trim()) || 0));
    }));
}

/** No signed-in user on the job → fail closed on anything not plainly open
 *  (assertLicenseAllowed needs a user row for opt-ins). */
function requireOpenLicense(wf: Parameters<typeof endpointLicense>[0], params: Record<string, unknown>) {
  const lic = endpointLicense(wf, params);
  if (lic.class === "open") return;
  const label = lic.components.find((c) => c.class === lic.class)?.license ?? lic.class;
  throw new RestrictedLicenseError(label, lic.class === "banned" ? "banned_license" : "restricted_license");
}

/** Output dims for the ffmpeg still path - matches the declared aspect param. */
export function stillDims(aspect: string): [number, number] {
  if (aspect === "9:16") return [480, 864];
  if (aspect === "1:1") return [480, 480];
  return [864, 480]; // 16:9 (and any unlisted value)
}

/** ffmpeg pan/zoom for the no-model "still" path - slow zoom into the keyframe. */
async function stillClip(imgPath: string, outPath: string, frames: number, fps: number, w: number, h: number) {
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},` +
    `zoompan=z='min(zoom+0.0012,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${fps}`;
  await execFile(ffmpegBin(), ["-y", "-loop", "1", "-framerate", String(fps), "-i", imgPath,
    "-vf", vf, "-frames:v", String(frames), "-pix_fmt", "yuv420p", outPath])
    .catch((e) => { throw new Error(`still-clip ffmpeg failed: ${e.message}`); });
}

/**
 * Stitch: for every scene, loop the motion clip to narration length and mux its
 * audio; then concat the scene files. Everything lands under `tmp` inside the
 * recipe's mkdtemp dir.
 */
async function stitchScenes(clips: string[], narrs: string[], durs: number[], tmp: string): Promise<Buffer> {
  const segs: string[] = [];
  for (let i = 0; i < clips.length; i++) {
    const out = path.join(tmp, `seg${i}.mp4`);
    await execFile(ffmpegBin(), ["-y", "-stream_loop", "-1", "-i", clips[i], "-i", narrs[i],
      "-t", String(durs[i]), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out])
      .catch((e) => { throw new Error(`stitch ffmpeg failed on scene ${i + 1}: ${e.message}`); });
    segs.push(out);
  }
  const listPath = path.join(tmp, "concat.txt");
  const esc = (s: string) => s.replace(/'/g, "'\\''");
  await fs.writeFile(listPath, segs.map((s) => `file '${esc(s)}'`).join("\n"));
  const outPath = path.join(tmp, "final.mp4");
  await execFile(ffmpegBin(), ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath])
    .catch((e) => { throw new Error(`stitch concat failed: ${e.message}`); });
  return fs.readFile(outPath);
}

/**
 * Caption stage on the stitched mp4 - everything it hands to ASR or the burn
 * is a path the recipe created itself inside its own mkdtemp dir.
 *
 *  Timing: whisper ASR on the stitched file gives real word offsets. When
 *  the machine has no whisper-cli/model (NEEDS_ASR) or the bundled model
 *  can't take the language (ASR_LANGUAGE), the known narration text is
 *  spread over each scene's own narration span (scene start = the running
 *  sum of segment durations) - the caller flags `captions_timing` honestly
 *  and never presents estimated timing as real. Other ASR failures
 *  propagate - a burned-but-mistimed caption is worse than a failed job.
 *
 *  The burn itself is hard-required: a failure throws and the job fails -
 *  an uncaptioned video is never returned as "captioned".
 */
export async function captionStitch(args: {
  stitchedPath: string;
  scenes: Scene[];
  /** narration seconds per scene (the span the words spread over) */
  narrSecs: number[];
  /** stitched segment seconds per scene (scene starts accumulate on these) */
  segSecs: number[];
  captions: "karaoke" | "pop";
  /** recipe mkdtemp dir - the burn's `out` lives next to the stitch */
  dir: string;
  jobId: string;
  base?: string;
  signal?: AbortSignal;
}): Promise<{ mp4: Buffer; srtUrl: string; vttUrl: string; timing: "real" | "estimated" }> {
  const { stitchedPath, scenes, narrSecs, segSecs, captions, dir, jobId, base, signal } = args;
  let words: Word[];
  let timing: "real" | "estimated" = "real";
  try {
    ({ words } = await transcribeWords(stitchedPath, { signal }));
  } catch (e) {
    const asr = e instanceof AsrError ? e : null;
    if (!asr || (asr.code !== "NEEDS_ASR" && asr.code !== "ASR_LANGUAGE")) throw e;
    let offset = 0;
    words = scenes.flatMap((s, i) => {
      const ws = wordsFromScript(s.narration, narrSecs[i] ?? segSecs[i] ?? 0).words
        .map((w) => ({ text: w.text, start: w.start + offset, end: w.end + offset }));
      offset += segSecs[i] ?? 0;
      return ws;
    });
    timing = "estimated";
  }
  const out = path.join(dir, "captioned.mp4");
  const burned = await burnCaptions({
    video: stitchedPath, words, mode: captions, out, base, signal,
  }).catch((e) => {
    throw new Error(`captions couldn't be burned - ${e instanceof Error ? e.message : e}; re-run with Captions: off`);
  });
  const mp4 = await fs.readFile(burned.mp4);
  const srtUrl = await saveBytes(`generated/${jobId}/explainer.srt`, await fs.readFile(burned.srt));
  const vttUrl = await saveBytes(`generated/${jobId}/explainer.vtt`, await fs.readFile(burned.vtt));
  return { mp4, srtUrl, vttUrl, timing };
}

/** Motion choices - each maps to a catalog endpoint; "still" runs ffmpeg only. */
const MOTION: Record<string, { endpoint: string; label: string } | null> = {
  "wan-vace":   { endpoint: "motionfield/wan-vace/image-to-video",  label: "Wan 2.1 VACE 1.3B (Apache-2.0)" },
  "wan22-ti2v": { endpoint: "motionfield/wan-2.2/image-to-video",   label: "Wan 2.2 TI2V 5B (Apache-2.0)" },
  "ltx":        { endpoint: "motionfield/ltx-video/image-to-video", label: "LTX-Video 0.9.5 (Open RAIL-M, opt-in)" },
  "still":      null,
};

/** Merge a patch into jobs.provider_meta.explainer - || on the explainer
 *  subtree only, so a caption-mode flag never clobbers sibling meta. */
async function mergeExplainerMeta(jobId: string, patch: Record<string, unknown>): Promise<void> {
  await sql(
    `UPDATE jobs SET provider_meta =
       jsonb_set(provider_meta, '{explainer}',
         COALESCE(provider_meta->'explainer', '{}'::jsonb) || $2::jsonb),
       updated_at = now()
     WHERE id = $1`,
    [jobId, JSON.stringify(patch)],
  ).catch(() => {});
}

export async function explainerRecipe(input: SubmitInput, ctx: RecipeCtx): Promise<ProviderOutputItem[]> {
  const p = input.params;
  const brief = String(p.prompt ?? p.brief ?? "").trim();
  if (!brief) throw new Error("explainer needs a topic or short script (prompt)");
  const n = Math.max(1, Math.min(8, Math.trunc(num(p.scenes, 3))));
  const voice = String(p.voice ?? "am_adam");
  const clipSec = Math.max(1, Math.min(15, num(p.clip_duration, 2)));
  const fps = Math.max(8, Math.min(30, Math.trunc(num(p.fps, 16))));
  const res = String(p.resolution ?? "480p");
  const aspect = ["16:9", "9:16", "1:1"].includes(String(p.aspect_ratio)) ? String(p.aspect_ratio) : "16:9";
  // one seed per run - every keyframe shares the look's noise floor
  const seed0 = num(p.seed, 1000);
  const steps = Math.max(2, Math.min(50, Math.trunc(num(p.steps, 8))));
  // look: a named look's prompt is the base style and any `style` text
  // appends; "custom" means the free-text style field alone drives the look
  const lookId = String(p.look ?? "flat-2d");
  const look = lookId === "custom" ? null : EXPLAINER_LOOKS.find((l) => l.id === lookId) ?? null;
  if (lookId !== "custom" && !look)
    throw new Error(`unknown look "${lookId}" - pick one of ${LOOK_VALUES.join(", ")}`);
  const userStyle = String(p.style ?? "").trim();
  const style = look
    ? [look.prompt, userStyle].filter(Boolean).join(", ")
    : (userStyle || "clean flat illustration, warm palette");
  const captionsRaw = String(p.captions ?? "karaoke");
  const captions = captionsRaw === "karaoke" || captionsRaw === "pop" || captionsRaw === "off" ? captionsRaw : null;
  if (!captions)
    throw new Error(`unknown captions "${captionsRaw}" - pick one of ${CAPTION_VALUES.join(", ")}`);
  const motionKey = String(p.motion_model ?? "wan-vace");
  const motion = MOTION[motionKey];
  if (motion === undefined) throw new Error(`unknown motion_model "${motionKey}" - pick one of ${Object.keys(MOTION).join(", ")}`);
  // Gate the chosen motion endpoint up front - a restricted pick (e.g. LTX
  // without opt-in) fails the job before any scene work is spent on it.
  if (motion) {
    const found = findEndpoint(motion.endpoint);
    if (!found?.workflow.providers.comfy?.workflow)
      throw new Error(`motion endpoint "${motion.endpoint}" has no bundled Comfy graph`);
    if (input.userId) await assertLicenseAllowed(found.workflow, input.userId, p);
    else requireOpenLicense(found.workflow, p);
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "of-explainer-"));
  /** /files/ urls of every sub-job artifact - deleted after the stitch (or on
   *  failure/cancel) so only the final mp4 remains in public/files/generated. */
  const intermediates = new Set<string>();
  const track = (out: ProviderOutputItem) => { if (out.url) intermediates.add(out.url); return out; };

  try {
    ctx.progress(2, "writing script");
    const { scenes, byLlm } = await planScenes(brief, n, ctx.signal, input.userId);
    if (!scenes.length) throw new Error("scene plan came back empty");
    // the writer's job ends with the script - release a local route's VRAM
    // before the media stages spin up (no-op on cloud routes). A route lookup
    // that throws here must not stop the job - the script is already written.
    if (byLlm) await resolveRoute("writer", input.userId).then(unloadLocalModel).catch(() => {});

    ctx.progress(8, `storyboards (0/${scenes.length})`);
    /** keyframe /files/ urls for the motion sub-job, local paths for ffmpeg */
    const imgs: string[] = [];
    const imgPaths: string[] = [];
    for (const [i, s] of scenes.entries()) {
      const img = track(await comfyStep(input, ctx, `keyframe${i}`, "motionfield/z-image-turbo/text-to-image", {
        prompt: `${s.visual}, ${style}, consistent explainer illustration`,
        resolution: res, aspect_ratio: aspect, steps, seed: seed0,
      }, `scene ${i + 1} image`, 12 * 60_000));
      ctx.signal.throwIfAborted();
      const imgPath = filePathFor(img.url);
      if (!imgPath) throw new Error(`scene ${i + 1}: unresolvable output path ${img.url}`);
      imgs.push(img.url);
      imgPaths.push(imgPath);
      ctx.progress(8 + Math.round(((i + 1) / scenes.length) * 27), `storyboards (${i + 1}/${scenes.length})`);
    }

    ctx.progress(35, `narration (0/${scenes.length})`);
    const narrs: string[] = [];
    const durs: number[] = [];
    const narrSecs: number[] = []; // narration wav length per scene - durs adds the clip floor
    for (const [i, s] of scenes.entries()) {
      const audio = track(await comfyStep(input, ctx, `narr${i}`, "motionfield/kokoro/text-to-speech", {
        prompt: s.narration, voice, speed: 1.0,
      }, `scene ${i + 1} narration`, 4 * 60_000));
      const audioPath = filePathFor(audio.url);
      if (!audioPath) throw new Error(`scene ${i + 1}: unresolvable narration path ${audio.url}`);
      narrs.push(audioPath);
      const narr = await audioDurationSeconds(audioPath);
      narrSecs.push(narr > 0 ? narr : clipSec);
      durs.push(Math.max(clipSec, narr));
      ctx.progress(35 + Math.round(((i + 1) / scenes.length) * 15), `narration (${i + 1}/${scenes.length})`);
    }

    ctx.progress(50, `motion clips (0/${scenes.length})`);
    const clips: string[] = [];
    for (const [i, s] of scenes.entries()) {
      let clipPath: string;
      if (motion) {
        const clip = track(await comfyStep(input, ctx, `clip${i}`, motion.endpoint, {
          prompt: `${s.visual} - gentle camera drift, subtle ambient motion, consistent style`,
          image_url: imgs[i], resolution: res, aspect_ratio: aspect, duration: clipSec, fps, steps,
          seed: seed0 + 2000 + i,
          ...(look?.negative ? { negative_prompt: look.negative } : {}),
        }, `scene ${i + 1} clip (${motion.label})`, 25 * 60_000));
        clipPath = filePathFor(clip.url) ?? "";
      } else {
        // still pan/zoom - honest no-model path
        const [sw, sh] = stillDims(aspect);
        clipPath = path.join(dir, `still${i}.mp4`);
        await stillClip(imgPaths[i], clipPath, Math.round(clipSec * fps), fps, sw, sh);
      }
      if (!clipPath) throw new Error(`scene ${i + 1}: unresolvable clip path`);
      clips.push(clipPath);
      ctx.progress(50 + Math.round(((i + 1) / scenes.length) * 40), `motion clips (${i + 1}/${scenes.length})`);
    }

    ctx.progress(92, "stitching");
    const tmp = path.join(dir, "stitch");
    await fs.mkdir(tmp, { recursive: true });
    const stitchedPath = path.join(tmp, "final.mp4"); // stitchScenes writes here
    let data = await stitchScenes(clips, narrs, durs, tmp);

    const meta: Record<string, unknown> = { look: look?.id ?? "custom", captions };
    if (captions !== "off") {
      ctx.progress(94, "captioning");
      const cap = await captionStitch({
        stitchedPath, scenes, narrSecs, segSecs: durs, captions,
        dir, jobId: input.jobId, base: input.appBaseUrl, signal: ctx.signal,
      });
      data = cap.mp4;
      meta.captions_timing = cap.timing;
      meta.caption_files = { srt: cap.srtUrl, vtt: cap.vttUrl };
    }

    const key = `generated/${input.jobId}/explainer.mp4`;
    const url = await saveBytes(key, data);
    await mergeExplainerMeta(input.jobId, meta);
    ctx.progress(100, "done");
    return [{ type: "video", url, duration: durs.reduce((a, b) => a + b, 0) }];
  } finally {
    // sub-job artifacts are intermediates - wipe them whether we finished,
    // failed, or got canceled; the recipe's final mp4 is never in this set
    for (const url of intermediates) {
      const fp = filePathFor(url);
      if (fp) await fs.rm(fp, { force: true }).catch(() => {});
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
