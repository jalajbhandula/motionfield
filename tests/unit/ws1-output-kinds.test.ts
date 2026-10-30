import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@/db";
import { webhookSweepIdle } from "@/lib/api/webhooks";
import { fetchJobView } from "@/lib/api/jobview";
import { mimeForUrl, mimeForJobOutput, OCTET_STREAM } from "@/lib/api/mime";

// PGlite setup can exceed the default 10s hook timeout on a busy machine.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

/** Stub provider completing with one raster image and one glb model - the
 *  union the job kind can't express is what persists + surfaces. */
vi.mock("@/lib/generation", () => ({
  getProvider: () => ({
    name: "mock",
    submit: async () => ({ providerJobId: "stub-1" }),
    poll: async () => ({
      state: "completed",
      output: { items: [
        { type: "image", url: "/files/generated/out.png" },
        { type: "model" as "image", url: "/files/generated/mesh.glb" },
      ] },
    }),
    cancel: async () => {},
  }),
}));

import { processJobs } from "@/lib/jobs";

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-ws1-0123456789abcdef0123456789ab";
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws1-kinds-"));
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
});

afterEach(async () => {
  await webhookSweepIdle();
});

describe("mime map", () => {
  it("covers image, audio, video, model and archive kinds by extension", () => {
    expect(mimeForUrl("/f/a.png")).toBe("image/png");
    expect(mimeForUrl("/f/a.svg")).toBe("image/svg+xml");
    expect(mimeForUrl("/f/a.mp3")).toBe("audio/mpeg");
    expect(mimeForUrl("/f/a.mp4")).toBe("video/mp4");
    expect(mimeForUrl("/f/a.glb")).toBe("model/gltf-binary");
    expect(mimeForUrl("/f/a.gltf")).toBe("model/gltf+json");
    expect(mimeForUrl("/f/a.usdz")).toBe("model/vnd.usdz+zip");
    expect(mimeForUrl("/f/a.zip")).toBe("application/zip");
    expect(mimeForUrl("/f/a.unknownext")).toBe(OCTET_STREAM);
    expect(mimeForUrl("/f/noext")).toBe(OCTET_STREAM);
    expect(mimeForUrl("/f/a.png?x=1")).toBe("image/png");
  });

  it("falls back to the coarse kind when the extension is unknown", () => {
    expect(mimeForJobOutput("image", "/f/noext")).toBe("image/png");
    expect(mimeForJobOutput("video", "/f/noext")).toBe("video/mp4");
    expect(mimeForJobOutput("audio", "/f/noext")).toBe("audio/wav");
    expect(mimeForJobOutput("model", "/f/noext")).toBe("model/gltf-binary");
    expect(mimeForJobOutput(undefined, "/f/noext")).toBe(OCTET_STREAM);
    expect(mimeForJobOutput("image", "/f/x.glb")).toBe("model/gltf-binary"); // ext wins
  });
});

describe("api job view output kinds", () => {
  it("[OF-0851] a completed job's outputs carry real MIME types (image/png + model/gltf-binary)", async () => {
    await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ('u-kinds','k','kinds@test.dev',true)
               ON CONFLICT (id) DO NOTHING`);
    const jobId = crypto.randomUUID();
    await sql(
      `INSERT INTO jobs (id, user_id, kind, model_id, endpoint_id, workflow, provider, provider_request_id,
                         status, progress, cost_credits, prompt)
       VALUES ($1,'u-kinds','threed','stub3d','motionfield/stub3d/mesh','mesh','mock','stub-1',
               'queued',0,0,'kinds test')`,
      [jobId]);
    await processJobs();

    const view = await fetchJobView("u-kinds", jobId);
    expect(view!.status).toBe("completed");
    expect(view!.outputs).toHaveLength(2);
    expect(view!.outputs[0].type).toBe("image/png");
    expect(view!.outputs[1].type).toBe("model/gltf-binary");

    // the persisted asset mime agrees with the API view
    const assets = await sql<{ url: string; mime: string }>(
      `SELECT url, mime FROM assets WHERE job_id = $1 ORDER BY url`, [jobId]);
    expect(assets.map((a) => a.mime).sort()).toEqual(["image/png", "model/gltf-binary"].sort());
    await webhookSweepIdle();
  });
});
