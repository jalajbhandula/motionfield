import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderOutputItem, SubmitInput, SubmitResult } from "./types";
import type { WorkflowDef } from "../catalog/types";
import { getProvider } from "./index";
import { filePathFor, saveBytes } from "../storage";
import { ffmpegBin, runArgv } from "../audio-mix/ffmpeg";
import { probeVideo } from "../re-edit-ffmpeg";

/**
 * Finishing pass - `motionfield/finish/video` (workflows/video-finish.json):
 * RealESRGAN x4 → lanczos to 2× → RIFE ×2 (2× fps) → CreateVideo, then a
 * light host-side unsharp + grain. One shared post-step: the jobs pipeline
 * runs it automatically on finals that carry `finish: true` (submitFinish →
 * the finish job is polled like the main job → mergeFinishOutput), and
 * recipes can call finishVideo() directly on their final render. The
 * un-finished render is always kept alongside as a "raw" output.
 */

export const FINISH_WORKFLOW: WorkflowDef = {
  id: "video-finish", label: "Finish - 2× sharper + smoother",
  endpointId: "motionfield/finish/video", kind: "v2v",
  params: [
    { name: "video_url", label: "Video", type: "video", required: true },
    { name: "out_fps", label: "Output fps", type: "number", required: true },
  ],
  cost: () => 0,
  providers: { comfy: { workflow: "video-finish.json" } },
};

const POLL_MS = 2000;
const FINISH_TIMEOUT_MS = 20 * 60_000;
/** finish only pays off on real outputs - cap the GPU spend on long clips */
export const FINISH_MAX_SECONDS = 60;

export interface FinishCtx {
  signal?: AbortSignal;
  progress?: (pct: number, stage?: string) => void;
}

function localFile(url: string): string {
  const f = url.startsWith("/files/") ? filePathFor(url) : null;
  if (!f) throw new Error(`finish: unresolvable output ${url}`);
  return f;
}

/** Which provider runs the finish graph: the job's own provider for plain
 *  comfy/mock jobs; recipe jobs fall through to the env provider their
 *  sub-steps already ran on (mock in e2e, comfy live). */
export function finishProviderName(jobProvider: string): "mock" | "comfy" {
  if (jobProvider === "mock") return "mock";
  if (jobProvider === "recipe" || jobProvider === "comfy")
    return process.env.GENERATION_PROVIDER === "mock" ? "mock" : "comfy";
  return "comfy";
}

/** Non-blocking submit of the finish graph for one rendered clip - the jobs
 *  pipeline stores the returned providerJobId and polls it like the main job. */
export async function submitFinish(
  input: Pick<SubmitInput, "jobId" | "model" | "appBaseUrl" | "userId">,
  videoUrl: string,
  providerName: "mock" | "comfy" = finishProviderName("comfy"),
): Promise<SubmitResult> {
  // finish only ever runs on our own rendered outputs - resolve directly;
  // the file isn't an assets row yet (finishJob creates those at finalize)
  const src = videoUrl.startsWith("/files/") ? filePathFor(videoUrl) : null;
  if (!src) throw new Error(`finish: unresolvable output ${videoUrl}`);
  const probe = await probeVideo(src);
  return getProvider(providerName).submit({
    jobId: `${input.jobId}-finish`, model: input.model, workflow: FINISH_WORKFLOW,
    params: { video_url: videoUrl, out_fps: Math.round(probe.fps * 2 * 100) / 100 },
    appBaseUrl: input.appBaseUrl, userId: input.userId,
  });
}

/** Poll the finish job to completion and apply the ffmpeg polish -
 *  the blocking form recipes use inside their own run. */
export async function finishVideo(
  input: Pick<SubmitInput, "jobId" | "model" | "appBaseUrl" | "userId">,
  videoUrl: string,
  ctx: FinishCtx = {},
): Promise<ProviderOutputItem> {
  const provider = getProvider();
  const sub = await submitFinish(input, videoUrl, provider.name === "mock" ? "mock" : "comfy");
  const deadline = Date.now() + FINISH_TIMEOUT_MS;
  let items: ProviderOutputItem[];
  try {
    for (;;) {
      if (ctx.signal?.aborted) throw new Error("canceled");
      const st = await provider.poll(sub.providerJobId, sub.meta ?? {});
      if (st.state === "completed") { items = st.output.items; break; }
      if (st.state === "failed" || st.state === "nsfw" || st.state === "canceled")
        throw new Error(("error" in st && st.error) || `finish ${st.state}`);
      if (Date.now() > deadline) throw new Error("finish timed out");
      ctx.progress?.(95, "finishing");
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, POLL_MS);
        ctx.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("canceled")); }, { once: true });
      });
    }
  } catch (e) {
    await provider.cancel(sub.providerJobId, sub.meta ?? {}).catch(() => {});
    throw e;
  }
  const raw = items.find((o) => o.type === "video")?.url;
  if (!raw) throw new Error("finish pass produced no video");
  return sharpen(localFile(raw), input.jobId, ctx);
}

/** Host-side polish on a finished clip (the jobs pipeline calls this once
 *  the finish sub-job lands). Light unsharp + fine grain, audio copied. */
export async function polishFinished(file: string, jobId: string, signal?: AbortSignal): Promise<ProviderOutputItem> {
  return sharpen(file, jobId, { signal });
}

async function sharpen(file: string, jobId: string, ctx: FinishCtx): Promise<ProviderOutputItem> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "of-finish-"));
  try {
    const out = path.join(dir, "finished.mp4");
    await runArgv(ffmpegBin(), [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", file,
      "-map", "0:v:0", "-map", "0:a?",
      "-vf", "unsharp=5:5:0.4:5:5:0.0,noise=alls=1.1:allf=t",
      "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p",
      "-c:a", "copy", "-movflags", "+faststart", out,
    ], { signal: ctx.signal });
    const url = await saveBytes(`generated/finish/${jobId}.mp4`, await fs.readFile(out));
    return { type: "video", url, role: "finished" };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Params gate used by the jobs pipeline - a final video job opts into the
 *  pass with `finish: true` (the catalog default on video finals); drafts
 *  (`draft: true`) and non-video outputs never reach here. */
export function wantsFinish(params: Record<string, unknown>, items: ProviderOutputItem[]): boolean {
  return params.finish === true && params.draft !== true && items.some((i) => i.type === "video");
}
