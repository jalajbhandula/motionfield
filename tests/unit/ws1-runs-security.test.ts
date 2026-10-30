/**
 * WS1 s8 run surface - behavioural security set:
 *  (a) ownership - user B's bearer gets 404 not_found from every run route
 *      on user A's run (handlers invoked directly, the way ws1-v1-extra does),
 *      an Idempotency-Key is per-user so B reusing A's key mints B's own run
 *      instead of replaying A's view, and A's stored run is untouched by the
 *      whole barrage;
 *  (b) secrets - across 400/404/409/422/201 paths the bearer appears in no
 *      console argument and no response body, and a sentinel prompt value
 *      reaches no console argument;
 *  plus the two static invariants worth keeping: the public run-view
 *  projection carries no internal fields, and every v1_run_idem statement
 *  is owner-scoped.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NextRequest } from "next/server";
import { sql } from "@/db";
import { createApiKey } from "@/lib/api/apikeys";
import { getRunView } from "@/lib/runs";
import { POST as createPOST } from "@/app/api/v1/runs/route";
import { GET as runGET } from "@/app/api/v1/runs/[id]/route";
import { POST as approvePOST } from "@/app/api/v1/runs/[id]/approve/route";
import { POST as controlPOST } from "@/app/api/v1/runs/[id]/control/route";
import { PATCH as stepPATCH } from "@/app/api/v1/runs/[id]/steps/[stepId]/route";

// PGlite setup can exceed the default 10s hook timeout on a busy machine.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

const A = "u-rsec-a";
const B = "u-rsec-b";
const EP = "motionfield/z-image-turbo/text-to-image";
let keyA = "";
let keyB = "";

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET = "test-secret-ws1-0123456789abcdef0123456789ab";
  delete process.env.MOTIONFIELD_HOSTED;
  // no LLM route at all - a dead planner pick must fall back to the built-in
  // planner without a single network call
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_API_KEY;
  for (const k of Object.keys(process.env))
    if (/^LLM_(TASK_|API_KEY_)/.test(k)) delete process.env[k];
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws1-rsec-"));
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
  for (const u of [A, B]) {
    await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$2,$3,true)
               ON CONFLICT (id) DO NOTHING`, [u, u, `${u}@test.dev`]);
    await sql(`INSERT INTO profiles (user_id, credits) VALUES ($1, 25)
               ON CONFLICT (user_id) DO NOTHING`, [u]);
  }
  keyA = (await createApiKey(A, "rsec-a")).key;
  keyB = (await createApiKey(B, "rsec-b")).key;
});

const req = (path: string, key: string | null, init: {
  method?: string; body?: string; headers?: Record<string, string>;
} = {}) =>
  new NextRequest(`http://localhost${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.body,
  });

const plan = (prompt: string) => ({
  title: "sec run",
  steps: [{ id: "s1", title: "frame", endpoint_id: EP, params: { prompt }, depends_on: [] }],
});

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const stepParams = (id: string, stepId: string) =>
  ({ params: Promise.resolve({ id, stepId }) });

describe("ownership - a foreign bearer never reaches the run", () => {
  it("B's key gets 404 from every run route on A's run, a reused Idempotency-Key mints B's own, and A's row is untouched", async () => {
    const idem = `rsec-${crypto.randomUUID()}`;
    const body = JSON.stringify({ plan: plan("a lighthouse"), ask_first: true });
    const mk = await createPOST(req("/api/v1/runs", keyA, {
      body, headers: { "idempotency-key": idem },
    }));
    expect(mk.status).toBe(201);
    const run = (await mk.json()) as { id: string };
    const before = (await getRunView(A, run.id))!;
    expect(before.status).toBe("awaiting_approval");

    // every run handler, invoked directly with B's bearer - each must answer
    // the same 404 a missing run gets; existence stays private
    const hits: [string, () => Promise<Response>][] = [
      ["GET /api/v1/runs/:id", () => runGET(
        req(`/api/v1/runs/${run.id}`, keyB), idParams(run.id))],
      ["POST /api/v1/runs/:id/approve", () => approvePOST(
        req(`/api/v1/runs/${run.id}/approve`, keyB, { method: "POST" }), idParams(run.id))],
      ["POST /api/v1/runs/:id/control {stop}", () => controlPOST(
        req(`/api/v1/runs/${run.id}/control`, keyB, {
          method: "POST", body: JSON.stringify({ action: "stop" }),
        }), idParams(run.id))],
      ["PATCH /api/v1/runs/:id/steps/s1", () => stepPATCH(
        req(`/api/v1/runs/${run.id}/steps/s1`, keyB, {
          method: "PATCH",
          body: JSON.stringify({ rev: before.steps[0].rev, title: "hijacked" }),
        }), stepParams(run.id, "s1"))],
    ];
    for (const [name, call] of hits) {
      const res = await call();
      expect(res.status, name).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    }

    // idempotency keys are per-user: B reusing A's key + identical body must
    // mint B's OWN run - replaying A's would leak the run view across users
    const bMk = await createPOST(req("/api/v1/runs", keyB, {
      body, headers: { "idempotency-key": idem },
    }));
    expect(bMk.status).toBe(201);
    expect(((await bMk.json()) as { id: string }).id).not.toBe(run.id);

    // A's stored run survived the whole barrage - status, rev and title
    // exactly as they were before B's attempts
    const after = (await getRunView(A, run.id))!;
    expect(after.status).toBe("awaiting_approval");
    expect(after.steps[0].rev).toBe(before.steps[0].rev);
    expect(after.steps[0].title).toBe(before.steps[0].title);
  });
});

describe("secrets - the bearer and caller values stay out of logs and bodies", () => {
  it("400/404/409/422/201 leak neither the key nor a sentinel value", async () => {
    const sentinel = `SENTINEL-${crypto.randomUUID()}`;
    const consoleArgs: unknown[][] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { consoleArgs.push(a); }));
    const bodies: string[] = [];
    const drain = async (res: Response) => { bodies.push(await res.text()); return res; };
    try {
      // 400 - an unparseable body
      expect((await drain(await createPOST(
        req("/api/v1/runs", keyA, { body: "this is not json{" })))).status).toBe(400);

      // 404 - a well-formed but unknown run id
      const miss = crypto.randomUUID();
      expect((await drain(await runGET(
        req(`/api/v1/runs/${miss}`, keyA), idParams(miss)))).status).toBe(404);

      // 409 stale_revision - a parked run edited with a rev it never had
      const mk = await createPOST(req("/api/v1/runs", keyA, {
        body: JSON.stringify({ plan: plan("parked"), ask_first: true }),
      }));
      expect(mk.status).toBe(201);
      const parked = (await mk.json()) as { id: string; steps: { rev: number }[] };
      const stale = await drain(await stepPATCH(
        req(`/api/v1/runs/${parked.id}/steps/s1`, keyA, {
          method: "PATCH",
          body: JSON.stringify({ rev: parked.steps[0].rev + 9, params: { prompt: `x ${sentinel}` } }),
        }), stepParams(parked.id, "s1")));
      expect(stale.status).toBe(409);
      expect((JSON.parse(bodies.at(-1)!) as { error: { code: string } }).error.code)
        .toBe("stale_revision");

      // 422 - a plan naming an endpoint that doesn't exist, sentinel as prompt
      const bad = await drain(await createPOST(req("/api/v1/runs", keyA, {
        body: JSON.stringify({
          plan: {
            title: "sentinel run",
            steps: [{ id: "s1", title: "x", endpoint_id: "motionfield/no-such-endpoint/v9",
              params: { prompt: sentinel }, depends_on: [] }],
          },
        }),
      })));
      expect(bad.status).toBe(422);

      // 201 - a text run with a dead planner pick: resolveExplicitRoute
      // refuses "nope" locally, no LLM env is set, so the built-in planner
      // answers without any network call and the fallback is on the view
      const made = await drain(await createPOST(req("/api/v1/runs", keyA, {
        body: JSON.stringify({ text: "make an image of a lighthouse", planner: "nope:nope" }),
      })));
      expect(made.status).toBe(201);
      const view = JSON.parse(bodies.at(-1)!) as {
        planner: { via: string | null; fallback_reason: string | null };
      };
      expect(view.planner.fallback_reason).toBeTruthy();

      const logs = consoleArgs.map((a) => a.map((x) => String(x)).join(" ")).join("\n");
      for (const key of [keyA, keyB]) expect(logs).not.toContain(key);
      expect(logs).not.toContain(sentinel);
      for (const b of bodies) {
        expect(b).not.toContain(keyA);
        expect(b).not.toContain(keyB);
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

/* ---- the two static invariants worth keeping ---- */

