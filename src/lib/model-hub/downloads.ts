import { homedir } from "node:os";
import path from "node:path";
import { lstat, mkdir, realpath, rename, stat, statfs } from "node:fs/promises";
import { z } from "zod";
import { assertVerdictAllowed, HubHttpError } from "./gate";
import { downloadToFile, DownloadCanceled, inspectRepo, type HubFile, type RepoInspection } from "./hf";
import {
  hfBase, hubTestFreeBytes, isModelSubfolder, isRepoName,
  MODEL_SUBFOLDERS, redFlagWeight, repoFileError, weightFileError, type ModelSubfolder,
} from "./guards";

/**
 * Hub download records + the runner.
 *
 * Live progress lives in a globalThis registry (HMR-safe - a dev rebuild
 * must not orphan a running download); durable rows land in hub_downloads
 * (migration 0208). One download runs per machine at a time. The .part file
 * is always the resumable artifact: cancel keeps it, a re-POST resumes it.
 */

const db = async () => (await import("@/db")).getDb();
const sch = async () => (await import("@/db")).schema;
const dq = async () => import("drizzle-orm");

const FREE_FLOOR = 10 * 2 ** 30; // MotionField keeps 10 GB free
const GIB = 2 ** 30;

/* ------------------------------ bodies ---------------------------------- */

export const DownloadBody = z.strictObject({
  repo: z.string().min(1).max(200),
  revision: z.string().min(1).max(120),
  file: z.string().min(1).max(400),
  subfolder: z.string().min(1).max(60),
});

export const PullBody = z.strictObject({
  repo: z.string().min(1).max(200),
  quant: z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/, "quant must be a tag like Q4_K_M"),
});

/* ------------------------------ registry -------------------------------- */

export type LiveStatus = "running" | "done" | "failed" | "canceled";

interface LiveEntry {
  controller: AbortController;
  bytesDone: number;
  bytesTotal: number;
  status: LiveStatus;
  error: string | null;
}

const g = globalThis as unknown as {
  __ofHubDownloads?: { entries: Map<string, LiveEntry>; activeId: string | null };
};

function registry() {
  g.__ofHubDownloads ??= { entries: new Map(), activeId: null };
  return g.__ofHubDownloads;
}

/** Placeholder id held in activeId between the synchronous claim and the row
 *  insert - any truthy value 409s a second starter, and a pre-start throw
 *  only releases the lock while it still reads pending. */
const CLAIM_PENDING = "__pending__";

/** Offline just flipped on - kill every live transfer (the network the
 *  download needs is about to be refused anyway). */
export function abortActiveHubTransfers(): void {
  for (const e of registry().entries.values()) {
    if (e.status === "running") e.controller.abort();
  }
}

/* ------------------------------- records -------------------------------- */

export interface HubRow {
  id: string;
  userId: string;
  kind: string;
  repo: string;
  revision: string;
  file: string;
  subfolder: string | null;
  sha256: string | null;
  bytes: number;
  licenceId: string;
  licenceClass: string;
  status: string;
  error: string | null;
  createdAt: Date | string;
}

interface HubRowOut extends HubRow {
  /** live progress - equals bytes when done */
  bytesDone: number;
  bytesTotal: number;
}

function shape(r: HubRow): HubRowOut {
  const live = registry().entries.get(r.id);
  const total = live?.bytesTotal ?? r.bytes;
  return {
    ...r,
    bytesTotal: total,
    bytesDone: r.status === "done" ? total : live?.bytesDone ?? 0,
    // a durable "running" row with no live entry means the process that ran
    // it is gone - it reads "interrupted" (resumable), never polls forever
    status: live?.status ?? (r.status === "running" ? "interrupted" : r.status),
    error: live?.error ?? r.error,
  };
}

export async function listDownloadRows(userId: string): Promise<HubRowOut[]> {
  const [d, s, { desc, eq }] = await Promise.all([db(), sch(), dq()]);
  const rows = await d.select().from(s.hubDownloads)
    .where(eq(s.hubDownloads.userId, userId))
    .orderBy(desc(s.hubDownloads.createdAt));
  return rows.map(shape);
}

async function getDownloadRow(id: string): Promise<HubRow | null> {
  const [d, s, { eq }] = await Promise.all([db(), sch(), dq()]);
  const [r] = await d.select().from(s.hubDownloads)
    .where(eq(s.hubDownloads.id, id)).limit(1);
  return r ?? null;
}

/** DELETE /<id> - the caller's own row only (another user's → 404).
 *  A running download is aborted and its .part kept for resume; a failed or
 *  running-but-not-live row lands "canceled"; a done row is left alone. */
