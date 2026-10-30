/**
 * ReCut v2 - one MotionField job per edit.
 *
 * The chain row (re_edit_chains) is the source of truth for the edit's shots,
 * per-shot generation windows and window outputs. The actual GPU work runs
 * inside a single re-edit-assemble recipe job (see
 * src/lib/generation/recipes/re-edit-assemble.ts) so the run respects the
 * plan's one-active-job gate - no child jobs.
 *
 *   POST /api/re-edit                    startChain    → chain + job
 *   POST /api/re-edit/detect             detectVideo   → shots only
 *   GET  /api/re-edit/[id]               getChain      → chain + jobs + shot states
 *   POST /api/re-edit/[id]/shots/[index] regenerateShot→ atomically claims the
 *                                                     chain and runs only that
 *                                                     shot's windows
 *   DELETE /api/re-edit/[id]             cancelChain   → cancels the live job
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { getDb, schema, sql } from "@/db";
import { createJob, cancelJob, tickJob, JobError } from "@/lib/jobs";
import { resolveOwnedMedia } from "@/lib/media-owned";
import { findWorkflow } from "@/lib/catalog/video-models";
import { RE_EDIT_FLOWS, RESTYLE_PRESET_IDS, type ReEditFlow } from "@/lib/catalog/video/swap";
import {
  probeVideo, detectCuts, buildShots,
  RE_EDIT_MIN_S, RE_EDIT_MAX_S,
  type ProbeInfo, type ShotSpec,
} from "@/lib/re-edit-ffmpeg";

export const RE_EDIT_ENDPOINT = "motionfield/re-edit/v1.0";
export { RE_EDIT_FLOWS, RESTYLE_PRESET_IDS };
export type { ReEditFlow };

/** image_urls cap per flow - matches the catalog's honest maxItems (A7). */
export const RE_EDIT_IMAGE_CAP: Record<ReEditFlow, number> = {
  "character-swap": 3,
  "motion-transfer": 1,
  "restyle": 1,
};

/** One generation window's stored output url (null while it has none). */
export type ShotOutput = { index: number; urls: (string | null)[] };

/* jsonb columns are untyped at the driver level - parse, never cast. A row
   that fails the shape was not written by this pipeline; treat as empty. */
const ShotSpanZ = z.object({ start: z.number(), end: z.number() });
const ShotSpecZ = ShotSpanZ.extend({
  index: z.number().int().nonnegative(),
  hint: z.string().optional(),
  windows: z.array(ShotSpanZ).default([]),
});
const ShotOutputZ = z.object({
  index: z.number().int().nonnegative(),
  urls: z.array(z.string().nullable()).default([]),
});
export const parseShots = (v: unknown): ShotSpec[] => {
  const p = z.array(ShotSpecZ).safeParse(v);
  return p.success ? p.data : [];
};
export const parseShotOutputs = (v: unknown): ShotOutput[] => {
  const p = z.array(ShotOutputZ).safeParse(v);
  return p.success ? p.data : [];
};
export type ReEditChainRow = typeof schema.reEditChains.$inferSelect;
export type JobRow = typeof schema.jobs.$inferSelect;
/** Raw `SELECT *` row from jobs - column names stay snake_case at the driver
 *  level, jsonb params come back untyped, timestamps arrive as Date|string. */
export type ChainJobRow = {
  id: string;
  user_id: string;
  status: string;
  progress: number;
  error: string | null;
  params: Record<string, unknown> | null;
  created_at: string | Date;
  completed_at: string | Date | null;
};
export type { ShotSpec, ProbeInfo };

export const flowEndpoint = (flow: ReEditFlow) => {
  const wf = findWorkflow("wan-vace", flow);
  if (!wf) throw new JobError(`unknown re-edit flow ${flow}`);
  return wf.endpointId!;
};

/** The public job shape the re-edit API returns - the raw row also carries
 *  user_id, params and provider ids the chain API doesn't expose. */
export function publicJob(job: Pick<JobRow, "id" | "status" | "progress" | "error" | "createdAt">) {
  return { id: job.id, status: job.status, progress: job.progress, error: job.error, created_at: job.createdAt };
}

