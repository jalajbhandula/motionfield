import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAuth } from "@/lib/auth";
import { sql } from "@/db";

/* A3 + A6 recipe evidence with the provider stubbed (same pattern as
 * ws4-person-swap-gates.test.ts - real PNG strips, the staged clip as the window
 * output, a synthetic jobs row):
 *  - an aspect crop makes the CROPPED clip the real source - provider_meta
 *    must record preflight_src = the .person-swap/src-aspect.mp4 the windows
 *    actually read, and compare_src must point at it too
 *  - a canceled job must never publish - the last assertLive before the
 *    save throws and no person-swap-<id>-*.mp4 lands in generated/ */

const stubItems: Record<string, { type: string; url: string }[]> = {};
// per-submit output queues - a wf hit by N windows needs N distinct file
// sets (consumed provider files are deleted); the submit stub shifts one
// entry per call. Seeds the recipe passed are captured per submit.
const stubQueues: Record<string, { type: string; url: string }[][]> = {};
const submits: { wf: string; seed: number | undefined; steps: number | undefined }[] = [];
const genRoot = resolve(process.cwd(), "public", "files", "generated");
const uploadRoot = resolve(process.cwd(), "public", "files", "uploads");
const tag = `w4rec-${randomUUID().slice(0, 8)}`;
const clipUrl = `/files/uploads/${tag}.mp4`;
const clipFile = join(uploadRoot, `${tag}.mp4`);
const clip6Url = `/files/uploads/${tag}-6s.mp4`;
const clip6File = join(uploadRoot, `${tag}-6s.mp4`);
const refUrl = `/files/uploads/${tag}-ref.png`;
const refFile = join(uploadRoot, `${tag}-ref.png`);
const g = (n: string) => `/files/generated/${tag}-${n}.png`;
const v = (n: string) => `/files/generated/${tag}-${n}.mp4`;

vi.mock("@/lib/generation", async (orig) => {
  const actual = await orig<object>();
  return {
    ...actual,
    getProvider: () => ({
      name: "comfy", // NOT "mock" - the gates only run off-mock
      submit: async (input: { workflow: { providers?: { comfy?: { workflow?: string } } }; params?: Record<string, unknown> }) => {
        const wf = input.workflow?.providers?.comfy?.workflow ?? "";
        submits.push({ wf, seed: input.params?.seed as number | undefined, steps: input.params?.steps as number | undefined });
        const items = stubQueues[wf]?.shift() ?? stubItems[wf];
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

let userId = "";
const madeFiles: string[] = [];
const madeJobs: string[] = [];

beforeAll(async () => {
  mkdirSync(genRoot, { recursive: true });
  mkdirSync(uploadRoot, { recursive: true });
  // 2 s 16:9 clip - the aspect crop path must engage on a 9:16 pick
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "gradients=size=128x72:rate=8:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clipFile,
  ]);
  madeFiles.push(clipFile);
  // 6 s clip → two generation windows - the same-seed + draft tests drive it
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "gradients=size=128x72:rate=8:duration=6",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", clip6File,
  ]);
  madeFiles.push(clip6File);
  // identity ref - a real PNG the person path's refcut consumes
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:size=32x32:duration=1",
    "-frames:v", "1", refFile,
  ]);
  madeFiles.push(refFile);
  // healthy strips - preflight + one per window pass. keepEvidence renames
  // a consumed file - every stub use needs its OWN copy.
  for (const n of ["hi-pf", "hi-w1", "hi-pf2", "hi-w2"]) png(n, 4, [[0.65, 0.66, 0.65, 0.65], [0.02, 0.02, 0.02, 0.02]]);
  for (const n of ["matte-a", "matte-b", "matte-c", "matte-d"]) png(n, 8, [[0, 0, 0, 0, 0, 0, 0, 0]]);
  // a separate disposable clip per window output - the recipe DELETES
  // provider files after consuming them, so the uploaded source must
  // never be the stub's window output
  for (const n of ["win-a", "win-b"]) {
    const fp = join(genRoot, `${tag}-${n}.mp4`);
    execFileSync("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi", "-i", "gradients=size=128x72:rate=8:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", fp,
    ]);
    madeFiles.push(fp);
  }
  const auth = await getAuth();
  const out = await auth.api.signUpEmail({
    body: { email: `w4rec-${randomUUID().slice(0, 8)}@ws4.test`, password: "password-1234", name: "w4rec" },
    returnHeaders: true,
  });
  userId = out.response.user.id;
  await sql(
    `INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'video/mp4', 4096, $3) ON CONFLICT DO NOTHING`,
    [userId, clipUrl, `${tag}.mp4`],
  );
  await sql(
    `INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'video/mp4', 4096, $3) ON CONFLICT DO NOTHING`,
    [userId, clip6Url, `${tag}-6s.mp4`],
  );
  await sql(
    `INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'image/png', 512, $3) ON CONFLICT DO NOTHING`,
    [userId, refUrl, `${tag}-ref.png`],
  );
});

