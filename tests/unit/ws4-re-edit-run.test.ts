import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sql } from "@/db";
import type { GenerationProvider, ProviderStatus, SubmitInput } from "@/lib/generation/types";
import { JobError, createJob, cancelJob, tickJob } from "@/lib/jobs";
import { EFFECT_PRESETS } from "@/lib/catalog/presets";
import { RE_EDIT_ENDPOINT, getChain, loadChain, regenerateShot, startChain } from "@/lib/re-edit";
import { setReEditStepProvider } from "@/lib/generation/recipes/re-edit-assemble";

/**
 * ReCut one-job runner (B4+B6): the whole edit runs inside a single recipe
 * job - provider submissions happen per window inside that job, per-shot
 * regeneration reuses the other windows' outputs, concurrent regenerations
 * can't both claim the chain, window billing is honored before GPU work,
 * and canceling the job cancels the in-flight window sub-job.
 */

process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws4-run-"));

const tmp = mkdtempSync(join(tmpdir(), "of-ws4-run-media-"));
const filesRoot = resolve(process.cwd(), "public", "files", "uploads");
const videoUrl = "/files/uploads/of-ws4-re-edit-test.mp4";
const videoFile = join(filesRoot, "of-ws4-re-edit-test.mp4");
const imgUrl = "/files/uploads/of-ws4-re-edit-ref.png";
const imgFile = join(filesRoot, "of-ws4-re-edit-ref.png");
const shortUrl = "/files/uploads/of-ws4-re-edit-short.mp4";
const shortFile = join(filesRoot, "of-ws4-re-edit-short.mp4");
const winFixture = join(tmp, "win-out.mp4");

// counting fake - what the recipe calls per window via the env-provider seam
const submissions: SubmitInput[] = [];
const cancels: string[] = [];
let hangPolls = false;
const inject: GenerationProvider = {
  name: "mock",
  async submit(input) {
    submissions.push(input);
    return { providerJobId: `fake-${submissions.length}` };
  },
  async poll(): Promise<ProviderStatus> {
    if (hangPolls) return { state: "in_progress", progress: 10 };
    return { state: "completed", output: { items: [{ type: "video", url: winFixture, width: 64, height: 36, duration: 1 }] } };
  },
  async cancel(id) { cancels.push(id); },
};

const frames = (d: number) => Math.round((Math.max(9, Math.round(d * 16)) - 1) / 8) * 8 + 1;

