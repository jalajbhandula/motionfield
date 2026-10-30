import { NextRequest } from "next/server";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { and, desc, eq } from "drizzle-orm";
import { json, err, requireApiUser } from "@/lib/api";
import { applyDailyCredits, createJob, tickJob, JobError } from "@/lib/jobs";
import { chargeCredits } from "@/lib/credits";
import { assertLicenseAllowed, RestrictedLicenseError } from "@/lib/catalog/license-gate";
import { resolveOwnedMedia } from "@/lib/media-owned";
import { probeVideo, type ProbeInfo } from "@/lib/re-edit-ffmpeg";
import { filePathFor } from "@/lib/storage";
import {
  personSwapWindows, PERSON_SWAP_MIN_S, PERSON_SWAP_MAX_S, PERSON_SWAP_MAX_IDENTITIES, PERSON_SWAP_MAX_CLIPS,
  PERSON_SWAP_MAX_REFS, PERSON_SWAP_QUICK_MAX_S,
  PERSON_SWAP_ENDPOINT, insertHeldPersonSwap, releasePersonSwapHolds, resolvePersonSwapGalleryClip,
  personSwapGalleryFile,
} from "@/lib/generation/recipes/person-swap";
import { PERSON_SWAP, PERSON_SWAP_MODES } from "@/lib/catalog/video/swap";
import { planById } from "@/lib/catalog/plans";
import { publicJob } from "@/lib/re-edit";
import { getDb, schema, sql } from "@/db";

export const runtime = "nodejs";

/**
 * POST /api/person-swap - submit person-swap runs: up to 4 clips × up to 4 identity
 * sets, one job each, sharing a batch_id. The server probes each clip itself
 * and derives the window count (what the job is charged for); callers never
 * get to name it. Jobs beyond the caller's free slots are HELD server-side -
 * real charged queued rows without a provider id - and submitted as members
 * finish; an identity is never rejected for concurrency alone.
 */
const Identity = z.object({ image_urls: z.array(z.string().max(4096)).max(PERSON_SWAP_MAX_REFS).default([]) });
const Body = z.object({
  video_url: z.string().min(1).max(4096).optional(),
  gallery_id: z.string().min(1).max(200).optional(),
  mode: z.enum(PERSON_SWAP_MODES).default("person"),
  image_urls: z.array(z.string().max(4096)).max(PERSON_SWAP_MAX_REFS).default([]),
  identities: z.array(Identity).max(PERSON_SWAP_MAX_IDENTITIES).optional(),
  clips: z.array(z.string().min(1).max(4096)).max(PERSON_SWAP_MAX_CLIPS).optional(),
  prompt: z.string().max(2000).optional(),
  env_prompt: z.string().max(2000).optional(),
  quick: z.boolean().optional(),
  aspect: z.enum(["source", "9:16", "16:9"]).optional(),
  likeness_consent: z.boolean().optional(),
  lip_sync: z.boolean().default(true),
  resolution: z.enum(["480p", "720p"]).default("480p"),
  steps: z.number().int().min(2).max(50).optional(),
  // draft → approve → final: `draft` renders window 0 at low steps as a
  // cheap preview; `draft_of` approves a completed draft - the final reuses
  // its seed (the matte recomputes identically on the same frames)
  draft: z.boolean().optional(),
  draft_of: z.string().min(1).max(64).optional(),
});

/** Revert a gallery copy - the uploads row and the file it staged. Only
 *  called when the request came back with zero jobs, so no job row or held
 *  member can still reference the url. */
