/* MotionField service worker — owns the "Send to MotionField" context menu, the
 * media fetch → upload → job submit flow, the recent-jobs list and the badge
 * count of live jobs. Runs as an ES module; shared client code lives in
 * lib/api.js. The API key never touches a non-configured origin (see
 * authHeaders). */

import {
  getConfig, apiFetch, apiJson, ApiError,
  UPLOAD_MIMES, MAX_UPLOAD_BYTES, TERMINAL_STATUSES,
  addRecent, listRecent, saveRecent, RECENT_KEY, MENUSPEC_KEY, ERROR_KEY,
} from "./lib/api.js";

const PARENT_ID = "of-send";
const SETUP_ID = "of-setup";
const MAX_MENU = 8;
const POLL_MS = 2500;
const POLL_TICKS_CAP = 240; // ~10 minutes — after that the badge just keeps the last view

/* ---------- media-field picking (shared by menu build + click submit) ---------- */

/** True when the schema property takes this media type — the field's own
 *  `x-media` (`image`/`video`/`audio`) or the items marker inside a media
 *  array. `media` is the "any medium" marker — it matches unless an `accepts`
 *  mime hint narrows the field to specific kinds (e.g. `image/*`). */
function mediaMatch(prop, mediaType) {
  const m = prop?.["x-media"] ?? prop?.items?.["x-media"];
  if (m === mediaType) return true;
  if (m !== "media") return false;
  const acc = prop?.accepts ?? prop?.items?.accepts ?? "";
  return !acc || acc.includes(`${mediaType}/`);
}

/** The param name a right-clicked medium feeds: the first REQUIRED matching
 *  field, else the first matching field in declared order. `array` when the
 *  schema says the value is a list — arrays get [url], not url. */
function pickMediaField(model, mediaType) {
  const props = model.inputs?.properties ?? {};
  const required = new Set(model.inputs?.required ?? []);
  let first = null;
  for (const [name, prop] of Object.entries(props)) {
    if (!mediaMatch(prop, mediaType)) continue;
    const cand = { field: name, array: prop.type === "array" };
    if (required.has(name)) return cand;
    first ??= cand;
  }
  return first;
}

/** True when a click submit can fill every required input honestly: each
 *  required field is either the picked media field or declares a schema
 *  `default`. Anything else would need an invented value, so the endpoint
 *  stays off the menu. */
function requiredFillable(model, mediaField) {
  const props = model.inputs?.properties ?? {};
  return (model.inputs?.required ?? []).every(
    (name) => name === mediaField || props[name]?.default !== undefined);
}

function menuSpecFor(models, mediaType) {
  return models
    .map((m) => ({ m, pick: pickMediaField(m, mediaType) }))
    .filter((x) => x.pick && requiredFillable(x.m, x.pick.field))
    .sort((a, b) => String(a.m.label).localeCompare(String(b.m.label)))
    .slice(0, MAX_MENU)
    .map(({ m, pick }) => ({ endpoint: m.id, label: m.label, field: pick.field, array: pick.array }));
}

/* ---------- context menus ---------- */

async function rebuildMenus() {
  const cfg = await getConfig();
  await chrome.contextMenus.removeAll();
  if (!cfg?.apiKey) {
    chrome.contextMenus.create({ id: SETUP_ID, title: "Set up MotionField…", contexts: ["image", "video"] });
    return;
  }
  // keep the last good spec when the models call fails — a stale menu that
  // errors honestly on click beats a silently empty one
  let spec = (await chrome.storage.local.get(MENUSPEC_KEY))[MENUSPEC_KEY] ?? { image: [], video: [] };
  try {
    const { models } = await apiJson(cfg, "/api/v1/models");
    spec = {
      image: menuSpecFor(models ?? [], "image"),
      video: menuSpecFor(models ?? [], "video"),
    };
    await chrome.storage.local.set({ [MENUSPEC_KEY]: spec });
  } catch { /* keep prior spec */ }
  chrome.contextMenus.create({ id: PARENT_ID, title: "Send to MotionField", contexts: ["image", "video"] });
  for (const mediaType of ["image", "video"]) {
    for (const item of spec[mediaType] ?? []) {
      chrome.contextMenus.create({
        id: `of-ep:${mediaType}:${item.endpoint}`,
        parentId: PARENT_ID,
        title: item.label,
        contexts: [mediaType],
      });
    }
  }
}

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === SETUP_ID) { void chrome.runtime.openOptionsPage(); return; }
  const m = /^of-ep:(image|video):(.+)$/.exec(String(info.menuItemId));
  if (!m || !info.srcUrl) return;
  void onMenuClick({ srcUrl: info.srcUrl, mediaType: m[1], endpoint: m[2] });
});

