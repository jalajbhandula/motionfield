import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NextRequest } from "next/server";
import { sql } from "@/db";
import { createApiKey } from "@/lib/api/apikeys";
import { GET } from "@/app/api/v1/jobs/[id]/result/route";

// PGlite setup can exceed the default 10s hook timeout on a busy machine.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

const USER = "u-res";
let apiKey: string;

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET = "test-secret-ws1-0123456789abcdef0123456789ab";
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws1-result-"));
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$2,$3,true)
             ON CONFLICT (id) DO NOTHING`, [USER, USER, `${USER}@test.dev`]);
  apiKey = (await createApiKey(USER, "res")).key;
});

/** The four output files jobWithOutput writes under public/files/generated/. */
afterAll(() => {
  for (const rel of ["rt-nosniff.png", "rt-page.html", "rt-vec.svg", "rt-img.png"])
    rmSync(join(process.cwd(), "public", "files", "generated", rel), { force: true });
});

/** A completed job whose single output is a real file under public/files. */
async function jobWithOutput(rel: string, bytes: string) {
  const fp = join(process.cwd(), "public", "files", rel);
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, bytes);
  const jobId = crypto.randomUUID();
  await sql(
    `INSERT INTO jobs (id, user_id, kind, model_id, endpoint_id, workflow, provider,
                       status, progress, cost_credits, outputs)
     VALUES ($1,$2,'image','m','e','w','mock','completed',100,0,$3::jsonb)`,
    [jobId, USER, JSON.stringify([{ url: `/files/${rel}`, type: "image" }])]);
  return jobId;
}

const get = (jobId: string, auth = true) =>
  GET(
    new NextRequest(`http://localhost/api/v1/jobs/${jobId}/result`, {
      headers: auth ? { authorization: `Bearer ${apiKey}` } : {},
    }),
    { params: Promise.resolve({ id: jobId }) },
  );

describe("result route hardening", () => {
  it("every response carries x-content-type-options: nosniff", async () => {
    const jobId = await jobWithOutput("generated/rt-nosniff.png", "PNG");
    for (const res of [
      await get(jobId, false),          // 401 without a key
      await get(crypto.randomUUID()),   // 404 unknown job
      await get(jobId),                 // 200 file
    ]) {
      expect(res.headers.get("x-content-type-options"), `status ${res.status}`).toBe("nosniff");
    }
  });

  it("html and svg outputs are attachments, never inline; png stays inline", async () => {
    const html = await get(await jobWithOutput("generated/rt-page.html", "<html><body>x</body></html>"));
    expect(html.headers.get("content-type")).toBe("text/html");
    expect(html.headers.get("content-disposition")).toMatch(/^attachment;/);

    const svg = await get(await jobWithOutput("generated/rt-vec.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>"));
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-disposition")).toMatch(/^attachment;/);

    const png = await get(await jobWithOutput("generated/rt-img.png", "PNG"));
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("content-disposition")).toMatch(/^inline;/);
  });
});
