import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import http from "http";
import https from "https";
import net from "net";
import { promises as dns } from "dns";
import { Readable } from "stream";
import { type Asset } from "@comfyorg/sdk";
import type { PostSpec } from "@/lib/catalog/types";
import type { GenerationProvider, ProviderOutputItem, ProviderStatus, SubmitInput, SubmitResult } from "./types";
import { backendFor, backendConfig, comfyClient, type ComfyBackend } from "./comfy-backend";
import { JOB_KIND_OUTPUT } from "./types";
import { KEYFRAME_MOVES, endCropRect, type KeyframeMove } from "@/lib/camera/keyframe-moves";
import { filePathFor, saveBytes } from "@/lib/storage";
import { isPublicIp, publicOnlyLookup, type RequestLookup } from "@/lib/render/brand";

/**
 * Runs workflows through the official Comfy SDK (Comfy API v2), so the same code
 * targets a self-hosted ComfyUI behind `comfy-api-proxy` (default, keyless),
 * a serverless deployment, or Comfy Cloud - only COMFY_BASE_URL / COMFY_API_KEY change.
 */
const WF_DIR = path.join(process.cwd(), "workflows");


type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** Param types that carry media references (URL strings) - they never flow
 *  through the generic scalar placeholder pass (that's prompt/text territory);
 *  their only route into a graph is the explicit media-placeholder mapping. */
export const MEDIA_PARAM_TYPES: ReadonlySet<string> = new Set(["url", "image", "media", "images"]);

/** Media params must reference an uploaded /files/* asset or an http(s) URL -
 *  a bare filename would let LoadImage read anything in ComfyUI's input
 *  folder, including other users' uploads. */
const MEDIA_REF = /^(\/files\/|https?:\/\/)/;

/** A media ref that passes MEDIA_REF can still carry traversal - reject "..",
 *  "..\\", encoded "%2e" (at any encoding depth) and backslashes before the
 *  path ever reaches fs or the Comfy input map. Local /files/* refs take no
 *  percent-encoding at all (%2f, %00, ...). */
const BAD_PATH = /(\.\.)|(\\)|(%2e)|(%25)|\0/i;

/** /files/* refs must additionally resolve under public/files - filePathFor
 *  double-checks, but params are rejected here so the error names the param. */
export function unsafePathChars(ref: string): boolean {
  if (BAD_PATH.test(ref)) return true;
  return ref.startsWith("/files/") && ref.includes("%");
}

/** Wrong-typed media params fail fast instead of dropping silently -
 *  url/image/media accept a URL string, images also accepts a string[];
 *  every value must be a /files/* or http(s) reference. */
export function validateMediaParams(workflow: Pick<SubmitInput["workflow"], "params">, params: Record<string, unknown>): void {
  for (const f of workflow.params ?? []) {
    if (!MEDIA_PARAM_TYPES.has(f.type)) continue;
    const v = params[f.name];
    if (v === undefined || v === null || v === "") continue;
    const vals = Array.isArray(v) ? v : [v];
    const ok = vals.every((x) => typeof x === "string" && !!x);
    if (!ok) throw new Error(`${f.name}: media param expects a URL string${f.type === "images" ? " or an array of URL strings" : ""}`);
    if (!vals.every((x) => MEDIA_REF.test(x))) throw new Error(`invalid media param ${f.name}`);
    if (vals.some((x) => unsafePathChars(x))) throw new Error(`invalid media param ${f.name}: path traversal is not allowed`);
  }
}

/** Build placeholder substitution map from workflow params. Exported for tests. */
export function placeholders(input: SubmitInput): Record<string, string> {
  const p = input.params;
  const mediaParams = new Set((input.workflow.params ?? []).filter((f) => MEDIA_PARAM_TYPES.has(f.type)).map((f) => f.name));
  const seed = String(p.seed || Math.floor(Math.random() * 1e9));
  const [w, h] = dims(String(p.aspect_ratio ?? "16:9"), String(p.resolution ?? "720p"));
  const fps = Number(p.fps || 25);
  const duration = Number(p.duration || 5);
  const frames = String(ltxFrames(duration, fps));

  const map: Record<string, string> = {
    PROMPT: String(p.prompt ?? p.text ?? ""),
    NEGATIVE: String(p.negative_prompt ?? "worst quality, inconsistent motion, blurry, jittery, distorted"),
    WIDTH: String(roundTo(w, 32)), HEIGHT: String(roundTo(h, 32)),
    FRAMES: frames, FPS: String(fps), SEED: seed, STEPS: String(p.steps ?? 30),
    BATCH: String(p.batch_size || 1), DENOISE: String(p.denoise ?? 0.75),
    SHOT_START: String(p.shot_start ?? 0), SHOT_END: String(p.shot_end ?? 0),
    PREFIX: `of_${input.jobId.slice(0, 8)}`,
    MODEL: "RealESRGAN_x4plus.pth",
    LIPS: String(p.lips_expression ?? 1.5),
    VOICE: String(p.voice ?? "af_heart"), SPEED: String(p.speed ?? 1),
    EXAGGERATION: String(p.exaggeration ?? 0.5),
    BBOX_SHIFT: String(p.bbox_shift ?? 0),
    MOTION_PROMPT: String(p.motion_prompt ?? "a person facing camera and talking, subtle natural head motion, steady framing"),
  };
  // media placeholders resolved to comfy input filenames after upload
  for (const k of ["image_url", "video_url", "audio_url", "mask_url", "mask_video_url", "base_image_url", "swap_image_url", "character_image_url", "product_image_url", "end_image_url", "pose_image_url"]) {
    const v = p[k];
    if (typeof v === "string" && v) map[paramToPlaceholder(k)] = v;
  }
  // end keyframe (ltx-vfx-keyframe): the guide node only exists when an end
  // image was supplied - END_FRAME pins it on the last generated frame
  if (map.END_IMAGE) map.END_FRAME = String(Math.max(0, Number(frames) - 1));
  // Lens text-to-video (ltx-lens-t2v.json): no still to crop, so the graph
  // renders one (Z-Image, up to 2x the clip for a sharp crop) and cuts the
  // end keyframe where the camera lands - same geometry as the i2v path
  const move = String(p.camera_movement ?? "");
  if (!p.image_url && move in KEYFRAME_MOVES) {
    const W = Number(map.WIDTH), H = Number(map.HEIGHT);
    const s = Math.min(2, 1536 / Math.max(W, H));
    const zw = roundTo(W * s, 32), zh = roundTo(H * s, 32);
    const r = endCropRect(zw, zh, move as KeyframeMove);
    Object.assign(map, {
      Z_WIDTH: String(zw), Z_HEIGHT: String(zh),
      CROP_X: String(r.left), CROP_Y: String(r.top), CROP_W: String(r.width), CROP_H: String(r.height),
      END_FRAME: String(Math.max(0, Number(frames) - 1)),
      STILL_PROMPT: map.PROMPT,
      PROMPT: `${map.PROMPT.trim()} ${KEYFRAME_MOVES[move as KeyframeMove].phrase}.`.trim(),
    });
  }
  // image_urls[] -> REF_IMAGE chain (extra refs land on optional stitched loaders)
  const refs = p.image_urls ?? p.reference_image_urls;
  if (Array.isArray(refs) && refs.length && typeof refs[0] === "string") map.REF_IMAGE = refs[0];
  if (Array.isArray(refs) && refs.length > 1 && typeof refs[1] === "string") map.REF_IMAGE_2 = refs[1];
  if (Array.isArray(refs) && refs.length > 2 && typeof refs[2] === "string") map.REF_IMAGE_3 = refs[2];
  if (typeof p.reference_image_url === "string" && p.reference_image_url) map.REF_IMAGE = p.reference_image_url;
  // reframe pads: host passes explicit pad_* when it knows source dims; 0 keeps the
  // original content region (outpaint fills nothing new when pads are all zero)
  map.PAD_LEFT = String(p.pad_left ?? 0);
  map.PAD_RIGHT = String(p.pad_right ?? 0);
  map.PAD_TOP = String(p.pad_top ?? 0);
  map.PAD_BOTTOM = String(p.pad_bottom ?? 0);
  // generic pass: every scalar param is also reachable as {{UPPER_SNAKE}} -
  // unless an explicit mapping already claimed that key (e.g. steps → STEPS
  // is already set; media params like image_url → INPUT_IMAGE stay separate).
  // RESERVED keys are never taken from a param name - a stray `input_video`,
  // `ref_image` or `prefix` param must not reach media/path inputs.
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null) continue;
    const t = typeof v;
    if (t !== "string" && t !== "number" && t !== "boolean") continue;
    if (mediaParams.has(k)) continue; // media refs reach their placeholders via the explicit mapping above only
    const key = k.toUpperCase();
    if (RESERVED.has(key)) continue;
    if (map[key] === undefined) map[key] = String(v);
  }
  // explicit output geometry: a v2v caller that knows the source (portrait
  // 480x832 @16fps) must not get the 16:9 / 5s@25fps defaults (864x480x129)
  const ew = Number(p.width), eh = Number(p.height), ef = Number(p.frames);
  if (ew > 0 && eh > 0) { map.WIDTH = String(roundTo(ew, 16)); map.HEIGHT = String(roundTo(eh, 16)); }
  if (ef > 0) map.FRAMES = String(Math.floor((Math.round(ef) - 1) / 4) * 4 + 1);
  // workflow-specific placeholder derivation (e.g. cam-i2v's rig sizing +
  // the trajectory stack → MOVES); the workflow's own map wins over generic
  const extra = input.workflow.providers.comfy?.map?.(p);
  if (extra) for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) map[k] = String(v);
  return map;
}