chrome.runtime.onInstalled.addListener(() => { void rebuildMenus(); void refreshBadge(); void pollLive(); });
chrome.runtime.onStartup.addListener(() => { void rebuildMenus(); void refreshBadge(); void pollLive(); });

// Options saves → chrome.storage.local write → menus rebuild here; no message
// plumbing needed (a dead SW is woken for storage events too).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.ofConfig) return;
  void rebuildMenus();
  void refreshBadge();
});

/* ---------- job submission ---------- */

/** Params for the click: the media field gets the upload url and every other
 *  input keeps its schema-declared `default` — nothing is invented. Endpoints
 *  whose required inputs can't be filled this way never reach the menu
 *  (requiredFillable), and the server re-checks required fields at submit. */
function fillParams(inputs, mediaField, url, array) {
  const params = { [mediaField]: array ? [url] : url };
  for (const [name, p] of Object.entries(inputs?.properties ?? {}))
    if (params[name] === undefined && p?.default !== undefined)
      params[name] = p.default;
  return params;
}

async function recordError(code, message) {
  await chrome.storage.local.set({ [ERROR_KEY]: { code, message, at: Date.now() } });
  return { ok: false, error: { code, message } };
}

async function apiFail(e) {
  if (e instanceof ApiError && e.code === "restricted_license")
    return recordError(e.code, `${e.message} — enable it at ${e.enableAt ?? "/settings/licenses"}`);
  return recordError(e.code ?? "internal_error", e.message);
}

/** POST /api/v1/jobs with one network retry under the SAME Idempotency-Key —
 *  a dropped connection must not be able to mint a second job. */
async function submitJob(cfg, endpoint, params, idemKey) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await apiJson(cfg, "/api/v1/jobs", {
        method: "POST",
        body: { endpoint, params },
        headers: { "Idempotency-Key": idemKey },
      });
    } catch (e) {
      // retry only on transport failures (status 0) — an HTTP answer means the
      // server saw the request, and replaying it would mint a second job
      if (attempt === 1 || (e instanceof ApiError && e.status !== 0)) throw e;
    }
  }
  throw new Error("unreachable");
}

/**
 * The click pipeline: guard the source URL → fetch the media → upload →
 * resolve the endpoint's media field → submit the job → record it.
 * Also exposed as self.motionfield.onMenuClick for the e2e lane.
 */
