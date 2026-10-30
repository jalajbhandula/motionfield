import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@/db";
import {
  signWebhookHeader, verifyWebhookSignature,
  encryptWebhookSecret, decryptWebhookSecret, generateWebhookSecret,
  webhookTargetDenied, deliverDueWebhooks,
  webhookSweepIdle, setWebhookSweepDepsForTest,
  type LookupAll, type WebhookTransport,
} from "@/lib/api/webhooks";
import { createApiKey } from "@/lib/api/apikeys";

// PGlite setup can exceed the default 10s hook timeout on a busy machine.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

/** Stub provider: poll() completes immediately - used by the finalization test. */
vi.mock("@/lib/generation", () => ({
  getProvider: () => ({
    name: "mock",
    submit: async () => ({ providerJobId: "stub-1" }),
    poll: async () => ({ state: "completed", output: { items: [{ type: "image", url: "/files/generated/wh.png" }] } }),
    cancel: async () => {},
  }),
}));

import { processJobs } from "@/lib/jobs";

const SECRET = "test-secret-ws1-0123456789abcdef0123456789ab";

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = SECRET;
  delete process.env.MOTIONFIELD_HOSTED;
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws1-wh-"));
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
});

let seq = 0;
beforeEach(async () => {
  seq++;
  const id = `u-wh-${seq}`;
  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$2,$3,true) ON CONFLICT (id) DO NOTHING`,
    [id, id, `${id}@test.dev`]);
  await sql(`INSERT INTO profiles (user_id, credits) VALUES ($1, 1000) ON CONFLICT (user_id) DO NOTHING`, [id]);
});

afterEach(async () => {
  delete process.env.MOTIONFIELD_HOSTED;
  setWebhookSweepDepsForTest(null);
  await webhookSweepIdle();
});

/** Stub resolver: IP literals pass through verbatim (so the guard tests
 *  exercise the real address checks); hostnames resolve to a benign public IP. */
const litLookup: LookupAll = async (host) => {
  const bare = host.replace(/^\[|\]$/g, "");
  const isIpLiteral = /^[\d.]+$/.test(bare) || bare.includes(":");
  return [{ address: isIpLiteral ? bare : "93.184.216.34", family: bare.includes(":") ? 6 : 4 }];
};

/** A transport that records what would be sent and answers `status`. */
function recordingTransport(status: number, calls: { url: string; headers: Record<string, string>; body: string }[]): WebhookTransport {
  return async (spec) => {
    calls.push({ url: spec.url, headers: spec.headers, body: spec.body });
    return { status };
  };
}

const statusTransport = (status: number): WebhookTransport => async () => ({ status });
const throwingTransport = (e: Error): WebhookTransport => async () => { throw e; };

async function insertDelivery(url: string, body = "{}") {
  const key = await createApiKey(`u-wh-${seq}`, "t");
  const id = crypto.randomUUID();
  await sql(
    `INSERT INTO webhook_deliveries (id, job_id, api_key_id, type, url, body, status, next_attempt_at)
     VALUES ($1, $2, $3, 'job.completed', $4, $5, 'pending', now())`,
    [id, crypto.randomUUID(), key.id, url, body]);
  return { id, key };
}

async function deliveryRow(id: string) {
  const [r] = await sql<{
    status: string; attempts: number; last_status: number | null;
    last_error: string | null; next_attempt_at: Date | null; first_attempt_at: Date | null;
  }>(`SELECT status, attempts, last_status, last_error, next_attempt_at, first_attempt_at
      FROM webhook_deliveries WHERE id = $1`, [id]);
  return r;
}

describe("webhook signature", () => {
  it("round-trips and rejects tampering + stale timestamps", () => {
    const secret = generateWebhookSecret();
    const body = JSON.stringify({ hello: "world" });
    const t = Math.floor(Date.now() / 1000);
    const header = signWebhookHeader(secret, body, t);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, header, body, 300, t)).toBe(true);
    // tampered body / wrong secret
    expect(verifyWebhookSignature(secret, header, body + " ", 300, t)).toBe(false);
    expect(verifyWebhookSignature("ofwh_other", header, body, 300, t)).toBe(false);
    // stale timestamp
    expect(verifyWebhookSignature(secret, header, body, 300, t + 301)).toBe(false);
    // malformed header
    expect(verifyWebhookSignature(secret, "t=x,v1=y", body)).toBe(false);
    expect(verifyWebhookSignature(secret, null, body)).toBe(false);
  });
});

describe("secret storage", () => {
  it("encrypt/decrypt round-trips and the column never holds plaintext", async () => {
    const s = generateWebhookSecret();
    expect(s).toMatch(/^ofwh_[A-Za-z0-9_-]{43}$/);
    const enc = encryptWebhookSecret(s);
    expect(enc).toMatch(/^ofe1\./);
    expect(decryptWebhookSecret(enc)).toBe(s);
    expect(decryptWebhookSecret("not-encrypted")).toBeNull();
    expect(decryptWebhookSecret(enc.slice(0, -2) + "xx")).toBeNull(); // tampered tag/ct

    const key = await createApiKey(`u-wh-${seq}`, "enc");
    const [row] = await sql<{ webhook_secret: string }>(
      `SELECT webhook_secret FROM api_keys WHERE id = $1`, [key.id]);
    expect(row.webhook_secret).not.toBe(key.webhookSecret);
    expect(row.webhook_secret).not.toContain("ofwh_");
    expect(decryptWebhookSecret(row.webhook_secret, key.id)).toBe(key.webhookSecret);
    // AAD binds the envelope to the key id - the same ciphertext under another
    // key id does not decrypt
    expect(decryptWebhookSecret(row.webhook_secret, crypto.randomUUID())).toBeNull();
    expect(decryptWebhookSecret(row.webhook_secret)).toBeNull();
  });
});

describe("destination guard", () => {
  it("always refuses link-local / 0.0.0.0 / multicast, and their v6-mapped forms", async () => {
    for (const target of [
      "http://169.254.169.254/latest",
      "http://0.0.0.0:9/x",
      "http://224.0.0.1/x",
      "http://[::ffff:169.254.169.254]/x",
      "http://[fe80::1]/x",
      "http://[ff02::1]/x",
      "http://[::]/x",
    ]) {
      const r = await webhookTargetDenied(target, litLookup);
      expect(r, target).toEqual({ reason: "destination not allowed", retryable: false });
    }
  });

  it("refuses loopback/RFC1918/ULA only when MOTIONFIELD_HOSTED=1", async () => {
    for (const target of ["http://127.0.0.1:8080/h", "http://10.1.2.3/h", "http://192.168.1.1/h", "http://172.16.5.5/h", "http://[::1]/h", "http://[fd00::1]/h"]) {
      delete process.env.MOTIONFIELD_HOSTED;
      expect(await webhookTargetDenied(target, litLookup), `${target} unhosted`).toBeNull();
      process.env.MOTIONFIELD_HOSTED = "1";
      expect(await webhookTargetDenied(target, litLookup), `${target} hosted`).toEqual({ reason: "destination not allowed", retryable: false });
    }
  });

  it("marks a refused delivery failed with 'destination not allowed'", async () => {
    const { id } = await insertDelivery("http://169.254.169.254/x");
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    await deliverDueWebhooks(Date.now(), {
      transport: recordingTransport(200, calls),
      lookup: litLookup,
    });
    const r = await deliveryRow(id);
    expect(r.status).toBe("failed");
    expect(r.last_error).toBe("destination not allowed");
    expect(calls).toHaveLength(0); // no request was ever attempted
  });
});

describe("delivery", () => {
  it("delivers once with a verifiable signature", async () => {
    const body = JSON.stringify({ id: "evt", type: "job.completed", created: 1, data: { id: "j" } });
    const { id, key } = await insertDelivery("http://webhook.test/hook", body);
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    await deliverDueWebhooks(Date.now(), { transport: recordingTransport(200, calls), lookup: litLookup });
    const r = await deliveryRow(id);
    expect(r.status).toBe("delivered");
    expect(r.attempts).toBe(1);
    expect(r.last_status).toBe(200);
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.url).toBe("http://webhook.test/hook");
    expect(c.headers["content-type"]).toBe("application/json");
    expect(c.headers["user-agent"]).toBe("MotionField-Webhooks/1");
    expect(c.headers["x-motionfield-event-id"]).toBe(id);
    // the receiver verifies with the show-once secret against raw bytes
    expect(verifyWebhookSignature(key.webhookSecret, c.headers["x-motionfield-signature"], c.body)).toBe(true);
  });

  it("retries 5xx at +30s/+2m/+10m/+30m/+60m then exhausts (6 attempts)", async () => {
    const { id } = await insertDelivery("http://webhook.test/down");
    const failing = statusTransport(500);
    const t0 = 1_800_000_000_000;
    const gaps = [30, 120, 600, 1800, 3600];
    let at = t0;
    for (let i = 0; i < 6; i++) {
      await deliverDueWebhooks(at, { transport: failing, lookup: litLookup });
      const r = await deliveryRow(id);
      expect(r.attempts).toBe(i + 1);
      if (i < 5) {
        expect(r.status).toBe("pending");
        expect(r.next_attempt_at!.getTime() - at).toBe(gaps[i] * 1000);
        at += gaps[i] * 1000;
      } else {
        expect(r.status).toBe("exhausted");
        expect(r.next_attempt_at).toBeNull();
      }
    }
    // an exhausted row is never claimed again
    const n = await deliverDueWebhooks(at + 3_600_000, { transport: failing, lookup: litLookup });
    expect(n).toBe(0);
  });

  it("fails fast on 404 (single attempt, no retry)", async () => {
    const { id } = await insertDelivery("http://webhook.test/missing");
    await deliverDueWebhooks(Date.now(), { transport: statusTransport(404), lookup: litLookup });
    const r = await deliveryRow(id);
    expect(r.status).toBe("failed");
    expect(r.attempts).toBe(1);
    expect(r.last_status).toBe(404);
  });

  it("retries 429 and network/timeout errors", async () => {
    const { id: a } = await insertDelivery("http://webhook.test/limited");
    await deliverDueWebhooks(Date.now(), { transport: statusTransport(429), lookup: litLookup });
    const { id: b } = await insertDelivery("http://webhook.test/timeout");
    await deliverDueWebhooks(Date.now(), {
      transport: throwingTransport(new Error("The operation timed out")),
      lookup: litLookup,
    });
    const ra = await deliveryRow(a);
    const rb = await deliveryRow(b);
    expect([ra.status, rb.status]).toEqual(["pending", "pending"]);
    expect(ra.last_status).toBe(429);
    expect(rb.last_error).toContain("timed out");
  });

  it("a hanging webhook target never blocks processJobs", async () => {
    const { id } = await insertDelivery("http://93.184.216.34/hook");
    // the transport hangs until released - the kicked sweep must not await it
    const releasers: (() => void)[] = [];
    const hanging: WebhookTransport = () =>
      new Promise<{ status: number }>((resolve) => {
        releasers.push(() => resolve({ status: 200 }));
      });
    setWebhookSweepDepsForTest({ transport: hanging, lookup: litLookup });
    try {
      const t0 = performance.now();
      await processJobs();
      expect(performance.now() - t0).toBeLessThan(1000);

      // let the kicked sweep claim the row and reach the hanging transport,
      // then release it so nothing is left in flight after the test
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (await deliveryRow(id)).status !== "delivering")
        await new Promise((r) => setTimeout(r, 25));
      while (Date.now() < deadline && !releasers.length)
        await new Promise((r) => setTimeout(r, 25));
      expect(releasers.length).toBeGreaterThan(0);
    } finally {
      for (const r of releasers) r();
      setWebhookSweepDepsForTest(null);
    }
    await webhookSweepIdle();
    expect((await deliveryRow(id)).status).toBe("delivered");
  });

  it("two concurrent finalizations enqueue exactly one delivery", async () => {
    // a live job whose provider reports completed - two overlapping sweeps race it
    const key = await createApiKey(`u-wh-${seq}`, "conc");
    const [{ jobId }] = await sql<{ jobId: string }>(
      `INSERT INTO jobs (user_id, kind, model_id, endpoint_id, workflow, provider, provider_request_id,
                         status, progress, cost_credits, prompt, api_key_id, provider_meta)
       VALUES ($1,'image','z-image-turbo','motionfield/z-image-turbo/text-to-image','text-to-image','mock','stub-1',
               'queued',0,0,'wh test',$2,$3::jsonb)
       RETURNING id AS "jobId"`,
      [`u-wh-${seq}`, key.id, JSON.stringify({ webhook_url: "http://127.0.0.1:9/hook" })]);
    setWebhookSweepDepsForTest({ transport: statusTransport(200), lookup: litLookup });
    await Promise.all([processJobs(), processJobs()]);
    const rows = await sql(`SELECT id, type, body FROM webhook_deliveries WHERE job_id = $1`, [jobId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("job.completed");
    const evt = JSON.parse(rows[0].body);
    expect(evt.type).toBe("job.completed");
    expect(evt.data.id).toBe(jobId);
    expect(evt.data.status).toBe("completed");
    await webhookSweepIdle();
  });
});

describe("real nodeTransport", () => {
  it("delivers to a host resolving to 127.0.0.1; a host resolving to 169.254.169.254 is refused before any connection", async () => {
    const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    const server: Server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body: b });
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      // Delivered side: the fake host resolves to the receiver's loopback
      // address, so the real node http transport completes the POST.
      const loopback: LookupAll = async () => [{ address: "127.0.0.1", family: 4 }];
      const body = JSON.stringify({ id: "evt-t", type: "job.completed", created: 1, data: { id: "j-t" } });
      const ok = await insertDelivery(`http://loopback.test:${port}/hook`, body);
      await deliverDueWebhooks(Date.now(), { lookup: loopback }); // no transport dep → real nodeTransport
      const okRow = await deliveryRow(ok.id);
      expect(okRow.status).toBe("delivered");
      expect(okRow.attempts).toBe(1);
      expect(received).toHaveLength(1);
      expect(received[0].body).toBe(body);
      expect(
        verifyWebhookSignature(ok.key.webhookSecret, received[0].headers["x-motionfield-signature"] as string, received[0].body),
      ).toBe(true);

      // Denied side: the pre-flight guard's resolve answers a public IP so
      // the attempt proceeds, but the connect-time re-resolve answers
      // 169.254.169.254 - the pinning lookup fails the request with
      // DestinationDeniedError before a socket is ever opened.
      let n = 0;
      const flip: LookupAll = async () =>
        ++n === 1
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "169.254.169.254", family: 4 }];
      const bad = await insertDelivery(`http://meta.test:${port}/latest`);
      await deliverDueWebhooks(Date.now(), { lookup: flip });
      const badRow = await deliveryRow(bad.id);
      expect(n).toBe(2); // guard resolve + connect-time resolve
      expect(badRow.status).toBe("failed");
      expect(badRow.last_error).toBe("destination not allowed");
      expect(received).toHaveLength(1); // the receiver saw no second connection
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
