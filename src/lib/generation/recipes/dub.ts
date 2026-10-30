import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RecipeCtx, RecipeFn } from "../recipe";
import type { GenerationProvider, ProviderOutputItem, SubmitInput } from "../types";
import type { WorkflowDef } from "../../catalog/types";
import { getProvider } from "../index";
import { findEndpoint } from "../../catalog/video-models";
import { filePathFor, saveBytes } from "../../storage";
import { resolveOwnedMedia } from "../../media-owned";
import { transcribeWords } from "../../captions/asr";
import { chatJson, llmConfigured } from "../../llm/index";
import { ffmpegBin, probeDuration, probeHasAudio, runArgv } from "../../audio-mix/ffmpeg";
import {
  DUB_MAX_SECONDS, baseVoice, dubParamsSchema, dubSrt, fitPlan, languageOf, medianPitch,
  segmentWords, translationMessages, translationSchema, type DubLanguage, type Segment,
} from "../../dub";

/**
 * Dub - `motionfield/dub/v1`. One job: an English talking clip comes back in
 * the target language, in the speaker's own voice, lips re-synced.
 *
 *   1. whisper.cpp word timestamps → spoken lines (src/lib/dub.ts)
 *   2. the user's local LLM translates line for line, keeping spoken length
 *   3. per line: Kokoro speaks it natively → Chatterbox VC onto the speaker's
 *      timbre (dub-voice.json; the reference is ~15 s of their own speech)
 *   4. each line time-fitted into its slot (atempo ≤ 1.3×), laid on silence
 *   5. MuseTalk re-syncs the mouth to the new track (lipsync-video.json),
 *      then the dubbed track is muxed back at full quality
 *
 * Sub-steps run through the env provider: ComfyUI live, mock in e2e.
 */

const POLL_MS = 2000;
const STEP_TIMEOUT_MS = 20 * 60_000;
const LIPSYNC_TIMEOUT_MS = 60 * 60_000;

const VOICE_WF: WorkflowDef = {
  id: "dub-voice", label: "Dub line in the speaker's voice", endpointId: "motionfield/dub/voice", kind: "audio",
  params: [
    { name: "audio_url", label: "Speaker reference", type: "audio", required: true },
    { name: "prompt", label: "Line", type: "textarea", required: true },
  ],
  cost: () => 0,
  providers: { comfy: { workflow: "dub-voice.json" } },
};

async function step(
  p: GenerationProvider, input: SubmitInput, workflow: WorkflowDef, params: Record<string, unknown>,
  label: string, ctx: RecipeCtx, timeoutMs: number,
): Promise<ProviderOutputItem[]> {
  const sub = await p.submit({ jobId: `${input.jobId}-${label}`, model: input.model, workflow, params, appBaseUrl: input.appBaseUrl, userId: input.userId });
  let deadline: number | null = null; // the budget starts when the sub-job leaves the GPU queue
  try {
    for (;;) {
      if (ctx.signal.aborted) throw new Error("canceled");
      const st = await p.poll(sub.providerJobId, sub.meta ?? {});
      if (deadline === null && st.state !== "queued") deadline = Date.now() + timeoutMs;
      if (st.state === "completed") {
        if (!st.output.items.length) throw new Error(`dub ${label}: no output`);
        return st.output.items;
      }
      if (st.state === "failed" || st.state === "nsfw" || st.state === "canceled")
        throw new Error(`dub ${label}: ${("error" in st && st.error) || st.state}`);
      if (deadline !== null && Date.now() > deadline) throw new Error(`dub ${label}: timed out`);
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, POLL_MS);
        ctx.signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("canceled")); }, { once: true });
      });
    }
  } catch (e) {
    await p.cancel(sub.providerJobId, sub.meta ?? {}).catch(() => {});
    throw e;
  }
}

/** provider output url → host path (mock and comfy both persist under /files/) */
function localFile(url: string): string {
  const f = url.startsWith("/files/") ? filePathFor(url) : null;
  if (!f) throw new Error(`dub: unresolvable output ${url}`);
  return f;
}

