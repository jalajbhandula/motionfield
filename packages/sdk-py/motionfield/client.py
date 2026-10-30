"""Synchronous + thread-wrapped async clients for the MotionField v1 API.

Stdlib only - urllib for HTTP, uuid/mimetypes for multipart, asyncio for the
async facade. Wire contract: docs/API.md / /docs/api.
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from email.utils import parsedate_to_datetime
from typing import Any

TERMINAL_STATUSES = frozenset({"completed", "failed", "nsfw", "canceled"})
TERMINAL_RUN_STATUSES = frozenset({"done", "failed", "stopped"})

_MAX_ATTEMPTS = 3
_BASE_DELAY = 0.3
_MAX_DELAY = 30.0
# A text brief plans server-side (the server's planner budget - default
# 300 s, MOTIONFIELD_PLANNER_BUDGET_MS) - POST /runs needs an attempt window
# that outlives it, and a same-key create still in flight is retried
# inside this total budget.
_CREATE_ATTEMPT_FLOOR = 330.0
_IN_PROGRESS_BUDGET = 340.0


class MotionFieldError(Exception):
    """Every non-2xx v1 response, mapped from the `{error: {code, message}}`
    envelope. `retry_after` (seconds) is set when the server sends Retry-After;
    `license`/`enable_at` carry the 403 restricted_license fields."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        retry_after: float | None = None,
        license: str | None = None,
        enable_at: str | None = None,
        head_rev: int | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.retry_after = retry_after
        self.license = license
        self.enable_at = enable_at
        # 409 stale_revision only - the step's current rev, for refetch-and-retry
        self.head_rev = head_rev

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"MotionFieldError(status={self.status}, code={self.code!r}, message={self.message!r})"