afterAll(() => {
  for (const f of madeFiles) if (existsSync(f)) rmSync(f, { force: true });
  for (const jobId of madeJobs) {
    rmSync(join(genRoot, ".person-swap", jobId), { recursive: true, force: true });
    for (const n of readdirSync(genRoot).filter((n) => n.startsWith(`person-swap-${jobId}-`) && n.endsWith(".mp4")))
      rmSync(join(genRoot, n), { force: true });
  }
});

async function run(status: string, params: Record<string, unknown>) {
  const { personSwapRecipe } = await import("@/lib/generation/recipes/person-swap");
  const jobId = randomUUID();
  madeJobs.push(jobId);
  await sql(
    `INSERT INTO jobs (id, user_id, kind, model_id, endpoint_id, workflow, provider, params, status, progress)
     VALUES ($1, $2, 'video', 'person-swap', 'motionfield/person-swap/v1.0', 'person-swap', 'comfy', $3, $4, 0)`,
    [jobId, userId, JSON.stringify(params), status],
  );
  const ac = new AbortController();
  const err = await personSwapRecipe(
    // workflow.endpointId marks this as the real person-swap surface - routed
    // endpoints are pinned to person mode and would ignore `mode`
    { jobId, model: "motionfield/person-swap/v1.0", workflow: { endpointId: "motionfield/person-swap/v1.0" }, params } as never,
    { signal: ac.signal, progress: () => {} } as never,
  ).then(() => null).catch((e: Error) => e.message);
  return { jobId, err };
}

describe("person-swap recipe - cropped preflight source + cancel-before-save", () => {
  it("aspect crop: provider_meta records the CROPPED clip as preflight_src + compare_src", async () => {
    stubItems["person-swap-matte.json"] = [{ type: "image", url: g("hi-pf") }, { type: "image", url: g("matte-a") }];
    stubItems["person-swap-environment.json"] = [
      { type: "image", url: g("hi-w1") }, { type: "image", url: g("matte-b") },
      { type: "video", url: v("win-a") },
    ];
    const { jobId, err } = await run("in_progress", {
      video_url: clipUrl, mode: "environment", likeness_consent: true,
      lip_sync: false, resolution: "480p", aspect: "9:16",
    });
    expect(err).toBeNull();
    const [row] = await sql<{ provider_meta: { person_swap?: Record<string, unknown> } }>(
      `SELECT provider_meta FROM jobs WHERE id = $1`, [jobId]);
    const meta = row.provider_meta?.person_swap ?? {};
    const cropped = `/files/generated/.person-swap/${jobId}/src-aspect.mp4`;
    // the preflight read the cropped clip, not the upload - and the
    // before/after compares against the same real source
    expect(meta.preflight_src).toBe(cropped);
    expect(meta.compare_src).toBe(cropped);
    expect(existsSync(join(genRoot, ".person-swap", jobId, "src-aspect.mp4"))).toBe(true);
  }, 60_000);

  it("cancel: a canceled job throws before the publish - no person-swap-<id>-*.mp4", async () => {
    stubItems["person-swap-matte.json"] = [{ type: "image", url: g("hi-pf2") }, { type: "image", url: g("matte-c") }];
    stubItems["person-swap-environment.json"] = [
      { type: "image", url: g("hi-w2") }, { type: "image", url: g("matte-d") },
      { type: "video", url: v("win-b") },
    ];
    // status 'canceled' from the start - the pre-assembly assertLive throws
    const { jobId, err } = await run("canceled", {
      video_url: clipUrl, mode: "environment", likeness_consent: true,
      lip_sync: false, resolution: "480p",
    });
    expect(err).toContain("canceled");
    const leaked = readdirSync(genRoot).filter((n) => n.startsWith(`person-swap-${jobId}-`) && n.endsWith(".mp4"));
    expect(leaked).toEqual([]);
    // no assembled remnant either - the work dir keeps only evidence
    expect(existsSync(join(genRoot, ".person-swap", jobId, "assembled.mp4"))).toBe(false);
  }, 60_000);
});

/* draft/approve mechanics through the real recipe: the 6 s clip splits into
 * two windows, a draft submits only window 0 at capped steps, every window
 * carries the same derived seed, and an approved final re-keys on the
 * draft's job id - the recorded draft is what the final re-renders. */
