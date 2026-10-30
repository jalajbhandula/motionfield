"""unittest suite for the stdlib MotionField SDK - run by tests/unit/ws1-sdk-py
via `python3 -I -B -m unittest discover -s packages/sdk-py/tests`."""

import asyncio
import hashlib
import hmac
import json
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # -I drops PYTHONPATH

from motionfield import AsyncClient, Client, MotionFieldError, verify_webhook


class Handler(BaseHTTPRequestHandler):
    submits = 0
    gets = 0
    run_gets = 0
    # >0 → the next N POST /api/v1/runs answer 409 idempotency_in_progress
    run_busy = 0
    calls: list[dict] = []

    def _send(self, status, body, headers=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _record(self):
        self.calls.append({
            "method": self.command,
            "path": self.path,
            "idem": self.headers.get("idempotency-key"),
            "auth": self.headers.get("authorization"),
        })

    def do_GET(self):
        self._record()
        path = self.path.split("?")[0]
        if path == "/api/v1/me":
            return self._send(200, {"user_id": "u-1", "email": "u@t.dev", "plan": "pro",
                                    "credits": 42.5, "key": {"id": "key-row-id", "label": "ci"}})
        if path == "/api/v1/system":
            return self._send(200, {"queue": {"queued": 1, "in_progress": 0},
                                    "gpu": {"busy": False}, "tier": "local",
                                    "disk": {"free_gb": 128.4}})
        if path == "/api/v1/capabilities":
            return self._send(200, {"capabilities": ["jobs", "jobs.list", "skills.read", "system"]})
        if path == "/api/v1/skills":
            return self._send(200, {"skills": [{"slug": "narrated-explainer",
                                               "name": "Narrated Explainer",
                                               "description": "Topic → narrated video"}]})
        if path == "/api/v1/skills/narrated-explainer":
            return self._send(200, {"slug": "narrated-explainer", "name": "Narrated Explainer",
                                    "description": "Topic → narrated video",
                                    "skill_md": "---\nname: Narrated Explainer\n---\n# x\n"})
        if path == "/api/v1/jobs":
            return self._send(200, {"jobs": [{"id": "job-1", "status": "completed", "progress": 100,
                                             "outputs": [], "error": None,
                                             "created_at": "t", "updated_at": "t"}],
                                    "next_cursor": "c3RyaW5nfGlk"})
        if path == "/api/v1/models":
            return self._send(200, {"models": [{
                "id": "motionfield/z-image-turbo/text-to-image", "kind": "image",
                "label": "Z · Generate", "inputs": {"type": "object"},
                "license": {"class": "open", "components": []},
                "estimate": {"credits": 0.08}, "tier": "local"}]})
        if path == "/api/v1/jobs/job-1":
            Handler.gets += 1
            if Handler.gets == 1:
                return self._send(200, {"id": "job-1", "status": "queued", "progress": 0,
                                        "outputs": [], "error": None,
                                        "created_at": "t", "updated_at": "t"})
            return self._send(200, {"id": "job-1", "status": "completed", "progress": 100,
                                    "outputs": [{"url": "/files/generated/x.png",
                                                 "type": "image/png", "bytes": 8}],
                                    "error": None, "created_at": "t", "updated_at": "t"})
        if path == "/api/v1/jobs/job-stuck":
            return self._send(200, {"id": "job-stuck", "status": "queued", "progress": 0,
                                    "outputs": [], "error": None,
                                    "created_at": "t", "updated_at": "t"})
        if path == "/api/v1/jobs/job-1/result":
            self.send_response(200)
            self.send_header("content-type", "image/png")
            self.end_headers()
            self.wfile.write(b"PNGBYTES")
            return
        if path == "/api/v1/jobs/restricted":
            return self._send(403, {"error": {"code": "restricted_license",
                                              "license": "CC-BY-NC-4.0",
                                              "enable_at": "/settings/licenses",
                                              "message": "endpoint requires a license opt-in"}})
        if path == "/api/v1/runs/run-1":
            Handler.run_gets += 1
            status = "running" if Handler.run_gets == 1 else "done"
            return self._send(200, {"id": "run-1", "status": status, "title": None,
                                    "mode": "auto", "ask_first": False, "project_id": None,
                                    "estimate": {"credits": 0.16, "eta_seconds": None},
                                    "planner": {"via": "built-in planner", "fallback_reason": None},
                                    "steps": [{"id": "s1", "title": "Generate", "endpoint": "ep",
                                               "status": "done" if status == "done" else "running",
                                               "rev": 1, "job_id": "job-1", "outputs": [],
                                               "error": None, "depends_on": []}],
                                    "created_at": "t", "updated_at": "t",
                                    "links": {"self": "/api/v1/runs/run-1",
                                              "approve": "/api/v1/runs/run-1/approve",
                                              "control": "/api/v1/runs/run-1/control"}})
        return self._send(404, {"error": {"code": "not_found", "message": "job not found"}})

    def do_POST(self):
        self._record()
        path = self.path.split("?")[0]
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        self.calls[-1]["body"] = body.decode("utf8", "replace")
        if path == "/api/v1/estimate":
            return self._send(200, {"credits": 0.08, "usd": 0.0008, "unlimited": False})
        if path == "/api/v1/jobs":
            Handler.submits += 1
            if Handler.submits == 1:
                return self._send(429, {"error": {"code": "rate_limited", "message": "slow down"}},
                                  {"retry-after": "1"})
            return self._send(202, {"id": "job-1", "status": "queued",
                                    "created_at": "2026-01-01T00:00:00Z",
                                    "links": {"self": "/api/v1/jobs/job-1",
                                              "cancel": "/api/v1/jobs/job-1/cancel",
                                              "result": "/api/v1/jobs/job-1/result"}})
        if path == "/api/v1/jobs/job-1/cancel":
            return self._send(200, {"id": "job-1", "status": "canceled", "progress": 0,
                                    "outputs": [], "error": None, "created_at": "t", "updated_at": "t"})
        if path == "/api/v1/runs":
            if Handler.run_busy > 0:
                Handler.run_busy -= 1
                return self._send(409, {"error": {"code": "idempotency_in_progress",
                                                  "message": "same-key create still in flight"}},
                                  {"retry-after": "0"})
            return self._send(201, {"id": "run-1", "status": "running", "title": None,
                                    "mode": "auto", "ask_first": False, "project_id": None,
                                    "estimate": {"credits": 0.16, "eta_seconds": None},
                                    "planner": {"via": "built-in planner", "fallback_reason": None},
                                    "steps": [], "created_at": "t", "updated_at": "t",
                                    "links": {"self": "/api/v1/runs/run-1",
                                              "approve": "/api/v1/runs/run-1/approve",
                                              "control": "/api/v1/runs/run-1/control"}})
        if path == "/api/v1/runs/run-1/approve":
            return self._send(200, {"id": "run-1", "status": "running", "steps": []})
        if path == "/api/v1/runs/run-1/control":
            return self._send(200, {"id": "run-1", "status": "paused", "steps": []})
        if path == "/api/v1/uploads":
            return self._send(201, {"url": "/files/uploads/up.png"})
        return self._send(404, {"error": {"code": "not_found", "message": "nope"}})

    def do_PATCH(self):
        self._record()
        path = self.path.split("?")[0]
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        if path == "/api/v1/runs/run-1/steps/s1":
            spec = json.loads(body)
            if spec.get("rev") != 1:
                return self._send(409, {"error": {"code": "stale_revision",
                                                "message": "the step changed since you loaded it - refresh and try again",
                                                "head_rev": 1}})
            return self._send(200, {"id": "run-1", "status": "awaiting_approval",
                                    "steps": [{"id": "s1", "rev": 2}]})
        return self._send(404, {"error": {"code": "not_found", "message": "step not found"}})

    def log_message(self, *args):  # quiet
        pass


class ServerFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.client = Client(cls.base, "of_test_key", timeout=10.0)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join(timeout=5)

    def setUp(self):
        Handler.calls.clear()

    def test_models_and_estimate(self):
        models = self.client.models()
        self.assertEqual(models[0]["id"], "motionfield/z-image-turbo/text-to-image")
        self.assertEqual(models[0]["estimate"]["credits"], 0.08)
        est = self.client.estimate("motionfield/z-image-turbo/text-to-image", {"prompt": "x"})
        self.assertEqual(est["credits"], 0.08)

    def test_submit_retries_429_with_idempotency_key(self):
        Handler.submits = 0
        t0 = time.monotonic()
        job = self.client.submit("motionfield/z-image-turbo/text-to-image", {"prompt": "x"})
        elapsed = time.monotonic() - t0
        self.assertEqual(job["id"], "job-1")
        self.assertEqual(Handler.submits, 2)
        self.assertGreaterEqual(elapsed, 0.9)  # Retry-After: 1 honored
        posts = [c for c in Handler.calls if c["method"] == "POST" and c["path"] == "/api/v1/jobs"]
        self.assertEqual(len(posts), 2)
        self.assertTrue(posts[0]["idem"])
        self.assertEqual(posts[0]["idem"], posts[1]["idem"])
        self.assertEqual(posts[0]["auth"], "Bearer of_test_key")

    def test_wait_and_download(self):
        Handler.gets = 0
        job = self.client.wait("job-1", interval=0.05, timeout=10)
        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["outputs"][0]["type"], "image/png")
        self.assertEqual(self.client.download(job["id"]), b"PNGBYTES")

    def test_wait_expiry_raises_wait_timeout(self):
        with self.assertRaises(MotionFieldError) as ctx:
            self.client.wait("job-stuck", interval=0.05, timeout=0.12)
        self.assertEqual(ctx.exception.code, "wait_timeout")
        self.assertEqual(ctx.exception.status, 0)

    def test_cancel(self):
        self.assertEqual(self.client.cancel("job-1")["status"], "canceled")

    def test_upload_multipart(self):
        up = self.client.upload(b"\x89PNG\r\n\x1a\n", filename="x.png", content_type="image/png")
        self.assertEqual(up["url"], "/files/uploads/up.png")

    def test_identity_system_capabilities(self):
        """me/system/capabilities read the new routes."""
        me = self.client.me()
        self.assertEqual(me["user_id"], "u-1")
        self.assertEqual(me["key"]["label"], "ci")
        self.assertNotIn("secret", json.dumps(me))
        system = self.client.system()
        self.assertEqual(system["queue"]["queued"], 1)
        self.assertEqual(system["tier"], "local")
        self.assertEqual(self.client.capabilities(),
                         ["jobs", "jobs.list", "skills.read", "system"])

    def test_list_jobs_and_skills(self):
        """jobs list pagination params + skills endpoints."""
        page = self.client.list_jobs(limit=10, status="completed", before="abc")
        self.assertEqual(page["jobs"][0]["id"], "job-1")
        self.assertEqual(page["next_cursor"], "c3RyaW5nfGlk")
        q = [c["path"] for c in Handler.calls if c["path"].startswith("/api/v1/jobs?")][0]
        self.assertIn("limit=10", q)
        self.assertIn("status=completed", q)
        self.assertIn("before=abc", q)
        skills = self.client.skills()
        self.assertEqual(skills[0]["slug"], "narrated-explainer")
        detail = self.client.skill("narrated-explainer")
        self.assertTrue(detail["skill_md"].startswith("---"))

    def test_runs_surface(self):
        """[OF-0759] create_run always carries an Idempotency-Key; get/approve/
        control/edit_step hit the documented paths; wait_run polls to terminal."""
        run = self.client.create_run(plan={"steps": [
            {"id": "s1", "title": "t", "endpoint_id": "ep"}]})
        self.assertEqual(run["id"], "run-1")
        posts = [c for c in Handler.calls if c["method"] == "POST" and c["path"] == "/api/v1/runs"]
        self.assertTrue(posts[0]["idem"])
        self.assertEqual(posts[0]["auth"], "Bearer of_test_key")

        self.assertEqual(self.client.approve_run("run-1")["status"], "running")
        self.assertEqual(self.client.control_run("run-1", "pause")["status"], "paused")
        edited = self.client.edit_step("run-1", "s1", rev=1, title="renamed")
        self.assertEqual(edited["steps"][0]["rev"], 2)
        with self.assertRaises(MotionFieldError) as stale:
            self.client.edit_step("run-1", "s1", rev=99, title="x")
        self.assertEqual(stale.exception.code, "stale_revision")
        self.assertEqual(stale.exception.head_rev, 1)

        Handler.run_gets = 0
        done = self.client.wait_run("run-1", interval=0.05, timeout=10)
        self.assertEqual(done["status"], "done")

    def test_create_run_retries_in_progress_and_sends_inputs(self):
        """[OF-0759] a 409 idempotency_in_progress replays on the same key
        until the in-flight create lands; media inputs ride the body."""
        Handler.run_busy = 2
        run = self.client.create_run(
            plan={"steps": [{"id": "s1", "title": "t", "endpoint_id": "ep"}]},
            inputs=[{"url": "/files/uploads/up.png", "mime": "image/png"}])
        self.assertEqual(run["id"], "run-1")
        posts = [c for c in Handler.calls
                 if c["method"] == "POST" and c["path"] == "/api/v1/runs"]
        self.assertEqual(len(posts), 3)
        self.assertEqual({p["idem"] for p in posts}, {posts[0]["idem"]})
        body = json.loads(posts[0]["body"])
        self.assertEqual(body["inputs"],
                         [{"url": "/files/uploads/up.png", "mime": "image/png"}])

    def test_error_envelope(self):
        with self.assertRaises(MotionFieldError) as ctx:
            self.client.get("missing")
        self.assertEqual(ctx.exception.status, 404)
        self.assertEqual(ctx.exception.code, "not_found")

        with self.assertRaises(MotionFieldError) as ctx2:
            self.client.get("restricted")
        self.assertEqual(ctx2.exception.status, 403)
        self.assertEqual(ctx2.exception.code, "restricted_license")
        self.assertEqual(ctx2.exception.license, "CC-BY-NC-4.0")
        self.assertEqual(ctx2.exception.enable_at, "/settings/licenses")


