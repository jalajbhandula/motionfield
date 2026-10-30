/* MotionField v1 client shared by the service worker and the extension pages.
 * The API key lives in chrome.storage.local (never .sync — it must not leave
 * the machine) and is attached to a request ONLY when the request's origin
 * equals the configured base origin. A media URL on any other origin is
 * fetched anonymously, so the key can never ride a request to a media host. */

export const DEFAULT_BASE = "http://localhost:3000";

/* Mirrors the server's upload allowlist (src/lib/api/upload-rules.ts) — the
 * server re-checks on POST /api/v1/uploads; this set only decides whether a
 * fetched source is worth uploading at all. */
export const UPLOAD_MIMES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif",
  "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/flac",
  "audio/x-flac", "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/aac",
  "audio/webm",
  "video/mp4", "video/webm", "video/quicktime",
]);

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const RECENT_CAP = 20;
export const TERMINAL_STATUSES = new Set(["completed", "failed", "nsfw", "canceled"]);

const CONFIG_KEY = "ofConfig";       // { baseUrl, apiKey, allowInsecure }
export const RECENT_KEY = "ofRecentJobs"; // [{ id, endpoint, status, created_at }] — cap 20
export const ERROR_KEY = "ofLastError";   // { code, message, at }
export const MENUSPEC_KEY = "ofMenuSpec"; // { image: […], video: […] }

/* ---------- config ---------- */

export async function getConfig() {
  const v = await chrome.storage.local.get(CONFIG_KEY);
  return v[CONFIG_KEY] ?? null;
}

export async function saveConfig(cfg) {
  await chrome.storage.local.set({ [CONFIG_KEY]: cfg });
}

export async function clearConfig() {
  await chrome.storage.local.remove([CONFIG_KEY, RECENT_KEY, ERROR_KEY, MENUSPEC_KEY]);
}

/* ---------- errors ---------- */

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.license = extra.license;
    this.enableAt = extra.enable_at;
  }
}

/* ---------- fetch ---------- */

/** Authorization headers for `url` — the bearer is attached ONLY when the
 *  request's origin equals the configured base origin. */
export function authHeaders(cfg, url) {
  try {
    if (cfg?.apiKey && new URL(url).origin === new URL(cfg.baseUrl).origin)
      return { authorization: `Bearer ${cfg.apiKey}` };
  } catch { /* malformed URL → no header */ }
  return {};
}

export async function apiFetch(cfg, url, opts = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      headers: { ...authHeaders(cfg, url), ...(opts.headers ?? {}) },
    });
  } catch (e) {
    throw new ApiError(0, "network_error", e?.message ?? String(e));
  }
  if (!res.ok) {
    let code = `http_${res.status}`, message = res.statusText || `HTTP ${res.status}`, extra = {};
    try {
      const body = await res.json();
      if (body?.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
        extra = body.error;
      }
    } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, code, message, extra);
  }
  return res;
}

export async function apiJson(cfg, path, opts = {}) {
  const url = /^https?:/i.test(path) ? path : `${cfg.baseUrl}${path}`;
  const headers = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await apiFetch(cfg, url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return res.json();
}

/* ---------- recent jobs ---------- */

export async function addRecent(job) {
  const v = await chrome.storage.local.get(RECENT_KEY);
  const list = [job, ...(v[RECENT_KEY] ?? []).filter((j) => j.id !== job.id)].slice(0, RECENT_CAP);
  await chrome.storage.local.set({ [RECENT_KEY]: list });
  return list;
}

export async function listRecent() {
  const v = await chrome.storage.local.get(RECENT_KEY);
  return v[RECENT_KEY] ?? [];
}

export async function saveRecent(list) {
  await chrome.storage.local.set({ [RECENT_KEY]: list.slice(0, RECENT_CAP) });
}