/** Placeholders only ever set by their explicit mappings - media loaders,
 *  path inputs and output-name internals. The generic param pass skips them. */
const RESERVED = new Set([
  "INPUT_IMAGE", "INPUT_VIDEO", "INPUT_AUDIO",
  "MASK_IMAGE", "MASK_VIDEO", "TARGET_IMAGE", "SOURCE_FACE_IMAGE",
  "END_IMAGE", "END_FRAME", "POSE_IMAGE",
  "REF_IMAGE", "REF_IMAGE_2", "REF_IMAGE_3",
  "PREFIX", "MODEL",
]);

/** Placeholders that carry prompt text - "true"/"false" must stay a string
 *  (a prompt that reads "false" is not a boolean). */
const TEXT_PLACEHOLDERS = new Set(["PROMPT", "NEGATIVE", "MOTION_PROMPT"]);

export function paramToPlaceholder(k: string) {
  return { image_url: "INPUT_IMAGE", video_url: "INPUT_VIDEO", audio_url: "INPUT_AUDIO", mask_url: "MASK_IMAGE", mask_video_url: "MASK_VIDEO", base_image_url: "TARGET_IMAGE", swap_image_url: "SOURCE_FACE_IMAGE", character_image_url: "SOURCE_FACE_IMAGE", product_image_url: "SOURCE_FACE_IMAGE", end_image_url: "END_IMAGE", pose_image_url: "POSE_IMAGE" }[k] ?? k.toUpperCase();
}

