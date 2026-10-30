import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { signWebhookHeader } from "@/lib/api/webhooks";
import { buildOpenApi } from "@/lib/api/openapi";
import {
  MotionField, MotionFieldError, verifyWebhook,
} from "../../packages/sdk-ts/src/index";
import type {
  Job, JobCreated, JobList, JobOutput, Me, Model, Run, RunStep,
  SkillDetail, SkillSummary, SystemInfo, WebhookEvent,
} from "../../packages/sdk-ts/src/index";
import { TERMINAL_RUN_STATUSES } from "../../packages/sdk-ts/src/index";

vi.setConfig({ testTimeout: 30_000 });

/* ---- a fake v1 server on 127.0.0.1:0 ---- */

const seen: { method: string; url: string; idem: string | null; auth: string | null }[] = [];
const slowReleasers: (() => void)[] = [];
let submits = 0;
let gets = 0;
let runGets = 0;
/** >0 → the next N POST /api/v1/runs answer 409 idempotency_in_progress. */
let runBusy = 0;

function send(res: import("node:http").ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(text);
}

function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { resolve({}); }
    });
  });
}

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    seen.push({ method: req.method!, url: url.pathname + url.search, idem: req.headers["idempotency-key"] as string ?? null, auth: req.headers.authorization as string ?? null });

    if (req.method === "GET" && url.pathname === "/api/v1/models")
      return send(res, 200, { models: [{ id: "motionfield/z-image-turbo/text-to-image", kind: "image", label: "Z · Generate", inputs: { type: "object" }, license: { class: "open", components: [] }, estimate: { credits: 0.08 }, tier: "local" }] });
    if (req.method === "POST" && url.pathname === "/api/v1/estimate")
      return send(res, 200, { credits: 0.08, usd: 0.0008, unlimited: false });
    if (req.method === "POST" && url.pathname === "/api/v1/jobs") {
      submits++;
      if (submits === 1) return send(res, 429, { error: { code: "rate_limited", message: "slow down" } }, { "retry-after": "1" });
      return send(res, 202, { id: "job-1", status: "queued", created_at: "2026-01-01T00:00:00Z", links: { self: "/api/v1/jobs/job-1", cancel: "/api/v1/jobs/job-1/cancel", result: "/api/v1/jobs/job-1/result" } });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/jobs/job-1") {
      gets++;
      return gets === 1
        ? send(res, 200, { id: "job-1", status: "queued", progress: 0, outputs: [], error: null, created_at: "t", updated_at: "t" })
        : send(res, 200, { id: "job-1", status: "completed", progress: 100, outputs: [{ url: "/files/generated/x.png", type: "image/png", bytes: 4 }], error: null, created_at: "t", updated_at: "t" });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/jobs/job-stuck")
      return send(res, 200, { id: "job-stuck", status: "queued", progress: 0, outputs: [], error: null, created_at: "t", updated_at: "t" });
    if (req.method === "GET" && url.pathname === "/api/v1/jobs/job-slow") {
      // holds the response until released - proves a caller signal reaches fetch
      slowReleasers.push(() => send(res, 200, { id: "job-slow", status: "queued", progress: 0, outputs: [], error: null, created_at: "t", updated_at: "t" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/jobs/job-1/result")
      return send(res, 200, "PNGBYTES", { "content-type": "image/png" });
    if (req.method === "POST" && url.pathname === "/api/v1/jobs/job-1/cancel")
      return send(res, 200, { id: "job-1", status: "canceled", progress: 0, outputs: [], error: null, created_at: "t", updated_at: "t" });
    if (req.method === "POST" && url.pathname === "/api/v1/uploads")
      return send(res, 201, { url: "/files/uploads/up.png" });
    if (req.method === "GET" && url.pathname === "/api/v1/jobs/restricted")
      return send(res, 403, { error: { code: "restricted_license", license: "CC-BY-NC-4.0", enable_at: "/settings/licenses", message: "endpoint requires a license opt-in" } });
    if (req.method === "POST" && url.pathname === "/api/v1/runs") {
      if (runBusy > 0) {
        runBusy--;
        return send(res, 409, {
          error: { code: "idempotency_in_progress", message: "same-key create still in flight" },
        }, { "retry-after": "0" });
      }
      return send(res, 201, {
        id: "run-1", status: "awaiting_approval", title: null, mode: "auto",
        ask_first: true, project_id: null,
        estimate: { credits: 0.16, eta_seconds: null },
        planner: { via: "built-in planner", fallback_reason: null },
        steps: [{ id: "s1", title: "Generate", endpoint: "motionfield/z-image-turbo/text-to-image",
                  status: "pending", rev: 0, job_id: null, outputs: [], error: null, depends_on: [] }],
        created_at: "t", updated_at: "t",
        links: { self: "/api/v1/runs/run-1", approve: "/api/v1/runs/run-1/approve", control: "/api/v1/runs/run-1/control" },
      });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/runs/run-1") {
      runGets++;
      const status = runGets === 1 ? "running" : "done";
      return send(res, 200, {
        id: "run-1", status, title: null, mode: "auto", ask_first: false, project_id: null,
        estimate: { credits: 0.16, eta_seconds: null },
        planner: { via: "built-in planner", fallback_reason: null },
        steps: [{ id: "s1", title: "Generate", endpoint: "motionfield/z-image-turbo/text-to-image",
                  status: status === "done" ? "done" : "running", rev: 1, job_id: "job-1",
                  outputs: [], error: null, depends_on: [] }],
        created_at: "t", updated_at: "t",
        links: { self: "/api/v1/runs/run-1", approve: "/api/v1/runs/run-1/approve", control: "/api/v1/runs/run-1/control" },
      });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/runs/run-1/approve")
      return send(res, 200, { id: "run-1", status: "running", steps: [] });
    if (req.method === "POST" && url.pathname === "/api/v1/runs/run-1/control") {
      const body = await readBody(req);
      return send(res, 200, { id: "run-1", status: body.action === "pause" ? "paused" : "running", steps: [] });
    }
    if (req.method === "PATCH" && url.pathname === "/api/v1/runs/run-1/steps/s1") {
      const body = await readBody(req);
      if (body.rev !== 1)
        return send(res, 409, { error: { code: "stale_revision", message: "the step changed since you loaded it", head_rev: 1 } });
      return send(res, 200, { id: "run-1", status: "awaiting_approval", steps: [{ id: "s1", rev: 2 }] });
    }
    return send(res, 404, { error: { code: "not_found", message: "job not found" } });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const client = () => new MotionField({ baseUrl: base, apiKey: "of_test_key", timeoutMs: 5000 });

describe("sdk-ts against a fake v1 server", () => {
  it("models + estimate decode", async () => {
    const c = client();
    const models = await c.models();
    expect(models[0].id).toBe("motionfield/z-image-turbo/text-to-image");
    expect(models[0].estimate.credits).toBe(0.08);
    const est = await c.estimate("motionfield/z-image-turbo/text-to-image", { prompt: "x" });
    expect(est.credits).toBe(0.08);
  });

  it("submit sends an Idempotency-Key, honors Retry-After, and retries a 429 once", async () => {
    submits = 0;
    const c = client();
    const job = await c.submit("motionfield/z-image-turbo/text-to-image", { prompt: "x" });
    expect(job.id).toBe("job-1");
    expect(submits).toBe(2); // 429 then 202
    const postCalls = seen.filter((s) => s.url === "/api/v1/jobs" && s.method === "POST");
    expect(postCalls.length).toBe(2);
    expect(postCalls[0].idem).toBeTruthy();
    // the default key is a WebCrypto UUID (globalThis.crypto.randomUUID)
    expect(postCalls[0].idem).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(postCalls[0].idem).toBe(postCalls[1].idem); // same key on the retry
    expect(postCalls[0].auth).toBe("Bearer of_test_key");
  });

  it("wait polls to a terminal state and download returns the bytes", async () => {
    gets = 0;
    const c = client();
    const job = await c.wait("job-1", { intervalMs: 50, timeoutMs: 10_000 });
    expect(job.status).toBe("completed");
    expect(job.outputs[0].type).toBe("image/png");
    const { bytes, contentType } = await c.download(job.id);
    expect(new TextDecoder().decode(bytes)).toBe("PNGBYTES");
    expect(contentType).toBe("image/png");
  });

  it("wait expiry throws MotionFieldError wait_timeout", async () => {
    const c = client();
    await expect(c.wait("job-stuck", { intervalMs: 20, timeoutMs: 80 }))
      .rejects.toMatchObject({ code: "wait_timeout", status: 0 });
  });

  it("wait's signal aborts the in-flight GET, not just the gap between polls", async () => {
    const c = client();
    const ac = new AbortController();
    const t0 = performance.now();
    const p = c.wait("job-slow", { intervalMs: 50, timeoutMs: 30_000, signal: ac.signal });
    // let the first GET reach the server and park there
    const deadline = Date.now() + 5_000;
    while (slowReleasers.length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    expect(slowReleasers.length).toBe(1);
    ac.abort();
    try {
      await expect(p).rejects.toMatchObject({ code: "aborted", status: 0 });
      // rejected off the abort, not by waiting out the 30s budget
      expect(performance.now() - t0).toBeLessThan(5_000);
    } finally {
      for (const r of slowReleasers.splice(0)) r();
    }
  });

  it("cancel returns the job view", async () => {
    const c = client();
    const job = await c.cancel("job-1");
    expect(job.status).toBe("canceled");
  });

  it("runs: create carries an Idempotency-Key; approve/control/edit hit the documented paths; stale_rev surfaces headRev; waitRun polls", async () => {
    const c = client();
    const run = await c.createRun({ plan: { steps: [{ id: "s1", title: "t", endpoint_id: "ep" }] } });
    expect(run.id).toBe("run-1");
    expect(run.status).toBe("awaiting_approval");
    const posts = seen.filter((s) => s.method === "POST" && s.url === "/api/v1/runs");
    expect(posts.at(-1)?.idem).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(posts.at(-1)?.auth).toBe("Bearer of_test_key");

    expect((await c.approveRun("run-1")).status).toBe("running");
    expect((await c.controlRun("run-1", "pause")).status).toBe("paused");
    const edited = await c.editStep("run-1", "s1", { rev: 1, title: "renamed" });
    expect((edited.steps as { rev: number }[])[0].rev).toBe(2);
    const stale = await c.editStep("run-1", "s1", { rev: 99, title: "x" }).catch((e) => e);
    expect(stale).toBeInstanceOf(MotionFieldError);
    expect(stale.code).toBe("stale_revision");
    expect(stale.headRev).toBe(1);

    runGets = 0;
    const done = await c.waitRun("run-1", { intervalMs: 50, timeoutMs: 10_000 });
    expect(done.status).toBe("done");
    expect(done.steps[0].job_id).toBe("job-1");
    // pause on a terminal run is a server-side no-op - the view comes back
    const urls = seen.map((s) => `${s.method} ${s.url}`);
    expect(urls).toContain("POST /api/v1/runs/run-1/approve");
    expect(urls).toContain("POST /api/v1/runs/run-1/control");
    expect(urls).toContain("PATCH /api/v1/runs/run-1/steps/s1");
  });

  it("createRun retries a 409 idempotency_in_progress on the same key until the winner lands", async () => {
    const c = client();
    runBusy = 2; // two in-flight answers, then the replay
    const run = await c.createRun({ plan: { steps: [{ id: "s1", title: "t", endpoint_id: "ep" }] } });
    expect(run.id).toBe("run-1");
    const posts = seen.filter((s) => s.method === "POST" && s.url === "/api/v1/runs");
    expect(posts.length).toBeGreaterThanOrEqual(3);
    const last3 = posts.slice(-3);
    expect(last3.every((p) => p.idem === last3[0].idem)).toBe(true);
  });

  it("waitRun expiry throws MotionFieldError wait_timeout; statuses stay exhaustive", async () => {
    // every terminal status the engine emits is in the SDK's set - a new
    // status would leave waitRun polling forever, so assert exhaustiveness
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual(["done", "failed", "stopped"]);
    // job-stuck equivalent for runs: serve "running" forever via a tiny server
    const stuck = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "run-stuck", status: "running", steps: [] }));
    });
    await new Promise<void>((r) => stuck.listen(0, "127.0.0.1", r));
    try {
      const c2 = new MotionField({ baseUrl: `http://127.0.0.1:${(stuck.address() as AddressInfo).port}`, apiKey: "of_test_key" });
      await expect(c2.waitRun("run-stuck", { intervalMs: 20, timeoutMs: 80 }))
        .rejects.toMatchObject({ code: "wait_timeout", status: 0 });
    } finally {
      stuck.close();
    }
  });

  it("upload posts a multipart body and decodes { url }", async () => {
    const c = client();
    const up = await c.upload(new Uint8Array([1, 2, 3]), { filename: "x.png", contentType: "image/png" });
    expect(up.url).toBe("/files/uploads/up.png");
  });

  it("does not forward Authorization across a cross-origin redirect", async () => {
    // the result route answers 302 for provider-hosted outputs - fetch must
    // not carry the Bearer token to the redirected host
    let targetAuth: string | null = "unset";
    const target = createServer((req, res) => {
      targetAuth = req.headers.authorization ?? null;
      res.writeHead(200, { "content-type": "image/png" });
      res.end("REDIRECTED-BYTES");
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const bouncer = createServer((_req, res) => {
      res.writeHead(302, {
        location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/out.png`,
      });
      res.end();
    });
    await new Promise<void>((r) => bouncer.listen(0, "127.0.0.1", r));
    try {
      const c = new MotionField({
        baseUrl: `http://127.0.0.1:${(bouncer.address() as AddressInfo).port}`,
        apiKey: "of_secret",
      });
      const { bytes } = await c.download("job-1");
      expect(new TextDecoder().decode(bytes)).toBe("REDIRECTED-BYTES");
      expect(targetAuth).toBeNull();
    } finally {
      bouncer.close();
      target.close();
    }
  });

  it("maps error envelopes - including restricted_license fields", async () => {
    const c = client();
    await expect(c.get("missing")).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(c.get("restricted")).rejects.toMatchObject({
      code: "restricted_license", status: 403,
      license: "CC-BY-NC-4.0", enableAt: "/settings/licenses",
    });
    const err = await c.get("restricted").catch((e) => e);
    expect(err).toBeInstanceOf(MotionFieldError);
  });
});

/* ---- SDK wire types must enumerate exactly what buildOpenApi() promises ---- */

type SchemaObject = { required?: string[]; properties?: Record<string, unknown> };

/** SDK key list == schema properties == schema required. `satisfies` makes
 *  tsc fail on type-side drift; the expects fail vitest on spec-side drift. */
function expectKeys(keys: Record<string, true>, schema: unknown) {
  const want = Object.keys(keys).sort();
  const s = schema as SchemaObject;
  expect(Object.keys(s.properties ?? {}).sort(), "properties").toEqual(want);
  expect([...(s.required ?? [])].sort(), "required").toEqual(want);
}

describe("sdk-ts wire types track the OpenAPI contract", () => {
  type SchemaObject = { required?: string[]; properties?: Record<string, SchemaObject>; items?: SchemaObject };
  type OpenApiDoc = {
    components: { schemas: Record<string, SchemaObject> };
    paths: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: SchemaObject }> }> }>>;
    webhooks: Record<string, { post: { requestBody: { content: Record<string, { schema: SchemaObject }> } } }>;
  };
  const prop = (s: SchemaObject | undefined, name: string): SchemaObject => {
    const p = s?.properties?.[name];
    if (!p) throw new Error(`schema missing property ${name}`);
    return p;
  };
  const doc = buildOpenApi() as unknown as OpenApiDoc;
  const jobSchema = doc.components.schemas.Job;
  const jobCreatedSchema = doc.components.schemas.JobCreated;
  const modelSchema = prop(
    doc.paths["/api/v1/models"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema,
    "models",
  ).items!;
  const hookSchema = doc.webhooks["job.completed"].post.requestBody
    .content["application/json"].schema;

  it("Job, JobOutput, JobCreated, links, Model and WebhookEvent key lists", () => {
    const job = {
      id: true, status: true, progress: true, endpoint: true, kind: true,
      params: true, outputs: true,
      error: true, source: true, created_at: true, updated_at: true,
    } satisfies Record<keyof Job, true>;
    const jobOutput = {
      url: true, type: true, bytes: true,
    } satisfies Record<keyof JobOutput, true>;
    const jobCreated = {
      id: true, status: true, created_at: true, links: true,
    } satisfies Record<keyof JobCreated, true>;
    const links = {
      self: true, cancel: true, result: true,
    } satisfies Record<keyof JobCreated["links"], true>;
    const model = {
      id: true, kind: true, label: true, tags: true, inputs: true,
      license: true, estimate: true, tier: true,
    } satisfies Record<keyof Model, true>;
    const webhookEvent = {
      id: true, type: true, created: true, data: true,
    } satisfies Record<keyof WebhookEvent, true>;

    expectKeys(job, jobSchema);
    expectKeys(jobOutput, prop(jobSchema, "outputs").items!);
    expectKeys(jobCreated, jobCreatedSchema);
    expectKeys(links, prop(jobCreatedSchema, "links"));
    expectKeys(model, modelSchema);
    expectKeys(webhookEvent, hookSchema);
  });

  it("WebhookEvent.type covers every declared webhook operation", () => {
    expect(Object.keys(doc.webhooks).sort()).toEqual(
      ["job.canceled", "job.completed", "job.failed", "job.nsfw"]);
  });

  it("Me, SystemInfo, SkillSummary, SkillDetail and JobList key lists", () => {
    const me = {
      user_id: true, email: true, plan: true, credits: true, key: true,
    } satisfies Record<keyof Me, true>;
    const meKey = { id: true, label: true } satisfies Record<keyof Me["key"], true>;
    const system = {
      queue: true, gpu: true, tier: true, disk: true,
    } satisfies Record<keyof SystemInfo, true>;
    const queue = { queued: true, in_progress: true } satisfies Record<keyof SystemInfo["queue"], true>;
    const gpu = { busy: true } satisfies Record<keyof SystemInfo["gpu"], true>;
    const disk = { free_gb: true } satisfies Record<keyof SystemInfo["disk"], true>;
    const skillSummary = {
      slug: true, name: true, description: true,
    } satisfies Record<keyof SkillSummary, true>;
    const skillDetail = {
      slug: true, name: true, description: true, skill_md: true,
    } satisfies Record<keyof SkillDetail, true>;
    const jobList = {
      jobs: true, next_cursor: true,
    } satisfies Record<keyof JobList, true>;

    const meSchema = doc.components.schemas.Me;
    const sysSchema = doc.components.schemas.SystemInfo;
    expectKeys(me, meSchema);
    expectKeys(meKey, prop(meSchema, "key"));
    expectKeys(system, sysSchema);
    expectKeys(queue, prop(sysSchema, "queue"));
    expectKeys(gpu, prop(sysSchema, "gpu"));
    expectKeys(disk, prop(sysSchema, "disk"));
    expectKeys(skillSummary, doc.components.schemas.SkillSummary);
    expectKeys(skillDetail, doc.components.schemas.SkillDetail);
    expectKeys(jobList, doc.components.schemas.JobList);
  });

  it("Run, RunStep, Run.estimate, Run.planner and Run.links key lists", () => {
    const run = {
      id: true, status: true, title: true, mode: true, ask_first: true,
      project_id: true, estimate: true, planner: true, steps: true,
      created_at: true, updated_at: true, links: true,
    } satisfies Record<keyof Run, true>;
    const runStep = {
      id: true, title: true, endpoint: true, status: true, rev: true,
      job_id: true, outputs: true, error: true, depends_on: true,
    } satisfies Record<keyof RunStep, true>;
    const estimate = { credits: true, eta_seconds: true } satisfies Record<keyof Run["estimate"], true>;
    const planner = { via: true, fallback_reason: true } satisfies Record<keyof Run["planner"], true>;
    const links = { self: true, approve: true, control: true } satisfies Record<keyof Run["links"], true>;

    const runSchema = doc.components.schemas.Run;
    const runStepSchema = doc.components.schemas.RunStep;
    expectKeys(run, runSchema);
    expectKeys(runStep, runStepSchema);
    expectKeys(estimate, prop(runSchema, "estimate"));
    expectKeys(planner, prop(runSchema, "planner"));
    expectKeys(links, prop(runSchema, "links"));
    // the steps array is typed RunStep[] in the SDK and $refs RunStep in the spec
    const stepsProp = prop(runSchema, "steps") as { items?: { $ref?: string } };
    expect(stepsProp.items?.$ref).toBe("#/components/schemas/RunStep");
  });
});

describe("verifyWebhook (sdk)", () => {
  const secret = "ofwh_test_secret";
  const body = JSON.stringify({ id: "e", type: "job.completed", data: {} });

  it("accepts a real header, rejects tampering/staleness", () => {
    const t = Math.floor(Date.now() / 1000);
    const header = signWebhookHeader(secret, body, t);
    expect(verifyWebhook(secret, header, body)).toBe(true);
    expect(verifyWebhook(secret, header, new TextEncoder().encode(body))).toBe(true);
    expect(verifyWebhook(secret, header, body + " ")).toBe(false);
    expect(verifyWebhook("ofwh_wrong", header, body)).toBe(false);
    expect(verifyWebhook(secret, header, body, { nowSec: t + 301 })).toBe(false);
    expect(verifyWebhook(secret, "t=abc,v1=zzz", body)).toBe(false);
    expect(verifyWebhook(secret, null, body)).toBe(false);
  });

  it("takes a one-element header array (Node receivers); any other array fails closed", () => {
    const t = Math.floor(Date.now() / 1000);
    const header = signWebhookHeader(secret, body, t);
    expect(verifyWebhook(secret, [header], body)).toBe(true);
    expect(verifyWebhook(secret, [header, header], body)).toBe(false);
    expect(verifyWebhook(secret, [], body)).toBe(false);
    expect(verifyWebhook(secret, ["bogus"], body)).toBe(false);
  });
});