export async function cancelDownload(userId: string, id: string): Promise<HubRowOut> {
  const row = await getDownloadRow(id);
  if (!row || row.userId !== userId) throw new HubHttpError("not found", 404);
  const reg = registry();
  const live = reg.entries.get(id);
  if (live && live.status === "running") {
    live.controller.abort();
    live.status = "canceled";
    live.error = "canceled";
  }
  if (row.status !== "done") {
    const [d, s, { eq }] = await Promise.all([db(), sch(), dq()]);
    const [r] = await d.update(s.hubDownloads)
      .set({ status: "canceled", error: "canceled" })
      .where(eq(s.hubDownloads.id, id))
      .returning();
    return shape(r ?? { ...row, status: "canceled", error: "canceled" });
  }
  return shape(row);
}

/* ------------------------------ paths/disk ------------------------------ */

function comfyModelsDir(): string {
  const root = process.env.COMFYUI_DIR || path.join(homedir(), "comfy", "ComfyUI");
  return path.join(root, "models");
}

/** Resolve <models>/<subfolder>/<basename(file)> inside the real models dir -
 *  a symlinked subfolder that lands outside is refused. Creates the
 *  subfolder when missing. Throws HubHttpError(400) "set COMFYUI_DIR" when
 *  the models dir itself doesn't exist. */
export async function resolveModelTarget(
  modelsDir: string,
  subfolder: string,
  file: string,
): Promise<string> {
  let realModels: string;
  try {
    realModels = await realpath(modelsDir);
  } catch {
    throw new HubHttpError(`no ComfyUI models dir at ${modelsDir} - set COMFYUI_DIR`, 400);
  }
  const sub = path.join(realModels, subfolder);
  await mkdir(sub, { recursive: true }).catch(() => {});
  const realSub = await realpath(sub).catch(() => null);
  if (!realSub || realSub !== path.join(realModels, subfolder)) {
    throw new HubHttpError(`models/${subfolder} doesn't resolve inside the models dir`, 400);
  }
  return path.join(realSub, path.basename(file));
}

