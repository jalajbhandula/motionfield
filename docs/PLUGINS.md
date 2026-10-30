# Plugins

## Chrome extension (`plugins/chrome/`)

A Manifest V3 extension that adds a **Send to MotionField** context menu to
images and videos on the web. Picking a menu item uploads the media to your
MotionField server and submits a generation job on the endpoint you chose -
the job then behaves like any other API-submitted job (`source: "api"`).

Plain JavaScript, **no build step** - the directory is the extension.

### Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   pick `plugins/chrome/`.
2. Right-click the toolbar icon → **Options** (or click the puzzle-pin →
   options).
3. Set your MotionField URL (`http://localhost:3000` is the default), paste an
   API key from Settings → API keys, and press **Check**. The key is stored
   only after `/api/v1/me` accepts it.

Tested on headless Chromium only (Playwright, unpacked); not tested in desktop Chrome.

### Permissions

| Permission | Why |
| --- | --- |
| `contextMenus` | builds the **Send to MotionField** menu |
| `storage` | config + the recent-jobs list in `chrome.storage.local` |
| `host_permissions`: `http://localhost/*`, `http://127.0.0.1/*` | talking to a locally-running app (the default) |
| `optional_host_permissions`: `http://*/*`, `https://*/*` | **off by default** - the options page's *Grant site access* button requests it, and it's needed for two things: connecting to an MotionField URL that isn't on this machine, and reading media straight off websites (without it, right-clicked media on other origins can't be fetched and you'll get a "can't read that media" error) |

There are **no content scripts** - the extension never reads page content,
only the media URL Chrome hands to the context-menu event. No remote code,
no `eval`, default extension CSP.

### What it does

- On install/startup/options-save the service worker fetches
  `GET /api/v1/models` and rebuilds the menu: a **Send to MotionField** parent
  on `image` and `video` contexts, children = the first eight endpoints
  (ordered by label) whose `inputs` schema carries an `x-media` property
  matching the clicked media type **and** whose every required input is
  either that media field or declares a schema `default` - so a click can
  always submit without inventing values. Restricted-license endpoints
  appear only if the models API returns them.
- A click fetches the media (`http(s)` and `data:` sources only - `blob:`,
  `file:` and `chrome:` sources get an honest error), checks it against the
  server's upload allowlist (media MIME types, ≤ 200 MB), uploads it via
  `POST /api/v1/uploads`, then submits `POST /api/v1/jobs` with a fresh
  `Idempotency-Key` (reused only if the request needs a network retry).
  The submitted `params` are exactly the uploaded URL on the endpoint's
  matching media field plus the schema's declared defaults - the extension
  never fills in a prompt, a number, or a second media input by guessing.
- The toolbar badge counts live jobs; the service worker polls
  `GET /api/v1/jobs/:id` for each live job - reads tick jobs forward, so
  statuses reach a terminal state even in dev mode.
- The popup lists recent jobs (`GET /api/v1/jobs?ids=…`, at most 12 ids)
  with a thumbnail of the first output, fetched with the bearer into a blob
  URL. Errors show the API code plus the fix: `unauthorized` → "key
  rejected - open options", `insufficient_credits` → add credits in
  Settings, `restricted_license` → link to enable it.

### Security notes

- The API key lives in `chrome.storage.local` - **never** `storage.sync`,
  so it can't roam to other machines.
- The bearer header is attached only when the request's origin equals the
  configured MotionField origin. Media fetches to any other origin go out
  anonymously, so the key can never leak to a media host.
- `http://` base URLs to a non-loopback host are refused unless you tick
  **allow insecure** - cleartext keys on a LAN are a footgun.
- "Forget key" in options wipes the stored key, the recent-jobs list and
  the menu spec.

### Troubleshooting

- **"Set up MotionField…" menu item** - no key configured; it opens the
  options page.
- **"can't read that media"** - grant site access on the options page, or
  the site serves a URL the extension can't fetch (protected CDN, hotlink
  rules).
- **"key rejected - open options"** - the key was revoked or mistyped;
  generate a new one and re-check.
- **Menu shows no endpoints** - the models fetch failed (server down or key
  bad); fix options and save again to rebuild.

## Blender extension (`plugins/blender/`)

