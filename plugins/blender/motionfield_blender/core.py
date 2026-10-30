# SPDX-License-Identifier: GPL-2.0-or-later
"""MotionField add-on core — every network, file and param rule lives here.

This module never imports bpy, so plain `python3` can exercise it (the e2e
and the security suite drive it straight from the unpacked extension zip).
The Blender half in __init__.py turns these into panel operators and never
adds rules of its own.

Security contract, honored everywhere in this file:
- the API key is never printed, logged, written to a file or filename, or
  shown in an error — user-facing strings pass through `redact()`;
- plain http to a non-loopback host is refused unless the caller opted in;
- downloads only ever land under the caller's output dir, under a name WE
  build from the job id + index + the output's declared MIME — a
  server-supplied name is never used.
"""

from __future__ import annotations

import mimetypes
import os
import re
import sys
import tempfile
import urllib.parse

DEFAULT_BASE_URL = "http://localhost:3000"
DEFAULT_TEXTURE_ENDPOINT = "motionfield/z-image-turbo/text-to-image"
DEFAULT_STILL_ENDPOINT = "motionfield/wan-vace/image-to-video"
DEFAULT_CLIP_ENDPOINT = "motionfield/wan-vace/restyle"

# a rendered frame range is capped here — longer clips belong in the app
MAX_CLIP_FRAMES = 81

_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")

# extension given to a downloaded output — from the declared MIME, never
# from a server filename (mirrors the server's own upload allowlist)
MIME_EXT = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
    "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg",
    "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3", "audio/flac": ".flac", "audio/x-flac": ".flac",
    "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a",
    "audio/aac": ".aac", "audio/webm": ".weba",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
    "model/gltf-binary": ".glb", "model/gltf+json": ".gltf",
}

TERMINAL_STATUSES = frozenset({"completed", "failed", "nsfw", "canceled"})


