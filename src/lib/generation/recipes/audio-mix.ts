/**
 * audio-mix - the sound recipe behind the Director's Sound toggle.
 *
 * Two endpoints share it (the recipe branches on endpointId):
 *
 *  - "motionfield/audio-mix/post-mix": lay an owned music/sfx bed under an
 *    owned video. Keep mode puts music UNDER dialogue - the source track
 *    two-passes to −16 LUFS and the bed to −20; replace mode (or a silent /
 *    absent source) has the bed carry the mix alone at −14. The bus mixes
 *    with amix normalize=0 and limits to ≤ −1 dBTP.
 *  - "motionfield/moss/video-sfx": rebuild a clip's soundtrack - frames are
 *    sampled across the clip (≤16, each timestamped), the caller's vision
 *    route plans foley cues (rows zod-validated one-by-one, bounds-
 *    sanitized), each cue renders through the MOSS sfx endpoint via the env
 *    provider (mock in e2e, ComfyUI live), cue wavs normalize to −16 LUFS
 *    and mux onto the h264 stream with the source audio ducked 6 dB under
 *    the cue bus.
 *
 * Every output is tagged in the container (audio=post-mix, comment="sound
 * added after generation") - post-mixed sound never pretends to be
 * original audio. Cue-driven runs embed the cue list as a `cues` tag.
 *
 * Needs: job-owner media access (resolveOwnedMedia), ffmpeg/ffprobe,
 * a "vision" LLM route (video→sfx only - absent → the job fails with the
 * needs-vision message before a single frame is sampled).
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "@/db";
import { findEndpoint } from "../../catalog/video-models";
import { filePathFor, saveBytes } from "../../storage";
import { getProvider } from "../index";
import { resolveOwnedMedia } from "../../media-owned";
import { chatJson, llmConfigured } from "../../llm/index";
import {
  runArgv, ffmpegBin, probeDuration, probeHasAudio, probeJson,
} from "../../audio-mix/ffmpeg";
import {
  loudnormTwoPass, measureLoudness, normalizeToWav,
  BED_TARGET, MUSIC_TARGET, SFX_TARGET, SOURCE_TARGET,
} from "../../audio-mix/loudness";
import { muxBedOntoVideo, muxCuesOntoVideo } from "../../audio-mix/mix";
import {
  sanitizeCues, sfxCueSchema, sfxCuesEnvelopeSchema,
  VIDEO_SFX_SYSTEM_PROMPT, type SfxCue,
} from "../../audio-mix/cues";
import type { RecipeCtx, RecipeFn } from "../recipe";
import type { GenerationProvider, SubmitInput } from "../types";
import type { ChatMessage, ContentPart } from "../../llm/types";
import type { ModelDef, WorkflowDef } from "../../catalog/types";

/** Test seam - unit tests inject a counting fake; everything else uses the
 *  env provider (GENERATION_PROVIDER), i.e. mock in e2e and comfy live. */
let stepProvider: GenerationProvider | null = null;
export function setAudioMixStepProvider(p: GenerationProvider | null): void {
  stepProvider = p;
}
const provider = () => stepProvider ?? getProvider();

const VIDEO_SFX_MAX_S = 60;
/** vision passes get at most this many frames - evenly spaced across the
 *  clip (1 fps under 16 s, sparser beyond), each labelled with its time */
const VIDEO_SFX_MAX_FRAMES = 16;
const CUE_TIMEOUT_MS = Number(process.env.AUDIO_MIX_CUE_TIMEOUT_MS || 10 * 60_000);
const POLL_MS = 2500;
const POST_MIX_COMMENT = "sound added after generation";
const NEEDS_VISION = "video→SFX needs a vision model - Settings → Models & LLMs";

async function ownerOf(jobId: string): Promise<string> {
  const rows = await sql<{ user_id: string }>(`SELECT user_id FROM jobs WHERE id = $1 LIMIT 1`, [jobId]);
  if (!rows[0]?.user_id) throw new Error("audio-mix: could not resolve the job owner");
  return rows[0].user_id;
}

/** A provider output url → a file path on this host (mock + comfy both
 *  persist under /files/generated/...). A /files/ ref that resolves nowhere
 *  is an error here, never a fallback - the string is not a path. */
function mediaFile(url: string): string {
  if (url.startsWith("/files/")) {
    const p = filePathFor(url);
    if (!p) throw new Error(`unresolvable /files/ ref: ${url}`);
    return p;
  }
  if (url.startsWith("file://")) return new URL(url).pathname;
  return url;
}

