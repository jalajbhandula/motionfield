import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAuth } from "@/lib/auth";
import { sql } from "@/db";

/* PersonSwap coverage gates - the env/person passes must refuse a clip whose
 * matte strip reads ~empty. The gate is the MEAN over the strip, not the
 * peak: a single hallucinated 7% blob on one segment must not pass (the
 * s6 gradient smoke clip produced exactly that). The provider stub returns
 * real PNG strips so stripCoverage parses the values the gate reads. Each
 * step gets its own strip file - keepEvidence renames, so a URL can only
 * be consumed once. */

const stubItems: Record<string, { type: string; url: string }[]> = {};
const genRoot = resolve(process.cwd(), "public", "files", "generated");
const uploadRoot = resolve(process.cwd(), "public", "files", "uploads");
const tag = `w4gate-${randomUUID().slice(0, 8)}`;
const clipUrl = `/files/uploads/${tag}.mp4`;
const refUrl = `/files/uploads/${tag}.png`;
const clipFile = join(uploadRoot, `${tag}.mp4`);
const refFile = join(uploadRoot, `${tag}.png`);
const g = (n: string) => `/files/generated/${tag}-${n}.png`;

vi.mock("@/lib/generation", async (orig) => {
  const actual = await orig<object>();
  return {
    ...actual,
    getProvider: () => ({
      name: "comfy", // NOT "mock" - the gates only run off-mock
      submit: async (input: { workflow: { providers?: { comfy?: { workflow?: string } } } }) => {
        const wf = input.workflow?.providers?.comfy?.workflow ?? "";
        const items = stubItems[wf];
        if (!items) return { providerJobId: `stub-${randomUUID().slice(0, 8)}`, meta: { missing: wf } };
        return { providerJobId: `stub-${randomUUID().slice(0, 8)}`, meta: { items } };
      },
      poll: async (_id: string, meta: { items?: { type: string; url: string }[]; missing?: string }) => {
        if (meta?.missing) return { state: "failed" as const, error: `SENTINEL no stub for ${meta.missing}` };
        return { state: "completed" as const, output: { items: meta?.items ?? [] } };
      },
      cancel: async () => {},
    }),
  };
});

function pgm(w: number, rows: number[][]): Buffer {
  const h = rows.length;
  const head = Buffer.from(`P5\n${w} ${h}\n255\n`);
  const px = Buffer.alloc(w * h);
  rows.forEach((row, r) => row.forEach((v, c) => { px[r * w + c] = Math.round(v * 255); }));
  return Buffer.concat([head, px]);
}

function png(name: string, w: number, rows: number[][]) {
  const out = join(genRoot, `${tag}-${name}.png`);
  const tmp = `${out}.pgm`;
  writeFileSync(tmp, pgm(w, rows));
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", tmp, out]);
  rmSync(tmp, { force: true });
  madeFiles.push(out);
}

async function makeUser(): Promise<{ id: string }> {
  const auth = await getAuth();
  const out = await auth.api.signUpEmail({
    body: { email: `gate-${randomUUID().slice(0, 8)}@ws4.test`, password: "password-1234", name: "gate" },
    returnHeaders: true,
  });
  return { id: out.response.user.id };
}

let userId = "";
const madeFiles: string[] = [];
const madeJobs: string[] = [];

