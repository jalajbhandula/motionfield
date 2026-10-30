/**
 * stage-render - render a Stage scene to video through Wan 2.1 VACE.
 *
 * One MotionField job drives the whole pipeline (like person-swap; only the items
 * it returns become assets):
 *
 *   pinned scene revision → render plan (16 fps, 4n+1, ≤2 windows)
 *   → headless three.js passes (scripts/render/stage.ts → /render/stage):
 *       previz mp4 (the grey-box scene itself) + control mp4
 *       (depth always; an OpenPose-style skeleton when a mannequin poses it)
 *   → per ≤81-frame window: WanVaceToVideo on the control pass -
 *       window 2 prepends window 1's last 8 frames as masked keep-frames
 *       (8-frame continuation) and re-cuts the control from window 1's end on
 *   → join, trim to the 4n+1 count, tag, save
 *
 * The scene comes from stage_revisions - never the head row - so a later
 * edit can't move a submitted render. provider_meta.stage_render records
 * the plan, the composed prompt, and every substituted window graph as the
 * run proceeds; a failure still shows how far it got.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { getDb, sql, schema } from "@/db";
import { filePathFor, saveBytes } from "@/lib/storage";
import { parseStageScene } from "@/lib/stage/scene";
import { getRevisionScene } from "@/lib/stage/revisions";
import { ff, probeVideo } from "@/lib/re-edit-ffmpeg";
import { jobOwner } from "@/lib/re-edit";
import { getProvider } from "../index";
import { prune, substitute } from "../comfy";
import {
  STAGE_RENDER_FPS, STAGE_OVERLAP, STAGE_MAX_WINDOWS, STAGE_STEPS,
  stageRenderSize, stageFrameCount, stageWindows, joinedFrames,
  composeRenderPrompt,
} from "@/lib/stage/render-plan";
import type { RecipeCtx, RecipeFn } from "../recipe";
import type { WorkflowDef } from "@/lib/catalog/types";
import type { GenerationProvider, ProviderOutputItem, SubmitInput } from "../types";

const WF_FILE = path.join(process.cwd(), "workflows", "stage-render.json");
const NEGATIVE = "blurry, distorted, extra limbs, flicker, watermark, text, low quality";
const POLL_MS = 2500;
const STALL_MS = 20 * 60_000;
const STEP_FLOOR_MS = 30 * 60_000;

/** The recipe-internal workflow - never a catalog endpoint; only the recipe
 *  submits it, with a fully substituted graphOverride per window. */
const WINDOW_WF: WorkflowDef = {
  id: "stage-window", label: "Stage render window",
  endpointId: "motionfield/stage/render-window", kind: "video",
  params: [
    { name: "video_url", label: "Control video", type: "video", required: true },
    { name: "mask_video_url", label: "Continuation mask", type: "media" },
    { name: "reference_image_url", label: "Anchor frame", type: "media", accepts: "image/*" },
    { name: "prompt", label: "Prompt", type: "prompt" },
  ],
  cost: () => 0,
  providers: { comfy: { workflow: "stage-render.json" } },
};

class StallError extends Error {}

/** Poll one window sub-step; mirrors person-swap's runStep - a 10-minute progress
 *  freeze after the first tick is a stall, the cap is max(30 min, 3× est),
 *  and on any failure the provider job is cancelled so the GPU isn't left
 *  on a dead run. */
