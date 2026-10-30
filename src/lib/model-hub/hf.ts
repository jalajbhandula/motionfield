import http from "node:http";
import https from "node:https";
import { z } from "zod";
import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import {
  defaultLookup, guardFetchTarget, pinningLookup, type LookupAll,
} from "@/lib/api/net-guard";
import { HubHttpError } from "./gate";
import {
  classifyRepoCard, downloadHopError, hfBase, isRepoName, quantTagFor,
  usingHubTestBase, WEIGHT_FILE_RE, type LicenceVerdict,
} from "./guards";

/**
 * The HF Hub client behind /api/models/hub/*:
 *  - card + tree reads at the card's pinned commit sha
 *  - a streaming, resumable resolve/ download
 *
 * Every request goes out with no Authorization header and no token lookup -
 * anonymous public repos only. Each hop (start + ≤5 redirects) re-checks the
 * host policy and, against the real hub, guardFetchTarget denies every
 * private/link-local address before DNS is pinned again at connect time.
 */

const MAX_HOPS = 5;
const TIMEOUT_MS = 30_000;
const JSON_CAP = 8 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Raised when the caller cancels - the .part file is kept for a resume. */
export class DownloadCanceled extends Error {
  constructor() { super("canceled"); this.name = "DownloadCanceled"; }
}

/* ------------------------------ wire shapes ----------------------------- */

const CardJson = z.looseObject({
  sha: z.string().optional(),
  gated: z.union([z.literal(false), z.string()]).optional(),
  private: z.boolean().optional(),
  cardData: z.looseObject({
    license: z.union([z.string(), z.array(z.string())]).optional(),
  }).optional(),
  tags: z.array(z.string()).optional(),
});

const TreeJson = z.array(z.looseObject({
  type: z.string(),
  path: z.string(),
  size: z.number().optional(),
  oid: z.string().optional(),
  lfs: z.looseObject({ oid: z.string(), size: z.number().optional() }).optional(),
}));

/* --------------------------- low-level request --------------------------- */

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: http.IncomingMessage;
}

/** One GET through the pinning resolver - deliberately minimal headers:
 *  no Authorization, no cookies, never a token. Against the real hub the
 *  resolver denies every non-public address at connect time; the loopback
 *  test base keeps the "always" deny ranges but may reach 127.0.0.1. */
function getOnce(
  url: string,
  opts: { headers?: Record<string, string>; signal?: AbortSignal; lookup?: LookupAll } = {},
): Promise<RawResponse> {
  const testBase = usingHubTestBase();
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname.replace(/^\[|\]$/g, ""),
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: {
          "user-agent": "MotionField/1.0 (+model-hub)",
          "accept": "*/*",
          "accept-encoding": "identity",
          ...opts.headers,
        },
        lookup: pinningLookup(opts.lookup ?? defaultLookup, !testBase),
        timeout: TIMEOUT_MS,
        signal: opts.signal,
      },
      (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res }),
    );
    req.on("timeout", () => req.destroy(new HubHttpError("couldn't reach Hugging Face", 502)));
    req.on("error", (e) => {
      reject(opts.signal?.aborted
        ? new DownloadCanceled()
        // DNS, resets and the timeout destroy above all land here - one
        // honest transport verdict, never a raw errno to the caller
        : e instanceof HubHttpError ? e : new HubHttpError("couldn't reach Hugging Face", 502));
    });
    req.end();
  });
}

/** GET with manual redirect following - the hop policy re-runs on every hop
 *  and the strict target guard re-classifies each hop's DNS answer. */
