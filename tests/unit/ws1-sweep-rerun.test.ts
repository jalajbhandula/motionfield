import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@/db";
import {
  kickWebhookDelivery, webhookSweepIdle, setWebhookSweepDepsForTest,
  type LookupAll, type WebhookTransport,
} from "@/lib/api/webhooks";
import { createApiKey } from "@/lib/api/apikeys";

// PGlite setup can exceed the default 10s hook timeout on a busy machine.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-ws1-0123456789abcdef0123456789ab";
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws1-rerun-"));
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
});

beforeEach(async () => {
  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ('u-rr','rr','rr@test.dev',true)
             ON CONFLICT (id) DO NOTHING`);
});

afterEach(async () => {
  setWebhookSweepDepsForTest(null);
  await webhookSweepIdle();
});

const litLookup: LookupAll = async () => [{ address: "93.184.216.34", family: 4 }];

async function insertDelivery(url: string) {
  const key = await createApiKey("u-rr", "t");
  const id = crypto.randomUUID();
  await sql(
    `INSERT INTO webhook_deliveries (id, job_id, api_key_id, type, url, body, status, next_attempt_at)
     VALUES ($1, $2, $3, 'job.completed', $4, '{}', 'pending', now())`,
    [id, crypto.randomUUID(), key.id, url]);
  return id;
}

const statusOf = async (id: string) =>
  (await sql<{ status: string }>(`SELECT status FROM webhook_deliveries WHERE id = $1`, [id]))[0].status;

describe("sweep rerun", () => {
  it("a kick during a running sweep reruns it - no delivery waits for another request", async () => {
    // First transport attempt parks until released; the rerun's attempts answer 200.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const transport: WebhookTransport = async (spec) => {
      calls++;
      if (calls === 1) await gate;
      return { status: 200 };
    };
    setWebhookSweepDepsForTest({ transport, lookup: litLookup });

    const first = await insertDelivery("http://hook.test/a");
    kickWebhookDelivery();

    // wait until the running sweep has parked inside the first attempt
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && calls === 0) await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);

    // enqueue a second delivery mid-sweep and kick again - it returns early
    // (sweep in flight) but must schedule a rerun.
    const second = await insertDelivery("http://hook.test/b");
    kickWebhookDelivery();

    release();
    await webhookSweepIdle();

    // both delivered; the second needed no further kick
    expect(await statusOf(first)).toBe("delivered");
    expect(await statusOf(second)).toBe("delivered");
    expect(calls).toBe(2);
  });
});
