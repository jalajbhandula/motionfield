/**
 * person-swap - windowed identity/environment swap on Wan 2.1 VACE.
 *
 * One MotionField job drives provider sub-steps directly (like re-edit-assemble;
 * only the assembled file becomes an asset):
 *
 *   probe → [person-ish modes: cheap matte+face preflight → coverage gate
 *                            → one ref-cutout pass per identity ref]
 *         → per ≤5 s window:  cut → [person pass: pose-driven masked VACE swap]
 *                                 → [env pass: invert-matte VACE restyle]
 *           (both = person pass, then env pass on its output)
 *         → assemble at the source's fps with the original soundtrack
 *         → optional MuseTalk pass re-times the person-swap's lips to it
 *
 * The coverage strip + matte frame each graph saves are the refusal evidence:
 * a run whose person matte stays under PERSON_SWAP_MIN_MATTE fails with the matte
 * kept under generated/.person-swap/<job>/ so the report is verifiable. Run state
 * (windows, wall seconds per window, gen box, steps, lip outcome) is merged
 * into jobs.provider_meta.person-swap as the run proceeds - a failure still shows
 * how far it got.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { sql } from "@/db";
import { findEndpoint } from "../../catalog/video-models";
import { filePathFor, saveBytes } from "../../storage";
import { getProvider } from "../index";
import { resolveParams, JobError } from "../../jobs";
import { resolveOwnedMedia } from "../../media-owned";
import { refundCredits } from "../../credits";
import { jobOwner } from "../../re-edit";
import { likenessConsentCheck } from "../../likeness";
import {
  PERSON_SWAP, PERSON_SWAP_MODES, personSwapGenBox, personSwapWindowPassMin, personSwapLocalSteps,
  PERSON_SWAP_LIP_MIN_PER_SEC,
} from "../../catalog/video/swap";
import { planById } from "../../catalog/plans";
import {
  chooseAspect, cutSegment, windowFrames,
  probeVideo, ff, even, RE_EDIT_GEN_FPS,
  type ProbeInfo, type ShotSpan,
} from "../../re-edit-ffmpeg";
import type { RecipeCtx, RecipeFn } from "../recipe";
import type { WorkflowDef } from "../../catalog/types";
import type { GenerationProvider, ProviderOutputItem, SubmitInput } from "../types";

const execFileP = promisify(execFile);
const FF = () => process.env.FFMPEG_BIN || "ffmpeg";
const FFP = () => process.env.FFPROBE_BIN || "ffprobe";

export const PERSON_SWAP_ENDPOINT = "motionfield/person-swap/v1.0";
export type PersonSwapMode = (typeof PERSON_SWAP_MODES)[number];
export const PERSON_SWAP_MIN_S = 1;
export const PERSON_SWAP_MAX_S = 30;
/** a batch is one clip × this many identity sets (each an independent job) */
export const PERSON_SWAP_MAX_IDENTITIES = 4;
/** clips[] - the primary clip plus up to this many more per request */
export const PERSON_SWAP_MAX_CLIPS = 4;
/** identity refs accepted per run - the best 3 by cut-out matte coverage
 *  drive the swap */
export const PERSON_SWAP_MAX_REFS = 8;
/** PersonSwap Quick - the short path: exactly 1 photo, one clip ≤ this many
 *  seconds, person mode only */
export const PERSON_SWAP_QUICK_MAX_S = 15;
/** consecutive generation windows share this many source frames - the
 *  join is a cross-fade, not a cut */
const PERSON_SWAP_XFADE_FRAMES = 8;
/** a draft runs its first window at this many sampler steps - cheap enough
 *  to review before paying the full render (the approved draft's seed then
 *  carries into the final) */
export const PERSON_SWAP_DRAFT_STEPS = 4;
export const PERSON_SWAP_MIN_MATTE = 0.03;
/** rows shaved off the top of every generated window's content rect - a
 *  VACE render leaves a dark line at the frame's top edge */
const PERSON_SWAP_TOP_INSET = 2;
/** a face must register on the preflight strip in at least this share of
 *  frames for the lip-restore pass to run */
const PERSON_SWAP_LIP_FACE_MIN = 0.5;
const POLL_MS = 2500;
/** no provider progress change for this long inside a step → "window N stalled" */
const STALL_MS = 10 * 60_000;
/** a step never runs longer than max(30 min, 3× its estimate) */
const STEP_FLOOR_MS = 30 * 60_000;

/** Window seeds come from ONE key per run, not per window: every window
 *  pass samples with the same seed so neighbouring windows stay in the same
 *  noise basin - the 8-frame overlap a join cross-fades then carries near-
 *  identical pixels instead of two divergent renditions (the seam reads as
 *  a pop when seeds differ). The draft/approve pair reuses the DRAFT job's
 *  id as the key so the approved preview is what the final re-renders at
 *  full steps. */