async function guardedGet(
  url: string,
  opts: { headers?: Record<string, string>; signal?: AbortSignal; lookup?: LookupAll } = {},
): Promise<RawResponse> {
  const testBase = usingHubTestBase();
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const why = downloadHopError(current, testBase);
    if (why) throw new HubHttpError(why, 400);
    if (!testBase) {
      const g = await guardFetchTarget(current, opts.lookup);
      if ("reason" in g) throw new HubHttpError(`destination not allowed (${g.reason})`, 400);
    }
    const res = await getOnce(current, opts);
    if (REDIRECTS.has(res.status)) {
      res.stream.resume(); // drain before the next hop
      const loc = res.headers.location;
      if (!loc) throw new HubHttpError(`hub answered redirect (${res.status}) without a location`, 502);
      if (hop === MAX_HOPS) break;
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new HubHttpError(`hub answered too many redirects (>${MAX_HOPS})`, 502);
}

function readAll(stream: http.IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (c: Buffer) => {
      size += c.length;
      if (size > cap) { stream.destroy(new HubHttpError("hub response too large", 502)); return; }
      chunks.push(c);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function getJson(
  url: string,
  opts: { signal?: AbortSignal; lookup?: LookupAll } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await guardedGet(url, opts);
  const buf = await readAll(res.stream, JSON_CAP);
  try {
    return { status: res.status, body: JSON.parse(buf.toString("utf8")) };
  } catch {
    return { status: res.status, body: null };
  }
}

/* ------------------------------- inspect -------------------------------- */

export interface HubFile {
  path: string;
  size: number;
  /** LFS sha256 (hex) or null for plain git blobs */
  sha256: string | null;
  /** non-LFS git blob oid (sha1) - the fallback checksum */
  gitOid: string | null;
  quant: string | null;
}

export interface RepoInspection {
  repo: string;
  /** the pinned commit sha - null for a refused repo with no readable card */
  revision: string | null;
  licenseIds: string[];
  verdict: LicenceVerdict;
  files: HubFile[];
}

const GATED_PRIVATE: LicenceVerdict = {
  cls: "refused", licenseId: "", reason: "gated or private repos aren't supported",
};

/** Card + file tree at the pinned commit sha. Throws HubHttpError on
 *  transport failures; gated/private/licence refusals come back in the
 *  verdict so the UI can render the reason. */
export async function inspectRepo(
  repo: string,
  kind: "weights" | "gguf",
  opts: { lookup?: LookupAll } = {},
): Promise<RepoInspection> {
  if (!isRepoName(repo)) {
    throw new HubHttpError("repo must look like owner/name - letters, digits, . _ - only", 400);
  }
  const base = hfBase();
  const card = await getJson(`${base}/api/models/${repo}`, opts);
  if (card.status === 401 || card.status === 403 || card.status === 404) {
    // auth-walled and missing repos are the same verdict - never a transport error
    return { repo, revision: null, licenseIds: [], verdict: GATED_PRIVATE, files: [] };
  }
  if (card.status !== 200) throw new HubHttpError(`hub answered HTTP ${card.status} for the model card`, 502);
  const parsed = CardJson.safeParse(card.body);
  if (!parsed.success) {
    throw new HubHttpError("the model card was unreadable", 502);
  }
  const c = parsed.data;
  // the pinned revision rides resolve/<sha>/ URLs - only a real commit sha is
  // trustworthy; anything else means the card didn't parse the way we need
  const sha = c.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new HubHttpError("the model card was unreadable", 502);
  }

  const ids = new Set<string>();
  const cardLic = c.cardData?.license;
  for (const id of Array.isArray(cardLic) ? cardLic : cardLic ? [cardLic] : []) ids.add(id);
  for (const t of c.tags ?? []) if (t.startsWith("license:")) ids.add(t.slice("license:".length));
  const verdict = classifyRepoCard({ licenseIds: [...ids], gated: c.gated, priv: c.private });

  const gatedOrPrivate = (c.gated !== undefined && c.gated !== false && c.gated !== null) || c.private === true;
  const files: HubFile[] = [];
  if (!gatedOrPrivate) {
    const tree = await getJson(`${base}/api/models/${repo}/tree/${encodeURIComponent(sha)}?recursive=true`, opts);
    if (tree.status !== 200) {
      throw new HubHttpError(`hub answered HTTP ${tree.status} for the file tree`, 502);
    }
    const entries = TreeJson.safeParse(tree.body);
    if (!entries.success) throw new HubHttpError("the file tree was unreadable", 502);
    for (const e of entries.data) {
      if (e.type !== "file") continue;
      if (kind === "gguf" ? !/\.gguf$/i.test(e.path) : !WEIGHT_FILE_RE.test(e.path)) continue;
      files.push({
        path: e.path,
        size: e.lfs?.size ?? e.size ?? 0,
        sha256: e.lfs?.oid ?? null,
        gitOid: e.lfs ? null : e.oid ?? null,
        quant: kind === "gguf" ? quantTagFor(e.path) : null,
      });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
  }

  return { repo, revision: sha, licenseIds: [...ids], verdict, files };
}

/* ------------------------------- download ------------------------------- */

export interface DownloadResult {
  bytes: number;
  /** hex digest actually verified (sha256 for LFS, sha1 blob for plain git) */
  digest: string;
  algo: "sha256" | "sha1";
}

function pickHash(f: { sha256: string | null; gitOid: string | null; size: number }): { hash: Hash; algo: "sha256" | "sha1"; want: string } {
  if (f.sha256) return { hash: createHash("sha256"), algo: "sha256", want: f.sha256.toLowerCase() };
  if (f.gitOid) {
    // a non-LFS tree oid is the git blob id: sha1("blob <size>\0" + content)
    const hash = createHash("sha1");
    hash.update(`blob ${f.size}\0`);
    return { hash, algo: "sha1", want: f.gitOid.toLowerCase() };
  }
  throw new HubHttpError("the hub offered no checksum for this file", 502);
}

/** Feed the existing .part through the running hash (a resume verifies the
 *  whole file, not just the appended tail). */
function hashFileInto(path: string, hash: Hash): Promise<void> {
  return new Promise((resolve, reject) => {
    const rs = createReadStream(path);
    rs.on("data", (c) => hash.update(c));
    rs.on("end", () => resolve());
    rs.on("error", reject);
  });
}

/**
 * Stream resolve/<rev>/<file> into <partPath> - resuming with
 * `Range: bytes=<n>-` when a partial file exists (a 200 instead of a 206
 * restarts from 0), hashing as it goes. On a checksum mismatch the caller
 * deletes the .part; on cancel it's kept.
 */
export async function downloadToFile(opts: {
  url: string;
  partPath: string;
  expectedSize: number;
  sha256: string | null;
  gitOid: string | null;
  signal: AbortSignal;
  lookup?: LookupAll;
  onBytes?: (done: number, total: number) => void;
}): Promise<DownloadResult> {
  const { partPath, expectedSize } = opts;
  let resumeFrom = await stat(partPath).then((s) => s.size).catch(() => 0);
  const pick = () => pickHash({ sha256: opts.sha256, gitOid: opts.gitOid, size: expectedSize });
  let { hash, algo, want } = pick();
  const progress = opts.onBytes ?? (() => {});

  if (resumeFrom > expectedSize) {
    // a stale .part from an older revision can never merge cleanly - drop it
    // and take the whole body instead of refusing
    await unlink(partPath).catch(() => {});
    resumeFrom = 0;
  }
  if (resumeFrom > 0) await hashFileInto(partPath, hash);
  progress(resumeFrom, expectedSize);

  if (resumeFrom < expectedSize) {
    const res = await guardedGet(opts.url, {
      headers: resumeFrom > 0 ? { range: `bytes=${resumeFrom}-` } : {},
      signal: opts.signal,
      lookup: opts.lookup,
    });
    if (res.status === 416 && resumeFrom === expectedSize) {
      // nothing left to fetch - verify below
    } else if (res.status !== 200 && res.status !== 206) {
      res.stream.resume();
      if (res.status === 404) throw new HubHttpError("the file isn't in that repo at that revision", 400);
      throw new HubHttpError(`hub answered HTTP ${res.status} for the file`, 502);
    } else {
      const fresh = res.status === 200;
      // a 200 to a Range request restarts the file at 0 - the hash must
      // restart too: the pre-fed .part bytes are not part of this body
      if (fresh) {
        resumeFrom = 0;
        ({ hash, algo, want } = pick());
      }
      const written = await writeStream(res.stream, partPath, fresh ? "w" : "a", hash, expectedSize - resumeFrom, (n) => {
        progress(resumeFrom + n, expectedSize);
      }, opts.signal);
      const done = resumeFrom + written;
      if (done !== expectedSize) {
        throw new HubHttpError(`hub sent ${done} bytes but the tree says ${expectedSize}`, 502);
      }
    }
  }

  const digest = hash.digest("hex");
  if (digest.toLowerCase() !== want) {
    await unlink(partPath).catch(() => {});
    throw new HubHttpError("checksum mismatch", 502);
  }
  return { bytes: expectedSize, digest, algo };
}

function writeStream(
  src: http.IncomingMessage,
  path: string,
  flags: "a" | "w",
  hash: Hash,
  max: number,
  onWritten: (n: number) => void,
  signal: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let n = 0;
    let ended = false;
    let settled = false;
    const fail = (e: Error) => { if (!settled) { settled = true; src.destroy(); out.destroy(); reject(e); } };
    const out = createWriteStream(path, { flags });
    out.on("error", fail);
    src.on("data", (c: Buffer) => {
      n += c.length;
      // never write past the size the tree declared - a hub that streams
      // more than advertised is failed, not truncated into place
      if (n > max) { fail(new HubHttpError("hub sent more than the tree says", 502)); return; }
      hash.update(c);
      onWritten(n);
      if (!out.write(c)) src.pause();
    });
    out.on("drain", () => src.resume());
    src.on("end", () => {
      ended = true;
      out.end(() => { if (!settled) { settled = true; resolve(n); } });
    });
    src.on("error", () => fail(new HubHttpError("the connection dropped mid-file - resume will pick it up", 502)));
    src.on("close", () => { if (!ended) fail(new HubHttpError("the connection dropped mid-file - resume will pick it up", 502)); });
    signal.addEventListener("abort", () => fail(new DownloadCanceled()), { once: true });
  });
}