class AddonError(Exception):
    """The only error shape the panel and CLI show: code + message.

    `status` is the HTTP status when one exists (0 for local/transport
    failures); `retry_after` mirrors the v1 Retry-After header."""

    def __init__(self, code, message, *, status=0, retry_after=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.retry_after = retry_after

    def display(self):
        return f"{self.code}: {self.message}"


def redact(text, *secrets):
    """`text` with every secret value replaced — applied to anything that
    can reach a UI string, a log line or a test's captured output."""
    out = str(text)
    for s in secrets:
        if s:
            out = out.replace(str(s), "***")
    return out


def _sdk():
    """The vendored sdk-py copy (vendor/motionfield inside the built zip).

    Imported lazily so the pure guards in this module run even where the
    vendor tree isn't unpacked. Inside the extension package this is a
    relative import — Blender's vendoring rule, no sys.path edits in the
    bpy half. A plain `python3 -I` run of this file as a top-level module
    (client_e2e.py, the security suite) falls back to a path-based import."""
    try:
        from .vendor.motionfield.client import Client, MotionFieldError  # noqa: PLC0415
        return Client, MotionFieldError
    except (ImportError, ValueError):
        pass
    vendor = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
    if os.path.isdir(vendor) and vendor not in sys.path:
        sys.path.insert(0, vendor)
    from motionfield.client import Client, MotionFieldError  # noqa: PLC0415
    return Client, MotionFieldError


# --------------------------------------------------------------------------
# base URL / client
# --------------------------------------------------------------------------

def normalize_base_url(raw, allow_insecure=False):
    """The configured base URL reduced to `scheme://host[:port]`.

    http(s) only; plain http to anything outside loopback refuses unless the
    caller opted in — a cleartext key on a LAN is a footgun."""
    text = (raw or "").strip()
    if not text:
        raise AddonError("bad_url", "base URL is empty")
    parsed = urllib.parse.urlparse(text if "//" in text else f"http://{text}")
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https") or not parsed.netloc:
        raise AddonError("bad_url", f"base URL must be http(s) — got {redact(raw)!r}")
    host = parsed.hostname or ""
    if scheme == "http" and host.lower() not in _LOOPBACK_HOSTS and not allow_insecure:
        raise AddonError(
            "insecure_url",
            f"plain http to {host} is refused — enable 'allow insecure' to send the key in cleartext")
    return f"{scheme}://{parsed.netloc}"


def make_client(base_url, api_key, *, allow_insecure=False, timeout=60.0,
                online_access=True):
    """A configured v1 client — the key lives only on the client object.

    `online_access` mirrors bpy.app.online_access — when False, only
    loopback hosts connect (Blender's own "no network" switch; a local
    dev server still works)."""
    url = normalize_base_url(base_url, allow_insecure)
    if not online_access:
        host = urllib.parse.urlparse(url).hostname or ""
        if host.lower() not in _LOOPBACK_HOSTS:
            raise AddonError(
                "offline",
                "Blender's online access is off and the server isn't on this machine — "
                "enable it in Preferences → System → Network, or use a loopback URL")
    Client, _ = _sdk()
    return Client(url, api_key, timeout=timeout)


def _map_error(exc, api_key=None):
    """Any failure → AddonError; the v1 envelope's code+message survives,
    the key is redacted, and nothing else (no traceback text) leaks."""
    _, MotionFieldError = _sdk()
    if isinstance(exc, AddonError):
        return exc
    if isinstance(exc, MotionFieldError):
        return AddonError(exc.code, redact(exc.message, api_key),
                          status=exc.status, retry_after=exc.retry_after)
    msg = redact(exc, api_key)
    return AddonError("internal_error", msg or "unexpected error")


def check_connection(base_url, api_key, *, allow_insecure=False, timeout=15.0,
                     online_access=True):
    """GET /api/v1/me → {email, plan, credits} — the preferences 'Check'
    button. Raises AddonError with the envelope's own code+message."""
    client = make_client(base_url, api_key, allow_insecure=allow_insecure,
                         timeout=timeout, online_access=online_access)
    try:
        me = client.me()
    except Exception as e:  # noqa: BLE001 — mapped, never re-raised raw
        raise _map_error(e, api_key) from None
    return {
        "email": me.get("email") or "",
        "plan": me.get("plan") or "",
        "credits": me.get("credits"),
    }


def list_models(client, api_key=None):
    """GET /api/v1/models — the catalog the panel enumerates."""
    try:
        return client.models()
    except Exception as e:  # noqa: BLE001
        raise _map_error(e, api_key) from None


# --------------------------------------------------------------------------
# endpoint picking + params
# --------------------------------------------------------------------------

def _prop_media(prop):
    """The x-media marker of a schema property (on the field or its array
    items), e.g. 'image' | 'video' | 'audio' | 'media', else None."""
    if not isinstance(prop, dict):
        return None
    m = prop.get("x-media")
    if m is None and isinstance(prop.get("items"), dict):
        m = prop["items"].get("x-media")
    return m


def _media_match(prop, media_type):
    """True when the field takes `media_type` — its own marker, or 'media'
    (any kind) narrowed by an `accepts` mime hint when present."""
    m = _prop_media(prop)
    if m == media_type:
        return True
    if m != "media":
        return False
    acc = (prop.get("accepts") or prop.get("items", {}).get("accepts") or "")
    return not acc or f"{media_type}/" in acc


def media_fields(model):
    """[(name, kind, is_array)] — every x-media input in declared order."""
    props = (model.get("inputs") or {}).get("properties") or {}
    out = []
    for name, prop in props.items():
        m = _prop_media(prop)
        if m:
            out.append((name, m, prop.get("type") == "array"))
    return out


def required_media_field(model, media_type):
    """The endpoint's REQUIRED field matching the rendered kind —
    (name, is_array) or None."""
    inputs = model.get("inputs") or {}
    required = set(inputs.get("required") or [])
    for name, prop in (inputs.get("properties") or {}).items():
        if name in required and _media_match(prop, media_type):
            return (name, prop.get("type") == "array")
    return None


# workflow kinds whose job output is a video — mirrors the server's
# JOB_KIND_OUTPUT map; image/edit/upscale endpoints can take a still but
# only give an image back, so they never belong in "Render to video"
_VIDEO_OUTPUT_KINDS = frozenset({"video", "v2v", "avatar"})


def video_endpoints(models, media_type):
    """Endpoints that turn the rendered kind INTO a video — a REQUIRED
    media field matching what was rendered ('image' for a still, 'video'
    for a clip) AND a video output kind, ordered by label. Whatever the
    API lists is what appears — restricted-license endpoints only ever
    reach this list when the server chose to serve them."""
    out = []
    for m in models:
        if m.get("kind") not in _VIDEO_OUTPUT_KINDS:
            continue
        if required_media_field(m, media_type):
            out.append(m)
    out.sort(key=lambda m: str(m.get("label") or m.get("id") or ""))
    return out


def default_endpoint(eligible, preferred):
    """The preselected endpoint id: `preferred` when the API lists it, else
    the first non-LTX eligible — an LTX endpoint is never the default, so
    None comes back when only LTX endpoints are eligible."""
    ids = [m.get("id") for m in eligible]
    if preferred in ids:
        return preferred
    for m in eligible:
        if "ltx" not in str(m.get("id") or "").lower():
            return m.get("id")
    return None


def texture_endpoints(models):
    """Endpoints that can generate an image from a prompt alone (kind
    'image', no required media input), ordered by label."""
    out = []
    for m in models:
        if m.get("kind") != "image":
            continue
        required = set((m.get("inputs") or {}).get("required") or [])
        if any(name in required for name, _, _ in media_fields(m)):
            continue
        out.append(m)
    out.sort(key=lambda m: str(m.get("label") or m.get("id") or ""))
    return out


def find_model(models, endpoint_id):
    for m in models:
        if m.get("id") == endpoint_id:
            return m
    return None


def schema_params(model):
    """The fields the panel may show — every input the schema declares, in
    declared order: {name, type ('string'|'integer'|'number'|'boolean'|
    'enum'|'media'|'other'), enum, default, required, media, array}.

    Media fields are included (flagged) so the caller can skip or treat
    them; 'other' covers shapes the panel declines to draw."""
    inputs = model.get("inputs") or {}
    required = set(inputs.get("required") or [])
    out = []
    for name, prop in (inputs.get("properties") or {}).items():
        if not isinstance(prop, dict):
            prop = {}
        media = _prop_media(prop)
        is_array = prop.get("type") == "array"
        enum = prop.get("enum")
        if media:
            ftype = "media"
        elif enum:
            ftype = "enum"
        elif prop.get("type") in ("string", "integer", "number", "boolean"):
            ftype = prop["type"]
        else:
            ftype = "other"
        out.append({
            "name": name, "type": ftype, "enum": enum or None,
            "default": prop.get("default"), "required": name in required,
            "media": media, "array": is_array,
            "description": prop.get("description") or "",
        })
    return out


def _coerce(f, v):
    """UI values arrive as strings — snap them to the field's declared type:
    an enum value must match a member (type included), numbers coerce, and
    anything that can't is a local missing_param, not a 422."""
    if v is None:
        return None
    if f["type"] == "enum":
        for cand in (v, _num(v)):
            if cand in (f["enum"] or []):
                return cand
        raise AddonError("missing_param",
                         f"{f['name']}: {v!r} isn't one of {f['enum']}")
    if f["type"] == "integer":
        try:
            return int(v)
        except (TypeError, ValueError):
            raise AddonError("missing_param", f"{f['name']} must be an integer") from None
    if f["type"] == "number":
        try:
            return float(v)
        except (TypeError, ValueError):
            raise AddonError("missing_param", f"{f['name']} must be a number") from None
    if f["type"] == "boolean":
        if isinstance(v, str):
            return v.strip().lower() in ("1", "true", "yes", "on")
        return bool(v)
    return v


def _num(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None


def build_params(model, media_field, media_value, values=None, extra_media=None):
    """The submission params for one endpoint.

    The rendered media lands on `media_field` (a list when the schema says
    array); `values` carries the scalar fields the panel drew; `extra_media`
    maps other media inputs to already-uploaded urls (e.g. an optional style
    reference). Every REQUIRED field must resolve to something — the media
    field, a value, an extra media url or a schema default — else the call
    refuses locally instead of inventing a value."""
    values = values or {}
    extra_media = extra_media or {}
    required = set((model.get("inputs") or {}).get("required") or [])
    params = {}
    for f in schema_params(model):
        name = f["name"]
        if name == media_field:
            params[name] = [media_value] if f["array"] else media_value
            continue
        if f["media"]:
            if name in extra_media and extra_media[name]:
                v = extra_media[name]
                params[name] = [v] if f["array"] else v
            elif name in required:
                raise AddonError(
                    "missing_param",
                    f"{model.get('id')} also needs {name} — supply that media too")
            continue
        v = values.get(name)
        if v is None or v == "":
            if f["required"]:
                if f["default"] is not None:
                    params[name] = f["default"]
                else:
                    raise AddonError(
                        "missing_param", f"{model.get('id')} needs {name}")
            elif f["default"] is not None and f["type"] in ("enum", "integer", "number", "boolean"):
                # declared defaults ride along so the job row shows honest
                # resolved params; unset scalars with no default stay out
                params[name] = f["default"]
            continue
        params[name] = _coerce(f, v)
    for name in required:
        if name not in params:
            raise AddonError("missing_param", f"{model.get('id')} needs {name}")
    return params


# --------------------------------------------------------------------------
# outputs / path guard
# --------------------------------------------------------------------------

def output_dir(blend_path=None):
    """`//motionfield/` next to the saved .blend — a stable temp dir while the
    file is unsaved. The only directory downloads may ever land in."""
    if blend_path:
        base = os.path.dirname(os.path.abspath(blend_path))
    else:
        base = os.path.join(tempfile.gettempdir(), "motionfield")
    out = os.path.join(base, "motionfield")
    os.makedirs(out, exist_ok=True)
    return out


def output_filename(job_id, index, mime):
    """The name a download is stored under — OUR name, built from the job id
    + output index + an extension derived from the declared MIME type. A
    server-supplied filename is never used anywhere."""
    if not isinstance(job_id, str) or not _JOB_ID_RE.match(job_id):
        raise AddonError("bad_job_id", "job id isn't a safe name component")
    if not isinstance(index, int) or index < 0 or index > 999:
        raise AddonError("bad_index", "output index out of range")
    clean = (mime or "").split(";")[0].strip().lower()
    return f"{job_id}-{index}{MIME_EXT.get(clean, '.bin')}"


def resolve_output_path(out_dir, name):
    """`name` inside `out_dir`, or a refusal. Only a plain basename resolves —
    separators, .., absolute paths and anything that escapes the directory
    after symlinks resolve are all rejected."""
    if not name or name in (".", ".."):
        raise AddonError("bad_path", "empty output name")
    if os.path.isabs(name):
        raise AddonError("bad_path", "absolute output paths are refused")
    # every separator spelling on every platform we run on — os.path.sep is
    # '/' here, but a crafted name must also fail on Windows' '\\'
    if any(s in name for s in ("/", "\\") + tuple(filter(None, (os.path.sep, os.path.altsep)))):
        raise AddonError("bad_path", "output names must not contain path separators")
    root = os.path.realpath(out_dir)
    path = os.path.realpath(os.path.join(root, name))
    if os.path.dirname(path) != root:
        raise AddonError("bad_path", "output path escapes the download directory")
    return path


# --------------------------------------------------------------------------
# jobs
# --------------------------------------------------------------------------

def submit_job(client, endpoint, params, api_key=None):
    """POST /api/v1/jobs (fresh Idempotency-Key per submit, inside the SDK)."""
    try:
        return client.submit(endpoint, params)
    except Exception as e:  # noqa: BLE001
        raise _map_error(e, api_key) from None


def job_status(client, job_id, api_key=None):
    try:
        return client.get(job_id)
    except Exception as e:  # noqa: BLE001
        raise _map_error(e, api_key) from None


def cancel_job(client, job_id, api_key=None):
    """POST /api/v1/jobs/{id}/cancel — already-terminal jobs return as-is."""
    try:
        return client.cancel(job_id)
    except Exception as e:  # noqa: BLE001
        raise _map_error(e, api_key) from None


def upload_media(client, path, api_key=None):
    """POST /api/v1/uploads for a local render — returns the /files/ url."""
    try:
        return client.upload(path)["url"]
    except Exception as e:  # noqa: BLE001
        raise _map_error(e, api_key) from None


def poll_once(client, job_id, api_key=None):
    """One GET — for the timer-driven panel loop. Returns the job dict;
    terminal statuses stay the caller's to finish."""
    return job_status(client, job_id, api_key=api_key)


def download_outputs(client, job, out_dir, api_key=None):
    """Every output of a completed job → [paths] under `out_dir`, named by
    output_filename(). The output urls themselves are never trusted as
    names — only the index and declared MIME."""
    paths = []
    outputs = job.get("outputs") or []
    for i, o in enumerate(outputs):
        mime = (o or {}).get("type") if isinstance(o, dict) else None
        name = output_filename(job.get("id", ""), i, mime or "")
        path = resolve_output_path(out_dir, name)
        try:
            data = client.download(job["id"], i)
        except Exception as e:  # noqa: BLE001
            raise _map_error(e, api_key) from None
        with open(path, "wb") as f:
            f.write(data)
        paths.append(path)
    return paths


# --------------------------------------------------------------------------
# composed flows (shared by the panel worker and the e2e driver)
# --------------------------------------------------------------------------

def pick_texture_endpoint(models, preferred=DEFAULT_TEXTURE_ENDPOINT):
    return default_endpoint(texture_endpoints(models), preferred)


def submit_texture(client, prompt, *, endpoint=None, values=None, api_key=None):
    """prompt → the picked text-to-image endpoint → the submitted job dict."""
    models = list_models(client, api_key=api_key)
    endpoint = endpoint or pick_texture_endpoint(models)
    model = find_model(models, endpoint or "")
    if not model:
        raise AddonError("not_found", "no text-to-image endpoint is listed")
    params = build_params(model, "__none__", None,
                          values={**(values or {}), "prompt": prompt})
    return submit_job(client, model["id"], params, api_key=api_key)


def pick_video_endpoint(models, media_type, preferred=None):
    """The endpoint a render submits to — default still/clip picks when the
    API lists them."""
    if preferred is None:
        preferred = DEFAULT_STILL_ENDPOINT if media_type == "image" else DEFAULT_CLIP_ENDPOINT
    return default_endpoint(video_endpoints(models, media_type), preferred)


def submit_render(client, render_path, media_type, *, endpoint=None,
                  values=None, extra_media_paths=None, api_key=None):
    """A rendered still/clip → upload → picked endpoint → submitted job.

    `extra_media_paths` maps other media inputs to local files, uploaded the
    same way (an optional style reference, a pose guide…)."""
    models = list_models(client, api_key=api_key)
    endpoint = endpoint or pick_video_endpoint(models, media_type)
    model = find_model(models, endpoint or "")
    if not model:
        raise AddonError("not_found", f"no endpoint takes a {media_type} input")
    pick = required_media_field(model, media_type)
    if not pick:
        raise AddonError("not_found", f"{endpoint} has no required {media_type} input")
    url = upload_media(client, render_path, api_key=api_key)
    extra = {}
    for field, p in (extra_media_paths or {}).items():
        if p:
            extra[field] = upload_media(client, p, api_key=api_key)
    params = build_params(model, pick[0], url, values=values, extra_media=extra)
    return submit_job(client, model["id"], params, api_key=api_key)


def wait_job(client, job_id, *, on_status=None, cancelled=None,
             interval=1.0, timeout=900.0, api_key=None):
    """Blocking poll — the worker-thread path. `cancelled()` returning true
    calls the real cancel endpoint and raises AddonError('canceled')."""
    import time
    deadline = time.monotonic() + timeout
    while True:
        if cancelled and cancelled():
            try:
                cancel_job(client, job_id, api_key=api_key)
            finally:
                raise AddonError("canceled", "cancelled by user")
        job = poll_once(client, job_id, api_key=api_key)
        if on_status:
            on_status(job.get("status", ""), job.get("progress"))
        status = job.get("status")
        if status == "completed":
            return job
        if status in TERMINAL_STATUSES:
            err = job.get("error") or {}
            msg = err.get("message") if isinstance(err, dict) else str(err or "")
            raise AddonError(status or "failed",
                             redact(msg or f"job ended {status}", api_key))
        left = deadline - time.monotonic()
        if left <= 0:
            raise AddonError("wait_timeout", f"job still {status} after wait budget")
        time.sleep(min(interval, left))


def run_job(client, job, out_dir, *, on_status=None, cancelled=None,
            interval=1.0, timeout=900.0, api_key=None):
    """wait → download → (job, [paths]). The one call the panel thread makes."""
    done = wait_job(client, job["id"], on_status=on_status, cancelled=cancelled,
                    interval=interval, timeout=timeout, api_key=api_key)
    return done, download_outputs(client, done, out_dir, api_key=api_key)


def guess_upload_mime(path):
    """Best-effort upload MIME for a render path — the server re-validates."""
    return mimetypes.guess_type(path)[0] or "application/octet-stream"
