import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@/db";
import {
  webhookSweepIdle, setWebhookSweepDepsForTest,
  type LookupAll, type WebhookTransport,
} from "@/lib/api/webhooks";
import { createApiKey } from "@/lib/api/apikeys";

// PGlite setup can exceed the default 10s hook timeout on a busy machine.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

/** Stub provider whose submit() always throws - optionally parking on a gate
 *  first so a cancel can land while the submit is still in flight. */
const stub = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  onEnter: null as null | (() => void),
}));
vi.mock("@/lib/generation", () => ({
  getProvider: () => ({
    name: "mock",
    submit: async () => {
      stub.onEnter?.();
      if (stub.gate) await stub.gate;
      throw new Error("provider blew up mid-submit");
    },
    poll: async () => ({ state: "queued" }),
    cancel: async () => {},
  }),
}));

import { createJobEx, cancelJob } from "@/lib/jobs";

const USER = "u-subfail";
const ENDPOINT = "motionfield/z-image-turbo/text-to-image";

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-ws1-0123456789abcdef0123456789ab";
  delete process.env.MOTIONFIELD_HOSTED;
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws1-subfail-"));
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
});

beforeEach(async () => {
  stub.gate = null;
  stub.onEnter = null;
  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$2,$3,true)
             ON CONFLICT (id) DO NOTHING`, [USER, USER, `${USER}@test.dev`]);
  await sql(`INSERT INTO profiles (user_id, credits) VALUES ($1, 100)
             ON CONFLICT (user_id) DO UPDATE SET credits = 100`, [USER]);
});

afterEach(async () => {
  setWebhookSweepDepsForTest(null);
  await webhookSweepIdle();
});

const litLookup: LookupAll = async () => [{ address: "93.184.216.34", family: 4 }];

const recording = (calls: { url: string; body: string }[]): WebhookTransport =>
  async (spec) => { calls.push({ url: spec.url, body: spec.body }); return { status: 200 }; };

const refundsFor = async (jobId: string) =>
  (await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM credit_ledger WHERE user_id = $1 AND kind = 'refund' AND ref_id = $2`,
    [USER, jobId]))[0].n;

const deliveriesFor = async (jobId: string) =>
  sql<{ type: string; status: string }>(
    `SELECT type, status FROM webhook_deliveries WHERE job_id = $1`, [jobId]);

describe("submit failure paths", () => {
  it("submit throws with no cancel: job failed, one refund, one job.failed delivery - kicked, not left pending", async () => {
    const key = await createApiKey(USER, "sf");
    const calls: { url: string; body: string }[] = [];
    setWebhookSweepDepsForTest({ transport: recording(calls), lookup: litLookup });

    const { job } = await createJobEx(USER, {
      endpointId: ENDPOINT,
      params: { prompt: "boom" },
      apiKeyId: key.id,
      webhookUrl: "http://hook.test/x",
    });
    expect(job.status).toBe("failed");
    expect(job.error).toContain("provider blew up");
    expect(await refundsFor(job.id)).toBe(1);

    const rows = await deliveriesFor(job.id);
    expect(rows.map((r) => r.type)).toEqual(["job.failed"]);

    // the kick inside the claim path already ran a sweep - the delivery is
    // delivered without any test-side nudge
    await webhookSweepIdle();
    expect(calls).toHaveLength(1);
    expect((await deliveriesFor(job.id))[0].status).toBe("delivered");
    const evt = JSON.parse(calls[0].body);
    expect(evt.type).toBe("job.failed");
    expect(evt.data.id).toBe(job.id);
    expect(evt.data.status).toBe("failed");
  });

  it("submit throws while a cancel lands: stays canceled, one refund, no job.failed row", async () => {
    const key = await createApiKey(USER, "sf2");
    let release!: () => void;
    stub.gate = new Promise<void>((r) => { release = r; });
    const entered = new Promise<void>((r) => { stub.onEnter = r; });

    const pending = createJobEx(USER, {
      endpointId: ENDPOINT,
      params: { prompt: "cancel me mid-submit" },
      apiKeyId: key.id,
      webhookUrl: "http://hook.test/x",
    });
    await entered; // submit() is parked inside the provider call

    const [{ id: jobId }] = await sql<{ id: string }>(
      `SELECT id FROM jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [USER]);
    const canceled = await cancelJob(USER, jobId);
    expect(canceled.status).toBe("canceled");

    release();
    const { job } = await pending;
    expect(job.id).toBe(jobId);
    expect(job.status).toBe("canceled");

    // the guarded transition lost the claim - no second refund, no job.failed
    expect(await refundsFor(jobId)).toBe(1);
    const rows = await deliveriesFor(jobId);
    expect(rows.map((r) => r.type)).toEqual(["job.canceled"]);
  });
});
