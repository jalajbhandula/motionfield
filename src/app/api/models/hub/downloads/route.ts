import { NextRequest } from "next/server";
import { statfs } from "node:fs/promises";
import { json } from "@/lib/api";
import { hubErr, hubUser } from "@/lib/model-hub/gate";
import { filePathFor } from "@/lib/storage";
import {
  DownloadBody, listDownloadRows, startWeightsDownload,
} from "@/lib/model-hub/downloads";

export const runtime = "nodejs";

/** The caller's hub download/pull records, newest first, with live progress
 *  merged from the registry - plus free disk so a big pull is sized up front. */
export async function GET(req: NextRequest) {
  try {
    // reads need no network - Offline still lists (and cancels) rows
    const user = await hubUser(req, { offlineOk: true });
    let freeGb: number | null = null;
    const dir = filePathFor("/files/");
    if (dir) {
      try { const s = await statfs(dir); freeGb = Math.round((s.bavail * s.bsize) / 1e9 * 10) / 10; }
      catch { freeGb = null; }
    }
    return json({ downloads: await listDownloadRows(user.id), disk: { free_gb: freeGb } });
  } catch (e) {
    return hubErr(e);
  }
}

/** Queue a ComfyUI weights download - the H1 checks re-run server-side and
 *  the fetch pins the commit the licence was read at. Returns 202 with the
 *  record; progress is polled via GET. */
export async function POST(req: NextRequest) {
  try {
    const user = await hubUser(req);
    const parsed = DownloadBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return json({ error: "send {repo, revision, file, subfolder}" }, 400);
    }
    const { row, alreadyInstalled } = await startWeightsDownload(user.id, parsed.data);
    return json({ download: row, alreadyInstalled }, alreadyInstalled ? 200 : 202);
  } catch (e) {
    return hubErr(e);
  }
}