beforeAll(async () => {
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], { env: { ...process.env }, stdio: "pipe" });

  // the restyle-preset submit needs comic-panel through the honesty gate -
  // point the test at a verify file with its record at the real mechanism
  // hash (computed, not hard-coded, so mechanism edits can't drift past it)
  const { specById, mechanismHash } = await import("@/lib/catalog/presets/schema");
  await import("@/lib/catalog/presets/effects");
  const spec = specById("comic-panel")!;
  const verifyFile = join(tmp, "preset-verify.json");
  writeFileSync(verifyFile, JSON.stringify({ version: 1, records: {
    "comic-panel": { mechanism_hash: mechanismHash(spec), status: "verified", checker: "vision" },
  } }));
  process.env.PRESET_VERIFY_FILE = verifyFile;

  mkdirSync(filesRoot, { recursive: true });
  // 12 s solid-color clip → no scene cuts → 1 shot, 3 windows (fallback splitting)
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "color=navy:size=64x36:rate=8:duration=12",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=12",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", videoFile,
  ]);
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x36:rate=16:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", winFixture,
  ]);
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "color=coral:size=64x64",
    "-frames:v", "1", imgFile,
  ]);
  // a 2 s clip - under the 4 s floor every vace-source param declares
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "color=navy:size=64x36:rate=8:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", shortFile,
  ]);

  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ('u-re-edit','r','r@test.dev',true)
             ON CONFLICT (id) DO NOTHING`, []);
  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ('u-re-edit-b','b','b@test.dev',true)
             ON CONFLICT (id) DO NOTHING`, []);
  await sql(`INSERT INTO profiles (user_id, credits) VALUES ('u-re-edit', 100000)
             ON CONFLICT (user_id) DO NOTHING`, []);
  await sql(`INSERT INTO profiles (user_id, credits) VALUES ('u-re-edit-b', 100000)
             ON CONFLICT (user_id) DO NOTHING`, []);
  await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ('u-re-edit', $1, 'video/mp4', 1024, 'three.mp4')
             ON CONFLICT DO NOTHING`, [videoUrl]);
  await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ('u-re-edit', $1, 'image/png', 256, 'ref.png')
             ON CONFLICT DO NOTHING`, [imgUrl]);
  await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ('u-re-edit', $1, 'video/mp4', 512, 'short.mp4')
             ON CONFLICT DO NOTHING`, [shortUrl]);
}, 120_000);

beforeEach(() => {
  setReEditStepProvider(inject);
  submissions.length = 0;
  cancels.length = 0;
  hangPolls = false;
});
afterEach(() => setReEditStepProvider(null));

/** tick a recipe-backed job until it settles (the recipe runs in-process). */
async function drain(jobId: string, tries = 400) {
  for (let i = 0; i < tries; i++) {
    await tickJob(jobId);
    const [{ status }] = await sql<{ status: string }>(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
    if (!["queued", "in_progress"].includes(status)) return status;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("job never settled");
}

describe("re-edit one-job run", () => {
  it("runs 3 windows in order inside one job, each FRAMES ≥ window frames", async () => {
    const { chain, job } = await startChain("u-re-edit", {
      videoUrl, flow: "restyle", imageUrls: [],
      instructions: "make it watercolor", resolution: "480p",
    });
    expect(chain.status).toBe("queued");
    // the recipe was submitted by createJob - drain it
    expect(await drain(job.id)).toBe("completed");

    const fresh = await loadChain(chain.id);
    expect(fresh?.status).toBe("completed");
    expect(fresh?.resultUrl).toMatch(/^\/files\/generated\/re-edit\//);

    const shots = fresh!.shots as { index: number; windows: { start: number; end: number }[] }[];
    const windows = shots.flatMap((s) => s.windows);
    expect(windows.length).toBe(3);
    expect(submissions.length).toBe(3);
    // window order: shot 0 windows in order, frames ≥ the window's 16 fps count
    submissions.forEach((s, i) => {
      const need = Math.ceil((windows[i].end - windows[i].start) * 16);
      expect(frames(Number(s.params.duration))).toBeGreaterThanOrEqual(need);
      expect(String(s.params.video_url)).toContain(`cut-0-${i}`);
      expect(String(s.params.prompt)).toContain("watercolor");
    });
    // assembled artifact exists + keeps 8 fps / 64x36 / ~12 s / audio
    const meta = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
      resolve(process.cwd(), "public", fresh!.resultUrl!.replace("/files/", "files/")),
    ]).toString());
    const v = meta.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    expect(v.width).toBe(64); expect(v.height).toBe(36);
    const [rn, rd] = v.avg_frame_rate.split("/").map(Number);
    expect(Math.abs(rn / rd - 8)).toBeLessThan(0.01);
    expect(Math.abs(Number(meta.format.duration) - 12)).toBeLessThanOrEqual(0.2);
    expect(meta.streams.some((s: { codec_type: string }) => s.codec_type === "audio")).toBe(true);
  }, 120_000);

  it("regenerating a shot runs only its windows; two concurrent regenerations → one 409", async () => {
    const { chain, job } = await startChain("u-re-edit", {
      videoUrl, flow: "restyle", imageUrls: [], resolution: "480p",
    });
    expect(await drain(job.id)).toBe("completed");

    submissions.length = 0;
    const [ok, bad] = await Promise.allSettled([
      regenerateShot("u-re-edit", chain.id, 0, "more teal"),
      regenerateShot("u-re-edit", chain.id, 0),
    ]);
    const winner = ok.status === "fulfilled" ? ok : bad;
    const loser = ok.status === "rejected" ? ok : bad;
    expect(winner.status).toBe("fulfilled");
    expect(loser.status).toBe("rejected");
    expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(JobError);
    expect((loser as PromiseRejectedResult).reason.status).toBe(409);

    const wjob = (winner as PromiseFulfilledResult<{ job: { id: string } }>).value.job;
    expect(await drain(wjob.id)).toBe("completed");
    expect(submissions.length).toBe(3); // this clip's single shot owns all 3 windows
    const fresh = await loadChain(chain.id);
    expect(fresh?.status).toBe("completed");
    const [s0] = fresh!.shots as { hint?: string }[];
    expect(s0.hint).toBe("more teal");
  }, 120_000);

  it("honors the billed window count - 1 window paid on a 3-window clip fails with 0 submissions", async () => {
    const job = await createJob("u-re-edit", {
      endpointId: RE_EDIT_ENDPOINT,
      params: { video_url: videoUrl, windows: 1, flow: "restyle", resolution: "480p" },
    });
    expect(await drain(job.id)).toBe("failed");
    const [{ error }] = await sql<{ error: string }>(`SELECT error FROM jobs WHERE id = $1`, [job.id]);
    expect(error).toContain("needs");
    expect(submissions.length).toBe(0);
  }, 120_000);

  it("cancel mid-run → chain canceled, in-flight window sub-job canceled, no result, temp gone", async () => {
    hangPolls = true;
    const { chain, job } = await startChain("u-re-edit", {
      videoUrl, flow: "restyle", imageUrls: [], resolution: "480p",
    });
    // wait until the first window sub-job is actually in flight
    for (let i = 0; i < 200 && !submissions.length; i++) await new Promise((r) => setTimeout(r, 100));
    expect(submissions.length).toBe(1);

    const canceled = await cancelJob("u-re-edit", job.id);
    expect(canceled.status).toBe("canceled");
    // the recipe notices the abort on its poll boundary, cancels the sub-job
    for (let i = 0; i < 200 && !cancels.length; i++) await new Promise((r) => setTimeout(r, 50));
    expect(cancels).toEqual(["fake-1"]);

    // give the recipe's catch/finally a beat to write the canceled state
    let final = await loadChain(chain.id);
    for (let i = 0; i < 100 && final?.status !== "canceled"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      final = await loadChain(chain.id);
    }
    expect(final?.status).toBe("canceled");
    expect(final?.resultUrl ?? null).toBeNull();
    expect(existsSync(resolve(process.cwd(), "public", "files", "generated", ".re-edit", job.id))).toBe(false);
  }, 120_000);

  it("a second user's job on the chain fails with 0 submissions and leaves the row unchanged", async () => {
    const { chain, job } = await startChain("u-re-edit", {
      videoUrl, flow: "restyle", imageUrls: [], resolution: "480p",
    });
    expect(await drain(job.id)).toBe("completed");
    const before = await loadChain(chain.id);

    submissions.length = 0;
    const evil = await createJob("u-re-edit-b", {
      endpointId: RE_EDIT_ENDPOINT,
      params: {
        chain_id: chain.id, regenerate_index: 0, windows: 1,
        flow: "restyle", video_url: videoUrl, resolution: "480p",
      },
    });
    expect(await drain(evil.id)).toBe("failed");
    const [{ error }] = await sql<{ error: string }>(`SELECT error FROM jobs WHERE id = $1`, [evil.id]);
    expect(error).toContain("re-edit chain not found");
    expect(submissions.length).toBe(0);

    const after = await loadChain(chain.id);
    expect(after?.status).toBe("completed");
    expect(after?.resultUrl).toBe(before?.resultUrl);
    expect(after?.shotOutputs).toEqual(before?.shotOutputs);
  }, 120_000);

  it("applies the restyle preset to every window submission", async () => {
    // a RESTYLE_PRESET_IDS effect - the fragment lands on every window;
    // restyle presets are plain-effect ones (no negative_prompt apply)
    const preset = EFFECT_PRESETS.find((p) => p.id === "comic-panel")!;
    const { job } = await startChain("u-re-edit", {
      videoUrl, flow: "restyle", imageUrls: [],
      instructions: "make it teal", presetId: preset.id, resolution: "480p",
    });
    expect(await drain(job.id)).toBe("completed");
    expect(submissions.length).toBe(3);
    for (const s of submissions) {
      expect(String(s.params.prompt)).toContain("make it teal");
      expect(String(s.params.prompt)).toContain(preset.promptFragment!.slice(0, 60));
    }
  }, 120_000);

  it("character-swap windows ride the person-swap person graph - cut-out pre-pass first, never the full-frame swap", async () => {
    const { chain, job } = await startChain("u-re-edit", {
      videoUrl, flow: "character-swap", imageUrls: [imgUrl], likenessConsent: true,
      instructions: "wearing my jacket", resolution: "480p",
    });
    expect(await drain(job.id)).toBe("completed");
    // 1 ref-cutout + 3 person windows - the full-frame vace-character-swap
    // graph never reaches the provider
    const graphs = submissions.map((s) => s.workflow.providers.comfy?.workflow);
    expect(graphs).toEqual([
      "person-swap-refcut.json",
      "person-swap-person.json", "person-swap-person.json", "person-swap-person.json",
    ]);
    const win = submissions[1];
    expect(String(win.params.video_url)).toContain("cut-0-0");
    // the window's identity ref is the cut-out the pre-pass returned
    expect(win.params.image_urls).toEqual([winFixture]);
    expect(String(win.params.prompt)).toContain("wearing my jacket");
    const fresh = await loadChain(chain.id);
    expect(fresh?.status).toBe("completed");
    expect(fresh?.resultUrl).toMatch(/^\/files\/generated\/re-edit\//);
  }, 120_000);

  it("a flow outside RE_EDIT_FLOWS fails with 0 submissions", async () => {
    const job = await createJob("u-re-edit", {
      endpointId: RE_EDIT_ENDPOINT,
      params: { video_url: videoUrl, windows: 1, flow: "image-to-video", resolution: "480p" },
    });
    expect(await drain(job.id)).toBe("failed");
    const [{ error }] = await sql<{ error: string }>(`SELECT error FROM jobs WHERE id = $1`, [job.id]);
    expect(error).toContain("unknown re-edit flow");
    expect(submissions.length).toBe(0);
  }, 120_000);

  it("regen refused while another video job is live → 429, chain back to completed", async () => {
    const { chain, job } = await startChain("u-re-edit", {
      videoUrl, flow: "restyle", imageUrls: [], resolution: "480p",
    });
    expect(await drain(job.id)).toBe("completed");

    // a live video job fills the free plan's single video slot - the mock
    // provider reports it in_progress for ~5 s, so the regen's createJob
    // sees 1 active job and refuses with 429
    const blocker = await createJob("u-re-edit", {
      endpointId: "motionfield/wan-2.1/text-to-video",
      params: { prompt: "blocker", duration: 3, resolution: "480p" },
    });
    try {
      await expect(regenerateShot("u-re-edit", chain.id, 0))
        .rejects.toMatchObject({ status: 429 });
      expect((await loadChain(chain.id))?.status).toBe("completed");
    } finally {
      await cancelJob("u-re-edit", blocker.id).catch(() => {});
    }
  }, 120_000);

  it("a lost run reconciles to failed on GET, then regen runs again", async () => {
    const { chain, job } = await startChain("u-re-edit", {
      videoUrl, flow: "restyle", imageUrls: [], resolution: "480p",
    });
    expect(await drain(job.id)).toBe("completed");

    // simulate a lost recipe run: the row says in_progress, the run is gone
    await sql(`UPDATE jobs SET status = 'in_progress', provider = 'recipe',
               provider_request_id = 'recipe-lost' WHERE id = $1`, [job.id]);
    await sql(`UPDATE re_edit_chains SET status = 'running' WHERE id = $1`, [chain.id]);

    const got = await getChain("u-re-edit", chain.id);
    expect(got?.chain.status).toBe("failed");
    expect(got?.chain.error).toContain("lost");

    const regen = await regenerateShot("u-re-edit", chain.id, 0);
    expect(regen.job?.id).toBeTruthy();
    expect(await drain(regen.job.id)).toBe("completed");
    expect((await loadChain(chain.id))?.status).toBe("completed");
  }, 120_000);

  it("a canceled chain can be reclaimed by a regen", async () => {
    const { chain, job } = await startChain("u-re-edit", {
      videoUrl, flow: "restyle", imageUrls: [], resolution: "480p",
    });
    expect(await drain(job.id)).toBe("completed");
    await sql(`UPDATE re_edit_chains SET status = 'canceled' WHERE id = $1`, [chain.id]);
    const regen = await regenerateShot("u-re-edit", chain.id, 0);
    expect(regen.job?.id).toBeTruthy();
    expect(await drain(regen.job.id)).toBe("completed");
    expect((await loadChain(chain.id))?.status).toBe("completed");
  }, 120_000);

  it("steps: absent → not sent to the graph; given → clamped to 2-50", async () => {
    const j1 = await createJob("u-re-edit", {
      endpointId: RE_EDIT_ENDPOINT,
      params: { video_url: videoUrl, windows: 3, flow: "restyle", resolution: "480p" },
    });
    expect(await drain(j1.id)).toBe("completed");
    expect(submissions.length).toBe(3);
    submissions.forEach((s) => expect(s.params.steps).toBeUndefined());

    submissions.length = 0;
    const j2 = await createJob("u-re-edit", {
      endpointId: RE_EDIT_ENDPOINT,
      params: { video_url: videoUrl, windows: 3, flow: "restyle", resolution: "480p", steps: 6 },
    });
    expect(await drain(j2.id)).toBe("completed");
    submissions.forEach((s) => expect(s.params.steps).toBe(6));

    submissions.length = 0;
    const j3 = await createJob("u-re-edit", {
      endpointId: RE_EDIT_ENDPOINT,
      params: { video_url: videoUrl, windows: 3, flow: "restyle", resolution: "480p", steps: 500 },
    });
    expect(await drain(j3.id)).toBe("completed");
    submissions.forEach((s) => expect(s.params.steps).toBe(50));
  }, 120_000);

  it("vace-source endpoints refuse a source clip under 4 s - pre-charge", async () => {
    // the vaceSource label has always promised ≥4s - now createJob probes
    // the owned file before credits move, on every endpoint that uses it
    await expect(createJob("u-re-edit", {
      endpointId: "motionfield/wan-vace/character-swap",
      params: { video_url: shortUrl, image_urls: [imgUrl], likeness_consent: true },
    })).rejects.toMatchObject({ status: 400 });
    await expect(createJob("u-re-edit", {
      endpointId: "motionfield/wan-vace/object-swap",
      params: { video_url: shortUrl, image_urls: [imgUrl] },
    })).rejects.toMatchObject({ status: 400 });
    expect(submissions.length).toBe(0);
  }, 120_000);

  it("rejects media the caller does not own", async () => {
    await expect(startChain("u-re-edit", {
      videoUrl: "/files/uploads/not-mine.mp4", flow: "restyle", imageUrls: [], resolution: "480p",
    })).rejects.toMatchObject({ status: 404 });
    await expect(startChain("u-re-edit", {
      videoUrl: "https://example.com/v.mp4", flow: "restyle", imageUrls: [], resolution: "480p",
    })).rejects.toMatchObject({ status: 400 });
  });
});