/** Poll one sfx sub-job to an audio output url; on abort, cancel it first. */
async function runCue(
  input: SubmitInput,
  ctx: RecipeCtx,
  subJobId: string,
  endpoint: { model: ModelDef; workflow: WorkflowDef },
  params: Record<string, unknown>,
): Promise<string> {
  const p = provider();
  const sub = await p.submit({
    jobId: subJobId,
    model: endpoint.model,
    workflow: endpoint.workflow,
    params,
    appBaseUrl: input.appBaseUrl,
  });
  let deadline: number | null = null; // the budget starts when the sub-job leaves the GPU queue
  try {
    while (true) {
      if (ctx.signal.aborted) throw new Error("canceled");
      const st = await p.poll(sub.providerJobId, sub.meta ?? {});
      if (deadline === null && st.state !== "queued") deadline = Date.now() + CUE_TIMEOUT_MS;
      if (st.state === "completed") {
        const out = st.output.items.find((o) => o.type === "audio") ?? st.output.items[0];
        if (!out?.url) throw new Error("cue produced no audio output");
        return out.url;
      }
      if (st.state === "failed" || st.state === "nsfw" || st.state === "canceled")
        throw new Error(("error" in st && st.error) ? String(st.error) : `cue sub-job ${st.state}`);
      if (deadline !== null && Date.now() > deadline) throw new Error("cue timed out");
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, POLL_MS);
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("canceled"));
        }, { once: true });
      });
    }
  } catch (e) {
    await p.cancel(sub.providerJobId, sub.meta ?? {}).catch(() => {});
    throw e;
  }
}