function roundTo(n: number, m: number) { return Math.max(m, Math.round(n / m) * m); }

function ltxFrames(durationSec: number, fps: number) {
  // LTX needs 8n+1 frames
  const target = Math.max(9, Math.round(durationSec * fps));
  return Math.round((target - 1) / 8) * 8 + 1;
}

function dims(ar: string, res: string): [number, number] {
  const hi = res === "4k" || res === "4K" ? 2048 : res === "2k" || res === "2K" || res === "1080p" ? 1080 : res === "1k" || res === "1K" ? 1024 : res === "480p" ? 480 : 720;
  const ratio = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3, "3:4": 3 / 4, "21:9": 21 / 9, "3:2": 1.5, "2:3": 2 / 3, "4:5": 0.8, "5:4": 1.25 }[ar] ?? 16 / 9;
  const short = Math.min(hi, 1080);
  // "480p/720p/1080p" name the SHORT side (video convention): a 9:16 480p
  // clip is 480x853, not a 270x480 thumbnail. K tiers keep the old height rule.
  if (/p$/i.test(res) && ratio < 1) return [short, short / ratio];
  return [short * ratio, short];
}

/**
 * Live progress per running job. `GET /jobs/{id}` only carries an indeterminate
 * snapshot on self-hosted surfaces, so percent comes from the job's SSE event
 * stream (`progress` frames), tracked in the background per provider job.
 * The stream is read over raw http - global fetch gets response-buffered by
 * dev-server instrumentation, which stalls SSE.
 */
const liveProgress = new Map<string, number>();
const liveSubs = new Set<string>();
const TERMINAL = new Set(["succeeded", "failed", "canceled", "expired"]);

/** Bearer for the Comfy progress stream - same-origin only so the key can
 *  never leak to a third-party host: the endpoint we were configured against
 *  gets the header, a server-supplied events url pointing anywhere else is
 *  streamed keylessly, and a malformed URL yields no header at all. The key
 *  never leaves the process (it is never logged - only the header value).
 *  Exported for tests. */
export function progressHeaders(url: string, backend: ComfyBackend = "main"): Record<string, string> {
  const { baseUrl, apiKey: key } = backendConfig(backend);
  if (!key) return {};
  try {
    const base = new URL(baseUrl);
    if (new URL(url).origin !== base.origin) return {};
  } catch {
    return {};
  }
  return { authorization: `Bearer ${key}` };
}

/** Exported for the wire-level header test - production callers go through
 *  trackProgress. */
export async function streamProgress(url: string, onEvent: (event: string, data: Record<string, unknown>) => void, signal: AbortSignal, backend: ComfyBackend = "main") {
  const http = url.startsWith("https") ? await import("node:https") : await import("node:http");
  await new Promise<void>((resolve, reject) => {
    const req = http.get(url, { headers: progressHeaders(url, backend) }, (res) => {
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = "message", data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;
          try { onEvent(event, JSON.parse(data)); } catch { /* unparseable frame - skip */ }
        }
      });
      res.on("end", resolve);
      res.on("error", reject);
    });
    req.on("error", reject);
    signal.addEventListener("abort", () => { req.destroy(); resolve(); });
  });
}

