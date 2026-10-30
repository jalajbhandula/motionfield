import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@/db";
import { findEndpoint } from "@/lib/catalog/video-models";
import { JobError, coerceParams } from "@/lib/jobs";
import { hashJobRequest } from "@/lib/api/idempotency";
import {
  validatePlan, estimateSteps, createRun, controlRun, tickRun, getRunView,
  AUTO_APPROVE_CAP_CREDITS, type LiveEndpoint,
} from "@/lib/runs";

/**
 * WS2 s4 run engine - durable runs over catalog endpoints.
 * GENERATION_PROVIDER=mock: submitted jobs complete ~5s after submit, so
 * executor tests advance the engine with explicit tickRun calls.
 */

const T2I = "motionfield/z-image-turbo/text-to-image";   // kind image, ~0.08 cr
const IMG2IMG = "motionfield/z-image-turbo/img2img";     // kind edit→image, 0.08 cr
const T2V = "motionfield/wan-2.1/text-to-video";         // kind video
const I2V = "motionfield/wan-2.1/image-to-video";        // heavy
const LTX = "motionfield/ltx-video/text-to-video";       // restricted license

const epsOf = (...ids: string[]): LiveEndpoint[] =>
  ids.map((id) => findEndpoint(id)!).filter(Boolean);
const ALL = epsOf(T2I, IMG2IMG, T2V, I2V, LTX);
const AUTO = { mode: "auto" as const, optIn: false };

beforeAll(() => {
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws2-runs-"));
  process.env.BETTER_AUTH_SECRET = "test-secret-ws2-0123456789abcdef0123456789ab";
  process.env.GENERATION_PROVIDER = "mock";
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
}, 60_000);

afterEach(() => {
  process.env.GENERATION_PROVIDER = "mock";
  vi.restoreAllMocks();
});

