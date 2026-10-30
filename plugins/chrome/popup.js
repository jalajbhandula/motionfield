/* Popup: the recent-jobs strip. Reads the SW's recent list, refreshes live
 * status from GET /api/v1/jobs?ids= (≤12 ids — the same batch route the API
 * documents for pollers), and for completed jobs fetches the first output
 * with the bearer into a blob URL for the thumbnail — each output is fetched
 * exactly once and cached by job id. Rows are created once and their status
 * text updates in place; polling stops once every listed job is terminal.
 * Errors show the API code plus the fix. The key never appears in the DOM. */

import {
  getConfig, apiJson, apiFetch,
  listRecent, TERMINAL_STATUSES, ERROR_KEY,
} from "./lib/api.js";

const jobsEl = document.getElementById("of-jobs");
const bannerEl = document.getElementById("of-banner");
const MAX_POPUP_IDS = 12;
const POLL_MS = 1500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* job id → { row, ep, st, spin? } — the DOM nodes persist between renders so
 * thumbnails never blink; only text and the spinner change in place. */
const rows = new Map();
/* job id → "pending" | "failed" | blob: url — an output download happens
 * once per job per popup lifetime; blob urls are revoked on pagehide. */
const outputs = new Map();

function showBanner(text, isErr, action) {
  bannerEl.textContent = "";
  bannerEl.className = isErr ? "show err" : "show";
  bannerEl.append(text);
  if (action) bannerEl.append(" ", action);
}

function clearBanner() {
  bannerEl.className = "";
  bannerEl.textContent = "";
}

function optionsLink(text) {
  const b = document.createElement("button");
  b.textContent = text;
  b.addEventListener("click", () => chrome.runtime.openOptionsPage());
  return b;
}

/** {code, message, enableAt?} → banner text + the fix that resolves it.
 *  Works for ApiError objects and for the plain {code,message} records the
 *  SW stores under ofLastError. */
function describeError(e, cfg) {
  const code = e?.code ?? "internal_error";
  const message = e?.message ?? String(e);
  switch (code) {
    case "unauthorized":
      return { text: "key rejected — open options", action: optionsLink("Options") };
    case "insufficient_credits":
      return { text: "insufficient credits — add credits in Settings" };
    case "restricted_license": {
      const a = document.createElement("a");
      a.href = `${cfg?.baseUrl ?? ""}${e.enableAt ?? "/settings/licenses"}`;
      a.target = "_blank";
      a.textContent = "enable license";
      return { text: `restricted license — ${message} · `, action: a };
    }
    case "not_configured":
      return { text: "not configured — open options", action: optionsLink("Options") };
    case "fetch_failed":
      return { text: `${message} — grant site access in options`, action: optionsLink("Options") };
    case "bad_source":
    case "unsupported_media_type":
    case "payload_too_large":
      return { text: message };
    default:
      return { text: `${code}: ${message}` };
  }
}

function newRow() {
  const row = document.createElement("div");
  row.className = "job";
  const meta = document.createElement("div");
  meta.className = "meta";
  const ep = document.createElement("div");
  ep.className = "ep";
  const st = document.createElement("div");
  st.className = "st";
  meta.append(ep, st);
  row.append(meta);
  return { row, ep, st, spin: null };
}

/** Download a completed job's first output exactly once — bearer into a
 *  blob URL so the media tag itself never needs auth. */