function trackProgress(jobId: string, eventsUrl?: string, backend: ComfyBackend = "main") {
  if (liveSubs.has(jobId)) return;
  liveSubs.add(jobId);
  const ac = new AbortController();
  void (async () => {
    const url = eventsUrl ?? `${backendConfig(backend).baseUrl}/api/v2/jobs/${jobId}/events`;
    for (let attempt = 0; attempt < 3 && !ac.signal.aborted; attempt++) {
      let terminal = false;
      try {
        await streamProgress(url, (event, data) => {
          if (event === "progress") {
            // prefer the running node's step counter (the sampler dominates wall
            // time); fall back to the node-weighted fraction - but skip early
            // frames where the node map is still tiny and value≈1 falsely
            const step = data.step != null ? Number(data.step) : null;
            const steps = data.steps != null ? Number(data.steps) : null;
            const nt = data.nodes_total != null ? Number(data.nodes_total) : 0;
            const pct = step != null && steps ? step / steps : nt >= 3 ? Number(data.value ?? 0) : null;
            if (pct != null) liveProgress.set(jobId, Math.max(0, Math.min(99, Math.round(pct * 100))));
          } else if (event === "status") {
            terminal = TERMINAL.has(String(data.status));
          }
        }, ac.signal, backend);
        if (terminal) return;
      } catch {
        // transient stream failure - reconnects below; poll() stays authoritative
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  })().finally(() => {
    liveSubs.delete(jobId);
    liveProgress.delete(jobId);
  });
}

/** Loader inputs that must carry a media ref - a bare filename here is read
 *  straight out of ComfyUI's input folder, which holds every user's uploads.
 *  attachMedia only ever uploads/fetches on these keys, so text that merely
 *  starts with /files/ or http(s):// can never become an asset fetch. */
const MEDIA_INPUT_NAMES: ReadonlySet<string> = new Set(["image", "audio", "video", "video_path", "file", "model_file", "mask", "audio_path", "latent"]);

/** Inputs that name a file path or weight: filename_prefix plus every
 *  *_name/*_path widget (ckpt_name, unet_name, clip_name1, file_path, ...) and
 *  the bare file-path names. */
const PATH_INPUT_RE = /(?:^|_)(?:name|path)\d*$|^(?:filename_prefix|file|filename|path|folder|directory)$/;

/** What a path-shaped input may never contain: traversal, separators that
 *  escape a folder, NUL, percent-encoding, an absolute anchor (/ or ~) or a
 *  Windows drive root. Interior "/" is fine - Comfy weights live in subdirs. */
const BAD_PATH_PART = /\.\.|\\|\x00|%|^[\/~]|^[a-zA-Z]:/;

/** Override graphs skip the placeholder path entirely, so param-level media
 *  validation never sees their inputs - and a fork's resolved graph carries
 *  real prompt text ("she turns... slowly"), so free text must never be
 *  path-checked. Only two input kinds are dangerous:
 *  (a) a loader input (image/audio/video/video_path/file/model_file) must BE
 *      a media ref - a bare filename is read straight out of ComfyUI's input
 *      folder - with no traversal, and a /files/ ref must resolve under
 *      public/files (filePathFor decides, same as toAsset). attachMedia only
 *      uploads on these keys, so they are the only strings ever fetched;
 *  (b) a path-shaped input (filename_prefix, *_name, *_path, folder/...) must
 *      carry no traversal or absolute root - Comfy joins it onto its own
 *      model/output folders.
 *  Everything else - including text that starts with http(s):// - is free text
 *  and is never inspected. */
export function assertSafeGraphInputs(graph: Graph): void {
  for (const [id, node] of Object.entries(graph)) {
    if (id === "_meta") continue;
    for (const [k, v] of Object.entries(node.inputs)) {
      if (typeof v !== "string") continue;
      if (MEDIA_INPUT_NAMES.has(k)) {
        if (!MEDIA_REF.test(v))
          throw new Error(`graph input ${id}.${k}: media input must be a /files/ or http(s) ref`);
        if (unsafePathChars(v))
          throw new Error(`graph input ${id}.${k}: path traversal is not allowed`);
        if (v.startsWith("/files/") && !filePathFor(v))
          throw new Error(`graph input ${id}.${k}: unresolvable /files/ ref`);
        continue;
      }
      if (PATH_INPUT_RE.test(k) && BAD_PATH_PART.test(v))
        throw new Error(`graph input ${id}.${k}: path traversal is not allowed`);
    }
  }
}

/** The upload-size cap lives in api/uploads.ts - imported lazily so this module
 *  stays out of the jobs→generation→comfy import cycle. */
let maxUploadBytes = 0;
async function uploadLimit(): Promise<number> {
  if (!maxUploadBytes) maxUploadBytes = (await import("@/lib/api/uploads")).MAX_UPLOAD_BYTES;
  return maxUploadBytes;
}

/* ---------- remote media fetch (SSRF boundary) ----------
 * A media ref can carry any http(s) URL - fetching it server-side must never
 * reach private/local addresses. Every hop's host is vetted before the socket
 * opens (literal IPs and DNS answers, IPv6 included), redirects are followed
 * manually (≤3, each re-vetted), and the real transport resolves through
 * publicOnlyLookup so a DNS answer that flips between the check and the
 * connect can't steer the socket. Mirrors render/brand.ts's guard; swap to
 * its shared module once ws5 exports one. */

type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const realMediaLookup: LookupFn = (host) => dns.lookup(host, { all: true });
const MEDIA_MAX_REDIRECTS = 3;

/** Reject a hop whose host is private/local - runs before the socket opens. */
async function assertPublicMediaHost(url: URL, resolve: LookupFn): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new Error(`URL blocked: "${host}" is not a public address`);
    return;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal"))
    throw new Error(`URL blocked: "${host}" is not a public host`);
  let addrs: { address: string; family: number }[];
  try {
    addrs = await resolve(host);
  } catch (e) {
    throw new Error(`can't resolve "${host}": ${e instanceof Error ? e.message : e}`);
  }
  if (!addrs.length || !addrs.every((a) => isPublicIp(a.address)))
    throw new Error(`URL blocked: "${host}" resolves to a private/local address`);
}

/** GET over node http/https with the connect-time lookup pinned to public
 *  addresses - fetch() can't express a `lookup`. Redirects are never followed
 *  here; fetchRemoteMedia re-vets each hop itself. */
function nodeMediaFetch(url: string, init: RequestInit | undefined, lookup: RequestLookup): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const headers: Record<string, string> = { "user-agent": "motionfield-media/1.0" };
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const req = lib.request(u, { method: "GET", headers, lookup }, (res) => {
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        out.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      const status = res.statusCode ?? 502;
      // 204/205/304 carry no body by definition - a stream body would throw
      if (status === 204 || status === 205 || status === 304) {
        res.resume();
        resolve(new Response(null, { status, headers: out }));
        return;
      }
      resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers: out }));
    });
    const onAbort = () => req.destroy(new Error("request aborted"));
    init?.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", reject);
    req.end();
  });
}