const ff = (argv: string[], ctx: RecipeCtx) => runArgv(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...argv], { signal: ctx.signal });

/** mono float samples of a span of the source, for pitch */
async function samples(file: string, from: number, len: number, rate: number, dir: string, ctx: RecipeCtx): Promise<Float32Array> {
  const raw = path.join(dir, "pitch.f32");
  await ff(["-ss", String(from), "-t", String(len), "-i", file, "-vn", "-ac", "1", "-ar", String(rate), "-f", "f32le", raw], ctx);
  const b = await fs.readFile(raw);
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
}

/** Translate line for line. Off a live provider with no LLM configured (the
 *  mock e2e path) lines are tagged instead, so the rest of the pipeline runs. */
async function translate(lines: string[], lang: DubLanguage, userId: string | undefined, mock: boolean, signal: AbortSignal): Promise<string[]> {
  if (!(await llmConfigured(userId, "writer"))) {
    if (mock) return lines.map((l) => `[${lang.id}] ${l}`);
    throw new Error("Dub translates with your local LLM - set one up in Settings → Models & LLMs (e.g. Ollama + qwen3.5)");
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    // no reasoning pass: qwen-style thinking on a non-Latin script (Hindi,
    // Japanese) ran past two minutes for three lines; a straight translation
    // takes seconds
    const { data } = await chatJson("writer", translationSchema, {
      messages: translationMessages(lines, lang), maxTokens: 4000, temperature: 0.2, think: false, timeoutMs: 240_000, signal,
    }, { userId });
    const out = data.lines.map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim());
    // script gate: a 9B model happily romanizes Hindi ("anthropic mein...") -
    // wrong script feeds Kokoro garbage phonemes, so count it a failed attempt
    if (out.length === lines.length && out.every(Boolean)
      && (!lang.scriptTest || out.every((l) => lang.scriptTest!.test(l)))) return out;
  }
  throw new Error("translation came back with the wrong number of lines - try again");
}

