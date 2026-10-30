import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAuth } from "@/lib/auth";

// PGlite setup can exceed the default 10s hook timeout on a busy machine.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

const SECRET = "test-secret-ws1-0123456789abcdef0123456789ab";
const g = globalThis as { __ofAuth?: unknown; __ofAuthPromise?: Promise<unknown> };

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = SECRET;
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws1-authsg-"));
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
});

afterEach(() => {
  delete process.env.MOTIONFIELD_HOSTED;
  process.env.BETTER_AUTH_SECRET = SECRET;
});

describe("getAuth", () => {
  it("dedupes concurrent first calls onto one instance", async () => {
    g.__ofAuth = undefined;
    g.__ofAuthPromise = undefined;
    const [a, b, c] = await Promise.all([getAuth(), getAuth(), getAuth()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("a failed build clears the in-flight promise - the next call retries", async () => {
    g.__ofAuth = undefined;
    g.__ofAuthPromise = undefined;
    process.env.MOTIONFIELD_HOSTED = "1";
    delete process.env.BETTER_AUTH_SECRET;
    await expect(getAuth()).rejects.toThrow(/BETTER_AUTH_SECRET/);
    // the rejection was not cached: with the env fixed, the same call succeeds
    delete process.env.MOTIONFIELD_HOSTED;
    process.env.BETTER_AUTH_SECRET = SECRET;
    await expect(getAuth()).resolves.toBeTruthy();
  });
});