describe("person-swap recipe - draft slicing + same-seed windows + approve re-key", () => {
  // unique evidence per submit - keepEvidence renames whatever it gets
  let n = 0;
  const strip = () => { const k = `s${n++}`; png(k, 4, [[0.65, 0.66, 0.65, 0.65]]); return { type: "image", url: g(k) }; };
  const matte = () => { const k = `m${n++}`; png(k, 8, [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]]); return { type: "image", url: g(k) }; };
  const cutout = () => { const k = `c${n++}`; png(k, 8, [[1, 1, 1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1, 1, 1]]); return { type: "image", url: g(k) }; };
  const win = () => {
    const k = `w${n++}`;
    const fp = join(genRoot, `${tag}-${k}.mp4`);
    execFileSync("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi", "-i", "gradients=size=128x72:rate=8:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", fp,
    ]);
    madeFiles.push(fp);
    return { type: "video", url: v(k) };
  };
  // preflight wants a 2-row strip (person+face); window graphs save 1-row
  const pfStrip = () => { const k = `s${n++}`; png(k, 4, [[0.65, 0.66, 0.65, 0.65], [0.02, 0.02, 0.02, 0.02]]); return { type: "image", url: g(k) }; };
  const queueRun = (windows: number) => {
    stubQueues["person-swap-matte.json"] = [[pfStrip(), matte()]];
    stubQueues["person-swap-refcut.json"] = [[cutout()]];
    stubQueues["person-swap-person.json"] = Array.from({ length: windows }, () => [strip(), matte(), win()]);
  };
  const personParams = (extra: Record<string, unknown>) => ({
    video_url: clip6Url, mode: "person", image_urls: [refUrl], likeness_consent: true,
    lip_sync: false, resolution: "480p", ...extra,
  });
  const personSeeds = () => submits.filter((s) => s.wf === "person-swap-person.json").map((s) => s.seed);

  it("a draft on a 2-window clip submits ONLY window 0, at capped steps, flagged in meta", async () => {
    queueRun(1);
    submits.length = 0;
    const { jobId, err } = await run("in_progress", personParams({ draft: true, steps: 12 }));
    expect(err).toBeNull();
    const wSeeds = personSeeds();
    expect(wSeeds.length).toBe(1);
    expect(submits.find((s) => s.wf === "person-swap-person.json")?.steps).toBe(4); // PERSON_SWAP_DRAFT_STEPS
    const [row] = await sql<{ provider_meta: { person_swap?: Record<string, unknown> } }>(
      `SELECT provider_meta FROM jobs WHERE id = $1`, [jobId]);
    const meta = row.provider_meta?.person_swap ?? {};
    expect(meta.draft).toBe(true);
    expect(meta.draft_steps).toBe(4);
    expect(meta.steps).toBe(4);
    expect(meta.windows).toBe(1);
    expect(meta.lip).toBe("lip restore skipped: draft");
  }, 60_000);

  it("every window of a full run carries the same derived seed", async () => {
    queueRun(2);
    submits.length = 0;
    const { jobId, err } = await run("in_progress", personParams({ windows: 2 }));
    expect(err).toBeNull();
    const wSeeds = personSeeds();
    expect(wSeeds.length).toBe(2);
    const { seedFor } = await import("@/lib/generation/recipes/person-swap");
    expect(wSeeds[0]).toBe(seedFor(jobId, 0, 1));
    expect(wSeeds[1]).toBe(seedFor(jobId, 0, 1));
    const [row] = await sql<{ provider_meta: { person_swap?: Record<string, unknown> } }>(
      `SELECT provider_meta FROM jobs WHERE id = $1`, [jobId]);
    expect(row.provider_meta?.person_swap?.windows).toBe(2);
  }, 60_000);

  it("a malformed draft_of 400s at the uuid guard - 'abc'/'----' never reach the pg cast", async () => {
    for (const bad of ["abc", "----", "no-such-job"]) {
      const { err } = await run("in_progress", personParams({ draft_of: bad }));
      expect(err).toContain("completed Person Swap draft");
      // not the raw pg cast error the loose guard used to leak
      expect(err).not.toContain("invalid input syntax");
    }
  }, 60_000);

  it("an approved final re-keys on the draft job id - the preview's seed is what re-renders", async () => {
    // a completed draft row for this user/endpoint, flagged in provider_meta
    const draftId = randomUUID();
    madeJobs.push(draftId);
    await sql(
      `INSERT INTO jobs (id, user_id, kind, model_id, endpoint_id, workflow, provider, params, status, progress, provider_meta)
       VALUES ($1, $2, 'video', 'person-swap', 'motionfield/person-swap/v1.0', 'person-swap', 'comfy', '{}', 'completed', 100, $3)`,
      [draftId, userId, JSON.stringify({ person_swap: { draft: true, draft_steps: 4, windows: 1 } })],
    );
    queueRun(2);
    submits.length = 0;
    const { jobId, err } = await run("in_progress", personParams({ draft_of: draftId, windows: 2 }));
    expect(err).toBeNull();
    const wSeeds = personSeeds();
    expect(wSeeds.length).toBe(2);
    const { seedFor } = await import("@/lib/generation/recipes/person-swap");
    // windows key on the DRAFT id, not the new job id
    expect(wSeeds[0]).toBe(seedFor(draftId, 0, 1));
    expect(wSeeds[0]).not.toBe(seedFor(jobId, 0, 1));
    const [row] = await sql<{ provider_meta: { person_swap?: Record<string, unknown> } }>(
      `SELECT provider_meta FROM jobs WHERE id = $1`, [jobId]);
    const meta = row.provider_meta?.person_swap ?? {};
    expect(meta.draft_of).toBe(draftId);
    expect(meta.draft).not.toBe(true);
    expect(meta.windows).toBe(2);
  }, 60_000);
});