export const dubRecipe: RecipeFn = async (input, ctx) => {
  const params = dubParamsSchema.parse(input.params);
  const lang = languageOf(params.language)!;
  const src = await resolveOwnedMedia(input.userId ?? "", params.video_url);
  const provider = getProvider();
  const mock = provider.name === "mock";
  if (!(await probeHasAudio(src))) throw new Error("this clip has no audio track to dub");
  const total = await probeDuration(src);
  if (!(total > 0)) throw new Error("could not read the clip's length");
  if (total > DUB_MAX_SECONDS + 0.5) throw new Error(`clips up to ${DUB_MAX_SECONDS}s - this one is ${Math.round(total)}s`);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "of-dub-"));
  const keep = `generated/dub/${input.jobId}`;
  const scratch: string[] = [];
  try {
    ctx.progress(3, "listening");
    const { words } = await transcribeWords(src, { signal: ctx.signal, language: "en" });
    const segs: Segment[] = segmentWords(words).filter((s) => s.start < total);
    if (!segs.length) throw new Error("no speech found in this clip");

    // the speaker's voice: their first ~15 s of speech, gaps closed
    ctx.progress(8, "learning the voice");
    const refSegs: Segment[] = [];
    let refLen = 0;
    for (const s of segs) { if (refLen >= 15) break; refSegs.push(s); refLen += s.end - s.start; }
    const refWav = path.join(dir, "voice-ref.wav");
    const parts = refSegs.map((s, i) => `[0:a]atrim=${s.start.toFixed(3)}:${Math.min(s.end + 0.1, total).toFixed(3)},asetpts=PTS-STARTPTS[r${i}]`);
    await ff(["-i", src, "-filter_complex", `${parts.join(";")};${refSegs.map((_, i) => `[r${i}]`).join("")}concat=n=${refSegs.length}:v=0:a=1,aresample=24000[out]`,
      "-map", "[out]", "-ac", "1", refWav], ctx);
    const pitch = medianPitch(await samples(refWav, 0, Math.min(refLen, 15), 16000, dir, ctx), 16000);
    const voice = baseVoice(lang, params.voice, pitch);
    const refUrl = await saveBytes(`${keep}/voice-ref.wav`, await fs.readFile(refWav));
    scratch.push(refUrl);

    ctx.progress(12, `translating to ${lang.label}`);
    const lines = await translate(segs.map((s) => s.text), lang, input.userId, mock, ctx.signal);

    // one line at a time - Kokoro natively, then onto the speaker's timbre
    const lineFiles: string[] = [];
    for (const [i, line] of lines.entries()) {
      ctx.progress(15 + Math.round((i / lines.length) * 40), `voicing line ${i + 1} of ${lines.length}`);
      const items = await step(provider, input, VOICE_WF,
        { audio_url: refUrl, prompt: line, voice, lang: lang.kokoro, speed: 1 }, `line${i}`, ctx, STEP_TIMEOUT_MS);
      const au = items.find((o) => o.type === "audio")?.url ?? items[0].url;
      if (!au) throw new Error(`dub line ${i + 1}: no audio`);
      const wav = path.join(dir, `line${i}.wav`);
      await ff(["-i", localFile(au), "-ac", "1", "-ar", "48000", wav], ctx);
      lineFiles.push(wav);
    }

    ctx.progress(57, "fitting the timing");
    const durations = await Promise.all(lineFiles.map((f) => probeDuration(f)));
    const plan = fitPlan(segs, durations, total);
    const filters = plan.map((pl, i) =>
      `[${i + 1}:a]${pl.tempo > 1.001 ? `atempo=${pl.tempo},` : ""}adelay=${Math.round(pl.start * 1000)}:all=1[l${i}]`);
    const mixIns = plan.map((_, i) => `[l${i}]`).join("");
    const bed = params.original_volume > 0 ? `;[0:a]volume=${params.original_volume}[bed]` : "";
    const track = path.join(dir, "dub.wav");
    await ff(["-i", src, ...lineFiles.flatMap((f) => ["-i", f]), "-filter_complex",
      `${filters.join(";")}${bed};${mixIns}${bed ? "[bed]" : ""}amix=inputs=${plan.length + (bed ? 1 : 0)}:normalize=0:duration=longest,` +
      `apad,atrim=0:${total.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11[out]`,
      "-map", "[out]", "-ar", "48000", "-ac", "2", track], ctx);

    let picture = src;
    if (params.lipsync) {
      ctx.progress(62, "re-syncing the lips");
      const lip = findEndpoint("motionfield/musetalk/lip-sync-video");
      if (!lip) throw new Error("lip-sync endpoint missing");
      const trackUrl = await saveBytes(`${keep}/dub-track.wav`, await fs.readFile(track));
      scratch.push(trackUrl);
      const items = await step(provider, input, lip.workflow,
        { video_url: params.video_url, audio_url: trackUrl, likeness_consent: true, bbox_shift: 0 }, "lipsync", ctx, LIPSYNC_TIMEOUT_MS);
      const v = items.find((o) => o.type === "video")?.url;
      if (!v) throw new Error("lip-sync returned no video");
      picture = localFile(v);
    }

    ctx.progress(93, "finishing");
    const out = path.join(dir, "out.mp4");
    // the lip-synced picture can run long (MuseTalk loops to the audio) - trim to the source length
    await ff(["-i", picture, "-i", track, "-map", "0:v:0", "-map", "1:a:0", "-t", total.toFixed(3),
      "-c:v", picture === src ? "copy" : "libx264", ...(picture === src ? [] : ["-crf", "17", "-preset", "medium", "-pix_fmt", "yuv420p"]),
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out], ctx);
    const url = await saveBytes(`${keep}/dub-${lang.id}.mp4`, await fs.readFile(out));
    await saveBytes(`${keep}/dub-${lang.id}.srt`, Buffer.from(dubSrt(lines, plan)));
    return [{ type: "video", url }];
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    for (const u of scratch) { const f = filePathFor(u); if (f) await fs.rm(f, { force: true }).catch(() => {}); }
  }
};