/** Probe a reference edit and split it into shots + generation windows. */
export async function detectVideo(file: string, hints?: string[]):
  Promise<{ probe: ProbeInfo; shots: ShotSpec[] }> {
  // a non-video or unreadable file is a bad request, not a server error -
  // fixed client-facing text; the ffprobe detail (which contains the server
  // path) stays in the log
  const probe = await probeVideo(file).catch((e) => {
    console.warn(`re-edit: probe failed - ${String((e as Error).message ?? e).slice(0, 300)}`);
    throw new JobError("unreadable video - upload a readable mp4/webm/mov", 400);
  });
  if (probe.durationSec < RE_EDIT_MIN_S || probe.durationSec > RE_EDIT_MAX_S)
    throw new JobError(`reference edit must be ${RE_EDIT_MIN_S}-${RE_EDIT_MAX_S} s (got ${probe.durationSec.toFixed(1)} s)`);
  const cuts = await detectCuts(file);
  const shots = buildShots(cuts, probe.durationSec);
  hints?.forEach((h, i) => { if (shots[i] && h.trim()) shots[i].hint = h.trim(); });
  return { probe, shots };
}

const windowCount = (shots: ShotSpec[]) => shots.reduce((a, s) => a + s.windows.length, 0);

export interface StartInput {
  videoUrl: string;
  flow: ReEditFlow;
  imageUrls: string[];
  instructions?: string | null;
  hints?: string[];
  presetId?: string | null;
  resolution: string;
  /** the caller's likeness-consent assertion - carried into every window
   *  job so createJob's consent gate sees it (docs/POLICY.md) */
  likenessConsent?: boolean;
  /** declared catalog param (2-50); only forwarded when given */
  steps?: number;
}