beforeAll(async () => {
  mkdirSync(genRoot, { recursive: true });
  mkdirSync(uploadRoot, { recursive: true });
  // 2 s abstract colour field - the same shape as the S4 smoke clip
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "gradients=size=128x72:rate=8:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", clipFile,
  ]);
  writeFileSync(refFile, Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  ]));
  madeFiles.push(clipFile, refFile);
  // low strips: [0, 0.07, 0, 0] person + zero face - mean 1.75% < 3%.
  // keepEvidence renames a consumed file - each test run needs its own.
  png("striplo-pf", 4, [[0, 0.07, 0, 0], [0, 0, 0, 0]]);
  png("striplo-pf2", 4, [[0, 0.07, 0, 0], [0, 0, 0, 0]]);
  png("striplo-w", 4, [[0, 0.07, 0, 0], [0, 0, 0, 0]]);
  // high strips: a real person's readings - mean ~65% + face present
  png("striphi-pf", 4, [[0.65, 0.66, 0.65, 0.65], [0.02, 0.02, 0.02, 0.02]]);
  png("striphi-w", 4, [[0.65, 0.66, 0.65, 0.65], [0.02, 0.02, 0.02, 0.02]]);
  for (const n of ["matte1", "matte2", "matte3", "matte4"]) png(n, 8, [[0, 0, 0, 0, 0, 0, 0, 0]]);
  const me = await makeUser();
  userId = me.id;
  await sql(
    `INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'video/mp4', 4096, $3) ON CONFLICT DO NOTHING`,
    [userId, clipUrl, `${tag}.mp4`],
  );
  await sql(
    `INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'image/png', 100, $3) ON CONFLICT DO NOTHING`,
    [userId, refUrl, `${tag}.png`],
  );
});

afterAll(() => {
  for (const f of madeFiles) if (existsSync(f)) rmSync(f, { force: true });
  // every recipe run leaves a .person-swap work dir + (on success) a final
  // generated/person-swap-<jobId>-*.mp4 - sweep both so a rerun starts clean
  for (const jobId of madeJobs) {
    rmSync(join(genRoot, ".person-swap", jobId), { recursive: true, force: true });
    for (const n of readdirSync(genRoot).filter((n) => n.startsWith(`person-swap-${jobId}-`) && n.endsWith(".mp4")))
      rmSync(join(genRoot, n), { force: true });
  }
});

async function run(mode: string) {
  const { personSwapRecipe } = await import("@/lib/generation/recipes/person-swap");
  const jobId = randomUUID();
  madeJobs.push(jobId);
  const params = {
    video_url: clipUrl, mode, likeness_consent: true,
    lip_sync: false, resolution: "480p", image_urls: [refUrl],
  };
  await sql(
    `INSERT INTO jobs (id, user_id, kind, model_id, endpoint_id, workflow, provider, params, status, progress)
     VALUES ($1, $2, 'video', 'person-swap', 'motionfield/person-swap/v1.0', 'person-swap', 'comfy', $3, 'in_progress', 0)`,
    [jobId, userId, JSON.stringify(params)],
  );
  const ac = new AbortController();
  return personSwapRecipe(
    { jobId, model: "motionfield/person-swap/v1.0",
      workflow: { endpointId: "motionfield/person-swap/v1.0" }, params } as never,
    { signal: ac.signal, progress: () => {} } as never,
  ).then(() => null).catch((e: Error) => e.message);
}

describe("person-swap coverage gates (recipe, stubbed provider)", () => {
  it("environment mode refuses a clip whose mean strip coverage is under 3%", async () => {
    stubItems["person-swap-matte.json"] = [
      { type: "image", url: g("striplo-pf") },
      { type: "image", url: g("matte1") },
    ];
    const err = await run("environment");
    expect(err).toMatch(/environment mode keeps the performer - no person found.*1\.8%/);
  }, 60_000);

  it("person mode refuses the same strip", async () => {
    stubItems["person-swap-matte.json"] = [
      { type: "image", url: g("striplo-pf2") },
      { type: "image", url: g("matte2") },
    ];
    const err = await run("person");
    expect(err).toMatch(/person not confidently found - mean matte coverage 1\.8%/);
  }, 60_000);

  it("a healthy strip clears preflight - the env window runs and lands", async () => {
    stubItems["person-swap-matte.json"] = [
      { type: "image", url: g("striphi-pf") },
      { type: "image", url: g("matte3") },
    ];
    stubItems["person-swap-environment.json"] = [
      { type: "image", url: g("striphi-w") },
      { type: "image", url: g("matte4") },
      { type: "video", url: clipUrl }, // real staged clip doubles as the window output
    ];
    const err = await run("environment");
    expect(err).toBeNull();
  }, 60_000);
});
