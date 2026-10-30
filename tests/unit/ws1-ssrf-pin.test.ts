import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@/db";
import {
  deliverDueWebhooks, webhookSweepIdle, DestinationDeniedError,
  type LookupAll, type WebhookTransport,
} from "@/lib/api/webhooks";
import { createApiKey } from "@/lib/api/apikeys";

// PGlite setup can exceed the default 10s hook timeout on a busy machine.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-ws1-0123456789abcdef0123456789ab";
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws1-pin-"));
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
});

afterEach(async () => {
  await webhookSweepIdle();
});

beforeEach(async () => {
  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ('u-pin','pin','pin@test.dev',true)
             ON CONFLICT (id) DO NOTHING`);
});

describe("connect-time DNS pinning", () => {
  it("a DNS answer that flips between the guard and connect() is refused before any byte is sent", async () => {
    const key = await createApiKey("u-pin", "pin");
    const id = crypto.randomUUID();
    await sql(
      `INSERT INTO webhook_deliveries (id, job_id, api_key_id, type, url, body, status, next_attempt_at)
       VALUES ($1, $2, $3, 'job.completed', 'http://pin.test/hook', '{}', 'pending', now())`,
      [id, crypto.randomUUID(), key.id]);

    // The guard's resolve answers a public IP; the connect-time resolve
    // answers link-local - a classic DNS-rebind flip.
    let lookups = 0;
    const flipLookup: LookupAll = async () =>
      ++lookups === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }];

    // Faithful transport: like http.request it consults spec.lookup before
    // connecting, and only then would "send" anything.
    const connectedTo: string[] = [];
    const sent: string[] = [];
    const transport: WebhookTransport = (spec) =>
      new Promise<{ status: number }>((resolve, reject) => {
        const host = new URL(spec.url).hostname;
        spec.lookup(host, {}, (err, address) => {
          if (err) return reject(err);
          connectedTo.push(String(address));
          sent.push(spec.body);
          resolve({ status: 200 });
        });
      });

    await deliverDueWebhooks(Date.now(), { transport, lookup: flipLookup });

    const [r] = await sql<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM webhook_deliveries WHERE id = $1`, [id]);
    expect(lookups).toBe(2); // guard resolve + connect-time resolve
    expect(connectedTo).toHaveLength(0); // nothing was ever connected to
    expect(sent).toHaveLength(0);
    expect(r.status).toBe("failed");
    expect(r.last_error).toBe("destination not allowed");
  });

  it("connects when both resolves answer approved addresses", async () => {
    const key = await createApiKey("u-pin", "pin2");
    const id = crypto.randomUUID();
    await sql(
      `INSERT INTO webhook_deliveries (id, job_id, api_key_id, type, url, body, status, next_attempt_at)
       VALUES ($1, $2, $3, 'job.completed', 'http://ok.test/hook', 'x', 'pending', now())`,
      [id, crypto.randomUUID(), key.id]);

    const lookup: LookupAll = async () => [{ address: "93.184.216.34", family: 4 }];
    const transport: WebhookTransport = (spec) =>
      new Promise<{ status: number }>((resolve, reject) => {
        spec.lookup(new URL(spec.url).hostname, {}, (err, address) => {
          if (err) return reject(err);
          expect(address).toBe("93.184.216.34");
          resolve({ status: 200 });
        });
      });
    await deliverDueWebhooks(Date.now(), { transport, lookup });
    const [r] = await sql<{ status: string }>(`SELECT status FROM webhook_deliveries WHERE id = $1`, [id]);
    expect(r.status).toBe("delivered");
  });

  it("DestinationDeniedError carries the refusal reason", () => {
    expect(new DestinationDeniedError().message).toBe("destination not allowed");
  });
});