/** API shape for a chain - snake_case, consistent with the rest of the API. */
export function chainView(row: ReEditChainRow) {
  return {
    id: row.id,
    user_id: row.userId,
    video_url: row.videoUrl,
    flow: row.flow,
    instructions: row.instructions,
    image_urls: row.imageUrls,
    preset_id: row.presetId,
    shots: row.shots,
    shot_outputs: row.shotOutputs,
    status: row.status,
    result_url: row.resultUrl,
    error: row.error,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export async function startChain(userId: string, input: StartInput) {
  const file = await resolveOwnedMedia(userId, input.videoUrl);
  for (const u of input.imageUrls) await resolveOwnedMedia(userId, u);
  const { shots } = await detectVideo(file, input.hints);
  const windows = windowCount(shots);
  const id = randomUUID();
  const db = await getDb();
  await db.insert(schema.reEditChains).values({
    id, userId,
    videoUrl: input.videoUrl,
    flow: input.flow,
    instructions: input.instructions ?? null,
    imageUrls: input.imageUrls,
    presetId: input.presetId ?? null,
    shots,
    shotOutputs: [],
    status: "queued",
  });
  // capture the queued row up front - the recipe claims the chain to
  // 'running' as soon as it starts, so a post-createJob read races
  const [chain] = await db.select().from(schema.reEditChains)
    .where(eq(schema.reEditChains.id, id)).limit(1);
  try {
    const job = await createJob(userId, {
      endpointId: RE_EDIT_ENDPOINT,
      title: `ReCut - ${windows} window${windows === 1 ? "" : "s"}`,
      params: {
        chain_id: id,
        windows,
        flow: input.flow,
        resolution: input.resolution,
        video_url: input.videoUrl,
        image_urls: input.imageUrls,
        likeness_consent: input.likenessConsent === true,
        instructions: input.instructions ?? "",
        preset_id: input.presetId ?? undefined,
        ...(input.steps !== undefined ? { steps: input.steps } : {}),
      },
    });
    return { chain: chainView(chain!), job };
  } catch (e) {
    await db.update(schema.reEditChains)
      .set({ status: "failed", error: String((e as Error).message ?? e).slice(0, 500), updatedAt: new Date() })
      .where(eq(schema.reEditChains.id, id));
    throw e;
  }
}

export async function loadChain(id: string): Promise<ReEditChainRow | null> {
  const db = await getDb();
  const [row] = await db.select().from(schema.reEditChains)
    .where(eq(schema.reEditChains.id, id)).limit(1);
  return row ?? null;
}

export async function chainJobs(id: string, userId: string): Promise<ChainJobRow[]> {
  return sql<ChainJobRow>(
    `SELECT * FROM jobs WHERE params->>'chain_id' = $1 AND user_id = $2 ORDER BY created_at ASC`,
    [id, userId]);
}

/** Recipe-side mutual exclusion: the run's job claims the chain for its
 *  owner - only a queued or already-running chain may be claimed, so a
 *  completed/failed/canceled chain can never be rewritten by a bare job. */
export async function claimChainRun(id: string, userId: string): Promise<boolean> {
  const claimed = await sql<{ id: string }>(
    `UPDATE re_edit_chains SET status = 'running', updated_at = now()
     WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'running') RETURNING id`,
    [id, userId]);
  return claimed.length > 0;
}

/** Another live job holding this chain, if any. Each sibling gets one tick
 *  first so a lost run's dead row doesn't block a real claim forever. */
export async function otherLiveChainJob(id: string, userId: string, selfJobId: string): Promise<ChainJobRow | null> {
  const others = (await chainJobs(id, userId)).filter((j) => j.id !== selfJobId);
  for (const j of others)
    if (j.status === "queued" || j.status === "in_progress")
      await tickJob(j.id).catch(() => { /* best-effort tick */ });
  return (await chainJobs(id, userId))
    .find((j) => j.id !== selfJobId && (j.status === "queued" || j.status === "in_progress")) ?? null;
}

/** Per-shot status for the UI: completed when every window has an output,
 *  the first unfinished shot is the one that's running (or the one that
 *  failed, for a failed chain). While a regenerate job is live, its target
 *  shot reports "running" even though its old outputs still exist - the
 *  other shots keep their real state. */
export function shotStates(chain: ReEditChainRow, liveRegenIndex: number | null = null): ("pending" | "running" | "completed" | "failed")[] {
  const shots = parseShots(chain.shots);
  const outs = new Map(parseShotOutputs(chain.shotOutputs).map((o) => [o.index, o.urls]));
  let inFlight = true;
  return shots.map((shot) => {
    if (liveRegenIndex !== null && shot.index === liveRegenIndex) return "running";
    const urls = outs.get(shot.index) ?? [];
    const done = shot.windows.filter((_, i) => Boolean(urls[i])).length;
    if (done === shot.windows.length) return "completed";
    if (chain.status === "completed") return "failed";
    const was = inFlight;
    inFlight = false;
    if (chain.status === "failed" && was) return "failed";
    if ((chain.status === "running" || chain.status === "assembling" || chain.status === "queued") && was)
      return liveRegenIndex === null ? "running" : "pending";
    return "pending";
  });
}

export async function getChain(userId: string, id: string) {
  const chain = await loadChain(id);
  if (!chain || chain.userId !== userId) return null;
  const jobs = await chainJobs(id, userId);
  // opportunistic tick so the job rows reflect recipe progress/final state
  for (const j of jobs) {
    if (j.status === "queued" || j.status === "in_progress") {
      try { await tickJob(j.id); } catch { /* tick is best-effort */ }
    }
  }
  const fresh = jobs.some((j) => j.status === "queued" || j.status === "in_progress")
    ? await chainJobs(id, userId) : jobs;
  // a live-looking chain with no live job means the run was lost (restart,
  // crashed recipe) - reconcile to failed so Regenerate can claim it again.
  // The guard against claiming a *just-started* chain: a real claim writes
  // updated_at = now() while every existing job finished long ago, so
  // "updated_at newer than the newest completed_at" marks regenerateShot's
  // claim→createJob gap. A chain with zero jobs at all is inside
  // startChain's insert→createJob (or insertChain→linkChainJob) gap - a
  // minute-old one of those is genuinely lost.
  const newestDoneAt = fresh.reduce((m, j) => {
    const t = j.completed_at ? new Date(j.completed_at).getTime() : 0;
    return Number.isFinite(t) && t > m ? t : m;
  }, 0);
  const updatedMs = new Date(chain.updatedAt).getTime();
  const freshClaim = Date.now() - updatedMs < 60_000
    && (fresh.length === 0 || updatedMs > newestDoneAt);
  if (!freshClaim && ["queued", "running", "assembling"].includes(chain.status)
      && !fresh.some((j) => j.status === "queued" || j.status === "in_progress")) {
    const lastErr = fresh[fresh.length - 1]?.error;
    await sql(
      `UPDATE re_edit_chains SET status = 'failed', error = $2, updated_at = now()
       WHERE id = $1 AND status IN ('queued', 'running', 'assembling')`,
      [id, String(lastErr ?? "run ended without a result").slice(0, 500)]);
    const reconciled = await loadChain(id);
    if (reconciled) return { chain: chainView(reconciled), jobs: fresh, shotStatus: shotStates(reconciled) };
  }
  // a live job carrying regenerate_index drives that shot's status chip
  const liveRegen = fresh.find((j) =>
    (j.status === "queued" || j.status === "in_progress")
    && j.params?.regenerate_index !== undefined
    && j.params?.regenerate_index !== null);
  const regenIdx = liveRegen ? Number(liveRegen.params?.regenerate_index) : null;
  return { chain: chainView(chain), jobs: fresh, shotStatus: shotStates(chain, Number.isInteger(regenIdx) ? regenIdx : null) };
}

/**
 * Regenerate one shot. Atomic claim: only a completed|failed|canceled chain
 * may move back to running - two concurrent POSTs can't both win. If the
 * job can't be created (402/429/…), the claim is rolled back so the chain
 * isn't stuck 'running' with no job behind it.
 */
export async function regenerateShot(userId: string, chainId: string, index: number, hint?: string) {
  const chain = await loadChain(chainId);
  if (!chain || chain.userId !== userId) throw new JobError("not found", 404);
  const shots = parseShots(chain.shots);
  const shot = shots[index];
  if (!shot || shot.index !== index) throw new JobError("shot not found", 404);
  const claimed = await sql<{ id: string; prev: string }>(
    `UPDATE re_edit_chains c SET status = 'running', updated_at = now()
     FROM (SELECT status FROM re_edit_chains WHERE id = $1) prev
     WHERE c.id = $1 AND c.user_id = $2 AND c.status IN ('completed', 'failed', 'canceled')
     RETURNING c.id, prev.status AS prev`, [chainId, userId]);
  if (!claimed.length) throw new JobError("chain is running", 409);
  const prevStatus = claimed[0].prev;
  if (hint !== undefined && hint.trim()) {
    shot.hint = hint.trim();
    await sql(`UPDATE re_edit_chains SET shots = $2::jsonb WHERE id = $1`, [chainId, JSON.stringify(shots)]);
  }
  // resume coverage: the target shot's windows plus every window of every
  // other shot that has no output (a failed run's leftovers get finished here)
  const outs = new Map(parseShotOutputs(chain.shotOutputs).map((o) => [o.index, o.urls]));
  const missing = shots
    .filter((s) => s.index !== index)
    .reduce((a, s) => a + s.windows.filter((_, w) => !(outs.get(s.index) ?? [])[w]).length, 0);
  const totalWindows = shot.windows.length + missing;
  const [firstJob] = await chainJobs(chainId, userId);
  const firstParams = firstJob?.params ?? {};
  const resolution = String(firstParams.resolution ?? "480p");
  const steps = Number(firstParams.steps);
  let job: JobRow;
  try {
    job = await createJob(userId, {
      endpointId: RE_EDIT_ENDPOINT,
      title: `ReCut - regenerate shot ${index + 1}`,
      params: {
        chain_id: chainId,
        regenerate_index: index,
        windows: totalWindows,
        flow: chain.flow,
        resolution,
        video_url: chain.videoUrl,
        image_urls: (chain.imageUrls as string[]) ?? [],
        // consent was asserted when the chain was created - reuse the first
        // job's flag rather than trusting a fresh claim
        likeness_consent: firstParams.likeness_consent === true,
        instructions: chain.instructions ?? "",
        preset_id: chain.presetId ?? undefined,
        ...(Number.isFinite(steps) ? { steps } : {}),
      },
    });
  } catch (e) {
    // undo only our own claim - another writer may legitimately hold it now
    await sql(`UPDATE re_edit_chains SET status = $2, updated_at = now()
               WHERE id = $1 AND status = 'running'`, [chainId, prevStatus]);
    throw e;
  }
  const after = await loadChain(chainId);
  return { chain: after ? chainView(after) : null, job };
}

/** Cancel the chain's live job (if any) and mark the chain canceled. A chain
 *  that's already finished is a 409 - there's nothing left to cancel. */
export async function cancelChain(userId: string, chainId: string) {
  const chain = await loadChain(chainId);
  if (!chain || chain.userId !== userId) return null;
  if (!["queued", "running", "assembling"].includes(chain.status))
    throw new JobError("chain already finished", 409);
  const live = (await chainJobs(chainId, userId))
    .filter((j) => j.status === "queued" || j.status === "in_progress");
  for (const j of live) {
    try { await cancelJob(userId, j.id); } catch { /* already terminal */ }
  }
  await db_update(chainId, { status: "canceled" });
  const after = await loadChain(chainId);
  return after ? chainView(after) : null;
}

/** Backfill the chain id onto a job that reached the recipe without one -
 *  a direct /api/jobs caller has no chain, the recipe inserts it and then
 *  links the job so chain lookups (and the live-job reconcile) see it. */
export async function linkChainJob(jobId: string, chainId: string) {
  await sql(
    `UPDATE jobs SET params = jsonb_set(params, '{chain_id}', to_jsonb($2::text)) WHERE id = $1`,
    [jobId, chainId]);
}

const db_update = async (id: string, set: Partial<{
  status: string; error: string | null; resultUrl: string | null;
  shotOutputs: ShotOutput[]; shots: ShotSpec[];
}>) => {
  const db = await getDb();
  await db.update(schema.reEditChains).set({ ...set, updatedAt: new Date() })
    .where(and(eq(schema.reEditChains.id, id), ne(schema.reEditChains.status, "canceled")));
};
export const updateChain = db_update;

/** Record one window's output on the chain (jsonb rewrite - only one job
 *  ever runs against a chain, so read-modify-write is safe). */
export async function saveWindowOutput(chainId: string, shotIndex: number, winIdx: number, url: string) {
  const chain = await loadChain(chainId);
  if (!chain || chain.status === "canceled") return;
  const outs = parseShotOutputs(chain.shotOutputs)
    .map((o) => ({ index: o.index, urls: [...o.urls] }));
  let row = outs.find((o) => o.index === shotIndex);
  if (!row) {
    row = { index: shotIndex, urls: [] };
    outs.push(row);
  }
  row.urls[winIdx] = url;
  await db_update(chainId, { shotOutputs: outs });
}

/** Insert the chain row a direct /api/jobs caller never POSTed - the recipe
 *  is the second path to a chain (the API route is the first). */
export async function insertChain(row: {
  id?: string; userId: string; videoUrl: string; flow: string;
  instructions?: string | null; imageUrls: string[]; presetId?: string | null;
  shots: ShotSpec[];
}) {
  const db = await getDb();
  const id = row.id ?? randomUUID();
  await db.insert(schema.reEditChains).values({
    id, userId: row.userId, videoUrl: row.videoUrl, flow: row.flow,
    instructions: row.instructions ?? null, imageUrls: row.imageUrls,
    presetId: row.presetId ?? null, shots: row.shots, shotOutputs: [],
    status: "running",
  });
  return loadChain(id);
}

/** The user who owns a job - needed when the recipe builds the chain. */
export async function jobOwner(jobId: string): Promise<string | null> {
  const rows = await sql<{ user_id: string }>(`SELECT user_id FROM jobs WHERE id = $1 LIMIT 1`, [jobId]);
  return rows[0]?.user_id ?? null;
}