export interface RemoteMediaDeps { fetch?: FetchLike; resolve?: LookupFn }
let remoteMediaDeps: RemoteMediaDeps = {};

/** Swap the transport/resolver - the override tests inject spies here so no
 *  real socket ever opens; production runs the node transport + real DNS. */
export function __setRemoteMediaDeps(deps: RemoteMediaDeps | null): void {
  remoteMediaDeps = deps ?? {};
}

/** http(s)-only GET with per-hop host vetting and manual redirects (≤3). */
export async function fetchRemoteMedia(url: string, init?: RequestInit): Promise<Response> {
  const resolve = remoteMediaDeps.resolve ?? realMediaLookup;
  const fetchImpl: FetchLike = remoteMediaDeps.fetch
    ?? ((u, i) => nodeMediaFetch(u, i, publicOnlyLookup(resolve)));
  const signal = init?.signal ?? AbortSignal.timeout(120_000);
  let current = url;
  for (let hop = 0; ; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      throw new Error(`invalid media url: ${current}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:")
      throw new Error(`URL blocked: "${u.protocol}" is not http/https`);
    await assertPublicMediaHost(u, resolve);
    let res: Response;
    try {
      res = await fetchImpl(current, { redirect: "manual", signal });
    } catch (e) {
      throw new Error(`can't reach ${u.host}: ${e instanceof Error ? e.message : e}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      void res.body?.cancel().catch(() => {}); // never read - release the socket
      if (hop >= MEDIA_MAX_REDIRECTS) throw new Error(`too many redirects (>${MEDIA_MAX_REDIRECTS})`);
      current = new URL(res.headers.get("location")!, u).toString();
      continue;
    }
    return res;
  }
}

