import { describe, it, expect, vi, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, hashJobRequest, hashMismatch, isValidIdempotencyKey } from "@/lib/api/idempotency";
import { JobError, createJobEx } from "@/lib/jobs";
import { sql } from "@/db";

// PGlite setup can exceed the default 10s hook timeout on a busy machine.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

describe("canonicalJson", () => {
  it("is independent of object key order", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson({ z: { y: 1, x: { w: 2, v: 3 } }, a: [3, { b: 1, a: 2 }] }))
      .toBe(canonicalJson({ a: [3, { a: 2, b: 1 }], z: { x: { v: 3, w: 2 }, y: 1 } }));
  });

  it("keeps array order significant", () => {
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
  });
});

describe("hashJobRequest", () => {
  it("produces identical hashes for reordered params", () => {
    const h1 = hashJobRequest("motionfield/x/gen", { prompt: "hi", seed: 5, extra: { b: 1, a: 2 } });
    const h2 = hashJobRequest("motionfield/x/gen", { extra: { a: 2, b: 1 }, seed: 5, prompt: "hi" });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the payload changes", () => {
    const base = hashJobRequest("ep", { prompt: "a" });
    expect(hashJobRequest("ep", { prompt: "b" })).not.toBe(base);
    expect(hashJobRequest("ep2", { prompt: "a" })).not.toBe(base);
    expect(hashJobRequest("ep", { prompt: "a", seed: 1 })).not.toBe(base);
  });
});

describe("hashMismatch", () => {
  it("detects a different hash and ignores an empty stored hash", () => {
    const h = hashJobRequest("ep", { a: 1 });
    const other = hashJobRequest("ep", { a: 2 });
    expect(hashMismatch(other, h)).toBe(true);
    expect(hashMismatch(h, h)).toBe(false);
    expect(hashMismatch(null, h)).toBe(false);
    expect(hashMismatch(undefined, h)).toBe(false);
  });
});

describe("JobError", () => {
  it("carries an optional machine-readable code", () => {
    const e = new JobError("mismatch", 422, "idempotency_mismatch");
    expect(e.status).toBe(422);
    expect(e.code).toBe("idempotency_mismatch");
    expect(new JobError("plain").code).toBeUndefined();
  });
});

describe("isValidIdempotencyKey", () => {
  it("accepts 1-255 printable ASCII and rejects everything else", () => {
    expect(isValidIdempotencyKey("k")).toBe(true);
    expect(isValidIdempotencyKey("x".repeat(255))).toBe(true);
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("x".repeat(256))).toBe(false);
    expect(isValidIdempotencyKey("bad\nkey")).toBe(false);
    expect(isValidIdempotencyKey("ünïcode")).toBe(false);
  });
});

describe("createJobEx idempotency (db)", () => {
  const ENDPOINT = "motionfield/z-image-turbo/text-to-image";

  beforeAll(() => {
    process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws1-idem-"));
    process.env.GENERATION_PROVIDER = "mock";
    process.env.BETTER_AUTH_SECRET ??= "test-secret-ws1-0123456789abcdef0123456789ab";
    execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
      env: { ...process.env }, stdio: "pipe",
    });
  });

  async function seed() {
    await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ('u-idem','idem','idem@test.dev',true)
               ON CONFLICT (id) DO NOTHING`);
    await sql(`INSERT INTO profiles (user_id, credits, plan_id) VALUES ('u-idem', 10000, 'pro')
               ON CONFLICT (user_id) DO UPDATE SET credits = 10000`);
  }

  it("rejects a 256-char Idempotency-Key with 400 before touching the db", async () => {
    await seed();
    await expect(createJobEx("u-idem", {
      endpointId: ENDPOINT, params: { prompt: "hi" }, idempotencyKey: "x".repeat(256),
    })).rejects.toMatchObject({ status: 400, code: "bad_request" });
  });

  it("same key + same payload replays the original job (replayed=true)", async () => {
    await seed();
    const a = await createJobEx("u-idem", {
      endpointId: ENDPOINT, params: { prompt: "same" }, idempotencyKey: "key-same",
    });
    expect(a.replayed).toBe(false);
    // shuffled param order still hashes identically → replay
    const b = await createJobEx("u-idem", {
      endpointId: ENDPOINT, params: { prompt: "same" }, idempotencyKey: "key-same",
    });
    expect(b.replayed).toBe(true);
    expect(b.job.id).toBe(a.job.id);
    // and the row got its hash at INSERT time, not a later UPDATE
    const [row] = await sql<{ request_hash: string | null }>(
      `SELECT request_hash FROM jobs WHERE id = $1`, [a.job.id]);
    expect(row.request_hash).toBe(hashJobRequest(ENDPOINT, { prompt: "same" }));
  });

  it("same key + different payload throws JobError 422", async () => {
    await seed();
    await expect(createJobEx("u-idem", {
      endpointId: ENDPOINT, params: { prompt: "different" }, idempotencyKey: "key-same",
    })).rejects.toMatchObject({ status: 422, code: "idempotency_mismatch" });
  });
});