class RedirectAuthTest(unittest.TestCase):
    """The result route answers 302 for provider-hosted outputs - urllib's
    default redirect handler would copy Authorization to that other host."""

    def test_cross_origin_redirect_drops_authorization(self):
        seen: dict = {}

        class Target(BaseHTTPRequestHandler):
            def do_GET(self):
                seen["authorization"] = self.headers.get("authorization")
                data = b"REDIRECTED-BYTES"
                self.send_response(200)
                self.send_header("content-type", "image/png")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        target = ThreadingHTTPServer(("127.0.0.1", 0), Target)
        target_thread = threading.Thread(target=target.serve_forever, daemon=True)
        target_thread.start()

        class Bouncer(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header(
                    "location",
                    f"http://127.0.0.1:{target.server_address[1]}/output.png")
                self.send_header("content-length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        bouncer = ThreadingHTTPServer(("127.0.0.1", 0), Bouncer)
        bouncer_thread = threading.Thread(target=bouncer.serve_forever, daemon=True)
        bouncer_thread.start()
        try:
            client = Client(
                f"http://127.0.0.1:{bouncer.server_address[1]}", "of_secret")
            self.assertEqual(client.download("job-1"), b"REDIRECTED-BYTES")
            self.assertIsNone(seen["authorization"])
        finally:
            bouncer.shutdown()
            target.shutdown()
            bouncer_thread.join(timeout=5)
            target_thread.join(timeout=5)


class AsyncClientTest(ServerFixture):
    def test_async_wait_matches_sync(self):
        """[OF-0858] AsyncClient.wait == Client.wait."""
        Handler.gets = 0
        job = asyncio.run(AsyncClient(self.base, "of_test_key").wait("job-1", interval=0.05, timeout=10))
        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["outputs"][0]["type"], "image/png")


class WebhookVerifyTest(unittest.TestCase):
    """The vitest wrapper passes OF_WH_SECRET/OF_WH_HEADER/OF_WH_BODY so this
    suite verifies a header signed by the server-side TypeScript code."""

    def test_cross_signed_header(self):
        secret = os.environ.get("OF_WH_SECRET")
        header = os.environ.get("OF_WH_HEADER")
        body = os.environ.get("OF_WH_BODY")
        if not (secret and header and body):
            self.skipTest("cross-sign env not set")
        self.assertTrue(verify_webhook(secret, header, body.encode("utf-8")))

    def test_local_sign_and_reject(self):
        secret = "ofwh_test_secret"
        body = json.dumps({"id": "e"}).encode()
        t = int(time.time())
        sig = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
        header = f"t={t},v1={sig}"
        self.assertTrue(verify_webhook(secret, header, body, now=t))
        self.assertFalse(verify_webhook(secret, header, body + b" ", now=t))
        self.assertFalse(verify_webhook("ofwh_wrong", header, body, now=t))
        self.assertFalse(verify_webhook(secret, header, body, now=t + 301))
        self.assertFalse(verify_webhook(secret, "t=x,v1=y", body, now=t))
        self.assertFalse(verify_webhook(secret, None, body, now=t))
        self.assertFalse(verify_webhook(secret, f"t={t},v1={sig[:-2]}zz", body, now=t))


if __name__ == "__main__":
    unittest.main()
