import { NextRequest } from "next/server";
import { statfs } from "node:fs/promises";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err } from "@/lib/api/v1";
import { sql } from "@/db";
import { filePathFor } from "@/lib/storage";

export const runtime = "nodejs";

/** Providers that drive this machine's GPU - a hosted (cloud) provider name
 *  would live outside this set, and "mock" never touches the GPU. Read from
 *  job rows only; never probes ComfyUI. */
const LOCAL_PROVIDERS = ["comfy", "recipe"] as const;

/** GET /api/v1/system - queue depth of the caller's live jobs, whether the
 *  local GPU is busy, deployment tier, and free disk on the storage volume. */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;

    const [q] = await sql<{ queued: number; in_progress: number }>(
      `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
              count(*) FILTER (WHERE status = 'in_progress')::int AS in_progress
       FROM jobs WHERE user_id = $1 AND status IN ('queued','in_progress')`,
      [auth.userId]);
    // Machine-wide: the GPU is shared - another user's in-flight render makes
    // it busy for everyone.
    const [{ busy }] = await sql<{ busy: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM jobs
                      WHERE status = 'in_progress' AND provider = ANY($1)) AS busy`,
      [[...LOCAL_PROVIDERS]]);

    const hosted = process.env.MOTIONFIELD_HOSTED === "1";
    let freeGb: number | null = null;
    const storageDir = filePathFor("/files/");
    if (!hosted && storageDir) {
      try {
        const stats = await statfs(storageDir);
        freeGb = Math.round(((stats.bavail * stats.bsize) / 1e9) * 10) / 10;
      } catch {
        freeGb = null; // filesystem without statfs support
      }
    }

    return v1json({
      queue: { queued: q?.queued ?? 0, in_progress: q?.in_progress ?? 0 },
      gpu: { busy: busy ?? false },
      tier: hosted ? "cloud" : "local",
      disk: { free_gb: freeGb },
    });
  } catch (e) {
    return v1err(e);
  }
}