def _retry_after_seconds(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        return max(0.0, parsedate_to_datetime(value).timestamp() - time.time())
    except Exception:
        return None


def _quote_filename(name: str) -> str:
    return name.replace("\\", "\\\\").replace('"', '\\"').replace("\r", "").replace("\n", "")


def _multipart(field: str, filename: str, data: bytes, content_type: str) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    body = b"".join([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="{field}"; filename="{_quote_filename(filename)}"\r\n'.encode(),
        f"Content-Type: {content_type}\r\n\r\n".encode(),
        data,
        b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    return body, f"multipart/form-data; boundary={boundary}"


def _origin(url: str) -> tuple[str | None, str | None, int | None]:
    p = urllib.parse.urlparse(url)
    try:
        port = p.port
    except ValueError:
        port = None
    if port is None:
        port = {"http": 80, "https": 443}.get(p.scheme)
    return (p.scheme, p.hostname, port)


class _RedirectHandler(urllib.request.HTTPRedirectHandler):
    """urllib's default redirect handling copies every header - including
    Authorization - to whatever host a 302 points at. The result route
    legitimately redirects to provider-hosted outputs, so the key must be
    dropped whenever scheme, host or port changes."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and _origin(newurl) != _origin(req.full_url):
            new.remove_header("Authorization")
        return new


class Client:
    """Synchronous client for the MotionField v1 API.

        client = Client("http://localhost:3000", "of_…")
        job = client.wait(client.submit(endpoint, {"prompt": "neon"})["id"])
        png = client.download(job["id"])
    """

    def __init__(self, base_url: str, api_key: str, timeout: float = 30.0,
                 source: str | None = None) -> None:
        """`source` tags every write with X-MotionField-Source - our own clients
        pass "cli" or "mcp"; unset lands tagged "api"."""
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.source = source
        self._opener = urllib.request.build_opener(_RedirectHandler())

    # -- transport ----------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
        retry: bool = False,
        raw: bool = False,
        timeout: float | None = None,
    ) -> Any:
        url = self.base_url + path
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            req_headers = {"authorization": f"Bearer {self.api_key}"}
            if self.source:
                req_headers["x-motionfield-source"] = self.source
            if headers:
                req_headers.update(headers)
            body = data
            if json_body is not None:
                body = json.dumps(json_body).encode("utf-8")
                req_headers.setdefault("content-type", "application/json")
            req = urllib.request.Request(url, data=body, headers=req_headers, method=method)
            try:
                with self._opener.open(req, timeout=timeout if timeout is not None else self.timeout) as res:
                    payload = res.read()
                    return payload if raw else json.loads(payload.decode("utf-8"))
            except urllib.error.HTTPError as e:
                err = self._to_error(e)
                if retry and attempt < _MAX_ATTEMPTS and (err.status == 429 or err.status >= 500):
                    delay = err.retry_after if err.retry_after is not None else _BASE_DELAY * 2 ** (attempt - 1)
                    time.sleep(min(delay, _MAX_DELAY))
                    continue
                raise err from e
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                if retry and attempt < _MAX_ATTEMPTS:
                    time.sleep(min(_BASE_DELAY * 2 ** (attempt - 1), _MAX_DELAY))
                    continue
                raise MotionFieldError(0, "network_error", str(e)) from e
        raise AssertionError("unreachable")

    @staticmethod
    def _to_error(e: urllib.error.HTTPError) -> MotionFieldError:
        code, message = f"http_{e.code}", e.reason or f"HTTP {e.code}"
        lic: str | None = None
        enable: str | None = None
        head_rev: int | None = None
        try:
            env = json.loads(e.read().decode("utf-8"))
            inner = env.get("error")
            if isinstance(inner, dict):
                code = inner.get("code", code)
                message = inner.get("message", message)
                lic = inner.get("license")
                enable = inner.get("enable_at")
                hr = inner.get("head_rev")
                if isinstance(hr, int):
                    head_rev = hr
            elif isinstance(inner, str) and inner:
                # the /api/stage routes answer flat {error: "…", code?,
                # head_revision?} - mapped onto the same codes clients
                # branch on (stale_revision, idempotency_mismatch, not_found)
                message = inner
                hr = env.get("head_revision")
                if isinstance(hr, int):
                    head_rev = hr
                flat = env.get("code")
                if isinstance(flat, str) and flat:
                    code = re.sub(r"[^a-z0-9]+", "_", flat.lower())
                elif e.code == 409 and head_rev is not None:
                    code = "stale_revision"
                elif e.code == 404:
                    code = "not_found"
                elif e.code == 401:
                    code = "unauthorized"
                elif e.code == 403:
                    code = "forbidden"
        except Exception:
            pass
        finally:
            e.close()
        return MotionFieldError(
            e.code, code, message,
            retry_after=_retry_after_seconds(e.headers.get("Retry-After")),
            license=lic, enable_at=enable, head_rev=head_rev,
        )

    # -- endpoints ----------------------------------------------------------

    def me(self) -> dict[str, Any]:
        """GET /api/v1/me - {user_id, email, plan, credits, key:{id,label}}.
        The key itself is never returned."""
        return self._request("GET", "/api/v1/me", retry=True)

    def system(self) -> dict[str, Any]:
        """GET /api/v1/system - {queue, gpu:{busy}, tier, disk:{free_gb}}."""
        return self._request("GET", "/api/v1/system", retry=True)

    def capabilities(self) -> list[str]:
        """GET /api/v1/capabilities - the static registry clients gate
        optional command groups on."""
        return self._request("GET", "/api/v1/capabilities", retry=True)["capabilities"]

    def list_jobs(
        self,
        *,
        limit: int | None = None,
        status: str | None = None,
        before: str | None = None,
        ids: list[str] | None = None,
        kind: str | None = None,
        source: str | None = None,
    ) -> dict[str, Any]:
        """GET /api/v1/jobs - the caller's jobs, newest first, cursor-paginated.
        Follow next_cursor as `before` until None. `ids` (≤12) returns the
        found set in request order."""
        q = urllib.parse.urlencode(
            {k: v for k, v in (
                ("limit", limit), ("status", status), ("before", before),
                ("ids", ",".join(ids) if ids else None), ("kind", kind), ("source", source))
             if v is not None})
        return self._request("GET", f"/api/v1/jobs{'?' + q if q else ''}", retry=True)

    def list_assets(
        self,
        *,
        kind: str | None = None,
        source: str | None = None,
        limit: int | None = None,
        before: str | None = None,
    ) -> dict[str, Any]:
        """GET /api/v1/assets - the caller's generated assets, newest first."""
        q = urllib.parse.urlencode(
            {k: v for k, v in (("kind", kind), ("source", source), ("limit", limit), ("before", before))
             if v is not None})
        return self._request("GET", f"/api/v1/assets{'?' + q if q else ''}", retry=True)

    def list_presets(self, *, kind: str | None = None) -> list[dict[str, Any]]:
        """GET /api/v1/presets - restricted-weight presets stay hidden until
        the caller opts in."""
        q = urllib.parse.urlencode({"kind": kind} if kind else {})
        return self._request("GET", f"/api/v1/presets{'?' + q if q else ''}", retry=True)["presets"]

    def resolve_preset(self, endpoint: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/v1/presets/resolve - what preset/style/effect ids will do
        to a params block, without creating a job."""
        return self._request("POST", "/api/v1/presets/resolve",
                             json_body={"endpoint": endpoint, "params": params or {}}, retry=True)

    def skills(self) -> list[dict[str, Any]]:
        """GET /api/v1/skills - [{slug, name, description}]."""
        return self._request("GET", "/api/v1/skills", retry=True)["skills"]

    def skill(self, slug: str) -> dict[str, Any]:
        """GET /api/v1/skills/:slug - summary plus generated skill_md."""
        return self._request("GET", f"/api/v1/skills/{urllib.parse.quote(slug, safe='')}", retry=True)

    def models(self) -> list[dict[str, Any]]:
        """GET /api/v1/models - each entry carries inputs schema, license and
        estimate; outputs[].type on jobs are MIME types (e.g. model/gltf-binary)."""
        return self._request("GET", "/api/v1/models", retry=True)["models"]

    def estimate(self, endpoint: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/v1/estimate - {credits, usd, unlimited}."""
        return self._request("POST", "/api/v1/estimate",
                             json_body={"endpoint": endpoint, "params": params or {}}, retry=True)

    def submit(
        self,
        endpoint: str,
        params: dict[str, Any] | None = None,
        *,
        webhook_url: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """POST /api/v1/jobs - always sends an Idempotency-Key (random UUID by
        default) and retries transient failures."""
        body: dict[str, Any] = {"endpoint": endpoint, "params": params or {}}
        if webhook_url:
            body["webhook_url"] = webhook_url
        return self._request("POST", "/api/v1/jobs", json_body=body,
                             headers={"idempotency-key": idempotency_key or str(uuid.uuid4())},
                             retry=True)

    def get(self, job_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/v1/jobs/{urllib.parse.quote(job_id, safe='')}", retry=True)

    def cancel(self, job_id: str) -> dict[str, Any]:
        return self._request("POST", f"/api/v1/jobs/{urllib.parse.quote(job_id, safe='')}/cancel", retry=True)

    def wait(self, job_id: str, interval: float = 1.0, timeout: float = 600.0) -> dict[str, Any]:
        """Poll until the job reaches a terminal status; expiry raises
        MotionFieldError with code \"wait_timeout\" (same as the TS SDK)."""
        deadline = time.monotonic() + timeout
        while True:
            job = self.get(job_id)
            if job["status"] in TERMINAL_STATUSES:
                return job
            left = deadline - time.monotonic()
            if left <= 0:
                raise MotionFieldError(
                    0, "wait_timeout",
                    f"job {job_id} still {job['status']} after wait budget")
            time.sleep(min(interval, left))

    def upload(
        self,
        file: bytes | bytearray | str | os.PathLike,
        *,
        filename: str | None = None,
        content_type: str | None = None,
    ) -> dict[str, Any]:
        """POST /api/v1/uploads - accepts bytes or a filesystem path; returns
        {"url": …} to feed into params."""
        if isinstance(file, (str, os.PathLike)):
            path = os.fspath(file)
            filename = filename or os.path.basename(path)
            with open(path, "rb") as f:
                data = f.read()
        else:
            data = bytes(file)
            filename = filename or "upload.bin"
        body, ctype = _multipart("file", filename, data,
                                 content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream")
        return self._request("POST", "/api/v1/uploads", data=body, headers={"content-type": ctype})

    def download(self, job_id: str, index: int = 0, path: str | None = None) -> bytes:
        """GET /api/v1/jobs/:id/result?i=N - the raw output bytes; optionally
        written to `path`."""
        raw = self._request("GET", f"/api/v1/jobs/{urllib.parse.quote(job_id, safe='')}/result?i={index}", raw=True)
        if path is not None:
            with open(path, "wb") as f:
                f.write(raw)
        return raw

    # -- runs ---------------------------------------------------------------

    def create_run(
        self,
        *,
        plan: dict[str, Any] | None = None,
        text: str | None = None,
        planner: str | None = None,
        skill: str | None = None,
        brief: str | None = None,
        answers: dict[str, str] | None = None,
        inputs: list[dict[str, Any]] | None = None,
        mode: str | None = None,
        ask_first: bool | None = None,
        project_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """POST /api/v1/runs - exactly one of plan / text(+planner) /
        skill(+brief+answers). `inputs` are media the run can consume -
        [{"url": "/files/uploads/…", "mime": …}] from POST /api/v1/uploads
        (or earlier job outputs). Always sends an Idempotency-Key (random
        UUID by default). A text brief plans server-side (up to the server's
        planner budget - default 300 s, MOTIONFIELD_PLANNER_BUDGET_MS), so
        that form's per-attempt timeout is at least 330 s; a same-key create
        still in flight answers 409 idempotency_in_progress and is retried
        after the server's Retry-After until the winner's run replays."""
        body: dict[str, Any] = {}
        for k, v in (
            ("plan", plan), ("text", text), ("planner", planner),
            ("skill", skill), ("brief", brief), ("answers", answers),
            ("inputs", inputs),
            ("mode", mode), ("ask_first", ask_first), ("project_id", project_id),
        ):
            if v is not None:
                body[k] = v
        key = idempotency_key or str(uuid.uuid4())
        attempt_timeout = max(self.timeout, _CREATE_ATTEMPT_FLOOR) if text is not None else self.timeout
        deadline = time.monotonic() + _IN_PROGRESS_BUDGET
        while True:
            try:
                return self._request("POST", "/api/v1/runs", json_body=body,
                                     headers={"idempotency-key": key},
                                     retry=True, timeout=attempt_timeout)
            except MotionFieldError as e:
                if e.code != "idempotency_in_progress":
                    raise
                left = deadline - time.monotonic()
                if left <= 0:
                    raise
                time.sleep(min(e.retry_after if e.retry_after is not None else 2.0, left))

    def get_run(self, run_id: str) -> dict[str, Any]:
        """GET /api/v1/runs/:id - live runs tick once on read, like jobs."""
        return self._request("GET", f"/api/v1/runs/{urllib.parse.quote(run_id, safe='')}", retry=True)

    def approve_run(self, run_id: str) -> dict[str, Any]:
        """POST /api/v1/runs/:id/approve - idempotent like the control verbs."""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(run_id, safe='')}/approve", retry=True)

    def control_run(self, run_id: str, action: str) -> dict[str, Any]:
        """POST /api/v1/runs/:id/control - action: pause | resume | stop."""
        return self._request("POST", f"/api/v1/runs/{urllib.parse.quote(run_id, safe='')}/control",
                             json_body={"action": action}, retry=True)

    def edit_step(
        self,
        run_id: str,
        step_id: str,
        *,
        rev: int,
        title: str | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """PATCH /api/v1/runs/:id/steps/:stepId - a stale rev raises
        MotionFieldError(409, "stale_revision") with `head_rev` set to the
        step's current rev."""
        body: dict[str, Any] = {"rev": rev}
        if title is not None:
            body["title"] = title
        if params is not None:
            body["params"] = params
        return self._request(
            "PATCH",
            f"/api/v1/runs/{urllib.parse.quote(run_id, safe='')}/steps/{urllib.parse.quote(step_id, safe='')}",
            json_body=body)

    def wait_run(self, run_id: str, interval: float = 1.0, timeout: float = 600.0) -> dict[str, Any]:
        """Poll until the run reaches a terminal status (done|failed|stopped);
        expiry raises MotionFieldError with code \"wait_timeout\"."""
        deadline = time.monotonic() + timeout
        while True:
            run = self.get_run(run_id)
            if run["status"] in TERMINAL_RUN_STATUSES:
                return run
            left = deadline - time.monotonic()
            if left <= 0:
                raise MotionFieldError(
                    0, "wait_timeout",
                    f"run {run_id} still {run['status']} after wait budget")
            time.sleep(min(interval, left))

    # -- stage (the /api/stage 3D scene API - not v1) -----------------------

    def stage_list(self) -> list[dict[str, Any]]:
        """GET /api/stage - your scenes, newest first."""
        return self._request("GET", "/api/stage", retry=True)["scenes"]

    def stage_create(
        self,
        *,
        prompt: str | None = None,
        empty: bool = False,
        refs: list[str] | None = None,
        duration: float | None = None,
        aspect: str | None = None,
        fps: int | None = None,
    ) -> dict[str, Any]:
        """POST /api/stage - `empty=True` mints the default camera+ground
        scene; `prompt` runs the LLM scene writer (503s when none is
        configured)."""
        body: dict[str, Any] = {}
        if prompt is not None:
            body["prompt"] = prompt
        if empty:
            body["empty"] = True
        if refs is not None:
            body["refs"] = refs
        if duration is not None:
            body["duration"] = duration
        if aspect is not None:
            body["aspect"] = aspect
        if fps is not None:
            body["fps"] = fps
        return self._request("POST", "/api/stage", json_body=body)

    def stage_get(self, scene_id: str) -> dict[str, Any]:
        """GET /api/stage/:id - the live head; a foreign id answers not_found."""
        return self._request("GET", f"/api/stage/{urllib.parse.quote(scene_id, safe='')}", retry=True)

    def stage_inspect(self, scene_id: str, t: str, rev: int | None = None) -> dict[str, Any]:
        """GET /api/stage/:id/inspect?t=meta|tree|shots|physics|problems[&rev=N]."""
        q = urllib.parse.urlencode({"t": t, **({"rev": rev} if rev is not None else {})})
        return self._request("GET", f"/api/stage/{urllib.parse.quote(scene_id, safe='')}/inspect?{q}", retry=True)

    def stage_apply_ops(
        self,
        scene_id: str,
        *,
        base_revision: int,
        ops: list[dict[str, Any]],
        selection: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """POST /api/stage/:id/ops - typed scene mutations under optimistic
        concurrency. `idempotency_key` dedupes byte-identical retries for
        24 h; a stale base_revision raises 409 stale_revision with
        `head_rev` set to the live revision."""
        body: dict[str, Any] = {"base_revision": base_revision, "ops": ops}
        if selection is not None:
            body["selection"] = selection
        headers = {"idempotency-key": idempotency_key} if idempotency_key else None
        return self._request("POST", f"/api/stage/{urllib.parse.quote(scene_id, safe='')}/ops",
                             json_body=body, headers=headers)

    def stage_revisions(self, scene_id: str) -> list[dict[str, Any]]:
        """GET /api/stage/:id/revisions - newest-first history (≤100)."""
        return self._request("GET", f"/api/stage/{urllib.parse.quote(scene_id, safe='')}/revisions", retry=True)["revisions"]

    def stage_revision(self, scene_id: str, rev: int) -> dict[str, Any]:
        """GET /api/stage/:id/revisions/:rev - the full stored scene, read-only."""
        return self._request(
            "GET",
            f"/api/stage/{urllib.parse.quote(scene_id, safe='')}/revisions/{urllib.parse.quote(str(rev), safe='')}",
            retry=True)

    def stage_restore(self, scene_id: str, rev: int, *, base_revision: int) -> dict[str, Any]:
        """POST /api/stage/:id/revisions/:rev/restore - copies the stored
        scene onto a NEW head; history is append-only. A stale base_revision
        raises 409 stale_revision with `head_rev`."""
        return self._request(
            "POST",
            f"/api/stage/{urllib.parse.quote(scene_id, safe='')}/revisions/{urllib.parse.quote(str(rev), safe='')}/restore",
            json_body={"base_revision": base_revision})


class AsyncClient:
    """Async facade - every method delegates to the sync client on a worker
    thread (asyncio.to_thread), so no third-party HTTP dependency is needed."""

    def __init__(self, base_url: str, api_key: str, timeout: float = 30.0,
                 source: str | None = None) -> None:
        self._sync = Client(base_url, api_key, timeout, source=source)

    async def me(self) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.me)

    async def system(self) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.system)

    async def capabilities(self) -> list[str]:
        return await asyncio.to_thread(self._sync.capabilities)

    async def list_jobs(
        self,
        *,
        limit: int | None = None,
        status: str | None = None,
        before: str | None = None,
        ids: list[str] | None = None,
        kind: str | None = None,
        source: str | None = None,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._sync.list_jobs, limit=limit, status=status, before=before,
            ids=ids, kind=kind, source=source)

    async def list_assets(
        self,
        *,
        kind: str | None = None,
        source: str | None = None,
        limit: int | None = None,
        before: str | None = None,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._sync.list_assets, kind=kind, source=source, limit=limit, before=before)

    async def list_presets(self, *, kind: str | None = None) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._sync.list_presets, kind=kind)

    async def resolve_preset(self, endpoint: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.resolve_preset, endpoint, params)

    async def skills(self) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._sync.skills)

    async def skill(self, slug: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.skill, slug)

    async def models(self) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._sync.models)

    async def estimate(self, endpoint: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.estimate, endpoint, params)

    async def submit(
        self,
        endpoint: str,
        params: dict[str, Any] | None = None,
        *,
        webhook_url: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._sync.submit, endpoint, params,
            webhook_url=webhook_url, idempotency_key=idempotency_key)

    async def get(self, job_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.get, job_id)

    async def cancel(self, job_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.cancel, job_id)

    async def wait(self, job_id: str, interval: float = 1.0, timeout: float = 600.0) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.wait, job_id, interval, timeout)

    async def upload(
        self,
        file: bytes | bytearray | str | os.PathLike,
        *,
        filename: str | None = None,
        content_type: str | None = None,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._sync.upload, file, filename=filename, content_type=content_type)

    async def download(self, job_id: str, index: int = 0, path: str | None = None) -> bytes:
        return await asyncio.to_thread(self._sync.download, job_id, index, path)

    async def create_run(self, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.create_run, **kwargs)

    async def get_run(self, run_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.get_run, run_id)

    async def approve_run(self, run_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.approve_run, run_id)

    async def control_run(self, run_id: str, action: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.control_run, run_id, action)

    async def edit_step(
        self,
        run_id: str,
        step_id: str,
        *,
        rev: int,
        title: str | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._sync.edit_step, run_id, step_id, rev=rev, title=title, params=params)

    async def wait_run(self, run_id: str, interval: float = 1.0, timeout: float = 600.0) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.wait_run, run_id, interval, timeout)

    async def stage_list(self) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._sync.stage_list)

    async def stage_create(self, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.stage_create, **kwargs)

    async def stage_get(self, scene_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.stage_get, scene_id)

    async def stage_inspect(self, scene_id: str, t: str, rev: int | None = None) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.stage_inspect, scene_id, t, rev)

    async def stage_apply_ops(self, scene_id: str, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.stage_apply_ops, scene_id, **kwargs)

    async def stage_revisions(self, scene_id: str) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._sync.stage_revisions, scene_id)

    async def stage_revision(self, scene_id: str, rev: int) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.stage_revision, scene_id, rev)

    async def stage_restore(self, scene_id: str, rev: int, *, base_revision: int) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.stage_restore, scene_id, rev, base_revision=base_revision)
