import { NextRequest } from "next/server";
import { json, err, requireApiUser } from "@/lib/api";
import { getDb, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { cancelJob, tickJob } from "@/lib/jobs";
import { publicJob } from "@/lib/re-edit";
import { generatedPathFor } from "@/lib/storage";
import { PERSON_SWAP_ENDPOINT, releasePersonSwapHolds } from "@/lib/generation/recipes/person-swap";
import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

/** Fetch the caller's own person-swap job - a foreign id, a non-person-swap job and a
 *  bad id all 404 identically. */
async function ownPersonSwap(userId: string, id: string) {
  const db = await getDb();
  const [job] = await db.select().from(schema.jobs)
    .where(and(eq(schema.jobs.id, id), eq(schema.jobs.userId, userId),
      eq(schema.jobs.endpointId, PERSON_SWAP_ENDPOINT)))
    .limit(1);
  return job ?? null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    let job = await ownPersonSwap(user.id, id);
    if (!job) return json({ error: "not found" }, 404);
    // opportunistic tick so the row reflects recipe progress/final state -
    // then any held batch member takes the slot this one may have just freed
    if (job.status === "queued" || job.status === "in_progress") {
      try { await tickJob(id); } catch { /* tick is best-effort */ }
      await releasePersonSwapHolds(user.id).catch(() => {});
      job = await ownPersonSwap(user.id, id) ?? job;
    }
    const p = (job.params ?? {}) as Record<string, unknown>;
    const meta = (job.providerMeta as Record<string, unknown> | null)?.person_swap ?? null;
    return json({
      job: {
        ...publicJob(job), outputs: job.outputs,
        mode: p.mode ?? null, batch_id: p.batch_id ?? null,
        video_url: p.video_url ?? null,
        held: job.status === "queued" && !job.providerRequestId,
        stage: (job.providerMeta as Record<string, unknown> | null)?.stage ?? null,
        meta,
      },
    });
  } catch (e) {
    return err(e);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireApiUser(req);
    const { id } = await params;
    const job = await ownPersonSwap(user.id, id);
    if (!job) return json({ error: "not found" }, 404);
    await cancelJob(user.id, id);
    // a canceled member frees its slot for the batch's held rows
    await releasePersonSwapHolds(user.id).catch(() => {});

    // takedown - the run's working dir (matte/strip evidence, intermediates),
    // the on-demand side-by-side render, every published output file, the
    // asset rows and the job's own outputs leave nothing app-side
    const removed: string[] = [];
    const evDir = generatedPathFor(`/files/generated/.person_swap/${id}`);
    if (evDir) {
      await fs.rm(evDir, { recursive: true, force: true }).catch(() => {});
      removed.push(`generated/.person_swap/${id}/`);
    }
    const sxs = generatedPathFor(`/files/generated/person-swap-sxs-${id}.mp4`);
    if (sxs && (await fs.stat(sxs).then(() => true, () => false))) {
      await fs.rm(sxs, { force: true }).catch(() => {});
      removed.push(`generated/person-swap-sxs-${id}.mp4`);
    }
    // the published outputs - only files the pipeline itself named:
    // generated/person-swap-<id>-* renders and the finish pass's
    // generated/finish/<id>.mp4, resolved through the symlink guard
    const outs = (job.outputs ?? []) as { url?: unknown }[];
    for (const o of outs) {
      const u = typeof o?.url === "string" ? o.url : "";
      const owned = path.basename(u).startsWith(`person-swap-${id}-`) || u === `/files/generated/finish/${id}.mp4`;
      if (!u || !owned) continue;
      const fp = generatedPathFor(u);
      if (!fp) continue;
      await fs.rm(fp, { force: true }).catch(() => {});
      removed.push(u.replace(/^\/files\//, ""));
    }
    const db = await getDb();
    // the asset rows the finish tick wrote - the same row delete the
    // assets route does, scoped to this job + owner
    await db.delete(schema.assets)
      .where(and(eq(schema.assets.jobId, id), eq(schema.assets.userId, user.id)));
    // the job row keeps its history but no longer publishes anything
    await db.update(schema.jobs)
      .set({ outputs: [], visibility: "private" })
      .where(eq(schema.jobs.id, id));
    // what the app cannot reach: the copies the ComfyUI side still holds -
    // input uploads (by their original basenames) and every output written
    // under this job's of_<id8>_ prefix. Listed so the owner can finish the
    // takedown on the Comfy host - with one caveat: the proxy dedupes
    // input/ by content hash, so an input copy may still be referenced by
    // another job; remove it there only once nothing references it.
    const p = (job.params ?? {}) as Record<string, unknown>;
    const media = [p.video_url, ...(Array.isArray(p.image_urls) ? p.image_urls : [])]
      .filter((u): u is string => typeof u === "string" && u.startsWith("/files/"))
      .map((u) => path.basename(u));
    const residuals = {
      comfy_input: media,
      comfy_output_prefix: `of_${id.slice(0, 8)}_*`,
      note: "copies on the ComfyUI host (input/ + output/ dirs) are outside the app's reach - delete them there for a full takedown; input/ files are content-deduped by the proxy, so only remove one once no other job references it",
    };
    return json({ ok: true, removed, residuals });
  } catch (e) {
    return err(e);
  }
}