/** Free bytes on the volume holding `dir` - the test seam overrides statfs. */
async function freeBytes(dir: string): Promise<number> {
  const test = hubTestFreeBytes();
  if (test !== null) return test;
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

/** The 10 GB floor - refuse before anything is written. */
async function assertFloor(dir: string, fileSize: number): Promise<void> {
  const free = await freeBytes(dir);
  if (free - fileSize < FREE_FLOOR) {
    const need = Math.ceil(fileSize / GIB);
    const have = Math.floor(free / GIB);
    throw new HubHttpError(`needs ${need} GB but only ${have} GB free - MotionField keeps 10 GB free`, 400);
  }
}

/* ------------------------------ inspection ------------------------------ */

/** Re-run the H1 checks server-side - a class sent by the client is never
 *  trusted. Throws 403 with the refusal reason when the verdict bars the
 *  caller. */
export async function reinspectAllowed(
  userId: string,
  repo: string,
  kind: "weights" | "gguf",
): Promise<RepoInspection> {
  const insp = await inspectRepo(repo, kind);
  await assertVerdictAllowed(userId, insp.verdict);
  return insp;
}

function matchFile(insp: RepoInspection, file: string): HubFile {
  const f = insp.files.find((x) => x.path === file);
  if (!f) throw new HubHttpError("no such file in that repo at that revision - run Check again", 400);
  return f;
}

/* --------------------------- weights download ---------------------------- */

export interface StartedDownload {
  row: HubRowOut;
  alreadyInstalled: boolean;
}

export async function startWeightsDownload(
  userId: string,
  body: z.infer<typeof DownloadBody>,
): Promise<StartedDownload> {
  if (!isRepoName(body.repo)) throw new HubHttpError("repo must look like owner/name", 400);
  const pathErr = repoFileError(body.file);
  if (pathErr) throw new HubHttpError(pathErr, 400);
  const extErr = weightFileError(body.file);
  if (extErr) throw new HubHttpError(extErr, 400);
  if (!isModelSubfolder(body.subfolder)) {
    throw new HubHttpError(`subfolder must be one of ${MODEL_SUBFOLDERS.join(", ")}`, 400);
  }
  // banned weights never reach the hub - the check is static and must land
  // before any network call, let alone a byte written
  if (redFlagWeight(body.repo) || redFlagWeight(body.file)) {
    throw new HubHttpError("this weight is on MotionField's banned list", 400);
  }
  const subfolder: ModelSubfolder = body.subfolder;

  // machine lock - claimed synchronously, same tick as the check and before
  // the first await, so a second concurrent starter can never slip through.
  // Any pre-start throw releases it again; once the transfer is running the
  // runner's finally does.
  const reg = registry();
  if (reg.activeId) throw new HubHttpError("a download is already running", 409);
  reg.activeId = CLAIM_PENDING;
  try {
    const insp = await reinspectAllowed(userId, body.repo, "weights");
    if (!insp.revision || body.revision !== insp.revision) {
      throw new HubHttpError("the revision moved - run Check again", 400);
    }
    const entry = matchFile(insp, body.file);
    if (redFlagWeight(entry.path)) {
      throw new HubHttpError("this weight is on MotionField's banned list", 400);
    }

    const target = await resolveModelTarget(comfyModelsDir(), subfolder, body.file);
    const partPath = `${target}.part`;

    // lstat sees the link itself - a symlinked target or .part is refused
    for (const p of [target, partPath]) {
      const lst = await lstat(p).catch(() => null);
      if (lst?.isSymbolicLink()) {
        throw new HubHttpError(`a symlink sits at models/${subfolder}/${path.basename(p)} - refusing to write`, 400);
      }
    }

    // same file + same sha → already installed; same name + different sha → 409
    const exists = await stat(target).then(() => true).catch(() => false);
    if (exists) {
      const [d, s, { and, eq }] = await Promise.all([db(), sch(), dq()]);
      const base = path.basename(body.file);
      const prior = await d.select().from(s.hubDownloads)
        .where(and(eq(s.hubDownloads.subfolder, subfolder), eq(s.hubDownloads.file, body.file)));
      const sameSha = prior.some((r: { status: string; sha256: string | null }) =>
        r.status === "done" && r.sha256 === (entry.sha256 ?? entry.gitOid));
      if (sameSha) {
        // it's on disk for everyone - give the caller their own done row
        const row = await insertRow(userId, {
          kind: "weights", repo: body.repo, revision: insp.revision, file: body.file,
          subfolder, sha256: entry.sha256 ?? entry.gitOid, bytes: entry.size,
          licenceId: insp.verdict.licenseId, licenceClass: insp.verdict.cls,
          status: "done",
        });
        reg.activeId = null;
        return { row: shape(row), alreadyInstalled: true };
      }
      throw new HubHttpError(
        `a different file already sits at models/${subfolder}/${base} - remove it first`, 409);
    }

    // the floor check waits for the claim - a refused download never held
    // the lock while statfs was in flight
    await assertFloor(path.dirname(target), entry.size);

    // a resumable row from an earlier failed/canceled attempt is reused
    const [d, s, { and, eq, ne }] = await Promise.all([db(), sch(), dq()]);
    const [existing] = await d.select().from(s.hubDownloads)
      .where(and(
        eq(s.hubDownloads.userId, userId),
        eq(s.hubDownloads.repo, body.repo),
        eq(s.hubDownloads.file, body.file),
        eq(s.hubDownloads.subfolder, subfolder),
        ne(s.hubDownloads.status, "done"),
      )).limit(1);
    const row = existing
      ? (await updateRow(existing.id, { status: "running", error: null, revision: insp.revision,
          sha256: entry.sha256 ?? entry.gitOid, bytes: entry.size,
          licenceId: insp.verdict.licenseId, licenceClass: insp.verdict.cls })) ?? existing
      : await insertRow(userId, {
          kind: "weights", repo: body.repo, revision: insp.revision, file: body.file,
          subfolder, sha256: entry.sha256 ?? entry.gitOid, bytes: entry.size,
          licenceId: insp.verdict.licenseId, licenceClass: insp.verdict.cls,
          status: "running",
        });

    const controller = new AbortController();
    reg.activeId = row.id;
    reg.entries.set(row.id, {
      controller,
      bytesDone: 0, bytesTotal: entry.size, status: "running", error: null,
    });
    void runWeightsDownload(row.id, `${hfBase()}/${body.repo}/resolve/${encodeURIComponent(insp.revision)}/${body.file}`, entry, target, partPath, controller.signal);
    return { row: shape(row), alreadyInstalled: false };
  } catch (e) {
    if (reg.activeId === CLAIM_PENDING) reg.activeId = null;
    throw e;
  }
}

async function runWeightsDownload(
  id: string,
  url: string,
  entry: HubFile,
  target: string,
  partPath: string,
  signal: AbortSignal,
): Promise<void> {
  const reg = registry();
  const live = reg.entries.get(id);
  const finish = async (status: LiveStatus, error: string | null) => {
    if (live) { live.status = status; live.error = error; }
    await updateRow(id, { status, error });
  };
  try {
    await downloadToFile({
      url, partPath, expectedSize: entry.size,
      sha256: entry.sha256, gitOid: entry.gitOid, signal,
      onBytes: (done, total) => {
        if (live) { live.bytesDone = done; live.bytesTotal = total; }
      },
    });
    // last check before the atomic rename - never clobber
    if (await stat(target).then(() => true).catch(() => false)) {
      throw new HubHttpError("the target appeared mid-download - refusing to overwrite it", 409);
    }
    await rename(partPath, target);
    await finish("done", null);
  } catch (e) {
    if (e instanceof DownloadCanceled) {
      await finish("canceled", "canceled");
      return;
    }
    const msg = e instanceof Error ? e.message : "download failed";
    await finish("failed", msg.slice(0, 300));
  } finally {
    // the machine lock always frees - even if the row update itself threw
    if (reg.activeId === id) reg.activeId = null;
  }
}

/* ------------------------------- gguf pull ------------------------------- */

export interface PreparedPull {
  row: HubRowOut;
  pullName: string;
  entry: HubFile;
  signal: AbortSignal;
  onProgress: (done: number, total: number) => void;
}

/** Everything before the Ollama call: licence re-check, the GGUF's quant tag
 *  must match, the 10 GB floor uses the matched file's size on the home
 *  volume. The route then streams pullOllamaModel events. */
export async function preparePull(
  userId: string,
  body: z.infer<typeof PullBody>,
): Promise<PreparedPull> {
  if (!isRepoName(body.repo)) throw new HubHttpError("repo must look like owner/name", 400);
  if (redFlagWeight(body.repo)) {
    throw new HubHttpError("this weight is on MotionField's banned list", 400);
  }
  // same machine lock as startWeightsDownload - claim synchronously, release
  // on any pre-start throw, finishPull clears it in a finally
  const reg = registry();
  if (reg.activeId) throw new HubHttpError("a download is already running", 409);
  reg.activeId = CLAIM_PENDING;
  try {
    const insp = await reinspectAllowed(userId, body.repo, "gguf");
    const match = insp.files.filter((f) => f.quant === body.quant);
    const file = match.sort((a, b) => a.path.localeCompare(b.path))[0];
    if (!file) {
      const seen = insp.files.map((f) => f.quant).filter(Boolean).join(", ");
      throw new HubHttpError(
        `no .gguf with quant "${body.quant}" in ${body.repo}${seen ? ` - saw ${seen}` : ""}`, 400);
    }
    if (redFlagWeight(file.path)) {
      throw new HubHttpError("this weight is on MotionField's banned list", 400);
    }
    await assertFloor(homedir(), file.size);
    const row = await insertRow(userId, {
      kind: "gguf", repo: body.repo, revision: insp.revision ?? "", file: file.path,
      subfolder: null, sha256: file.sha256 ?? file.gitOid, bytes: file.size,
      licenceId: insp.verdict.licenseId, licenceClass: insp.verdict.cls,
      status: "running",
    });
    const controller = new AbortController();
    reg.activeId = row.id;
    reg.entries.set(row.id, {
      controller,
      bytesDone: 0, bytesTotal: file.size, status: "running", error: null,
    });
    return {
      row: shape(row),
      pullName: `hf.co/${body.repo}:${body.quant}`,
      entry: file,
      signal: controller.signal,
      onProgress: (done, total) => {
        const live = registry().entries.get(row.id);
        if (live) { live.bytesDone = done; live.bytesTotal = total; }
      },
    };
  } catch (e) {
    if (reg.activeId === CLAIM_PENDING) reg.activeId = null;
    throw e;
  }
}

/** End of a pull - the record lands done/failed/canceled and the machine
 *  lock frees. A caller-aborted pull stays "canceled". */
export async function finishPull(id: string, ok: boolean, error: string | null): Promise<void> {
  const reg = registry();
  const live = reg.entries.get(id);
  const status: LiveStatus = ok ? "done" : live?.status === "canceled" || error === "canceled" ? "canceled" : "failed";
  try {
    if (live) {
      live.status = status;
      live.error = ok ? null : error;
      if (ok) live.bytesDone = live.bytesTotal;
    }
    await updateRow(id, { status, error: ok ? null : error });
  } finally {
    if (reg.activeId === id) reg.activeId = null;
  }
}

/* ------------------------------- row ops -------------------------------- */

async function insertRow(
  userId: string,
  v: {
    kind: string; repo: string; revision: string; file: string;
    subfolder: string | null; sha256: string | null; bytes: number;
    licenceId: string; licenceClass: string; status: string;
  },
): Promise<HubRow> {
  const [d, s] = await Promise.all([db(), sch()]);
  const [row] = await d.insert(s.hubDownloads).values({ userId, ...v }).returning();
  return row;
}

async function updateRow(id: string, set: Partial<{
  status: string; error: string | null; revision: string;
  sha256: string | null; bytes: number; licenceId: string; licenceClass: string;
}>): Promise<HubRow | null> {
  const [d, s, { eq }] = await Promise.all([db(), sch(), dq()]);
  const [row] = await d.update(s.hubDownloads).set(set).where(eq(s.hubDownloads.id, id)).returning();
  return row ?? getDownloadRow(id);
}