async function onMenuClick({ srcUrl, mediaType, endpoint }) {
  const cfg = await getConfig();
  if (!cfg?.apiKey) {
    void chrome.runtime.openOptionsPage();
    return recordError("not_configured", "MotionField isn't configured — opening options");
  }
  let u;
  try { u = new URL(srcUrl); } catch { return recordError("bad_source", "that media source isn't a URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "data:")
    return recordError("bad_source", `can't send ${u.protocol} sources — only http(s) and inline data: media`);

  // resolve the endpoint's media field — fresh from the API so a changed
  // schema can't silently write the wrong param
  let model;
  try {
    const { models } = await apiJson(cfg, "/api/v1/models");
    model = (models ?? []).find((m) => m.id === endpoint);
  } catch (e) {
    return apiFail(e);
  }
  const pick = model && pickMediaField(model, mediaType);
  if (!pick) return recordError("not_found", `endpoint ${endpoint} has no ${mediaType} media field`);

  // fetch the media itself — anonymous: no bearer leaves the base origin.
  // The body cap applies while streaming: a chunked body without a
  // Content-Length can't overshoot the 200MB limit before we notice.
  let buf, mime;
  try {
    const res = await fetch(srcUrl);
    if (!res.ok) return recordError("fetch_failed", `the media fetch answered HTTP ${res.status}`);
    // a declared size over the cap fails before the body is even streamed
    if (Number(res.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES)
      return recordError("payload_too_large", "file too large (200MB max)");
    mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (res.body) {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value?.byteLength ?? 0;
        if (total > MAX_UPLOAD_BYTES) {
          await reader.cancel().catch(() => {});
          return recordError("payload_too_large", "file too large (200MB max)");
        }
        if (value) chunks.push(value);
      }
      buf = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) { buf.set(c, at); at += c.byteLength; }
      buf = buf.buffer;
    } else {
      buf = await res.arrayBuffer();
    }
  } catch (e) {
    return recordError("fetch_failed",
      `can't read that media (${e?.message ?? e}) — if it's a website, grant site access in options`);
  }
  if (!mime || !UPLOAD_MIMES.has(mime))
    return recordError("unsupported_media_type", `"${mime || "unknown"}" isn't an accepted upload type`);
  if (buf.byteLength > MAX_UPLOAD_BYTES)
    return recordError("payload_too_large", "file too large (200MB max)");

  let up;
  try {
    const fd = new FormData();
    fd.set("file", new Blob([buf], { type: mime }), `motionfield-${Date.now()}`);
    const res = await apiFetch(cfg, `${cfg.baseUrl}/api/v1/uploads`, { method: "POST", body: fd });
    up = await res.json();
  } catch (e) {
    return apiFail(e);
  }

  let job;
  try {
    job = await submitJob(cfg, endpoint, fillParams(model.inputs, pick.field, up.url, pick.array), crypto.randomUUID());
  } catch (e) {
    return apiFail(e);
  }

  await addRecent({ id: job.id, endpoint, status: job.status ?? "queued", created_at: job.created_at ?? new Date().toISOString() });
  await refreshBadge();
  void pollLive();
  return { ok: true, job: { id: job.id, endpoint, status: job.status ?? "queued" } };
}

/* ---------- badge + live polling ---------- */

async function refreshBadge() {
  const recent = await listRecent();
  const live = recent.filter((j) => !TERMINAL_STATUSES.has(j.status)).length;
  await chrome.action.setBadgeBackgroundColor({ color: "#1d4ed8" });
  await chrome.action.setBadgeText({ text: live ? String(live) : "" });
}

let polling = false;

/* Each GET /api/v1/jobs/:id also ticks the job server-side (the app advances
 * a job on read) — polling individual jobs is how they reach a terminal
 * state in mock/dev mode; the ?ids= list is a snapshot that never ticks. */
async function pollLive() {
  if (polling) return;
  polling = true;
  try {
    for (let tick = 0; tick < POLL_TICKS_CAP; tick++) {
      const cfg = await getConfig();
      if (!cfg?.apiKey) break;
      const recent = await listRecent();
      const live = recent.filter((j) => !TERMINAL_STATUSES.has(j.status));
      if (!live.length) break;
      for (const j of live) {
        try {
          const view = await apiJson(cfg, `/api/v1/jobs/${j.id}`);
          j.status = view.status ?? j.status;
        } catch { /* keep last known status */ }
      }
      await saveRecent(recent);
      await refreshBadge();
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    polling = false;
    await refreshBadge().catch(() => {});
  }
}

/* Exposed for tests + debugging — the e2e fires this with a srcUrl the way a
 * real context-menu click would. */
self.motionfield = { onMenuClick, rebuildMenus };