async function runStep(
  p: GenerationProvider, input: SubmitInput, params: Record<string, unknown>,
  graph: Record<string, unknown>, label: string, ctx: RecipeCtx,
  onProgress: (f: number) => void, estMs: number,
): Promise<ProviderOutputItem[]> {
  const capMs = Math.max(STEP_FLOOR_MS, estMs * 3);
  const sub = await p.submit({
    jobId: `${input.jobId}-${label}`,
    model: input.model, workflow: WINDOW_WF, params,
    graphOverride: graph, appBaseUrl: input.appBaseUrl,
  });
  const deadline = Date.now() + capMs;
  let lastProg = 0;
  let lastChange = -1;
  try {
    for (;;) {
      if (ctx.signal.aborted) throw new Error("canceled");
      const st = await p.poll(sub.providerJobId, sub.meta ?? {});
      if (st.state === "completed") {
        if (!st.output.items.length) throw new Error("step produced no outputs");
        return st.output.items;
      }
      if (st.state === "failed" || st.state === "nsfw" || st.state === "canceled")
        throw new Error(("error" in st && st.error) ? String(st.error) : `stage ${label} ${st.state}`);
      const prog = st.state === "in_progress" ? (st.progress ?? 0) : 0;
      const now = Date.now();
      if (st.state === "queued") {
        if (lastChange >= 0) lastChange = now;
      } else if (prog !== lastProg) {
        lastProg = prog;
        if (prog > 0) lastChange = now;
      } else if (lastChange >= 0 && now - lastChange > STALL_MS)
        throw new StallError("no provider progress for 20 min");
      if (now > deadline) throw new Error(`stage ${label} timed out (cap ${Math.round(capMs / 60000)} min)`);
      onProgress(prog / 100);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, POLL_MS);
        ctx.signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("canceled")); }, { once: true });
      });
    }
  } catch (e) {
    await p.cancel(sub.providerJobId, sub.meta ?? {}).catch(() => {});
    throw e;
  }
}

const videoItem = (items: ProviderOutputItem[], label: string) => {
  const v = items.find((i) => i.type === "video" && i.url);
  if (!v?.url) throw new Error(`stage ${label} - provider returned no video`);
  return v.url;
};

/** Substitute a window's graph straight from the shipped workflow file -
 *  the JSON is the source of truth; the recipe only fills placeholders and
 *  drops the optional mask/ref loaders a window doesn't feed. */
async function windowGraph(opts: {
  controlRef: string; maskRef?: string; refImage?: string;
  w: number; h: number; frames: number; seed: number; steps: number;
  prompt: string; prefix: string;
}): Promise<Record<string, { class_type: string; inputs: Record<string, unknown> }>> {
  type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  const raw = JSON.parse(await fs.readFile(WF_FILE, "utf8")) as Graph;
  if (!opts.maskRef) {
    delete raw["7"];
    delete raw["7b"];
    delete raw["9"].inputs.control_masks;
  }
  if (!opts.refImage) {
    delete raw["8"];
    delete raw["9"].inputs.reference_image;
  }
  const map: Record<string, string> = {
    PROMPT: opts.prompt, NEGATIVE,
    WIDTH: String(opts.w), HEIGHT: String(opts.h), FRAMES: String(opts.frames),
    SEED: String(opts.seed), STEPS: String(opts.steps),
    INPUT_VIDEO: opts.controlRef, PREFIX: opts.prefix,
    ...(opts.maskRef ? { MASK_VIDEO: opts.maskRef } : {}),
    ...(opts.refImage ? { REF_IMAGE: opts.refImage } : {}),
  };
  return prune(substitute(raw, map, new Set()));
}

/** Merge a patch into jobs.provider_meta.stage_render - the recipe subtree
 *  only, so unrelated keys are never clobbered. */
async function mergeStageMeta(jobId: string, patch: Record<string, unknown>): Promise<void> {
  await sql(
    `UPDATE jobs SET provider_meta =
       jsonb_set(provider_meta, '{stage_render}',
         COALESCE(provider_meta->'stage_render', '{}'::jsonb) || $2::jsonb),
       updated_at = now()
     WHERE id = $1`,
    [jobId, JSON.stringify(patch)],
  ).catch(() => {});
}

/** The last submitted window graph - jobs.graph_json keeps the same shape a
 *  plain comfy job stores, so /api/jobs/:id/graph reads it directly. */
async function recordGraph(jobId: string, graph: Record<string, unknown>): Promise<void> {
  await sql(`UPDATE jobs SET graph_json = $2::jsonb WHERE id = $1`, [jobId, JSON.stringify(graph)])
    .catch(() => {});
}

/** globalThis so dev HMR doesn't fork the queue - shared with motion-render:
 *  one headless-Chromium + ffmpeg pair at a time across both recipes. */
const g = globalThis as { __ofMotionQueue?: Promise<unknown> };
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = (g.__ofMotionQueue ?? Promise.resolve()).then(fn, fn);
  g.__ofMotionQueue = p.then(() => {}, () => {});
  return p;
}