/** Lazy SDK asset handle for a local /files/* asset or remote URL; hashed + uploaded on submit. */
async function toAsset(urlOrPath: string, backend: ComfyBackend): Promise<Asset> {
  if (urlOrPath.startsWith("/files/")) {
    const local = filePathFor(urlOrPath);
    // a /files/ ref that doesn't resolve under public/files must die here -
    // fetching it would send "GET /files/../..." to our own server
    if (!local) throw new Error(`unresolvable /files/ ref: ${urlOrPath}`);
    return comfyClient(backend).assets.fromBytes(new Uint8Array(await fs.readFile(local)), { filename: path.basename(local) });
  }
  const limit = await uploadLimit();
  const r = await fetchRemoteMedia(urlOrPath);
  if (!r.ok) throw new Error(`fetch ${urlOrPath}: ${r.status}`);
  // refuse oversize remote media - first on the declared length, then on the
  // actual streamed bytes (a lying/absent content-length can't slip past)
  const declared = Number(r.headers?.get?.("content-length") ?? 0);
  if (declared > limit) throw new Error(`remote media too large: ${declared}B exceeds the ${limit}B upload cap`);
  const filename = urlOrPath.split("?")[0].split("/").pop() || "input.bin";
  const reader = r.body?.getReader?.();
  let bytes: Uint8Array;
  if (reader) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel?.().catch(() => {});
        throw new Error(`remote media exceeds the ${limit}B upload cap`);
      }
      chunks.push(value);
    }
    bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
  } else {
    bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error(`remote media exceeds the ${limit}B upload cap`);
  }
  return comfyClient(backend).assets.fromBytes(bytes, { filename });
}

/** Swap media URLs in loader inputs for asset handles. Only the loader input
 *  names are touched - a URL sitting in any other input is free text, never a
 *  fetch. The stored graph keeps the URLs, so a remixed graph stays portable
 *  across Comfy deployments. */
async function attachMedia(graph: Graph, backend: ComfyBackend): Promise<Graph> {
  const handles = new Map<string, Promise<Asset>>();
  const out: Graph = {};
  for (const [id, node] of Object.entries(graph)) {
    if (id === "_meta") continue;
    const inputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.inputs)) {
      if (typeof v === "string" && MEDIA_INPUT_NAMES.has(k) && MEDIA_REF.test(v)) {
        if (!handles.has(v)) handles.set(v, toAsset(v, backend));
        inputs[k] = await handles.get(v);
      } else inputs[k] = v;
    }
    out[id] = { class_type: node.class_type, inputs };
  }
  return out;
}

/** Substitute {{PLACEHOLDER}}s. A placeholder listed in the workflow's
 *  `_meta.optional` that has no param value drops the whole node carrying it
 *  (optional placeholders sit on dedicated loader nodes, e.g. restyle's
 *  REF_IMAGE LoadImage) plus every link feeding it. */
export function substitute(graph: Graph, map: Record<string, string>, optional: ReadonlySet<string>): Graph {
  const dropNodes = new Set<string>();
  const out: Graph = {};
  for (const [id, node] of Object.entries(graph)) {
    if (id === "_meta") continue;
    const inputs: Record<string, unknown> = {};
    let drop = false;
    for (const [k, v] of Object.entries(node.inputs)) {
      if (typeof v === "string" && /^\{\{[A-Z_0-9]+\}\}$/.test(v)) {
        const key = v.slice(2, -2);
        const val = map[key];
        if (val === undefined) {
          if (optional.has(key)) { drop = true; break; }
          inputs[k] = v; // unresolved - collected by the missing-placeholder scan below
          continue;
        }
        inputs[k] = !TEXT_PLACEHOLDERS.has(key) && (val === "true" || val === "false") ? val === "true"
          : /^\d+(\.\d+)?$/.test(val) && !RESERVED.has(key) ? Number(val) : val;
      } else inputs[k] = v;
    }
    if (!drop) out[id] = { class_type: node.class_type, inputs };
    else dropNodes.add(id);
  }
  if (!dropNodes.size) return assertResolved(out);
  // _meta.cascade_drop lists nodes that must go when any node they link to
  // dropped (e.g. wan-animate's grey background plate: with no mask the
  // stock template disconnects background_video entirely - an unmasked
  // plate would hand WanAnimateToVideo an all-grey background)
  const cascade = (graph._meta as { cascade_drop?: string[] } | undefined)?.cascade_drop ?? [];
  for (let changed = true; changed;) {
    changed = false;
    for (const id of cascade) {
      if (!out[id]) continue;
      if (Object.values(out[id].inputs).some((v) => Array.isArray(v) && typeof v[0] === "string" && dropNodes.has(v[0]))) {
        delete out[id]; dropNodes.add(id); changed = true;
      }
    }
  }
  // dropped pass-through nodes forward their own upstream link to consumers -
  // _meta.passthrough[nodeId][outputIndex] names the input to splice in
  // (e.g. an optional LTXVAddGuide mid-chain rewires to the previous guide)
  const passthrough = (graph._meta as { passthrough?: Record<string, string[]> } | undefined)?.passthrough ?? {};
  for (const node of Object.values(out))
    for (const [k, v] of Object.entries(node.inputs))
      if (Array.isArray(v) && typeof v[0] === "string" && dropNodes.has(v[0])) {
        let link: unknown = v;
        while (Array.isArray(link) && typeof link[0] === "string" && dropNodes.has(link[0])) {
          const input = passthrough[link[0]]?.[Number(link[1])];
          link = input !== undefined ? graph[link[0]]?.inputs?.[input] : undefined;
        }
        if (Array.isArray(link)) node.inputs[k] = link;
        else delete node.inputs[k];
      }
  return assertResolved(out);
}