async function dropGalleryCopy(userId: string, url: string): Promise<void> {
  await sql(`DELETE FROM uploads WHERE user_id = $1 AND url = $2`, [userId, url]).catch(() => {});
  const fp = filePathFor(url);
  if (fp) await fs.rm(fp, { force: true }).catch(() => {});
}

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    await applyDailyCredits(user.id);
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    const b = parsed.data;

    // PersonSwap Quick - the short path. The server enforces the whole shape
    // up front: one photo, one clip ≤15 s, person mode, Quick defaults.
    // Anything else is a 400 with a clear message, never a silent remap.
    const quick = b.quick === true;
    if (quick) {
      if (b.mode !== "person") return json({ error: "Quick person swap runs person mode only" }, 400);
      if (b.identities?.length || b.clips?.length)
        return json({ error: "Quick person swap takes one clip and one identity - no batch fields" }, 400);
      if (b.steps !== undefined) return json({ error: "Quick person swap uses fixed steps" }, 400);
      if (b.image_urls.length !== 1)
        return json({ error: "Quick person swap takes exactly one reference photo" }, 400);
      if (b.aspect && !["source", "9:16", "16:9"].includes(b.aspect))
        return json({ error: "Quick person swap aspect is source / 9:16 / 16:9" }, 400);
    }
    // one clip source at a time - a client that sends both doesn't get a
    // silent preference for either
    if (b.video_url && b.gallery_id)
      return json({ error: "send video_url or gallery_id - not both" }, 400);

    // draft / approve gates - a draft is one clip × one identity, never a
    // batch and never itself an approval
    if (quick && (b.draft === true || b.draft_of))
      return json({ error: "Quick person swap is already the fast path - no draft" }, 400);
    if (b.draft === true && b.draft_of)
      return json({ error: "a draft can't approve another draft" }, 400);
    if (b.draft === true && (b.identities?.length || b.clips?.length))
      return json({ error: "a draft is one clip × one identity - no batch fields" }, 400);
    if (b.draft_of && (b.identities?.length || b.clips?.length))
      return json({ error: "an approved final is one clip × one identity - re-run the batch with its own drafts" }, 400);
    // the approved draft must be the caller's own completed draft - same
    // check the recipe re-runs (a direct /api/jobs submit lands there too);
    // a foreign or non-draft id 400s before any probe or charge
    if (b.draft_of) {
      // a non-uuid never reaches the table - the cast error would 500
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.draft_of))
        return json({ error: "draft_of must name a completed Person Swap draft" }, 400);
      const rows = await sql<{ d: Record<string, unknown> | null }>(
        `SELECT provider_meta->'person_swap' AS d FROM jobs
          WHERE id = $1 AND user_id = $2 AND endpoint_id = $3 AND status = 'completed'`,
        [b.draft_of, user.id, PERSON_SWAP_ENDPOINT]);
      if (!rows.length || rows[0].d?.draft !== true)
        return json({ error: "draft_of must name a completed Person Swap draft" }, 400);
    }

    // EVERY refusal the request can hit lands BEFORE the gallery copy -
    // copying a clip creates an uploads row + file, and a refused request
    // must leave neither behind. The gallery entry itself is only READ
    // (existence + probe on the manifest file; the copy is byte-identical).
    let galleryHit: { entry: { id: string; file: string }; file: string } | null = null;
    if (!b.video_url && b.gallery_id) {
      galleryHit = await personSwapGalleryFile(b.gallery_id);
      if (!galleryHit) return json({ error: "unknown gallery clip" }, 400);
    }
    const videoUrl = b.video_url;
    if (!videoUrl && !galleryHit) return json({ error: "video_url or gallery_id is required" }, 400);

    // clips resolve first - a traversal/foreign/external video_url must hit
    // its own 400/404 before any probe or ref check (order is the contract)
    const GALLERY = "__gallery__";
    const clipKeys = [...new Set([videoUrl ?? GALLERY, ...(quick ? [] : (b.clips ?? []))])].slice(0, PERSON_SWAP_MAX_CLIPS);
    const sets = b.identities?.length ? b.identities : [{ image_urls: b.image_urls }];
    const probes = new Map<string, ProbeInfo>();
    const maxS = quick ? PERSON_SWAP_QUICK_MAX_S : PERSON_SWAP_MAX_S;
    for (const u of clipKeys) {
      const file = u === GALLERY ? galleryHit!.file : await resolveOwnedMedia(user.id, u);
      const probe = await probeVideo(file);
      if (probe.durationSec < PERSON_SWAP_MIN_S || probe.durationSec > maxS)
        return json({ error: `clip must be ${PERSON_SWAP_MIN_S}-${maxS} s (got ${probe.durationSec.toFixed(1)} s)` }, 400);
      probes.set(u, probe);
    }
    const refs = [...new Set(sets.flatMap((s) => s.image_urls))];
    for (const u of refs) await resolveOwnedMedia(user.id, u);
    if (b.mode !== "environment" && sets.some((s) => s.image_urls.length === 0))
      return json({ error: `${b.mode} needs at least one reference image per identity` }, 400);

    const profile = (await sql<{ plan_id: string | null; boost_slots: number; auto_publish: boolean }>(
      `SELECT plan_id, boost_slots, auto_publish FROM profiles WHERE user_id = $1`, [user.id]))[0];
    const plan = planById(profile?.plan_id);
    const limit = plan.parallelVideo + Number(profile?.boost_slots ?? 0);
    const [{ n: liveN }] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs WHERE user_id = $1 AND status IN ('queued','in_progress')`, [user.id]);
    let free = Math.max(0, limit - Number(liveN));

    const units = clipKeys.flatMap((clip) => sets.map((s) => {
      const probe = probes.get(clip)!;
      return {
        clip, refs: s.image_urls,
        // honest charging - the lip stage only runs (and is only paid for)
        // when a soundtrack exists and the person pass is part of the run
        windows: personSwapWindows(probe.durationSec).length,
        lipSync: b.lip_sync && b.mode !== "environment" && probe.hasAudio,
      };
    }));

    const batchId = units.length > 1 ? crypto.randomUUID() : undefined;
    const jobs: Record<string, unknown>[] = [];
    const rejected: { index: number; error: string }[] = [];
    const wf = PERSON_SWAP.workflows[0];
    const costOf = (params: Record<string, unknown>) => wf.cost(params);

    // Units that end up HELD never pass through createJob - so every check
    // createJob would have run (workflow validate → licence gate → plan
    // floor) runs up-front here on the batch's behalf, before a single row
    // or charge exists. Held rows get a fresh consent re-check on release.
    // A gallery unit validates on its gallery_id - the copy's video_url is
    // filled in below once every refuse is behind us.
    const unitParams = units.map((u) => {
      const params: Record<string, unknown> = {
        ...(u.clip !== GALLERY ? { video_url: u.clip } : {}),
        mode: b.mode, image_urls: u.refs,
        prompt: b.prompt ?? "", env_prompt: b.env_prompt ?? "",
        likeness_consent: b.likeness_consent === true,
        lip_sync: u.lipSync, resolution: b.resolution, windows: u.windows,
        ...(b.draft === true ? { draft: true } : {}),
        ...(b.draft_of ? { draft_of: b.draft_of } : {}),
        ...(quick ? { quick: true } : {}),
        ...(b.aspect && b.aspect !== "source" ? { aspect: b.aspect } : {}),
        ...(b.gallery_id ? { gallery_id: b.gallery_id } : {}),
        ...(b.steps !== undefined ? { steps: b.steps } : {}),
        ...(batchId ? { batch_id: batchId } : {}),
      };
      const invalid = wf.validate?.(params) ?? null;
      if (invalid) throw new JobError(invalid, 400, "bad_request");
      return params;
    });
    await assertLicenseAllowed(wf, user.id, unitParams[0] ?? {});
    if ((PERSON_SWAP.minPlanTier ?? 0) > plan.tier) {
      const names = ["paid", "Basic", "Pro", "Max", "Team"];
      throw new JobError(`${PERSON_SWAP.label} requires ${names[PERSON_SWAP.minPlanTier ?? 1]}+ plan`, 402);
    }

    // the only fs/db side effect the request makes - everything that could
    // refuse is already behind us. If the batch still comes back empty the
    // copy is reverted so a refused request leaves no upload row.
    let galleryCopyUrl: string | null = null;
    try {
      if (galleryHit) {
        galleryCopyUrl = await resolvePersonSwapGalleryClip(user.id, b.gallery_id!);
        for (const [i, u] of units.entries())
          if (u.clip === GALLERY) unitParams[i].video_url = galleryCopyUrl;
      }

      for (const [i, u] of units.entries()) {
        const params = unitParams[i];
        if (free > 0) {
          try {
            const job = await createJob(user.id, {
              endpointId: PERSON_SWAP_ENDPOINT, params,
              title: `PersonSwap · ${b.mode}`,
            });
            jobs.push({ ...publicJob(job), held: false });
            free -= 1;
            continue;
          } catch (e) {
            // a concurrency race is a hold, not a rejection - everything else
            // (validation, credits) reports honestly
            const code = (e as { code?: string })?.code;
            if (code !== "concurrency_limit") {
              rejected.push({ index: i, error: e instanceof Error ? e.message : String(e) });
              continue;
            }
          }
        }
        // held - charged, queued, no provider id; releasePersonSwapHolds submits it
        try {
          const { id } = await insertHeldPersonSwap({
            userId: user.id, title: `PersonSwap · ${b.mode}`, prompt: String(b.prompt ?? ""),
            cost: costOf(params), visibility: profile?.auto_publish ? "public" : "private", params,
          });
          try {
            const cost = costOf(params);
            if (cost > 0) await chargeCredits(user.id, cost, "job", id, `PersonSwap · ${b.mode}`);
          } catch (ce) {
            await sql(`DELETE FROM jobs WHERE id = $1 AND provider_request_id IS NULL`, [id]);
            rejected.push({ index: i, error: ce instanceof Error ? ce.message : String(ce) });
            continue;
          }
          jobs.push({
            id, status: "queued", progress: 0, error: null,
            created_at: new Date().toISOString(), held: true,
          });
        } catch (e) {
          rejected.push({ index: i, error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (!jobs.length && rejected.length) throw new JobError(rejected[0].error, 400, "bad_request");
      return json({ batch_id: batchId, jobs, rejected, windows: [...new Set(units.map((u) => u.windows))] }, jobs.length ? 201 : 400);
    } catch (e) {
      if (galleryCopyUrl) await dropGalleryCopy(user.id, galleryCopyUrl);
      throw e;
    }
  } catch (e) {
    if (e instanceof RestrictedLicenseError) return json(e.body, e.status);
    return err(e);
  }
}

/** GET /api/person-swap[?batch_id=…] - my person-swap runs, newest first. */
export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const db = await getDb();
    const batchId = req.nextUrl.searchParams.get("batch_id");
    const rows = await db.select().from(schema.jobs)
      .where(and(eq(schema.jobs.userId, user.id), eq(schema.jobs.endpointId, PERSON_SWAP_ENDPOINT)))
      .orderBy(desc(schema.jobs.createdAt)).limit(50);
    // opportunistic ticks - the list is the poll the client runs - then any
    // held members take the slots finished members just freed
    for (const j of rows)
      if (j.status === "queued" || j.status === "in_progress")
        await tickJob(j.id).catch(() => { /* best-effort */ });
    await releasePersonSwapHolds(user.id).catch(() => {});
    const fresh = await db.select().from(schema.jobs)
      .where(and(eq(schema.jobs.userId, user.id), eq(schema.jobs.endpointId, PERSON_SWAP_ENDPOINT)))
      .orderBy(desc(schema.jobs.createdAt)).limit(50);
    type JobRow = typeof schema.jobs.$inferSelect;
    const jobs = fresh
      .filter((j: JobRow) => !batchId || (j.params as Record<string, unknown>)?.batch_id === batchId)
      .map((j: JobRow) => {
        const meta = (j.providerMeta as Record<string, unknown>)?.person_swap as Record<string, unknown> | undefined;
        return {
          ...publicJob(j),
          outputs: j.outputs,
          mode: (j.params as Record<string, unknown>)?.mode ?? null,
          batch_id: (j.params as Record<string, unknown>)?.batch_id ?? null,
          held: j.status === "queued" && !j.providerRequestId,
          meta: meta ?? null,
          lip: meta?.lip ?? null,
        };
      });
    return json({ jobs });
  } catch (e) {
    return err(e);
  }
}
