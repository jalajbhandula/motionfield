import { describe, it, expect, vi, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import { sql } from "@/db";
import {
  createApiKey, verifyApiKey, revokeApiKey, listApiKeys,
  generateApiKey, parseApiKey, secretMatches, sha256hex,
} from "@/lib/api/apikeys";

// PGlite setup + migrate can exceed the default 10s hook timeout under
// parallel-suite load - give it room.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

beforeAll(() => {
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws1-keys-"));
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
});

async function makeUser(id: string) {
  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$2,$3,true)`, [id, id, `${id}@test.dev`]);
}

describe("api key format", () => {
  it("generates of_<keyId>_<secret> with a 12-char keyId", () => {
    const { keyId, secret } = generateApiKey();
    expect(keyId).toHaveLength(12);
    expect(secret.length).toBeGreaterThanOrEqual(40);
  });

  it("parses well-formed tokens and rejects malformed ones", () => {
    const { keyId, secret } = generateApiKey();
    const token = `of_${keyId}_${secret}`;
    expect(parseApiKey(token)).toEqual({ keyId, secret });
    expect(parseApiKey("not-a-key")).toBeNull();
    expect(parseApiKey("of_short_x")).toBeNull();
    expect(parseApiKey(`of_${keyId}_`)).toBeNull();
  });
});

describe("create / verify / revoke", () => {
  it("verifies a freshly created key and stamps last_used_at", async () => {
    await makeUser("u-keys-1");
    const issued = await createApiKey("u-keys-1", "ci");
    expect(issued.key.startsWith(`of_${issued.keyId}_`)).toBe(true);
    // only the hash is stored - the secret itself never is
    const rows = await sql<{ secret_hash: string; last_used_at: unknown }>(
      `SELECT secret_hash, last_used_at FROM api_keys WHERE id = $1`, [issued.id]);
    expect(rows[0].secret_hash).toBe(sha256hex(issued.key.slice(`of_${issued.keyId}_`.length)));
    expect(rows[0].secret_hash).not.toContain(issued.key.slice(-8));

    const v = await verifyApiKey(issued.key);
    expect(v).not.toBeNull();
    expect(v!.userId).toBe("u-keys-1");
    expect(v!.keyId).toBe(issued.keyId);
    expect(v!.maxConcurrency).toBe(2);
    const [after] = await sql<{ last_used_at: unknown }>(`SELECT last_used_at FROM api_keys WHERE id = $1`, [issued.id]);
    expect(after.last_used_at).not.toBeNull();
  });

  it("rejects a wrong secret (and uses a constant-time compare)", async () => {
    const issued = await createApiKey("u-keys-1", "ci-2");
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    const wrong = `of_${issued.keyId}_${crypto.randomBytes(32).toString("base64url")}`;
    expect(await verifyApiKey(wrong)).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rejects malformed, unknown and revoked keys", async () => {
    const issued = await createApiKey("u-keys-1", "ci-3");
    expect(await verifyApiKey("")).toBeNull();
    expect(await verifyApiKey("of_zzzzzzzzzzzz_whatever")).toBeNull();
    expect(await revokeApiKey("u-keys-1", issued.id)).toBe(true);
    expect(await verifyApiKey(issued.key)).toBeNull();
    // second revoke is a no-op
    expect(await revokeApiKey("u-keys-1", issued.id)).toBe(false);
  });

  it("other users cannot revoke the key", async () => {
    await makeUser("u-keys-2");
    const issued = await createApiKey("u-keys-1", "ci-4");
    expect(await revokeApiKey("u-keys-2", issued.id)).toBe(false);
    expect(await verifyApiKey(issued.key)).not.toBeNull();
  });

  it("lists keys without secrets", async () => {
    const keys = await listApiKeys("u-keys-1");
    expect(keys.length).toBeGreaterThanOrEqual(4);
    for (const k of keys) {
      expect(k).toHaveProperty("keyId");
      expect(k).toHaveProperty("maxConcurrency");
      expect(k).not.toHaveProperty("secretHash");
      expect(k).not.toHaveProperty("key");
    }
  });
});

describe("secretMatches", () => {
  it("compares sha256 digests constant-time", () => {
    const secret = crypto.randomBytes(32).toString("base64url");
    const hash = sha256hex(secret);
    expect(secretMatches(secret, hash)).toBe(true);
    expect(secretMatches(secret + "x", hash)).toBe(false);
    expect(secretMatches(secret, "00")).toBe(false);
  });
});