const seedFor = (jobId: string, i: number): number => {
  let h = i + 1;
  for (const c of jobId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
};

/** Up to VIDEO_SFX_MAX_FRAMES jpegs spaced evenly across the clip - each
 *  paired with its timestamp so the cue plan can place sound in time. */
async function sampleFrames(video: string, dir: string, durationSec: number): Promise<{ file: string; t: number }[]> {
  const fps = Math.min(1, VIDEO_SFX_MAX_FRAMES / Math.max(durationSec, 1e-6));
  await runArgv(ffmpegBin(), [
    "-y", "-hide_banner", "-v", "error", "-i", video,
    "-vf", `fps=${fps},scale=320:-2`, "-q:v", "4",
    path.join(dir, "frame-%03d.jpg"),
  ]);
  const names = (await fs.readdir(dir)).filter((f) => f.endsWith(".jpg")).sort();
  return names.slice(0, VIDEO_SFX_MAX_FRAMES)
    .map((n, i) => ({ file: path.join(dir, n), t: i / fps }));
}

async function planCues(
  frames: { file: string; t: number }[], durationSec: number, guidance: string, userId: string,
): Promise<SfxCue[]> {
  const parts: ContentPart[] = [{
    type: "text",
    text: `The clip is ${durationSec.toFixed(1)} s - each frame below is introduced by its timestamp.` +
      (guidance.trim() ? ` Caller guidance: ${guidance.trim().slice(0, 300)}` : ""),
  }];
  for (const f of frames) {
    parts.push({ type: "text", text: `frame at t≈${f.t.toFixed(1)} s` });
    const buf = await fs.readFile(f.file);
    parts.push({ type: "image", mime: "image/jpeg", base64: buf.toString("base64") });
  }
  const messages: ChatMessage[] = [
    { role: "system", content: VIDEO_SFX_SYSTEM_PROMPT },
    { role: "user", content: parts },
  ];
  const { data } = await chatJson("vision", sfxCuesEnvelopeSchema, {
    messages, maxTokens: 1500, temperature: 0.2,
  }, { userId });
  // per-row validation - one bad cue can't sink the plan
  const rows: SfxCue[] = [];
  for (const raw of data.cues) {
    const r = sfxCueSchema.safeParse(raw);
    if (r.success) rows.push(r.data);
  }
  return sanitizeCues(rows, durationSec).slice(0, 12);
}

async function postMix(input: SubmitInput, ctx: RecipeCtx) {
  const p = input.params;
  const owner = await ownerOf(input.jobId);
  const videoPath = await resolveOwnedMedia(owner, String(p.video_url ?? ""));
  const bedPath = await resolveOwnedMedia(owner, String(p.audio_url ?? ""));
  const keep = p.mode !== "replace";

  const j = await probeJson(videoPath);
  const durationSec = Number(j.format?.duration ?? 0) || 0;
  const sourceHasAudio = (j.streams ?? []).some((s) => s.codec_type === "audio");

  ctx.progress(10, "post-mix: normalizing");
  return withTmp(async (dir) => {
    /* keep mode puts music UNDER dialogue: the source track two-passes to
     * −16 LUFS, the bed to −20. Replace mode - and a silent or absent
     * source - has the bed carry the mix alone at −14. */
    let srcNorm: string | undefined;
    if (keep && sourceHasAudio) {
      const m = await measureLoudness(videoPath, SOURCE_TARGET);
      if (Number.isFinite(m.input_i)) {
        srcNorm = path.join(dir, "src-norm.wav");
        await normalizeToWav(videoPath, srcNorm, SOURCE_TARGET, m);
      }
    }
    ctx.progress(40, "post-mix: normalizing the bed");
    const bedNorm = path.join(dir, "bed-norm.wav");
    await loudnormTwoPass(bedPath, bedNorm, srcNorm ? BED_TARGET : MUSIC_TARGET);
    ctx.progress(60, "post-mix: mixing");
    const out = path.join(dir, "post-mix.mp4");
    await muxBedOntoVideo({
      video: videoPath, bed: bedNorm, out,
      src: srcNorm,
      durationSec: durationSec || undefined,
      tags: { audio: "post-mix", comment: POST_MIX_COMMENT },
    });
    ctx.progress(92, "post-mix: saving");
    const url = await saveBytes(`generated/post-mix/${input.jobId}.mp4`, await fs.readFile(out));
    ctx.progress(100, "post-mix: done");
    return [{
      type: "video" as const, url,
      duration: durationSec || undefined,
    }];
  });
}

async function videoSfx(input: SubmitInput, ctx: RecipeCtx) {
  const p = input.params;
  const owner = await ownerOf(input.jobId);
  // the whole point of the pass is the caller's vision route - fail fast
  // with the settings hint before a byte of the clip is even probed
  if (!(await llmConfigured(owner, "vision").catch(() => false)))
    throw new Error(NEEDS_VISION);
  const videoPath = await resolveOwnedMedia(owner, String(p.video_url ?? ""));
  const durationSec = await probeDuration(videoPath);
  if (!durationSec || durationSec > VIDEO_SFX_MAX_S)
    throw new Error(`video→sfx supports clips up to ${VIDEO_SFX_MAX_S} s (got ${durationSec ? durationSec.toFixed(1) : "unreadable"} s)`);
  const sourceHasAudio = await probeHasAudio(videoPath);
  const guidance = String(p.prompt ?? "");
  const endpoint = findEndpoint("motionfield/moss/sfx");
  if (!endpoint) throw new Error("motionfield/moss/sfx has no workflow");

  return withTmp(async (dir) => {
    ctx.progress(5, "video→sfx: sampling frames");
    const frames = await sampleFrames(videoPath, dir, durationSec);

    ctx.progress(12, "video→sfx: planning cues");
    const cues = await planCues(frames, durationSec, guidance, owner);
    if (!cues.length)
      throw new Error("the vision cue pass produced no usable cues for this clip");

    const cueFiles: { file: string; tStart: number }[] = [];
    for (let i = 0; i < cues.length; i++) {
      if (ctx.signal.aborted) throw new Error("canceled");
      const c = cues[i];
      const len = Math.min(20, Math.max(1, c.t_end - c.t_start));
      ctx.progress(15 + Math.round((i / cues.length) * 55),
        `video→sfx: cue ${i + 1}/${cues.length} - ${c.prompt.slice(0, 40)}`);
      const url = await runCue(input, ctx, `${input.jobId}-cue${i}`, endpoint, {
        prompt: c.prompt,
        duration: len,
        seed: p.seed ? Number(p.seed) + i : seedFor(input.jobId, i),
      });
      const raw = mediaFile(url);
      const norm = path.join(dir, `cue-${i}.wav`);
      await loudnormTwoPass(raw, norm, SFX_TARGET);
      cueFiles.push({ file: norm, tStart: c.t_start });
    }

    ctx.progress(78, "video→sfx: mixing");
    const out = path.join(dir, "video-sfx.mp4");
    await muxCuesOntoVideo({
      video: videoPath, cues: cueFiles, out,
      durationSec, sourceHasAudio, duckDb: 6,
      tags: { audio: "post-mix", comment: POST_MIX_COMMENT, cues: JSON.stringify(cues) },
    });
    ctx.progress(92, "video→sfx: saving");
    const url = await saveBytes(`generated/video-sfx/${input.jobId}.mp4`, await fs.readFile(out));
    ctx.progress(100, "video→sfx: done");
    return [{ type: "video" as const, url, duration: durationSec }];
  });
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "of-amix-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export const audioMixRecipe: RecipeFn = async (input, ctx) => {
  if (input.workflow.endpointId === "motionfield/moss/video-sfx") return videoSfx(input, ctx);
  return postMix(input, ctx);
};

export default audioMixRecipe;