/** After the optional-loader drop logic, any {{X}} left on a remaining node's
 *  inputs is a param the graph asked for but the job didn't supply - fail the
 *  submit naming every missing placeholder. */
function assertResolved(graph: Graph): Graph {
  const missing = new Set<string>();
  for (const node of Object.values(graph))
    for (const v of Object.values(node.inputs))
      if (typeof v === "string" && /^\{\{[A-Z_0-9]+\}\}$/.test(v)) missing.add(v.slice(2, -2));
  if (missing.size) throw new Error(`missing placeholders: ${[...missing].sort().join(", ")}`);
  return graph;
}

/** Nodes that produce an artifact we collect - never pruned as dangling. */
const OUTPUT_CLASSES = new Set([
  "SaveImage", "PreviewImage", "SaveAnimatedWEBP", "SaveAnimatedPNG",
  "VHS_VideoCombine", "SaveAudio", "SaveVideo", "OF_ProvTag",
  "Save3DAdvanced", "SaveGLB", "SaveGaussianSplat", "SavePointCloud",
]);

/** Drop nodes no remaining node consumes and that produce no artifact
 *  (e.g. a LoadImage left dangling when an optional input was dropped).
 *  Exported so offline runners (runpod validate, director-smoke) build the
 *  exact graph createJob submits. */
export function prune(graph: Graph): Graph {
  const used = new Set<string>();
  for (const node of Object.values(graph))
    for (const v of Object.values(node.inputs))
      if (Array.isArray(v) && typeof v[0] === "string") used.add(v[0]);
  const out: Graph = {};
  for (const [id, node] of Object.entries(graph))
    if (used.has(id) || OUTPUT_CLASSES.has(node.class_type)) out[id] = node;
  return Object.keys(out).length === Object.keys(graph).length ? out : prune(out);
}

/** Deployment-side weight remap: COMFY_MODEL_MAP='{"wan2.1_vace_14B_fp8scaled.safetensors":"wan2.1_vace_1.3B_fp16.safetensors"}'
 *  lets the same workflow JSON run lighter/different weights per environment.
 *  Mapped values are normalised to forward slashes - a Windows-style
 *  "dir\\file.safetensors" target would trip the path-input guard on forks. */
let modelMap: Record<string, string> | null = null;
let modelMapSrc = "";
/** Exported - see prune: offline runners must remap the same way submit does. */
export function remapModels(graph: Graph): Graph {
  const src = process.env.COMFY_MODEL_MAP || "{}";
  if (modelMap === null || modelMapSrc !== src) {
    try { modelMap = JSON.parse(src); } catch { modelMap = {}; }
    modelMapSrc = src;
  }
  const mm = modelMap ?? {};
  if (!Object.keys(mm).length) return graph;
  for (const node of Object.values(graph)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (typeof v === "string" && mm[v]) node.inputs[k] = mm[v].replace(/\\/g, "/");
    }
  }
  return graph;
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/webm": "webm", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/mpeg": "mp3", "audio/flac": "flac", "audio/ogg": "ogg",
};

/** Map an SDK output onto our media kinds; text/latent outputs are skipped.
 *  The 3D save nodes emit under the "3d" key (Saved3DModels) - the SDK tags
 *  those outputs type "3d" with a .glb/.gltf name. */
function mediaKind(o: { type: string; contentType: string; name: string }): ProviderOutputItem["type"] | null {
  const ct = o.contentType || "";
  if (ct.startsWith("model/") || o.type === "3d" || /\.(glb|gltf|obj|stl|usdz|ply|fbx)$/i.test(o.name)) return "model";
  if (ct.startsWith("video/") || /\.(mp4|webm|gif|mov)$/i.test(o.name)) return "video";
  if (ct.startsWith("audio/") || o.type === "audio") return "audio";
  if (ct.startsWith("image/") || o.type === "image") return "image";
  return o.type === "video" ? "video" : null;
}