function ensureOutput(cfg, j, refs) {
  const out = j.outputs?.[0];
  if (!out?.url || outputs.has(j.id)) return;
  outputs.set(j.id, "pending");
  const el = document.createElement(
    out.type?.startsWith("video/") ? "video" : out.type?.startsWith("audio/") ? "audio" : "img");
  el.dataset.testid = "output";
  el.dataset.bytes = String(out.bytes ?? "");
  el.muted = true;
  el.controls = out.type?.startsWith("image/") === false;
  refs.row.append(el);
  apiFetch(cfg, `${cfg.baseUrl}${new URL(out.url, cfg.baseUrl).pathname}`)
    .then((r) => r.blob())
    .then((b) => {
      const u = URL.createObjectURL(b);
      // a blob url already parked under this id leaks if it's overwritten —
      // revoke before replacing (the map also survives a dead fetch retry)
      const prev = outputs.get(j.id);
      if (typeof prev === "string" && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
      outputs.set(j.id, u);
      el.src = u;
    })
    .catch(() => {
      outputs.set(j.id, "failed");
      el.remove(); // a broken img icon is worse than no thumb
      // the render loop re-stamps the " · output fetch failed" suffix from
      // the map — writing it here once would vanish on the next render
    });
}

async function render() {
  const cfg = await getConfig();
  if (!cfg?.apiKey) {
    showBanner("not configured — open options", true, optionsLink("Options"));
    rows.clear();
    jobsEl.innerHTML = "";
    return;
  }

  const recent = (await listRecent()).slice(0, MAX_POPUP_IDS);
  // fresh views for the visible ids — a snapshot, the SW's per-job polling is
  // what ticks them server-side
  let jobs = [];
  try {
    // only real UUIDs reach the query — a malformed id in storage would make
    // the whole ?ids= request a 400
    const ids = recent.map((j) => j.id).filter((id) => UUID_RE.test(id));
    if (ids.length) {
      const r = await apiJson(cfg, `/api/v1/jobs?ids=${ids.join(",")}`);
      jobs = r.jobs ?? [];
    }
    // an action error (failed upload, rejected key) surfaces once here
    const last = (await chrome.storage.local.get(ERROR_KEY))[ERROR_KEY];
    if (last && Date.now() - last.at < 60_000) {
      const d = describeError(last, cfg);
      showBanner(d.text, true, d.action);
    } else {
      clearBanner();
    }
  } catch (e) {
    const d = describeError(e, cfg);
    showBanner(d.text, true, d.action);
    return e; // the poll scheduler backs off on failures, stops on dead keys
  }

  // drop rows for jobs that fell off the recent list
  const listed = new Set(jobs.map((j) => j.id));
  for (const [id, refs] of rows) {
    if (listed.has(id)) continue;
    rows.delete(id);
    refs.row.remove();
  }

  if (!jobs.length) {
    jobsEl.innerHTML = "";
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "no recent jobs — right-click an image or video to send one";
    jobsEl.append(p);
    stopPolling(); // nothing live to follow
    return;
  }
  jobsEl.querySelector(".empty")?.remove();

  let allTerminal = true;
  for (const j of jobs) {
    let refs = rows.get(j.id);
    if (!refs) {
      refs = newRow();
      rows.set(j.id, refs);
    }
    refs.ep.textContent = j.endpoint ?? "job";
    const bytes = j.outputs?.[0]?.bytes;
    refs.st.textContent = `${j.status}${j.error ? ` — ${j.error}` : ""}${bytes ? ` · ${bytes} B` : ""}` +
      (outputs.get(j.id) === "failed" ? " · output fetch failed" : "");
    if (TERMINAL_STATUSES.has(j.status)) {
      refs.spin?.remove();
      refs.spin = null;
      if (j.status === "completed") ensureOutput(cfg, j, refs);
    } else {
      allTerminal = false;
      if (!refs.spin) {
        const spin = document.createElement("div");
        spin.className = "st";
        spin.textContent = "…";
        refs.spin = spin;
        refs.row.append(spin);
      }
    }
  }
  // re-append ONLY when the listed order changed — appending the same
  // sequence every poll is needless DOM churn on rows that persist
  const want = jobs.map((j) => rows.get(j.id).row);
  const have = [...jobsEl.querySelectorAll(":scope > .job")];
  if (want.length !== have.length || want.some((r, i) => r !== have[i]))
    for (const r of want) jobsEl.append(r);
  if (allTerminal) stopPolling();
}

/* Self-rescheduling poll with backoff: each failed render doubles the delay
 * (1500ms → 30s cap); an unauthorized answer stops rescheduling entirely —
 * hammering /me-adjacent reads with a dead key helps no one. */
let timer = null;
let stopped = false;
let fails = 0;
const MAX_BACKOFF_MS = 30_000;

function schedule() {
  if (stopped || timer) return;
  timer = setTimeout(() => {
    timer = null;
    void pollOnce();
  }, Math.min(POLL_MS * 2 ** fails, MAX_BACKOFF_MS));
}

async function pollOnce() {
  const err = await render().catch((e) => e);
  if (stopped) return;
  if (err && (err.code === "unauthorized" || err.status === 401)) { stopPolling(); return; }
  fails = err ? fails + 1 : 0;
  schedule();
}

function startPolling() {
  schedule();
}
function stopPolling() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

void render();
startPolling();
window.addEventListener("pagehide", () => {
  stopPolling();
  for (const u of outputs.values())
    if (typeof u === "string" && u.startsWith("blob:")) URL.revokeObjectURL(u);
  outputs.clear();
});