let n = 0;
async function makeUser() {
  const id = `u-runs-${++n}`;
  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$2,$3,true)`, [id, id, `${id}@test.dev`]);
  const { ensureProfile } = await import("@/lib/profiles");
  await ensureProfile(id, `${id}@test.dev`, id);
  await sql(`UPDATE profiles SET credits = 10000 WHERE user_id = $1`, [id]);
  return id;
}

const plan = (...steps: { id: string; endpoint_id: string; params?: Record<string, unknown>; depends_on?: string[]; title?: string }[]) => ({
  title: "test plan",
  steps: steps.map((s) => ({ title: s.title ?? s.id, params: {}, depends_on: [], ...s })),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** settle one mock job (queue 1.2s + run 3.8s + margin) then tick */
const settle = async (runId: string) => { await sleep(5300); await tickRun(runId); };

/* ------------------------------- validatePlan ------------------------------ */

describe("validatePlan", () => {
  it("refuses malformed plans with a 422 naming the bad field", () => {
    expect(() => validatePlan({ steps: [] }, ALL, AUTO)).toThrowError(JobError);
    try { validatePlan({ steps: "nope" }, ALL, AUTO); expect.unreachable(); }
    catch (e) { expect((e as JobError).status).toBe(422); expect(String((e as Error).message)).toMatch(/malformed/); }
  });

  it("refuses duplicate step ids", () => {
    expect(() => validatePlan(
      plan({ id: "s1", endpoint_id: T2I, params: { prompt: "a" } }, { id: "s1", endpoint_id: T2I, params: { prompt: "b" } }),
      ALL, AUTO)).toThrowError(/repeats step id/);
  });

  it("refuses endpoints not installed, not allowlisted, or license-gated", () => {
    expect(() => validatePlan(
      plan({ id: "s1", endpoint_id: "motionfield/ghost/thing", params: {} }), ALL, AUTO))
      .toThrowError(/isn't installed/);
    // restricted without opt-in
    expect(() => validatePlan(
      plan({ id: "s1", endpoint_id: LTX, params: { prompt: "a" } }), ALL, AUTO))
      .toThrowError(/opt-in/);
    // not in this turn's allowlist at all
    expect(() => validatePlan(
      plan({ id: "s1", endpoint_id: T2V, params: { prompt: "a" } }), epsOf(T2I), AUTO))
      .toThrowError(/isn't available/);
  });

  it("refuses heavy endpoints in offline mode", () => {
    expect(() => validatePlan(
      plan({ id: "s1", endpoint_id: I2V, params: { prompt: "a", image_url: "/files/x.png" } }),
      ALL, { mode: "offline", optIn: false })).toThrowError(/[Oo]ffline/);
  });

  it("refuses forward/self dependencies (order is topological by construction)", () => {
    expect(() => validatePlan(
      plan({ id: "s1", endpoint_id: T2I, params: { prompt: "a" }, depends_on: ["s2"] },
           { id: "s2", endpoint_id: T2I, params: { prompt: "b" } }), ALL, AUTO))
      .toThrowError(/earlier in the plan/);
    expect(() => validatePlan(
      plan({ id: "s1", endpoint_id: T2I, params: { prompt: "a" }, depends_on: ["s1"] }), ALL, AUTO))
      .toThrowError(/depend on itself/);
  });

  it("refuses $step refs outside media params, without depends_on, or of the wrong kind", () => {
    // ref in a non-media param
    expect(() => validatePlan(
      plan({ id: "s1", endpoint_id: T2I, params: { prompt: "a" } },
           { id: "s2", endpoint_id: IMG2IMG, params: { prompt: "$step:s1.outputs[0]", image_url: "/files/x.png" }, depends_on: ["s1"] }),
      ALL, AUTO)).toThrowError(/only media params/);
    // ref without depends_on
    expect(() => validatePlan(
      plan({ id: "s1", endpoint_id: T2I, params: { prompt: "a" } },
           { id: "s2", endpoint_id: IMG2IMG, params: { prompt: "b", image_url: "$step:s1.outputs[0]" } }),
      ALL, AUTO)).toThrowError(/doesn't depend on it/);
    // video output can't feed an image param
    expect(() => validatePlan(
      plan({ id: "s1", endpoint_id: T2V, params: { prompt: "a" } },
           { id: "s2", endpoint_id: IMG2IMG, params: { prompt: "b", image_url: "$step:s1.outputs[0]" }, depends_on: ["s1"] }),
      ALL, AUTO)).toThrowError(/expects image|outputs video/);
  });

  it("refuses missing required params", () => {
    expect(() => validatePlan(
      plan({ id: "s1", endpoint_id: IMG2IMG, params: { prompt: "b" } }), ALL, AUTO))
      .toThrowError(/missing required input "image_url"/);
  });

  it("accepts a valid image→image chain and normalizes cost/coercion", () => {
    const steps = validatePlan(
      plan({ id: "s1", endpoint_id: T2I, params: { prompt: "a lighthouse" } },
           { id: "s2", endpoint_id: IMG2IMG, title: "restyle", params: { prompt: "sepia", image_url: "$step:s1.outputs[0]", denoise: "0.5" }, depends_on: ["s1"] }),
      ALL, AUTO);
    expect(steps).toHaveLength(2);
    expect(steps[0].cost).toBeCloseTo(0.08, 5);
    expect(steps[1].dependsOn).toEqual(["s1"]);
    expect(steps[1].params.denoise).toBe(0.5); // string coerced to number
  });

  it("refuses a literal media param whose file kind can't match (F4)", () => {
    const RESTYLE = "motionfield/wan-vace/restyle"; // video_url required
    const OPT = { mode: "auto" as const, optIn: true };
    // extension-known url in the wrong slot
    expect(() => validatePlan(
      plan({ id: "s1", endpoint_id: RESTYLE, params: { prompt: "a", video_url: "/files/u/shot.png" } }),
      epsOf(RESTYLE), OPT))
      .toThrowError(/step "s1" needs a video for "video_url", but the attached file is a image/);
    // no useful extension - the attached file's own kind decides
    expect(() => validatePlan(
      plan({ id: "s1", endpoint_id: RESTYLE, params: { prompt: "a", video_url: "/files/u/blob" } }),
      epsOf(RESTYLE), { ...OPT, atts: [{ url: "/files/u/blob", mime: "audio/wav" }] }))
      .toThrowError(/attached file is a audio/);
    // the session's last-output bucket decides too
    expect(() => validatePlan(
      plan({ id: "s1", endpoint_id: RESTYLE, params: { prompt: "a", video_url: "/files/u/last" } }),
      epsOf(RESTYLE), { ...OPT, lastOutputs: { image: "/files/u/last" } }))
      .toThrowError(/attached file is a image/);
    // array params check each item
    expect(() => validatePlan(
      plan({ id: "s1", endpoint_id: RESTYLE, params: { prompt: "a", video_url: "/files/u/clip.mp4", image_urls: ["/files/u/a.png", "/files/u/b.wav"] } }),
      epsOf(RESTYLE), OPT))
      .toThrowError(/needs a image for "image_urls", but the attached file is a audio/);
    // kind-unknown urls pass - the rule only refuses what it knows is wrong
    expect(validatePlan(
      plan({ id: "s1", endpoint_id: RESTYLE, params: { prompt: "a", video_url: "/files/u/opaque" } }),
      epsOf(RESTYLE), OPT)).toHaveLength(1);
  });
});

/* ------------------------------- estimateSteps ----------------------------- */

describe("estimateSteps", () => {
  it("sums catalog costs and takes the median of the last 20 finished jobs per endpoint", async () => {
    const uid = await makeUser();
    // 3 completed jobs on T2V with durations 10s, 20s, 30s → median 20
    for (const [i, secs] of [10, 20, 30].entries()) {
      await sql(
        `INSERT INTO jobs (user_id, kind, model_id, endpoint_id, workflow, provider, provider_request_id,
                           status, progress, cost_credits, prompt, started_at, completed_at)
         VALUES ($1,'video','wan-2-1',$2,'text-to-video','mock',$3,'completed',100,5,'eta',
                 now() - ($4 || ' seconds')::interval, now())`,
        [uid, T2V, `hist-${uid}-${i}`, String(secs)]);
    }
    const steps = validatePlan(
      plan({ id: "s1", endpoint_id: T2V, params: { prompt: "a", resolution: "720p", duration: 5 } },
           { id: "s2", endpoint_id: T2I, params: { prompt: "b" }, depends_on: ["s1"] },
           // s3 is the same endpoint at its declared defaults - the only
           // spec the endpoint median describes
           { id: "s3", endpoint_id: T2V, params: { prompt: "c" }, depends_on: ["s2"] }), ALL, AUTO);
    const est = await estimateSteps(steps);
    // coerceParams now fills declared defaults - s3 runs 480p (5 cr), not
    // the graph's unguided 720p
    expect(est.total).toBeCloseTo(9 + 0.08 + 5, 2);        // per5s 720p × 5s + t2i + t2v at its own default spec
    expect(est.perStep[0].etaSeconds).toBeNull();          // 720p differs from the 480p default → honest unknown
    expect(est.perStep[2].etaSeconds).toBe(20);            // median of 10/20/30 at default spec
    expect(est.etaSeconds).toBeNull();                     // any unknown step → honest unknown
  }, 30000);

  it("returns etaSeconds null when no endpoint has history", async () => {
    const steps = validatePlan(plan({ id: "s1", endpoint_id: T2I, params: { prompt: "a" } }), epsOf(T2I), AUTO);
    const est = await estimateSteps(steps);
    expect(est.etaSeconds).toBeNull();
    expect(est.total).toBeCloseTo(0.08, 5);
  }, 30000);
});

/* --------------------------- createRun + approve --------------------------- */

describe("createRun gate + approve", () => {
  it("ask_first parks the run at awaiting_approval and creates 0 jobs until approve", async () => {
    const uid = await makeUser();
    const run = await createRun(uid, { plan: plan({ id: "s1", endpoint_id: T2I, params: { prompt: "a" } }), askFirst: true });
    expect(run.status).toBe("awaiting_approval");
    expect(run.steps[0].status).toBe("pending");
    expect(await sql(`SELECT id FROM jobs WHERE user_id = $1`, [uid])).toHaveLength(0);

    await controlRun(uid, run.id, "approve");
    const view = (await getRunView(uid, run.id))!;
    expect(view.status).toBe("running");
    expect(view.steps[0].status).toBe("running");
    expect(view.steps[0].job_id).toBeTruthy();
    expect(view.steps[0].input_hash).toMatch(/^[0-9a-f]{64}$/);
  }, 30000);

  it("estimate over the auto-approve cap parks the run even without ask_first", async () => {
    const uid = await makeUser();
    const run = await createRun(uid, {
      plan: plan({ id: "s1", endpoint_id: T2V, params: { prompt: "a", resolution: "720p", duration: 5 } }), // 9 cr > cap
    });
    expect(run.estimate_credits).toBeGreaterThan(AUTO_APPROVE_CAP_CREDITS);
    expect(run.status).toBe("awaiting_approval");
  }, 30000);

  it("under the cap auto-starts and stays idempotent across ticks", async () => {
    const uid = await makeUser();
    const run = await createRun(uid, { plan: plan({ id: "s1", endpoint_id: T2I, params: { prompt: "a" } }) });
    expect(run.status).toBe("running");
    await tickRun(run.id); await tickRun(run.id); // job still in flight → no-op
    const jobs = await sql<{ id: string; idempotency_key: string; request_hash: string }>(
      `SELECT id, idempotency_key, request_hash FROM jobs WHERE user_id = $1`, [uid]);
    expect(jobs).toHaveLength(1);
    const stepId = run.steps[0].id;
    // the key is revision-scoped - a re-run of the same step mints a new job
    expect(jobs[0].idempotency_key).toBe(`run-step:${stepId}:r0`);
    // validatePlan stores coerceParams'd params - declared defaults are
    // filled, so the hash covers them
    const t2i = findEndpoint(T2I)!.workflow;
    expect(jobs[0].request_hash).toBe(hashJobRequest(T2I, coerceParams(t2i, { prompt: "a" })));
  }, 30000);
});

/* ------------------------------- tickRun exec ------------------------------ */

describe("tickRun sequential execution", () => {
  it("chains $step output into the next job - one step in flight at a time", async () => {
    const uid = await makeUser();
    const run = await createRun(uid, {
      plan: plan(
        { id: "s1", endpoint_id: T2I, params: { prompt: "a lighthouse" } },
        { id: "s2", endpoint_id: IMG2IMG, params: { prompt: "sepia", image_url: "$step:s1.outputs[0]" }, depends_on: ["s1"] }),
    });
    // s1 running, s2 still gated
    expect(run.steps[0].status).toBe("running");
    expect(run.steps[1].status).toBe("pending");

    await settle(run.id);   // s1's job completes → stepDone → the same tick
                            // keeps going: s2 claims the freed slot inline
    let view = (await getRunView(uid, run.id))!;
    expect(view.steps[0].status).toBe("done");
    expect(view.steps[1].status).toBe("running"); // claimed AFTER s1 was done - sequentiality holds
    const [j2] = await sql<{ params: { image_url?: string } }>(
      `SELECT params FROM jobs WHERE id = $1`, [view.steps[1].job_id]);
    const s1out = (view.steps[0].outputs as { url: string }[])[0].url;
    expect(j2.params.image_url).toBe(s1out);    // the ref resolved to s1's url

    await settle(run.id);                       // s2 completes → the same tick finalizes
    view = (await getRunView(uid, run.id))!;
    expect(view.steps[1].status).toBe("done");
    expect(view.status).toBe("done");
  }, 60000);

  it("a failed step fails the run and skips the rest", async () => {
    const uid = await makeUser();
    process.env.GENERATION_PROVIDER = "nope"; // provider submit throws → job failed
    const run = await createRun(uid, {
      plan: plan(
        { id: "s1", endpoint_id: T2I, params: { prompt: "a" } },
        { id: "s2", endpoint_id: T2I, params: { prompt: "b" }, depends_on: ["s1"] }),
    });
    process.env.GENERATION_PROVIDER = "mock";
    await tickRun(run.id); // reconcile s1's failed job
    const view = (await getRunView(uid, run.id))!;
    expect(view.steps[0].status).toBe("failed");
    expect(view.steps[1].status).toBe("skipped");
    expect(view.status).toBe("failed");
    const jobs = await sql(`SELECT status FROM jobs WHERE user_id = $1`, [uid]);
    expect(jobs).toHaveLength(1); // s2 never submitted
  }, 30000);
});

/* --------------------------------- stop ------------------------------------ */

describe("controlRun stop", () => {
  it("cancels the live job, cancels pending steps and stops the run", async () => {
    const uid = await makeUser();
    const run = await createRun(uid, {
      plan: plan(
        { id: "s1", endpoint_id: T2I, params: { prompt: "a" } },
        { id: "s2", endpoint_id: T2I, params: { prompt: "b" }, depends_on: ["s1"] }),
    });
    expect(run.steps[0].status).toBe("running");
    const jobId = run.steps[0].job_id!;

    await controlRun(uid, run.id, "stop");
    const view = (await getRunView(uid, run.id))!;
    expect(view.status).toBe("stopped");
    expect(view.steps[0].status).toBe("canceled");
    expect(view.steps[1].status).toBe("canceled");
    const [job] = await sql<{ status: string }>(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
    expect(job.status).toBe("canceled");

    await tickRun(run.id); // stopped runs never resume
    expect((await getRunView(uid, run.id))!.status).toBe("stopped");

    // idempotent: a second stop is a no-op returning the terminal view
    expect(await controlRun(uid, run.id, "stop")).toBe(true);
  }, 30000);

  it("ownership: another user's stop/approve reads nothing and mutates nothing", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const run = await createRun(owner, { plan: plan({ id: "s1", endpoint_id: T2I, params: { prompt: "a" } }), askFirst: true });
    expect(await controlRun(other, run.id, "stop")).toBeNull();
    expect(await controlRun(other, run.id, "approve")).toBeNull();
    expect(await getRunView(other, run.id)).toBeNull();
    expect((await getRunView(owner, run.id))!.status).toBe("awaiting_approval");
  }, 30000);
});
