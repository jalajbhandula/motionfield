import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@/db";
import { createApiKey } from "@/lib/api/apikeys";
import { webhookSweepIdle } from "@/lib/api/webhooks";

// PGlite setup can exceed the default 10s hook timeout on a busy machine.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

vi.mock("@/lib/generation", () => ({
  getProvider: () => ({
    name: "mock",
    submit: async () => ({ providerJobId: "stub-1" }),
    poll: async () => ({ state: "queued" }),
    cancel: async () => {},
  }),
}));

import { POST } from "@/app/api/v1/jobs/route";

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-ws1-0123456789abcdef0123456789ab";
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws1-cap-"));
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
});

afterEach(async () => {
  await webhookSweepIdle();
});

async function makeKey() {
  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ('u-cap','cap','cap@test.dev',true)
             ON CONFLICT (id) DO NOTHING`);
  await sql(`INSERT INTO profiles (user_id, credits) VALUES ('u-cap', 10000) ON CONFLICT (user_id) DO NOTHING`);
  const key = await createApiKey("u-cap", "cap");
  return `Bearer ${key.key}`;
}

/** A streamed body with no Content-Length - the chunked-encoding shape. */
function streamedRequest(bytes: Uint8Array, auth: string) {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      // feed in 64 KB chunks like a real chunked upload
      for (let i = 0; i < bytes.length; i += 65536) c.enqueue(bytes.subarray(i, i + 65536));
      c.close();
    },
  });
  return new NextRequest("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: stream,
    duplex: "half", // undici requires duplex for streamed request bodies
  });
}

describe("POST /api/v1/jobs body cap", () => {
  it("a 1.1 MB streamed body without Content-Length gets 413", async () => {
    const auth = await makeKey();
    const res = await POST(streamedRequest(new Uint8Array(1.1 * 1024 * 1024), auth));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.code).toBe("payload_too_large");
  });

  it("a valid JSON body under the cap still submits", async () => {
    const auth = await makeKey();
    const payload = JSON.stringify({
      endpoint: "motionfield/z-image-turbo/text-to-image",
      params: { prompt: "cap test" },
    });
    const res = await POST(streamedRequest(new TextEncoder().encode(payload), auth));
    expect(res.status, await res.text()).toBe(202);
  });
});
