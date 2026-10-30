/* Options page: save the MotionField base URL + API key into
 * chrome.storage.local - but only after GET /api/v1/me accepts the key, so a
 * typo never sticks. Forget wipes config + recent jobs. The optional
 * all-hosts (http+https) grant is requested here (and only here) because it
 * needs a user gesture. */

import { getConfig, saveConfig, clearConfig, apiJson, ApiError, DEFAULT_BASE } from "./lib/api.js";

const $ = (id) => document.getElementById(id);
const urlEl = $("of-url"), keyEl = $("of-key"), insecureEl = $("of-insecure");
const checkBtn = $("of-check"), forgetBtn = $("of-forget"), grantBtn = $("of-grant");
const statusEl = $("of-status"), grantStatusEl = $("of-grant-status");

function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = cls;
}

/** Loopback = exactly the hosts the manifest's required host_permissions
 *  cover: localhost, 127.0.0.1. Anything else - ::1 (match patterns can't
 *  express it), `foo.localhost`, `127.0.0.2`, `0x7f…` - counts as remote:
 *  the plaintext-key warning applies, and a failed probe hints at the
 *  optional grant rather than pretending the manifest covers it. */
function isLoopback(u) {
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1";
}

async function refresh() {
  const cfg = await getConfig();
  urlEl.value = cfg?.baseUrl ?? DEFAULT_BASE;
  if (cfg?.apiKey) keyEl.placeholder = "•••••••• (saved - paste a new one to replace)";
  insecureEl.checked = !!cfg?.allowInsecure;
  setStatus(cfg?.apiKey ? "configured" : "not configured");
  const granted = await chrome.permissions.contains({ origins: ["http://*/*", "https://*/*"] });
  grantStatusEl.textContent = granted ? "granted" : "not granted";
  grantBtn.textContent = granted ? "Site access granted" : "Grant site access";
  grantBtn.disabled = granted;
}

checkBtn.addEventListener("click", async () => {
  const url = (urlEl.value.trim().replace(/\/+$/, "") || DEFAULT_BASE);
  const key = keyEl.value.trim();
  let parsed;
  try { parsed = new URL(url); } catch { return setStatus("that's not a URL", "err"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return setStatus("base URL must be http(s)", "err");
  if (parsed.protocol === "http:" && !isLoopback(parsed) && !insecureEl.checked)
    return setStatus("http:// to a non-local host sends your key in the clear - tick 'allow insecure' to permit it", "err");
  if (!key) return setStatus("paste an API key first", "err");

  checkBtn.disabled = true;
  setStatus("checking…");
  try {
    // probe BEFORE saving - the key is stored only once /me accepts it
    const me = await apiJson({ baseUrl: url, apiKey: key }, "/api/v1/me");
    await saveConfig({ baseUrl: url, apiKey: key, allowInsecure: insecureEl.checked });
    keyEl.value = "";
    setStatus(`connected - ${me.email} · ${me.plan ?? "no plan"} · ${me.credits} credits`, "ok");
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.code === "unauthorized"))
      setStatus("key rejected - check it in Settings → API keys", "err");
    else if (e instanceof ApiError && e.status === 0 && !isLoopback(parsed))
      // a base the manifest doesn't cover needs the optional grant first -
      // the fetch fails before CORS can even report why
      setStatus(`can't reach MotionField at ${url} - grant site access first, then check again`, "err");
    else
      setStatus(`can't reach MotionField at ${url} (${e.message})`, "err");
  } finally {
    checkBtn.disabled = false;
  }
});

forgetBtn.addEventListener("click", async () => {
  await clearConfig();
  keyEl.value = "";
  keyEl.placeholder = "of_live_…";
  await refresh();
});

grantBtn.addEventListener("click", async () => {
  // this must come from a user gesture - that's why it lives on this button
  // and nowhere else (never silently requested at install/startup)
  const granted = await chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] });
  grantStatusEl.textContent = granted ? "granted" : "not granted";
  await refresh();
});

void refresh();