export const comfyProvider: GenerationProvider = {
  name: "comfy",

  async submit(input: SubmitInput): Promise<SubmitResult> {
    // the workflow's own gate re-runs here so a param it can't honour is
    // refused before any media upload or queue slot is spent
    const invalid = input.workflow.validate?.(input.params);
    if (invalid) throw new Error(invalid);
    validateMediaParams(input.workflow, input.params);
    let raw: Graph;
    if (input.graphOverride) {
      raw = input.graphOverride as Graph;
    } else {
      const prov = input.workflow.providers.comfy;
      const wfFile = prov?.workflowFor?.(input.params) ?? prov?.workflow;
      if (!wfFile) throw new Error(`no comfy workflow for ${input.workflow.endpointId}`);
      raw = JSON.parse(await fs.readFile(path.join(WF_DIR, wfFile), "utf8")) as Graph;
    }

    const metaOpt = (raw._meta as { optional?: unknown } | undefined)?.optional;
    const optional = new Set<string>(
      Array.isArray(metaOpt) ? metaOpt.filter((x): x is string => typeof x === "string") : [],
    );
    const graph = remapModels(input.graphOverride ? raw : prune(substitute(raw, placeholders(input), optional)));
    if (input.graphOverride) assertSafeGraphInputs(graph);
    const dropOutputs = (raw._meta as { drop_outputs?: unknown } | undefined)?.drop_outputs;
    const backend = backendFor(input);
    const client = comfyClient(backend);
    const wf = client.workflows.fromJson(await attachMedia(graph, backend));
    const job = await client.submit(wf, { idempotencyKey: input.jobId });
    trackProgress(job.id, job.urls?.events ?? undefined, backend);
    // host post-look (Director's body/palette grade): the spec rides job meta -
    // a vf string is rebuilt at poll time so a restarted process still resolves
    const post = await input.workflow.providers.comfy?.post?.(input.params) ?? null;
    return { providerJobId: job.id, meta: { comfyBackend: backend, endpointId: input.workflow.endpointId, graph, dropOutputs, ...(post ? { post } : {}) } };
  },

  async poll(jobId: string, _meta): Promise<ProviderStatus> {
    const backend = _meta?.comfyBackend === "audio" ? "audio" : "main";
    const job = await comfyClient(backend).jobs.get(jobId);
    switch (job.status) {
      case "queued":
        return { state: "queued", position: job.queuePosition ?? undefined };
      case "running":
      case "canceling": {
        trackProgress(jobId, undefined, backend); // jobs submitted by another process/restart get a subscriber too
        const live = liveProgress.get(jobId);
        return { state: "in_progress", progress: live ?? (job.progress ? Math.round(job.progress.value * 100) : undefined) };
      }
      case "canceled":
        return { state: "canceled" };
      case "expired":
        return { state: "failed", error: "comfy job expired before its outputs were collected" };
      case "failed": {
        const e = job.error;
        return { state: "failed", error: e ? `${e.class_type ? `${e.class_type}: ` : ""}${e.message}` : "comfy execution error" };
      }
      case "succeeded":
        break;
      default:
        return { state: "in_progress" };
    }

    // copy every media output into our storage so assets outlive the job's retention window;
    // _meta.drop_outputs marks mid-chain artifacts (e.g. an intermediate clip that only
    // feeds a later node) - they stay in Comfy's output dir but never reach the gallery.
    const dropped = new Set<string>(
      Array.isArray((_meta as { dropOutputs?: unknown })?.dropOutputs)
        ? (_meta as { dropOutputs: string[] }).dropOutputs : [],
    );
    // a post spec parked on meta at submit grades each video output host-side
    // (Director's ffmpeg look) - rebuilt here so the lut file regenerates if
    // the tmp cache was cleared between submit and poll
    const post = (_meta as { post?: PostSpec } | undefined)?.post;
    let postVf: string | null = null;
    if (post) {
      const { postSpecFor } = await import("@/lib/grade/post");
      postVf = (await postSpecFor({ camera_body: post.body, color_palette: post.palette })).vf;
    }
    const items: ProviderOutputItem[] = [];
    for (const out of job.outputs) {
      if (dropped.has(out.nodeId)) continue;
      const kind = mediaKind(out);
      if (!kind) continue;
      const ext = out.name.match(/\.([a-z0-9]{2,5})$/i)?.[1].toLowerCase()
        ?? EXT_BY_TYPE[out.contentType] ?? (kind === "video" ? "mp4" : kind === "audio" ? "wav" : "png");
      let bytes = await out.toBytes();
      if (kind === "video" && postVf) {
        const { ffmpegVideo } = await import("@/lib/grade/post");
        try {
          bytes = new Uint8Array(await ffmpegVideo(bytes, postVf));
        } catch (e) {
          return { state: "failed", error: `post grade failed: ${e instanceof Error ? e.message : e}` };
        }
      }
      const url = await saveBytes(`generated/${crypto.randomUUID()}.${ext}`, bytes);
      items.push({ type: kind, url });
    }
    if (!items.length) return { state: "failed", error: "comfy produced no outputs" };
    return { state: "completed", output: { items } };
  },

  async cancel(jobId: string, meta) {
    const backend = meta?.comfyBackend === "audio" ? "audio" : "main";
    const job = await comfyClient(backend).jobs.get(jobId).catch(() => null);
    await job?.cancel().catch(() => {});
  },
};

export const comfyKindOutput = JOB_KIND_OUTPUT;