function runExport(args: string[], ctx: RecipeCtx, basePct: number, span: number): Promise<void> {
  return new Promise((res, rej) => {
    if (ctx.signal.aborted) return rej(ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("aborted"));
    const proc = spawn(process.execPath, args, { cwd: process.cwd() });
    let errTail = "";
    const onAbort = () => proc.kill("SIGTERM");
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    proc.stdout.on("data", (d) => {
      const m = /frame (\d+)\/(\d+)/.exec(d.toString());
      if (m) ctx.progress(basePct + Math.round((Number(m[1]) / Number(m[2])) * span), "rendering scene passes");
    });
    proc.stderr.on("data", (d) => { errTail = (errTail + d).slice(-4000); });
    proc.on("close", (code) => {
      ctx.signal.removeEventListener("abort", onAbort);
      if (code === 0) res();
      else rej(new Error(`stage exporter exited ${code}${errTail ? `: ${errTail.trim()}` : ""}`));
    });
    proc.on("error", rej);
  });
}

export const stageRenderRecipe: RecipeFn = async (input, ctx) => {
  const p = input.params;
  const sceneId = String(p.scene_id ?? "");
  const revision = Number(p.revision);
  const startS = Number(p.start_s ?? 0);
  const durationS = Number(p.duration_s ?? 3);
  const control = String(p.control ?? "depth");
  const seed = Number.isFinite(Number(p.seed)) ? Number(p.seed) : 0;

  const owner = await jobOwner(input.jobId);
  if (!owner) throw new Error("stage-render: could not resolve the job owner");

  // pinned revision of an owned scene - head can move on; the render can't
  const db = await getDb();
  const [sceneRow] = await db.select()
    .from(schema.stageScenes).where(eq(schema.stageScenes.id, sceneId)).limit(1);
  if (!sceneRow || sceneRow.userId !== owner) throw new Error("scene not found");
  if (!Number.isInteger(revision) || revision < 1) throw new Error("revision must be a positive integer");
  const rev = await getRevisionScene(sceneId, revision);
  if (!rev) throw new Error(`scene revision ${revision} not found`);
  const scene = parseStageScene(rev.scene);

  if (!(startS >= 0) || startS >= scene.meta.duration)
    throw new Error(`start_s must be in [0, ${scene.meta.duration})`);
  if (!(durationS > 0) || startS + durationS > scene.meta.duration)
    throw new Error(`duration_s must keep the render inside the scene (start + duration ≤ ${scene.meta.duration} s)`);
  if (control !== "depth" && control !== "pose")
    throw new Error(`control must be depth or pose (got "${control}")`);
  const hasMannequin = scene.nodes.some((n) => n.kind === "mannequin");
  if (control === "pose" && !hasMannequin)
    throw new Error("pose control needs a mannequin in the scene");

  const frames = stageFrameCount(durationS);
  const windows = stageWindows(frames);
  if (!windows.length || windows.length > STAGE_MAX_WINDOWS)
    throw new Error(
      `${frames} frames needs more than the local ${STAGE_MAX_WINDOWS}-window ceiling - not in this build`,
    );
  const out = stageRenderSize(scene.meta.aspect);
  const joined = Math.min(frames, joinedFrames(windows));
  const prompt = composeRenderPrompt(scene, String(p.prompt ?? ""), startS, frames, out.w, out.h).text;
  if (!prompt.trim()) throw new Error("prompt is empty - the scene has no prompt and no visible objects");

  // previz at the scene's own render size, capped at 1920×1080 even dims
  const rs = scene.meta.renderSize;
  const ps = Math.min(1, 1920 / Math.max(rs.w, rs.h), 1080 / Math.min(rs.w, rs.h));
  const previz = { w: Math.max(2, Math.round(rs.w * ps) & ~1), h: Math.max(2, Math.round(rs.h * ps) & ~1) };
  const tag = `rendered from Stage scene ${sceneId} rev ${revision}`;

  await mergeStageMeta(input.jobId, {
    scene_id: sceneId, revision, start_s: startS, duration_s: durationS,
    control, out_size: `${out.w}×${out.h}`, frames: joined, fps: STAGE_RENDER_FPS,
    windows: windows.map((w) => ({ len: w.len, overlap: w.overlap })),
    prompt, graphs: [], tag,
  });

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "of-stage-"));
  const provider = getProvider();
  const providerFiles: string[] = [];
  const dropLater = (u?: string | null) => { const fp = u ? filePathFor(u) : null; if (fp) providerFiles.push(fp); };
  // progress: passes 0-15%, generation windows 15-90%, join/tag 90-100%
  const winSpan = 75 / windows.length;
  try {
    /* ---------- headless scene passes ---------- */
    ctx.progress(2, "rendering scene passes");
    const controlPath = path.join(dir, "control.mp4");
    const previzPath = path.join(dir, "previz.mp4");
    const jobFile = path.join(dir, "job.json");
    await fs.writeFile(jobFile, JSON.stringify({
      scene, startS, fps: STAGE_RENDER_FPS, frames,
      passes: [
        { kind: "previz", w: previz.w, h: previz.h, out: previzPath },
        { kind: control, w: out.w, h: out.h, out: controlPath },
      ],
    }));
    await enqueue(() => runExport([
      "--experimental-strip-types", "scripts/render/stage.ts",
      "--job", jobFile, "--base", input.appBaseUrl,
    ], ctx, 2, 12));
    ctx.signal.throwIfAborted();

    // window 1's anchor - the first previz frame pins identity to the scene
    const refPng = path.join(dir, "ref.png");
    await ff(["-y", "-i", previzPath, "-vframes", "1", refPng], ctx.signal);

    ctx.progress(15, "saving passes");
    const controlUrl = await saveBytes(`generated/.stage/${input.jobId}/control.mp4`, await fs.readFile(controlPath));
    const previzUrl = await saveBytes(`generated/.stage/${input.jobId}/previz.mp4`, await fs.readFile(previzPath));

    /* ---------- VACE windows ---------- */
    const graphs: Record<string, unknown>[] = [];
    const winFiles: string[] = [];
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const wiSeed = (seed + i * 7919) >>> 0;
      let winControl = controlUrl;
      let maskUrl: string | undefined;
      let refUrl: string | undefined;
      if (i === 0) {
        refUrl = await saveBytes(`generated/.stage/${input.jobId}/ref0.png`, await fs.readFile(refPng));
        if (w.len < frames) {
          const cut = path.join(dir, `control-w${i}.mp4`);
          await ff(["-y", "-i", controlPath, "-vf", `trim=end_frame=${w.len}`, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", cut], ctx.signal);
          winControl = await saveBytes(`generated/.stage/${input.jobId}/control-w${i}.mp4`, await fs.readFile(cut));
        }
      } else {
        /* continuation: prepend the last OVERLAP frames of the previous
         * window's OUTPUT (masked keep-frames) to the fresh control cut -
         * VACE holds them and continues from there. -sseof pulls the tail
         * without a frame count so a shorter provider video still pads to
         * exactly OVERLAP frames. */
        const prevOut = winFiles[i - 1];
        const tail = path.join(dir, `tail-w${i}.mp4`);
        await ff([
          "-y", "-sseof", "-1", "-i", prevOut,
          "-vf", `trim=end_frame=${STAGE_OVERLAP},tpad=stop=${STAGE_OVERLAP}:stop_mode=clone,trim=end_frame=${STAGE_OVERLAP},scale=${out.w}:${out.h},setsar=1`,
          "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", tail,
        ], ctx.signal);
        const w2control = path.join(dir, `control-w${i}.mp4`);
        await ff([
          "-y",
          "-i", tail, "-i", controlPath,
          "-filter_complex",
          `[1:v]select='gte(n,${windows[0].len})',tpad=stop=3:stop_mode=clone,trim=end_frame=${w.len - STAGE_OVERLAP},setsar=1[b];` +
          `[0:v][b]concat=n=2:v=1[out]`,
          "-map", "[out]", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", w2control,
        ], ctx.signal);
        winControl = await saveBytes(`generated/.stage/${input.jobId}/control-w${i}.mp4`, await fs.readFile(w2control));
        // mask: keep-white on the prepended overlap, generate-black after
        const maskPath = path.join(dir, `mask-w${i}.mp4`);
        const keepS = STAGE_OVERLAP / STAGE_RENDER_FPS;
        const genS = (w.len - STAGE_OVERLAP) / STAGE_RENDER_FPS;
        await ff([
          "-y",
          "-f", "lavfi", "-i", `color=white:s=${out.w}x${out.h}:r=${STAGE_RENDER_FPS}:d=${keepS}`,
          "-f", "lavfi", "-i", `color=black:s=${out.w}x${out.h}:r=${STAGE_RENDER_FPS}:d=${genS}`,
          "-filter_complex", "[0:v][1:v]concat=n=2:v=1[out]",
          "-map", "[out]", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", maskPath,
        ], ctx.signal);
        maskUrl = await saveBytes(`generated/.stage/${input.jobId}/mask-w${i}.mp4`, await fs.readFile(maskPath));
      }

      ctx.progress(15 + i * winSpan, `window ${i + 1}/${windows.length}`);
      const graph = await windowGraph({
        controlRef: winControl, maskRef: maskUrl, refImage: refUrl,
        w: out.w, h: out.h, frames: w.len, seed: wiSeed,
        steps: Math.min(STAGE_STEPS, Math.max(4, Number(p.steps) || STAGE_STEPS)),
        prompt, prefix: `of_stage_${input.jobId.slice(0, 8)}_w${i}`,
      });
      graphs.push(graph);
      await recordGraph(input.jobId, graph);
      await mergeStageMeta(input.jobId, { graphs });

      let items: ProviderOutputItem[];
      // ~45-60 s/frame of VACE 1.3B on Apple silicon - honest step cap input
      const estMs = Math.max(60_000, w.len * 60_000);
      try {
        items = await runStep(provider, input, {
          video_url: winControl,
          ...(maskUrl ? { mask_video_url: maskUrl } : {}),
          ...(refUrl ? { reference_image_url: refUrl } : {}),
          prompt, seed: wiSeed,
        }, graph, `w${i}`, ctx,
          (f) => ctx.progress(15 + (i + f) * winSpan, `window ${i + 1}/${windows.length}`),
          estMs);
      } catch (e) {
        if (e instanceof StallError) throw new StallError(`window ${i + 1} stalled`);
        throw new Error(`window ${i + 1} failed: ${(e as Error).message}`);
      }
      const url = videoItem(items, `window ${i + 1}`);
      const fp = filePathFor(url);
      if (!fp) throw new Error(`window ${i + 1}: output outside generated storage`);
      const keep = path.join(dir, `window-${i}.mp4`);
      await fs.copyFile(fp, keep);
      dropLater(url);
      winFiles.push(keep);
    }

    /* ---------- join + tag ---------- */
    ctx.progress(90, "joining");
    const joinedPath = path.join(dir, "joined.mp4");
    if (winFiles.length === 1) {
      await ff(["-y", "-i", winFiles[0], "-vf", `trim=end_frame=${joined}`, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", joinedPath], ctx.signal);
    } else {
      const drops = winFiles.map((_, i) => (i === 0 ? 0 : STAGE_OVERLAP));
      const filters = winFiles.map((_, i) =>
        `[${i}:v]scale=${out.w}:${out.h},setsar=1,select='gte(n,${drops[i]})'[w${i}]`).join(";")
        + `;${winFiles.map((_, i) => `[w${i}]`).join("")}concat=n=${winFiles.length}:v=1[cat];`
        + `[cat]trim=end_frame=${joined}[out]`;
      await ff([
        "-y", ...winFiles.flatMap((f) => ["-i", f]),
        "-filter_complex", filters, "-map", "[out]",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", joinedPath,
      ], ctx.signal);
    }
    const tagged = path.join(dir, "final.mp4");
    await ff(["-y", "-i", joinedPath, "-c", "copy", "-movflags", "+faststart", "-metadata", `comment=${tag}`, tagged], ctx.signal);

    ctx.progress(96, "saving");
    const probe = await probeVideo(tagged).catch(() => null);
    const url = await saveBytes(`generated/stage-${input.jobId}.mp4`, await fs.readFile(tagged));
    await mergeStageMeta(input.jobId, { graphs });
    ctx.progress(100, "done");
    return [
      { type: "video", url, width: out.w, height: out.h, duration: probe?.durationSec ?? joined / STAGE_RENDER_FPS },
      { type: "video", url: previzUrl, width: previz.w, height: previz.h, duration: frames / STAGE_RENDER_FPS },
      { type: "video", url: controlUrl, width: out.w, height: out.h, duration: frames / STAGE_RENDER_FPS },
    ] satisfies ProviderOutputItem[];
  } finally {
    for (const fp of providerFiles) await fs.rm(fp, { force: true }).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};