const ROOT = resolve(__dirname, "../..");

describe("the run view projection", () => {
  const src = readFileSync(resolve(ROOT, "src/lib/api/runs-v1.ts"), "utf8");
  const fields = (iface: string) => {
    const m = new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`).exec(src);
    expect(m, `${iface} declared`).toBeTruthy();
    return [...m![1].matchAll(/^  (\w+)\??:/gm)].map((x) => x[1]);
  };

  it("RunV1/RunStepV1/RunOutputV1 carry the documented fields and nothing internal", () => {
    expect(fields("RunV1").sort()).toEqual([
      "ask_first", "created_at", "estimate", "id", "links", "mode",
      "planner", "project_id", "status", "steps", "title", "updated_at",
    ].sort());
    // internals stay internal - session ids, user ids, raw plan, idempotency
    // bookkeeping, anything that could carry secret material
    for (const banned of ["user_id", "session_id", "plan", "planner_note", "estimate_credits",
      "idempotency_key", "request_hash", "api_key", "key", "secret", "token", "password"])
      expect(fields("RunV1")).not.toContain(banned);

    expect(fields("RunStepV1").sort()).toEqual([
      "depends_on", "endpoint", "error", "id", "job_id",
      "outputs", "rev", "status", "title",
    ].sort());
    // declared params can embed $step wiring + resolved paths - server-side only
    for (const banned of ["params", "input_hash", "endpoint_id", "model_options", "revisions"])
      expect(fields("RunStepV1")).not.toContain(banned);

    // step outputs are the public {url,type,bytes} contract - never a provider raw
    expect(fields("RunOutputV1").sort()).toEqual(["bytes", "type", "url"].sort());
  });
});

describe("the v1_run_idem statements are all owner-scoped", () => {
  it("SELECT/UPDATE/DELETE carry user_id - one user's keys never reach another", () => {
    const src = readFileSync(resolve(ROOT, "src/lib/api/runs-v1.ts"), "utf8");
    // findRunIdem SELECT + finishRunIdem UPDATE + releaseRunIdem DELETE +
    // the stale-reservation reclaim DELETE - every statement filters user_id
    expect(src.match(/user_id = \$1/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(src).toContain("ON CONFLICT (user_id, idempotency_key) DO NOTHING");
    // a dead reservation is reclaimed, never trusted: the reclaim only fires
    // on rows still NULL past the planner's own budget
    expect(src).toContain("run_id IS NULL");
    expect(src).toContain("interval '10 minutes'");
  });
});