export const seedFor = (jobId: string, i: number, tag: number): number => {
  let h = (i + 1) * 131 + tag;
  for (const c of jobId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
};

/** Uniform ≤5 s windows across the clip - a person-swap source isn't an edit, so
 *  there are no cuts to detect; the window count is what the job paid for. */
export function personSwapWindows(durationSec: number): ShotSpan[] {
  const span = Math.min(Math.max(durationSec, PERSON_SWAP_MIN_S), PERSON_SWAP_MAX_S);
  const n = Math.max(1, Math.ceil(span / 5));
  const per = span / n;
  return Array.from({ length: n }, (_, i) => ({ start: i * per, end: i === n - 1 ? span : (i + 1) * per }));
}

/** true only on the PersonSwap endpoint itself - the wan-vace character-swap
 *  endpoint routes here too, as a pure person-mode run: quick, gallery,
 *  aspect, lip and mode stay PersonSwap's own surface gates. */
const isPersonSwap = (input: SubmitInput) => input.workflow?.endpointId === PERSON_SWAP_ENDPOINT;

/** The recipe-internal graphs - never catalog endpoints; only the recipe
 *  submits them, with job-internal params. */

const MATTE_WF: WorkflowDef = {
  id: "matte-preflight", label: "PersonSwap matte preflight", endpointId: "motionfield/person-swap/matte", kind: "image",
  params: [{ name: "video_url", label: "Source clip", type: "video", required: true }],
  cost: () => 0,
  providers: { comfy: { workflow: "person-swap-matte.json" } },
};
export const REFCUT_WF: WorkflowDef = {
  id: "ref-cutout", label: "PersonSwap ref cut-out", endpointId: "motionfield/person-swap/ref-cutout", kind: "image",
  params: [{ name: "image_url", label: "Identity ref", type: "image", required: true }],
  cost: () => 0,
  providers: { comfy: { workflow: "person-swap-refcut.json" } },
};
export const PERSON_WF: WorkflowDef = {
  id: "person-window", label: "PersonSwap person window", endpointId: "motionfield/person-swap/person-window", kind: "v2v",
  params: [
    { name: "video_url", label: "Window clip", type: "video", required: true },
    { name: "image_urls", label: "Identity cut-outs", type: "images", maxItems: 3, accepts: "image/*" },
  ],
  cost: () => 0,
  providers: { comfy: { workflow: "person-swap-person.json" } },
};
const ENV_WF: WorkflowDef = {
  id: "environment-window", label: "PersonSwap environment window", endpointId: "motionfield/person-swap/environment-window", kind: "v2v",
  params: [
    { name: "video_url", label: "Window clip", type: "video", required: true },
    { name: "image_urls", label: "Setting ref", type: "images", maxItems: 1, accepts: "image/*" },
  ],
  cost: () => 0,
  providers: { comfy: { workflow: "person-swap-environment.json" } },
};

/** The smallest 8n+1 frame count ≥ the window's frames at the gen fps,
 *  expressed as a duration the graph's {{FRAMES}} math reproduces exactly. */
export const windowDur = (span: ShotSpan): number =>
  (8 * Math.ceil(Math.max(1, windowFrames(span, RE_EDIT_GEN_FPS) - 1) / 8) + 1) / RE_EDIT_GEN_FPS;

export class StallError extends Error {}

/** Poll one sub-step; returns ALL output items (video + matte evidence
 *  images). estMs feeds the step cap (max 30 min / 3× estimate); a 10-minute
 *  progress freeze is a stall - but only once the step has produced its first
 *  non-zero progress tick: model load / text encode / upload all sit at 0%
 *  for minutes on a cold run, and they answer to the cap, not the stall
 *  guard. On abort/stall/cap, cancel the provider job first so ComfyUI isn't
 *  left burning GPU on a dead run. */
export async function runStep(
  p: GenerationProvider, input: SubmitInput, workflow: WorkflowDef,
  params: Record<string, unknown>, label: string, ctx: RecipeCtx,
  onProgress: (f: number) => void, estMs: number,
): Promise<ProviderOutputItem[]> {
  const capMs = Math.max(STEP_FLOOR_MS, estMs * 3);
  const sub = await p.submit({
    jobId: `${input.jobId}-${label}`,
    model: input.model, workflow, params, appBaseUrl: input.appBaseUrl,
  });
  const deadline = Date.now() + capMs;
  let lastProg = 0;
  /** stall clock - starts at the first >0 progress tick, not at submit */
  let lastChange = -1;
  try {
    while (true) {
      if (ctx.signal.aborted) throw new Error("canceled");
      const st = await p.poll(sub.providerJobId, sub.meta ?? {});
      if (st.state === "completed") {
        if (!st.output.items.length) throw new Error("step produced no outputs");
        return st.output.items;
      }
      if (st.state === "failed" || st.state === "nsfw" || st.state === "canceled")
        throw new Error(("error" in st && st.error) ? String(st.error) : `person-swap ${label} ${st.state}`);
      const prog = st.state === "in_progress" ? (st.progress ?? 0) : 0;
      const now = Date.now();
      if (st.state === "queued") {
        if (lastChange >= 0) lastChange = now; // re-queued after starting - waiting on the gpu isn't a stall
      } else if (prog !== lastProg) {
        lastProg = prog;
        if (prog > 0) lastChange = now;
      } else if (lastChange >= 0 && now - lastChange > STALL_MS)
        throw new StallError("no provider progress for 10 min");
      if (now > deadline) throw new Error(`person-swap ${label} timed out (cap ${Math.round(capMs / 60000)} min)`);
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

export const videoItem = (items: ProviderOutputItem[], label: string) => {
  const v = items.find((i) => i.type === "video" && i.url);
  if (!v?.url) throw new Error(`person-swap ${label} - provider returned no video`);
  return v.url;
};
export const imageItem = (items: ProviderOutputItem[], label: string) => {
  // refcut emits exactly one image - the white-plate cut-out
  const v = items.find((i) => i.type === "image" && i.url);
  if (!v?.url) throw new Error(`person-swap ${label} - provider returned no image`);
  return v.url;
};

/** Pixel dims for a still image - probeVideo rejects PNGs (no duration), and
 *  the evidence files are PNGs, so a dims-only probe is what classification
 *  needs. Throws on unreadable input. */
async function imageDims(fp: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileP(FFP(),
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", fp]);
  const [w, h] = stdout.trim().split(",").map(Number);
  if (!w || !h) throw new Error(`no image dims for ${fp}`);
  return { width: w, height: h };
}

/** Classify a step's image outputs: the coverage strip (1×N per-window,
 *  2×N for the preflight's person+face rows, 1×1 for a single-ref cut-out)
 *  vs the matte evidence frame. Heights are probed - nothing depends on
 *  url names; a real matte frame is never ≤2 px tall. */
export async function classifyEvidence(items: ProviderOutputItem[]) {
  const out: { strip?: string; matte?: string } = {};
  for (const item of items) {
    if (item.type !== "image" || !item.url) continue;
    const fp = filePathFor(item.url);
    if (!fp) continue;
    try {
      const pr = await imageDims(fp);
      if (pr.height <= 2 && pr.width >= 1) out.strip = out.strip ?? item.url;
      else out.matte = out.matte ?? item.url;
    } catch { /* unreadable image - ignore */ }
  }
  return out;
}

/** Per-frame coverage (0..1) decoded from a saved strip PNG. The preflight
 *  graph stacks person coverage on row 0 and face coverage on row 1 (a 2×N
 *  strip); window graphs save a 1×N person-only strip. null when no strip
 *  came back (mock provider) - "no signal", never a fail. */
export async function stripCoverage(stripUrl: string): Promise<{ person: number[]; face: number[] | null } | null> {
  const fp = filePathFor(stripUrl);
  if (!fp) return null;
  try {
    const pr = await imageDims(fp);
    const { stdout } = await execFileP(FF(),
      ["-nostdin", "-v", "error", "-i", fp, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
      { encoding: "buffer", maxBuffer: 1 << 20 });
    const px = stdout instanceof Buffer ? stdout : Buffer.from(stdout);
    const row = (r: number) => [...px.subarray(r * pr.width, (r + 1) * pr.width)].map((b) => b / 255);
    return { person: row(0), face: pr.height >= 2 ? row(1) : null };
  } catch {
    return null;
  }
}

/** Move a provider-saved loose artifact under the job's .person-swap evidence dir
 * - it stays /files-reachable for the refusal report but out of the flat
 *  generated root, and it never becomes a gallery asset. */
export async function keepEvidence(url: string | undefined, workDir: string, name: string): Promise<string | null> {
  if (!url) return null;
  const fp = filePathFor(url);
  if (!fp) return null;
  const dst = path.join(workDir, name);
  try { await fs.rename(fp, dst); } catch { return null; }
  return `/files/generated/.person-swap/${path.basename(workDir)}/${name}`;
}

export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
/** Mean coverage across the strip - the fail-closed gate uses the mean,
 *  not the peak: a single hallucinated blob on one segment must not pass
 *  a "person is present" check. A real person fills most segments. */
export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/* PersonSwap Quick gallery - public/person-swap/gallery/manifest.json names the
 *  ready clips the picker may send. Clients pass only the entry id; the
 *  server resolves the file itself - a client-supplied path is never
 *  accepted (an unknown or unverified id 400s before any fs touch). */
export function personSwapGalleryDir(): string {
  return process.env.PERSON_SWAP_GALLERY_DIR || path.join(process.cwd(), "public", "person-swap", "gallery");
}

/** the recorded check a `verified: true` stands on - the verify block must
 *  carry the re-gen's steps and seed, the probe/size it produced, the
 *  vision-judge result and the check date, and the judge line has to record
 *  a 2/2 pass. A claimed `verified: true` without this block (or with a
 *  failing judge) degrades to an unverified entry - it is never served. */
export const PersonSwapGalleryVerify = z.object({
  steps: z.number().int().min(1),
  seed: z.number().int(),
  judge: z.string().min(1).refine((s) => s.includes("2/2"), "verify.judge must record a 2/2 pass"),
  size_bytes: z.number().int().positive(),
  seconds: z.number().positive(),
  checked_at: z.string().min(4),
});
const GalleryEntryZ = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  // basename only - resolution goes through path.basename anyway, and a
  // path-shaped file must never parse
  file: z.string().regex(/^[^/\\]{1,200}$/),
  seconds: z.number().positive(),
  aspect: z.string().min(1).max(40),
  provenance: z.union([z.record(z.string(), z.unknown()), z.string(), z.null()]).optional(),
  verified: z.boolean().optional(),
  verify: z.unknown().optional(),
}).passthrough();

export interface PersonSwapGalleryEntry {
  id: string; file: string; seconds: number; aspect: string;
  provenance: Record<string, unknown> | string | null; verified?: boolean;
  /** the recorded check a `verified: true` stands on - steps/seed read back
   *  off the saved file, the vision-judge result, size and wall seconds.
   *  "verified" means this check ran clean - the block validated and the
   *  judge passed 2/2 - not merely that a file exists. */
  verify?: { steps?: number; seed?: number; judge?: string; size_bytes?: number; seconds?: number; checked_at?: string };
}

/** Manifest entries → honest gallery rows: unparseable entries drop out
 *  entirely; a `verified: true` claim survives only on a strict verify
 *  block. Exported for the unit gate. */
export function parsePersonSwapGallery(raw: unknown): PersonSwapGalleryEntry[] {
  const clips = (raw as { clips?: unknown })?.clips;
  if (!Array.isArray(clips)) return [];
  const out: PersonSwapGalleryEntry[] = [];
  for (const c of clips) {
    const p = GalleryEntryZ.safeParse(c);
    if (!p.success) continue;
    const verify = p.data.verify !== undefined ? PersonSwapGalleryVerify.safeParse(p.data.verify) : null;
    out.push({
      id: p.data.id, file: p.data.file, seconds: p.data.seconds, aspect: p.data.aspect,
      provenance: p.data.provenance ?? null,
      verified: p.data.verified === true && verify?.success === true,
      verify: (p.data.verify ?? undefined) as PersonSwapGalleryEntry["verify"],
    });
  }
  return out;
}
export async function readPersonSwapGallery(): Promise<PersonSwapGalleryEntry[]> {
  try {
    return parsePersonSwapGallery(JSON.parse(await fs.readFile(path.join(personSwapGalleryDir(), "manifest.json"), "utf8")));
  } catch { return []; }
}
/** Verified gallery entry + its on-disk path - null when the id is
 *  unknown, unverified, or the file hasn't landed yet. */
export async function personSwapGalleryFile(galleryId: string): Promise<{ entry: PersonSwapGalleryEntry; file: string } | null> {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(galleryId)) return null;
  const entry = (await readPersonSwapGallery()).find((e) => e.id === galleryId && e.verified === true);
  if (!entry) return null;
  const file = path.resolve(/* turbopackIgnore: true */ personSwapGalleryDir(), path.basename(entry.file));
  return (await fs.stat(file).then(() => true, () => false)) ? { entry, file } : null;
}
/** Resolve a gallery pick into a caller-owned upload - the copy is what
 *  every downstream gate (ownership, probe, likeness) sees. */
export async function resolvePersonSwapGalleryClip(userId: string, galleryId: string): Promise<string> {
  const hit = await personSwapGalleryFile(galleryId);
  if (!hit) throw new JobError("unknown gallery clip", 400);
  const key = `uploads/${crypto.randomUUID()}${path.extname(hit.file) || ".mp4"}`;
  const buf = await fs.readFile(hit.file);
  const url = await saveBytes(key, buf);
  await sql(
    `INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'video/mp4', $3, $4)
     ON CONFLICT DO NOTHING`,
    [userId, url, buf.length, path.basename(hit.file)],
  );
  return url;
}

/**
 * Assemble the generated windows into the final file - person-swap's own
 * assembler (kept out of re-edit-ffmpeg.ts which ReCut still uses as a
 * straight concat). Each window is conformed to its span's frame count at
 * the source fps PLUS the 8-frame tail every non-last window generated,
 * and neighbouring windows join with an ffmpeg xfade over that shared
 * region - independent VACE passes diverge, so the join fades rather than
 * pops. Total video length stays exactly the source's; the ORIGINAL
 * soundtrack (audioPath, the pre-crop upload) is muxed to the assembled
 * length.
 */
async function assemblePersonSwap(
  inputs: { file: string; span: ShotSpan }[], probe: ProbeInfo,
  audioPath: string, outPath: string, signal?: AbortSignal,
): Promise<void> {
  if (!inputs.length) throw new Error("assemble: no windows");
  if (signal?.aborted) throw new Error("canceled");
  const fps = probe.fps;
  const w = even(probe.width), h = even(probe.height);
  const xfSec = PERSON_SWAP_XFADE_FRAMES / fps;
  const parts: string[] = [];
  inputs.forEach((inp, i) => {
    const need = windowFrames(inp.span, fps) + (i < inputs.length - 1 ? PERSON_SWAP_XFADE_FRAMES : 0);
    parts.push(
      `[${i}:v]fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
      `tpad=stop_mode=clone:stop=${(need / fps).toFixed(3)},trim=end_frame=${need},setpts=N/${fps}/TB[v${i}]`);
  });
  // xfade offset for join i = the span frames accumulated so far - the
  // tail the previous window generated plays UNDER the fade
  let accFrames = windowFrames(inputs[0].span, fps);
  let cur = "v0";
  for (let i = 1; i < inputs.length; i++) {
    const out = `x${i}`;
    parts.push(`[${cur}][v${i}]xfade=transition=fade:duration=${xfSec.toFixed(6)}:offset=${(accFrames / fps).toFixed(6)}[${out}]`);
    accFrames += windowFrames(inputs[i].span, fps);
    cur = out;
  }
  const totalSec = accFrames / fps;
  await ff([
    "-y",
    ...inputs.flatMap((inp) => ["-i", inp.file]),
    "-i", audioPath,
    "-filter_complex", parts.join(";"),
    "-map", `[${cur}]`, "-map", `${inputs.length}:a:0?`,
    "-t", totalSec.toFixed(6),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart", outPath,
  ], signal);
}

/** Merge a patch into jobs.provider_meta.person-swap - || on the person-swap subtree
 *  only, so unrelated keys (and other lanes' meta) are never clobbered. */
async function mergePersonSwapMeta(jobId: string, patch: Record<string, unknown>): Promise<void> {
  await sql(
    `UPDATE jobs SET provider_meta =
       jsonb_set(provider_meta, '{person_swap}',
         COALESCE(provider_meta->'person_swap', '{}'::jsonb) || $2::jsonb),
       updated_at = now()
     WHERE id = $1`,
    [jobId, JSON.stringify(patch)],
  ).catch(() => {});
}

/**
 * A batch identity (or extra clip) that doesn't fit the caller's free slots
 * is held server-side: a real charged queued job row with NO
 * provider_request_id. createJob counts it toward the user's live-job cap
 * like any queued job, and releasePersonSwapHolds submits it once a slot opens -
 * identities are never rejected for concurrency.
 */
export async function insertHeldPersonSwap(h: {
  userId: string; title: string; prompt: string; cost: number;
  visibility: string; params: Record<string, unknown>;
}): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  await sql(
    `INSERT INTO jobs (id, user_id, kind, model_id, endpoint_id, workflow, title, prompt,
                       params, inputs, provider, provider_meta, status, progress,
                       cost_credits, outputs, visibility, source)
     VALUES ($1,$2,'v2v','person_swap',$3,'swap',$4,$5,$6::jsonb,'[]'::jsonb,'recipe','{}'::jsonb,
             'queued',0,$7,'[]'::jsonb,$8,'ui')`,
    [id, h.userId, PERSON_SWAP_ENDPOINT, h.title, h.prompt, JSON.stringify(h.params), h.cost, h.visibility],
  );
  return { id };
}

/** Submit the oldest held person-swap jobs into free slots - called after a member
 *  finishes (recipe end + every person-swap poll). The row-level claim rides
 *  provider_meta.person_swap_claim - provider_request_id stays NULL until the
 *  provider submit has returned a real id, so a tick landing mid-release
 *  can't read the half-claimed row as a lost recipe run, and two releasers
 *  can't both submit (the claim UPDATE is exclusive). `exceptJobId` excludes
 *  one still-live row from the count - the finishing member calls this from
 *  its own finally, before its row is marked complete.
 *
 *  Clients: poll /api/person-swap/:id (or /api/person-swap) - those GETs re-run this
 *  release so the held chain advances. A generic /api/jobs/:id hook is a
 *  WS1 request; until it lands, polling the person-swap endpoints is the contract. */
export async function releasePersonSwapHolds(userId: string, exceptJobId?: string): Promise<number> {
  const prof = await sql<{ plan_id: string | null; boost_slots: number }>(
    `SELECT plan_id, boost_slots FROM profiles WHERE user_id = $1`, [userId]);
  const plan = planById(prof[0]?.plan_id);
  const limit = plan.parallelVideo + Number(prof[0]?.boost_slots ?? 0);
  const liveRows = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM jobs
      WHERE user_id = $1 AND status IN ('queued','in_progress') AND provider_request_id IS NOT NULL
        AND ($2::uuid IS NULL OR id <> $2)`,
    [userId, exceptJobId ?? null]);
  let free = Math.max(0, limit - Number(liveRows[0]?.n ?? 0));
  if (!free) return 0;
  const staleBefore = Math.floor(Date.now() / 1000) - 300; // crashed release → claim expires
  // a malformed (non-numeric) claim is stale - never wedges the row
  const staleClaim = `(provider_meta->>'person_swap_claim' IS NULL
       OR provider_meta->>'person_swap_claim' !~ '^\\d+(\\.\\d+)?$'
       OR (provider_meta->>'person_swap_claim')::double precision < $3)`;
  const held = await sql<{ id: string; params: Record<string, unknown>; cost_credits: string }>(
    `SELECT id, params, cost_credits FROM jobs
      WHERE user_id = $1 AND endpoint_id = $2 AND status = 'queued' AND provider_request_id IS NULL
        AND ${staleClaim}
      ORDER BY created_at`, [userId, PERSON_SWAP_ENDPOINT, staleBefore]);
  const consentCheck = likenessConsentCheck(PERSON_SWAP_ENDPOINT);
  let released = 0;
  for (const row of held) {
    if (free <= 0) break;
    const cost = Number(row.cost_credits) || 0;
    // a held row was charged without createJob's gates - re-check consent
    // before it can touch the GPU; on failure it fails and is refunded
    const denied = consentCheck(row.params ?? {});
    if (denied) {
      await sql(
        `UPDATE jobs SET status = 'failed', error = $2, completed_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'queued' AND provider_request_id IS NULL`,
        [row.id, denied]);
      if (cost > 0) await refundCredits(userId, cost, "job", row.id, `held release: ${denied}`).catch(() => {});
      continue;
    }
    const claimed = await sql<{ id: string }>(
      `UPDATE jobs SET provider_meta = provider_meta || $2::jsonb, updated_at = now()
        WHERE id = $1 AND status = 'queued' AND provider_request_id IS NULL
          AND ${staleClaim}
        RETURNING id`,
      [row.id, JSON.stringify({ person_swap_claim: Date.now() / 1000 }), staleBefore]);
    if (!claimed.length) continue;
    try {
      // a second releaser may have claimed or submitted a sibling while
      // this claim landed - re-count what the user's slots really carry
      // (submitted rows + fresh claims held by anyone else) before paying
      // a submit, so a 1-slot plan can never run 2 person-swaps at once
      const [{ n: liveNow }] = await sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM jobs
          WHERE user_id = $1 AND status IN ('queued','in_progress')
            AND (provider_request_id IS NOT NULL
                OR (endpoint_id = $2
                    AND provider_meta->>'person_swap_claim' ~ '^\\d+(\\.\\d+)?$'
                    AND (provider_meta->>'person_swap_claim')::double precision >= $3))
            AND id <> $4 AND ($5::uuid IS NULL OR id <> $5)`,
        [userId, PERSON_SWAP_ENDPOINT, staleBefore, row.id, exceptJobId ?? null]);
      if (limit - Number(liveNow) <= 0) {
        // hand the claim back - a later tick can pick the row again
        await sql(
          `UPDATE jobs SET provider_meta = provider_meta - 'person_swap_claim', updated_at = now()
           WHERE id = $1 AND status = 'queued' AND provider_request_id IS NULL`,
          [row.id]);
        break;
      }
      const wf = PERSON_SWAP.workflows[0];
      const sub = await getProvider("recipe").submit({
        jobId: row.id, model: PERSON_SWAP, workflow: wf, params: row.params, userId,
        appBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
      });
      await sql(
        `UPDATE jobs SET provider_request_id = $2,
           provider_meta = (provider_meta - 'person_swap_claim') || $3::jsonb, updated_at = now()
         WHERE id = $1`,
        [row.id, sub.providerJobId, JSON.stringify({ recipe: "person-swap", ...(sub.meta ?? {}) })]);
      free -= 1; released += 1;
    } catch (e) {
      await sql(
        `UPDATE jobs SET status = 'failed', error = $2,
           provider_meta = provider_meta - 'person_swap_claim', completed_at = now(), updated_at = now()
         WHERE id = $1`,
        [row.id, `held submit failed: ${(e as Error).message?.slice(0, 200)}`]);
      if (cost > 0) await refundCredits(userId, cost, "job", row.id, "held submit failed").catch(() => {});
    }
  }
  return released;
}

export const personSwapRecipe: RecipeFn = async (input, ctx) => {
  const params = resolveParams(input.params);

  // last-ditch consent gate - every entry path (batch holds, direct submits,
  // replays) funnels here; the source clip is itself a likeness input
  if (params.likeness_consent !== true) throw new Error("likeness consent required");

  // mode/quick/aspect/gallery/windows-billing are PersonSwap's own surface -
  // other endpoints routed here (wan-vace character-swap) run a pure
  // person-mode swap: the PersonSwap recipe but never PersonSwap's UI gates
  const personSwapSurface = isPersonSwap(input);
  const modeRaw = personSwapSurface ? String(params.mode ?? "person") : "person";
  if (!(PERSON_SWAP_MODES as readonly string[]).includes(modeRaw)) throw new Error(`unknown person-swap mode ${modeRaw}`);
  const mode = modeRaw as PersonSwapMode;
  const needsPerson = mode !== "environment";
  const needsEnv = mode !== "person";
  const lipSync = personSwapSurface && params.lip_sync !== false && needsPerson;
  const resolution = String(params.resolution ?? "480p");
  const windowsPaid = Math.min(Math.max(Number(params.windows) || 1, 1), 24);
  const quick = personSwapSurface && params.quick === true;
  // a draft is the cheap first-window preview the user approves before the
  // full render - drafts and approvals only exist on the PersonSwap surface
  const draft = personSwapSurface && params.draft === true;

  const owner = await jobOwner(input.jobId);
  if (!owner) throw new Error("person-swap: could not resolve the job owner");

  // draft approval - `draft_of` names the completed draft this run renders.
  // Same owner, same endpoint, completed, and flagged draft in provider_meta
  // - anything else (another user's, a non-draft, a live job) refuses before
  // any work. The approved id becomes the seed key: the final's windows
  // sample the same seeds the preview did, and the person matte recomputes
  // deterministically on the same frames (BiRefNet is a fixed function of
  // the input - "reusing the masks" is identical inputs, not a file hand-off).
  let seedKey = input.jobId;
  if (personSwapSurface && params.draft_of) {
    const draftId = String(params.draft_of);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(draftId)) throw new JobError("draft_of must name a completed Person Swap draft", 400);
    const rows = await sql<{ d: Record<string, unknown> | null }>(
      `SELECT provider_meta->'person_swap' AS d FROM jobs
        WHERE id = $1 AND user_id = $2 AND endpoint_id = $3 AND status = 'completed'`,
      [draftId, owner, PERSON_SWAP_ENDPOINT]);
    if (!rows.length || rows[0].d?.draft !== true)
      throw new JobError("draft_of must name a completed Person Swap draft", 400);
    seedKey = draftId;
  }

  // a gallery pick resolves server-side into the owner's uploads - the
  // client only ever sends the manifest id, never a path
  let videoUrl = String(params.video_url ?? "");
  if (!videoUrl && params.gallery_id && personSwapSurface)
    videoUrl = await resolvePersonSwapGalleryClip(owner, String(params.gallery_id));
  const imageUrls = Array.isArray(params.image_urls) ? params.image_urls.map(String).filter(Boolean).slice(0, PERSON_SWAP_MAX_REFS) : [];
  if (needsPerson && !imageUrls.length) throw new Error("person-swap: person/both needs at least one identity ref");
  if (quick && imageUrls.length !== 1) throw new Error("Quick person swap takes exactly one reference photo");

  const workDir = filePathFor(`/files/generated/.person-swap/${input.jobId}/`)
    ?? path.join(process.cwd(), "public", "files", "generated", ".person-swap", input.jobId);
  await fs.mkdir(workDir, { recursive: true });
  const genUrl = (name: string) => `/files/generated/.person-swap/${input.jobId}/${name}`;
  const workFile = (name: string) => path.join(workDir, name);

  const uploadPath = await resolveOwnedMedia(owner, videoUrl);
  for (const u of imageUrls) await resolveOwnedMedia(owner, u);
  let srcPath = uploadPath;
  let probe: ProbeInfo = await probeVideo(srcPath);
  const maxS = quick ? PERSON_SWAP_QUICK_MAX_S : PERSON_SWAP_MAX_S;
  if (probe.durationSec < PERSON_SWAP_MIN_S || probe.durationSec > maxS)
    throw new Error(`clip must be ${PERSON_SWAP_MIN_S}-${maxS} s (got ${probe.durationSec.toFixed(1)} s)`);

  // Quick aspect - centre-crop the clip to the picked ratio before the
  // swap ("crops your clip"); gen box, windows and assembly then all land
  // on the cropped frame. audioPath stays the uploaded file so assembly
  // and the lip pass re-mux the ORIGINAL soundtrack.
  const aspect = personSwapSurface ? String(params.aspect ?? "source") : "source";
  if (aspect === "9:16" || aspect === "16:9") {
    const tAR = aspect === "9:16" ? 9 / 16 : 16 / 9;
    const inAR = probe.width / probe.height;
    if (Math.abs(inAR - tAR) > 0.02) {
      const [cw, ch] = inAR > tAR
        ? [even(probe.height * tAR), even(probe.height)]
        : [even(probe.width), even(probe.width / tAR)];
      const cropped = workFile("src-aspect.mp4");
      await ff([
        "-y", "-i", srcPath, "-vf", `crop=${cw}:${ch}`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-c:a", "copy", cropped,
      ], ctx.signal);
      srcPath = cropped;
      probe = await probeVideo(srcPath);
    }
  }

  const runs = personSwapWindows(probe.durationSec);
  // honor the billed window count before any GPU work - off the PersonSwap
  // endpoint `windows` is unmetered (the character-swap surface bills a
  // flat credit cost, so the computed window count just runs). A draft is
  // billed as one window and only ever renders the first - the check is
  // meaningless for it.
  if (personSwapSurface && !draft && runs.length > windowsPaid)
    throw new Error(`clip needs ${runs.length} generation windows - paid for ${windowsPaid}`);
  // the windows this run actually generates - a draft only ever renders the
  // first as the preview; the approved final re-runs all of them
  const runSpans = draft ? runs.slice(0, 1) : runs;

  // the generation box the provider's aspect_ratio+resolution placeholders
  // resolve to - window cuts are transcoded to exactly this
  const ar = chooseAspect(probe.width, probe.height);
  const [dw, dh] = personSwapGenBox(probe.width, probe.height, resolution);

  const prompt = String(params.prompt ?? "").trim();
  const envPromptParam = String(params.env_prompt ?? "").trim();
  const personPrompt = prompt
    || "the person in the reference photos, same pose and motion, seamlessly in the scene";
  // "both" splits the fields - prompt describes the person, env_prompt the
  // setting; a bare environment run keeps accepting prompt for compat
  const envPrompt = envPromptParam || (mode === "environment" ? prompt : "")
    || "a new cinematic setting around the person, consistent lighting and color";
  const negative = "blurry, distorted face, extra limbs, flicker, watermark, text";

  const stepsN = Number.isFinite(Number(params.steps)) && params.steps !== undefined && params.steps !== null && params.steps !== ""
    ? Math.min(50, Math.max(2, Math.trunc(Number(params.steps))))
    : personSwapLocalSteps();
  // the draft trades fidelity for speed - low steps on the same seed/mask,
  // enough to judge identity + matte before paying for the full render
  const effSteps = draft ? Math.min(stepsN, PERSON_SWAP_DRAFT_STEPS) : stepsN;

  // step wall-clock estimates → the stall guard and per-step cap. Honest
  // measured rates (see swap.ts): each pass gets its own per-second number -
  // a person window is ~4× an environment one.
  const windowEstMs = (span: ShotSpan, pass: "person" | "environment") =>
    Math.max(60_000, personSwapWindowPassMin(probe.width, probe.height, span.end - span.start, pass, resolution) * 60_000);
  const lipEstMs = Math.max(60_000, probe.durationSec * PERSON_SWAP_LIP_MIN_PER_SEC * 60_000);

  // matte preflight (every mode - the env strip is the person gate too)
  // + one ref cut-out per identity ref + N windows × passes + lip restore
  const totalSteps = 1 + (needsPerson ? imageUrls.length : 0)
    + runSpans.length * (mode === "both" ? 2 : 1) + (lipSync && probe.hasAudio && !draft ? 1 : 0);
  let doneSteps = 0;
  const report = (stage: string) => ctx.progress(Math.min(96, 2 + (doneSteps / (totalSteps + 1)) * 94), stage);
  const onStep = () => {
    // the provider restarts progress per Comfy node - a step's fraction
    // must never report backwards, so clamp to the peak it has shown
    let peak = 0;
    return (f: number) => {
      peak = Math.max(peak, f);
      ctx.progress(Math.min(96, 2 + ((doneSteps + peak) / (totalSteps + 1)) * 94));
    };
  };

  await mergePersonSwapMeta(input.jobId, {
    windows: runSpans.length, gen_box: `${dw}×${dh}`, steps: effSteps,
    endpoint: input.workflow.endpointId,
    ...(draft ? { draft: true, draft_steps: effSteps } : {}),
    ...(seedKey !== input.jobId ? { draft_of: seedKey } : {}),
  });

  const provider = getProvider();
  /** Cancel-before-save: ctx.signal fires inside a step's poll, but the
   *  pipeline can also land between the last poll and the publish - a
   *  DELETE mid-run (status flips to 'canceled', the job row may even be
   *  gone) must stop the recipe from writing an output or reporting done.
   *  Re-read the row's status at the publish boundaries. */
  const assertLive = async () => {
    const rows = await sql<{ status: string }>(
      `SELECT status FROM jobs WHERE id = $1`, [input.jobId]).catch(() => [] as { status: string }[]);
    if (!rows.length || !["queued", "in_progress"].includes(rows[0].status))
      throw new Error("canceled");
  };
  let finalUrl: string;
  let facePct: number | null = null;
  const wallS: number[] = [];
  // provider-side artifacts (comfy output files / mock renders) - deleted once
  // consumed so generated/ only holds the final asset + .person-swap evidence
  const providerFiles: string[] = [];
  const dropLater = (u?: string | null) => { const fp = u ? filePathFor(u) : null; if (fp) providerFiles.push(fp); };
  try {
    // cheap matte+face pass over the whole clip - refuse before burning a
    // VACE window on footage the detector never finds a person in. Every
    // mode gates on this strip: for person/both it also feeds the lip
    // face gate; for environment it is the "performer to keep" check.
    {
      report("matte preflight");
      // the preflight reads the clip the windows read - when an aspect crop
      // ran above, the cropped file is the real source, not the upload
      const croppedSrc = srcPath !== uploadPath;
      const preflightUrl = croppedSrc ? genUrl("src-aspect.mp4") : videoUrl;
      await mergePersonSwapMeta(input.jobId, { preflight_src: preflightUrl });
      const items = await runStep(provider, input, MATTE_WF, {
        video_url: preflightUrl,
        mask_w: probe.height > probe.width ? "512" : "0",
        mask_h: probe.height > probe.width ? "0" : "512",
        mask_force: probe.height > probe.width ? "Custom Width" : "Custom Height",
        evidence_frame: Math.max(0, Math.floor(Math.min(90, Math.round(probe.durationSec * 2)) / 2)),
      }, "matte", ctx, onStep(), 90_000);
      const ev = await classifyEvidence(items);
      const cov = ev.strip ? await stripCoverage(ev.strip) : null;
      const matteUrl = await keepEvidence(ev.matte, workDir, "matte-preflight.png");
      await keepEvidence(ev.strip, workDir, "cov-preflight.png");
      // the saved matte rides provider_meta so the page can show it -
      // the draft review and the run row both link the same evidence file
      await mergePersonSwapMeta(input.jobId, {
        matte: matteUrl,
        coverage: cov ? { person_mean: mean(cov.person), face_pct: cov.face ? cov.face.filter((c) => c > 0).length / cov.face.length : null } : null,
      });
      // the mock provider returns no strip - "no signal" is fine there; a
      // real run without coverage evidence must not burn a window blind
      if (!cov?.person.length) {
        if (provider.name !== "mock")
          throw new Error("matte preflight returned no coverage strip - refusing to run blind");
      } else if (mean(cov.person) < PERSON_SWAP_MIN_MATTE) {
        const msg = needsPerson
          ? `person not confidently found - mean matte coverage ${pct(mean(cov.person))} < ${pct(PERSON_SWAP_MIN_MATTE)}`
          : `environment mode keeps the performer - no person found on the coverage strip (mean matte coverage ${pct(mean(cov.person))} < ${pct(PERSON_SWAP_MIN_MATTE)})`;
        throw new Error(msg + (matteUrl ? ` (matte evidence ${matteUrl})` : ""));
      }
      if (cov?.face?.length) facePct = cov.face.filter((c) => c > 0).length / cov.face.length;
      doneSteps += 1;
    }

    if (needsPerson) {
      // identity refs - a white-background cut-out keys VACE's reference
      // encoder far better than a busy scene photo. Every submitted ref
      // (≤8) gets the cut-out pass; the person graph then takes the best
      // 3 by matte coverage (a full-face matte keys the encoder best).
      const scored: { url: string; cov: number | null }[] = [];
      for (const [ri, ru] of imageUrls.entries()) {
        report(`identity ref ${ri + 1}/${imageUrls.length} - cut-out`);
        const rItems = await runStep(provider, input, REFCUT_WF,
          { image_url: ru }, `refcut${ri}`, ctx, onStep(), 30_000);
        const ev = await classifyEvidence(rItems);
        const cov = ev.strip ? await stripCoverage(ev.strip) : null;
        await keepEvidence(ev.strip, workDir, `cov-ref${ri}.png`);
        // on the refcut graph the non-strip image IS the cut-out
        const cut = ev.matte ?? imageItem(rItems, `identity ref ${ri + 1} cut-out`);
        dropLater(cut);
        scored.push({ url: cut, cov: cov?.person?.[0] ?? null });
        doneSteps += 1;
      }
      const anyCov = scored.some((s) => s.cov !== null);
      const picked = (anyCov
        ? [...scored].sort((a, b) => (b.cov ?? 0) - (a.cov ?? 0))
        : scored // a strip-less provider (mock) keeps the caller's order
      ).slice(0, 3);
      imageUrls.splice(0, imageUrls.length, ...picked.map((s) => s.url));
    }

    const windowOuts: { file: string; span: ShotSpan }[] = [];
    for (let i = 0; i < runSpans.length; i++) {
      const span = runSpans[i];
      // the window generates 8 source frames past its span so assembly can
      // cross-fade the join instead of cutting - the last window has no
      // next join, and the tail never runs past the clip's end. A draft's
      // single window never joins - no tail to pay for either.
      const tail = i < runSpans.length - 1 ? PERSON_SWAP_XFADE_FRAMES / probe.fps : 0;
      const cutSpan: ShotSpan = { start: span.start, end: Math.min(span.end + tail, probe.durationSec) };
      const cutPath = workFile(`cut-${i}.mp4`);
      const t0 = Date.now();
      report(`window ${i + 1}/${runSpans.length} - cutting`);
      await cutSegment(srcPath, cutPath, cutSpan, dw, dh, ctx.signal);
      let current = genUrl(`cut-${i}.mp4`);
      try {
        if (needsPerson) {
          let items: ProviderOutputItem[];
          try {
            items = await runStep(provider, input, PERSON_WF, {
              video_url: current, image_urls: imageUrls,
              prompt: personPrompt, negative_prompt: negative,
              aspect_ratio: ar, resolution,
              duration: windowDur(cutSpan), fps: RE_EDIT_GEN_FPS, steps: effSteps,
              seed: seedFor(seedKey, 0, 1),
            }, `w${i}p`, ctx, onStep(), windowEstMs(cutSpan, "person"));
          } catch (e) {
            if (e instanceof StallError) throw new StallError(`window ${i + 1} stalled`);
            throw new Error(`window ${i + 1} failed: ${(e as Error).message}`);
          }
          const ev = await classifyEvidence(items);
          const cov = ev.strip ? await stripCoverage(ev.strip) : null;
          const matte = await keepEvidence(ev.matte, workDir, `matte-w${i}.png`);
          await keepEvidence(ev.strip, workDir, `cov-w${i}.png`);
          // the applied window-0 matte is the mask the review UI shows -
          // grown + feathered inside the graph, this is what actually gated
          // the VACE region on the preview the user approves
          if (i === 0) await mergePersonSwapMeta(input.jobId, { mask: matte });
          if (!cov?.person.length) {
            if (provider.name !== "mock")
              throw new Error(`window ${i + 1} failed: no matte coverage strip`);
          } else if (mean(cov.person) < PERSON_SWAP_MIN_MATTE)
            throw new Error(`window ${i + 1} failed: person not confidently found - mean matte coverage ${pct(mean(cov.person))} < ${pct(PERSON_SWAP_MIN_MATTE)}` +
              (matte ? ` (matte evidence ${matte})` : ""));
          current = videoItem(items, `window ${i + 1} person pass`);
          doneSteps += 1;
        }

        if (needsEnv) {
          let items: ProviderOutputItem[];
          try {
            items = await runStep(provider, input, ENV_WF, {
              video_url: current,
              // in pure environment mode image_urls is the optional setting ref;
              // in 'both' it already conditioned the person pass
              image_urls: mode === "environment" ? imageUrls.slice(0, 1) : [],
              prompt: envPrompt, negative_prompt: negative,
              aspect_ratio: ar, resolution,
              duration: windowDur(cutSpan), fps: RE_EDIT_GEN_FPS, steps: effSteps,
              seed: seedFor(seedKey, 0, 2),
            }, `w${i}e`, ctx, onStep(), windowEstMs(cutSpan, "environment"));
          } catch (e) {
            if (e instanceof StallError) throw new StallError(`window ${i + 1} stalled`);
            throw new Error(`window ${i + 1} failed: ${(e as Error).message}`);
          }
          const ev = await classifyEvidence(items);
          const cov = ev.strip ? await stripCoverage(ev.strip) : null;
          const matte = await keepEvidence(ev.matte, workDir, `matte-env-w${i}.png`);
          await keepEvidence(ev.strip, workDir, `cov-env-w${i}.png`);
          if (i === 0) await mergePersonSwapMeta(input.jobId, { mask: matte });
          // the performer has to be on the frame for the invert-matte pass
          // to preserve - gate on the env strip exactly like the person
          // pass does (off mock, a personless window refuses loudly)
          if (!cov?.person.length) {
            if (provider.name !== "mock")
              throw new Error(`window ${i + 1} failed: no person-coverage strip`);
          } else if (mean(cov.person) < PERSON_SWAP_MIN_MATTE)
            throw new Error(`window ${i + 1} failed: person not confidently found - mean matte coverage ${pct(mean(cov.person))} < ${pct(PERSON_SWAP_MIN_MATTE)}` +
              (matte ? ` (matte evidence ${matte})` : ""));
          current = videoItem(items, `window ${i + 1} environment pass`);
          doneSteps += 1;
        }
      } finally {
        await fs.rm(cutPath, { force: true }).catch(() => {});
      }

      const fp = filePathFor(current);
      if (!fp) throw new Error(`person-swap window ${i + 1}: output outside generated storage`);
      const keep = workFile(`window-${i}.mp4`);
      // The cut padded the source into the gen box and the window output
      // carries those bars - crop back to the EXACT content rect the
      // cut's scale+pad produced (decrease-fit dims via av_rescale
      // rounding, centred pad offsets truncated toward zero - verified
      // against ffmpeg's own output). Rounding the offset to even, as an
      // earlier version did, lets a pad row or column ride into the
      // assembly and show as a dark edge seam. Odd rects survive via the
      // 444 hop; nothing is lost and nothing is stretched.
      const winP = await probeVideo(fp);
      const inAR = probe.width / probe.height;
      const [cw, ch] = (winP.width / winP.height) > inAR
        ? [Math.round(winP.height * inAR), winP.height]
        : [winP.width, Math.round(winP.width / inAR)];
      // Two dark lines ride in from outside the content rect: the pad
      // band's first content line blends bar-black on each padded side,
      // and VACE leaves a dark line on the top edge even with no pad.
      // Inset the crop on every padded side plus PERSON_SWAP_TOP_INSET off the
      // top, then scale back - sub-1% stretch, every window re-encodes,
      // no seam line enters the frame.
      const ix = winP.width > cw ? 2 : 0;
      const iy = winP.height > ch ? 2 : 0;
      const cx = Math.floor((winP.width - cw) / 2) + ix;
      const cy = Math.floor((winP.height - ch) / 2) + iy + PERSON_SWAP_TOP_INSET;
      await ff([
        "-y", "-i", fp,
        "-vf", `format=yuv444p,crop=${Math.max(2, cw - 2 * ix)}:${Math.max(2, ch - 2 * iy - PERSON_SWAP_TOP_INSET)}:${cx}:${cy},scale=${cw}:${ch}:flags=lanczos`,
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv444p", "-crf", "18", keep,
      ], ctx.signal);
      dropLater(current);
      windowOuts.push({ file: keep, span });
      wallS.push((Date.now() - t0) / 1000);
      await mergePersonSwapMeta(input.jobId, { window_wall_s: wallS });
    }

    report("assembling");
    await assertLive(); // a DELETE during the windows still stops the publish
    const assembled = workFile("assembled.mp4");
    await assemblePersonSwap(windowOuts, probe, uploadPath, assembled, ctx.signal);
    finalUrl = genUrl("assembled.mp4");

    // lip restore - only with audio AND a face on ≥50% of preflight frames.
    // A strip-less provider (mock) can't measure a face - don't block on that.
    let lip: string | null = null;
    if (!needsPerson) lip = "lip restore skipped: environment mode";
    else if (draft) lip = "lip restore skipped: draft";
    else if (!probe.hasAudio) lip = "lip restore skipped: no audio";
    else if (params.lip_sync === false) lip = "lip restore skipped: off";
    else if (facePct !== null && facePct < PERSON_SWAP_LIP_FACE_MIN) lip = `lip restore skipped: no face (${pct(facePct)})`;
    if (lip === null) {
      report("lip restore");
      try {
        const wavPath = workFile("track.wav");
        await ff(["-i", uploadPath, "-vn", "-ac", "1", "-ar", "16000", "-y", wavPath], ctx.signal);
        const lipWf = findEndpoint("motionfield/musetalk/lip-sync-video");
        if (!lipWf) throw new Error("lip-sync endpoint not in catalog");
        const items = await runStep(provider, { ...input, model: lipWf.model }, lipWf.workflow, {
          video_url: finalUrl, audio_url: genUrl("track.wav"),
          likeness_consent: params.likeness_consent === true,
          bbox_shift: 0,
        }, "lip", ctx, onStep(), lipEstMs);
        const lipUrl = videoItem(items, "lip restore");
        // move into the job dir first - provider files are wiped in finally,
        // before the save below reads the result
        const lipFp = filePathFor(lipUrl);
        if (!lipFp) throw new Error("lip output outside generated storage");
        await fs.copyFile(lipFp, workFile("lip-raw.mp4"));
        dropLater(lipUrl);
        // MuseTalk returns the whole clip it was fed - conform to the source
        // frame, trim back to the source duration and re-mux the ORIGINAL
        // audio stream (the mono wav sent to the pass is a working copy,
        // not the soundtrack)
        await ff([
          "-y", "-i", workFile("lip-raw.mp4"), "-i", uploadPath,
          "-filter_complex",
          `[0:v]fps=${probe.fps},scale=${even(probe.width)}:${even(probe.height)}:` +
          `force_original_aspect_ratio=decrease,pad=${even(probe.width)}:${even(probe.height)}:` +
          `(ow-iw)/2:(oh-ih)/2,setsar=1[lv]`,
          "-map", "[lv]", "-map", "1:a:0?", "-t", probe.durationSec.toFixed(6),
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
          "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", workFile("lip.mp4"),
        ], ctx.signal);
        await fs.rm(workFile("lip-raw.mp4"), { force: true }).catch(() => {});
        finalUrl = genUrl("lip.mp4");
        lip = "restored";
        doneSteps += 1;
      } catch (e) {
        lip = `lip restore failed: ${(e as Error).message?.slice(0, 200)}`;
      }
    }
    await mergePersonSwapMeta(input.jobId, { lip });
  } finally {
    for (let i = 0; i < runSpans.length; i++)
      await fs.rm(workFile(`window-${i}.mp4`), { force: true }).catch(() => {});
    for (const fp of providerFiles) await fs.rm(fp, { force: true }).catch(() => {});
    // members held behind this one get their slot the moment it frees -
    // this row still counts as live until the tick lands, so exclude it
    if (owner) await releasePersonSwapHolds(owner, input.jobId).catch(() => {});
  }

  // last cancel check before the published file exists - a DELETE that
  // landed during assembly/lip leaves no person-swap-<id>-*.mp4 behind
  await assertLive();
  const outFp = filePathFor(finalUrl);
  if (!outFp) throw new Error("person-swap: final output outside generated storage");
  const outProbe = await probeVideo(outFp).catch(() => null);
  const buf = await fs.readFile(outFp);
  const url = await saveBytes(`generated/person-swap-${input.jobId}-${crypto.randomUUID().slice(0, 8)}.mp4`, buf);
  // a cropped source stays behind for the page's before/after - the
  // comparison must read what the model actually saw, not the raw upload
  const compareSrc = srcPath !== uploadPath ? genUrl("src-aspect.mp4") : null;
  // the evidence dir keeps only matte/strip evidence + the compare clip -
  // the pipeline intermediates are gone with the run
  if (!compareSrc) await fs.rm(workFile("src-aspect.mp4"), { force: true }).catch(() => {});
  await fs.rm(workFile("assembled.mp4"), { force: true }).catch(() => {});
  await fs.rm(workFile("track.wav"), { force: true }).catch(() => {});
  await fs.rm(workFile("lip-raw.mp4"), { force: true }).catch(() => {});
  await fs.rm(workFile("lip.mp4"), { force: true }).catch(() => {});
  // createJob rewrites provider_meta after submit returns - if that landed
  // after the first merge, the headline fields were lost; re-merge at the end
  await mergePersonSwapMeta(input.jobId, {
    windows: runSpans.length, gen_box: `${dw}×${dh}`, steps: effSteps,
    ...(draft ? { draft: true, draft_steps: effSteps } : {}),
    ...(seedKey !== input.jobId ? { draft_of: seedKey } : {}),
    ...(compareSrc ? { compare_src: compareSrc } : {}),
  });
  return [{
    type: "video",
    url,
    width: outProbe?.width ?? probe.width, height: outProbe?.height ?? probe.height,
    duration: outProbe?.durationSec ?? probe.durationSec,
  }];
};
