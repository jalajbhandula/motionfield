import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@/db";
import { webhookSweepIdle } from "@/lib/api/webhooks";

// PGlite setup can exceed the default 10s hook timeout on a busy machine.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

/** Stub provider: poll() reports the hoisted state; `gate` (when set) makes
 *  poll() block until released so tests can interleave a mid-poll cancel. */
const stub = vi.hoisted(() => ({
  state: "completed" as "completed" | "failed" | "in_progress",
  gate: null as Promise<void> | null,
  onEnter: null as null | (() => void),
}));
vi.mock("@/lib/generation", () => ({
  getProvider: () => ({
    name: "mock",
    submit: async () => ({ providerJobId: "stub-1" }),
    poll: async () => {
      stub.onEnter?.();
      if (stub.gate) await stub.gate;
      if (stub.state === "in_progress") return { state: "in_progress", progress: 50 };
      return stub.state === "completed"
        ? { state: "completed", output: { items: [{ type: "image", url: "/files/generated/fin.png", width: 8, height: 8 }] } }
        : { state: "failed", error: "stub provider error" };
    },
    cancel: async () => {},
  }),
}));

import { processJobs, tickJob, cancelJob } from "@/lib/jobs";

beforeAll(() => {
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws1-fin-"));
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
});

beforeEach(async () => {
  stub.state = "completed";
  stub.gate = null;
  stub.onEnter = null;
  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ('u-fin','fin','fin@test.dev',true)
             ON CONFLICT (id) DO NOTHING`);
  await sql(`INSERT INTO profiles (user_id, credits) VALUES ('u-fin', 100) ON CONFLICT (user_id) DO NOTHING`);
});

afterEach(async () => {
  // no sweep may outlive its test
  await webhookSweepIdle();
});

async function insertJob(cost = "5"): Promise<string> {
  const [{ id }] = await sql<{ id: string }>(
    `INSERT INTO jobs (user_id, kind, model_id, endpoint_id, workflow, provider, provider_request_id, status, progress, cost_credits, prompt)
     VALUES ('u-fin','image','z-image-turbo','motionfield/z-image-turbo/text-to-image','text-to-image','mock','stub-1','queued',0,$1,'finalize test')
     RETURNING id`, [cost]);
  return id;
}

describe("job finalization happens exactly once", () => {
  it("completed: two concurrent ticks produce 1 asset + 1 notification", async () => {
    const jobId = await insertJob("0");
    await Promise.all([processJobs(), processJobs()]);

    const [{ status }] = await sql<{ status: string }>(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
    expect(status).toBe("completed");

    const [{ n: assets }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM assets WHERE job_id = $1`, [jobId]);
    expect(assets).toBe(1);

    const [{ n: notes }] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE user_id = 'u-fin' AND type = 'job_done'`, []);
    expect(notes).toBe(1);

    const [{ outputs }] = await sql<{ outputs: unknown[] }>(`SELECT outputs FROM jobs WHERE id = $1`, [jobId]);
    expect(Array.isArray(outputs)).toBe(true);
    expect(outputs).toHaveLength(1);
  });

  it("failed: two concurrent ticks refund and notify at most once", async () => {
    stub.state = "failed";
    const jobId = await insertJob("5");
    await Promise.all([processJobs(), processJobs()]);

    const [job] = await sql<{ status: string; error: string | null }>(
      `SELECT status, error FROM jobs WHERE id = $1`, [jobId]);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("stub provider error");

    const [{ n: notes }] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE user_id = 'u-fin' AND type = 'job_failed'`, []);
    expect(notes).toBe(1);

    const [{ n: refunds }] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM credit_ledger WHERE user_id = 'u-fin' AND kind = 'refund' AND ref_id = $1`, [jobId]);
    expect(refunds).toBe(1);
  });

  it("cancel lands during a tick: status stays canceled, exactly one refund, a later completed poll can't resurrect it", async () => {
    const jobId = await insertJob("5");
    // poll() blocks on the gate so cancelJob lands while the tick is in flight.
    let release!: () => void;
    stub.gate = new Promise<void>((r) => { release = r; });
    const entered = new Promise<void>((r) => { stub.onEnter = r; });
    stub.state = "in_progress";

    const tick = tickJob(jobId);
    await entered;                    // the tick is parked inside poll()
    const job = await cancelJob("u-fin", jobId);
    expect(job.status).toBe("canceled");
    release();                        // poll now reports in_progress - too late
    expect(await tick).toBe(false);

    const [{ status }] = await sql<{ status: string }>(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
    expect(status).toBe("canceled");
    const [{ n: refunds }] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM credit_ledger WHERE user_id = 'u-fin' AND kind = 'refund' AND ref_id = $1`, [jobId]);
    expect(refunds).toBe(1);

    // the provider eventually reports completed - the canceled row must win
    stub.state = "completed";
    await processJobs();
    await processJobs();
    const [after] = await sql<{ status: string }>(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
    expect(after.status).toBe("canceled");
    const [{ n: assets }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM assets WHERE job_id = $1`, [jobId]);
    expect(assets).toBe(0);
  });
});