A Blender 4.2+ extension that talks to your MotionField server from the 3D
Viewport sidebar - generate a texture for the active object, or render the
scene camera and submit it as a video job. **Blender is external and never
bundled** - the extension runs inside Blender's own Python and only speaks
HTTP to the v1 API.

The add-on is **GPL-2.0-or-later** (`plugins/blender/motionfield_blender/LICENSE`,
also `license = ["SPDX:GPL-2.0-or-later"]` in `blender_manifest.toml`). The
pure-python API client is vendored into the built zip at
`vendor/motionfield/` verbatim from `packages/sdk-py/` and stays under its MIT
license (`vendor/motionfield/LICENSE`) - the add-on never edits that copy;
`plugins/blender/build.py` rebuilds it. The app itself remains MIT.

### Build + install

1. `python3 plugins/blender/build.py` → `plugins/blender/dist/motionfield_blender-<ver>.zip`
   (stdlib only; entries are sorted with pinned mtimes, so two builds give
   the same sha256).
2. Blender → **Edit → Preferences → Extensions** → drop-down → **Install
   from Disk…** → pick the zip → enable **MotionField**.
3. Open the extension's preferences and set the **Server URL**
   (`http://localhost:3000` default), paste an **API key** (password field)
   from Settings → API keys, and press **Check** - it calls `GET /api/v1/me`
   and shows email, plan and credits.

### The panel (3D Viewport → N → MotionField)

- **Texture** - a prompt plus a text-to-image endpoint picked from
  `GET /api/v1/models` (kind `image`, no required media; default
  `motionfield/z-image-turbo/text-to-image`). Submit runs
  `POST /api/v1/jobs`, polls `GET /api/v1/jobs/{id}` in a worker thread,
  downloads `GET /api/v1/jobs/{id}/result?i=0` and wires the image into an
  Image Texture node on the active object's material Base Color - a new
  material is created when the object has none.
- **Render to video** - renders the scene camera: one PNG still, or the
  scene frame range (≤81 frames) encoded to MP4 by Blender's own FFMPEG
  output. The render uploads through `POST /api/v1/uploads`, then submits
  to an endpoint whose **required** media input matches AND whose output
  is video - still → `image` inputs (default
  `motionfield/wan-vace/image-to-video`), clip → `video` inputs (default
  `motionfield/wan-vace/restyle`). Endpoints are only ever those the API
  lists - restricted-license models (the LTX family) appear only when the
  server serves them, and never as a default; when only restricted
  endpoints fit, the list shows "(pick an endpoint)" and an empty pick
  refuses rather than preselecting one. The panel shows the prompt plus
  exactly the fields the endpoint's input schema declares; `enum` fields
  draw as dropdowns.
- **Import** - replays the last download: an image becomes a camera-facing
  plane; a video becomes a plane with a movie texture, or a VSE strip when
  you pick that.
- **Refresh / Cancel** - re-fetch the endpoint list, or
  `POST /api/v1/jobs/{id}/cancel` the running job.

Jobs are non-blocking: a worker thread submits and polls while
`bpy.app.timers` mirrors status/progress into the panel. Downloads land in
`//motionfield/` next to the saved `.blend` (a temp dir while unsaved), named
from the job id + output index + declared MIME - a server-supplied filename
is never used.

### Security notes

- The API key lives only in add-on preferences - Blender's own user prefs -
  never on a scene property (those serialize into `.blend`), never in the
  Info log, never printed, never in a filename.
- `http://` base URLs to a non-loopback host are refused unless **allow
  insecure** is ticked - cleartext keys on a LAN are a footgun.
- Errors surface as the v1 envelope's `code` + `message` only - no
  traceback that could carry the key.
- `core.py` contains all network/file/param logic and never imports `bpy`;
  `tests/blender/client_e2e.py` drives it with plain `python3 -I`.

### Headless smoke

`blender --background --factory-startup --python tests/blender/ws1_addon_smoke.py`
with `OF_ZIP`, `MOTIONFIELD_URL` and `MOTIONFIELD_API_KEY` set installs the zip
through `bpy.ops.extensions.package_install_files`, refreshes the endpoint
list, then drives `bpy.ops.motionfield.render_submit()` end to end - render,
submit, worker download via `_pump()` - and checks the downloaded MP4 for
an ftyp box. It covers the operator/worker contract only - it ran against
real Blender 5.2.3 headless, but the interactive GUI panel has **not yet
run on a real Blender - needs a manual test** in a real Blender window.
