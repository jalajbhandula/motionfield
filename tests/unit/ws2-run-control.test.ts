import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@/db";
import { JobError } from "@/lib/jobs";
import {
  createRun, controlRun, editStep, tickRun, getRunView, listRunEvents,
} from "@/lib/runs";

/**
 * WS2 s5 run control - pause/resume, step revisions, durable run events.
 * GENERATION_PROVIDER=mock: submitted jobs complete ~5s after submit, so
 * the engine is advanced with explicit tickRun calls (same lazily-fired tick
 * the session poll uses).
 */

const T2I = "motionfield/z-image-turbo/text-to-image";   // kind image, ~0.08 cr
const IMG2IMG = "motionfield/z-image-turbo/img2img";     // kind edit→image

beforeAll(() => {
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws2-ctl-"));
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
  const id = `u-ctl-${++n}`;
  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$2,$3,true)`, [id, id, `${id}@test.dev`]);
  const { ensureProfile } = await import("@/lib/profiles");
  await ensureProfile(id, `${id}@test.dev`, id);
  await sql(`UPDATE profiles SET credits = 10000 WHERE user_id = $1`, [id]);
  return id;
}

const plan = (...steps: { id: string; endpoint_id: string; params?: Record<string, unknown>; depends_on?: string[]; title?: string }[]) => ({
  title: "control plan",
  steps: steps.map((s) => ({ title: s.title ?? s.id, params: {}, depends_on: [], ...s })),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = async (runId: string) => { await sleep(5300); await tickRun(runId); };
const jobsOf = (uid: string) => sql<{ id: string }>(`SELECT id FROM jobs WHERE user_id = $1`, [uid]);

describe("controlRun pause/resume", () => {
  it("paused: in-flight step reconciles, pending steps stay parked; resume continues to done", async () => {
    const uid = await makeUser();
    const run = await createRun(uid, {
      plan: plan(
        { id: "s1", endpoint_id: T2I, params: { prompt: "a" } },
        { id: "s2", endpoint_id: T2I, params: { prompt: "b" }, depends_on: ["s1"] }),
    });
    expect(run.status).toBe("running");
    expect(run.steps[0].job_id).toBeTruthy();

    await controlRun(uid, run.id, "pause");
    let view = (await getRunView(uid, run.id))!;
    expect(view.status).toBe("paused");

    // s1's job finishes while paused - the step reconciles, but s2 must NOT
    // submit: no new jobs while parked, however many ticks fire
    await settle(run.id);
    view = (await getRunView(uid, run.id))!;
    expect(view.status).toBe("paused");
    expect(view.steps[0].status).toBe("done");
    expect(view.steps[1].status).toBe("pending");
    expect(view.steps[1].job_id).toBeNull();
    expect(await jobsOf(uid)).toHaveLength(1);
    await tickRun(run.id);
    expect(await jobsOf(uid)).toHaveLength(1);

    await controlRun(uid, run.id, "resume");
    view = (await getRunView(uid, run.id))!;
    expect(view.status).toBe("running");
    expect(view.steps[1].job_id).toBeTruthy(); // resume's own tick claimed s2

    await settle(run.id);
    await tickRun(run.id);
    view = (await getRunView(uid, run.id))!;
    expect(view.status).toBe("done");
  }, 60000);

  it("pause/resume are idempotent; pause after terminal is a no-op; stop works from paused", async () => {
    const uid = await makeUser();
    const run = await createRun(uid, {
      plan: plan(
        { id: "s1", endpoint_id: T2I, params: { prompt: "a" } },
        { id: "s2", endpoint_id: T2I, params: { prompt: "b" }, depends_on: ["s1"] }),
    });
    expect(await controlRun(uid, run.id, "pause")).toBe(true);
    expect(await controlRun(uid, run.id, "pause")).toBe(true);
    expect((await getRunView(uid, run.id))!.status).toBe("paused");
    // resume → pause again → stop from paused: pending cancels, in-flight cancels
    expect(await controlRun(uid, run.id, "resume")).toBe(true);
    expect(await controlRun(uid, run.id, "pause")).toBe(true);
    expect(await controlRun(uid, run.id, "stop")).toBe(true);
    const view = (await getRunView(uid, run.id))!;
    expect(view.status).toBe("stopped");
    expect(view.steps[1].status).toBe("canceled");
    // pause from a terminal state is an illegal transition → 409 (B2)
    await expect(controlRun(uid, run.id, "pause")).rejects.toMatchObject({ status: 409 });
    expect((await getRunView(uid, run.id))!.status).toBe("stopped");
  }, 30000);

  it("illegal transitions 409: pause on awaiting_approval, resume on anything but paused", async () => {
    const uid = await makeUser();
    const run = await createRun(uid, {
      plan: plan({ id: "s1", endpoint_id: T2I, params: { prompt: "a" } }), askFirst: true,
    });
    expect((await getRunView(uid, run.id))!.status).toBe("awaiting_approval");
    await expect(controlRun(uid, run.id, "pause")).rejects.toMatchObject({ status: 409 });
    await expect(controlRun(uid, run.id, "resume")).rejects.toMatchObject({ status: 409 });
    expect((await getRunView(uid, run.id))!.status).toBe("awaiting_approval");
    // a stop on a parked run is legal; stop on terminal is an idempotent 200
    expect(await controlRun(uid, run.id, "stop")).toBe(true);
    expect(await controlRun(uid, run.id, "stop")).toBe(true);
    await expect(controlRun(uid, run.id, "resume")).rejects.toMatchObject({ status: 409 });
  }, 30000);
});

describe("editStep + revisions", () => {
  it("editing a pending step bumps rev, snapshots the old spec, recomputes the estimate", async () => {
    const uid = await makeUser();
    const run = await createRun(uid, {
      plan: plan(
        { id: "s1", endpoint_id: T2I, params: { prompt: "original" } },
        { id: "s2", endpoint_id: IMG2IMG, params: { prompt: "restyle", image_url: "$step:s1.outputs[0]" }, depends_on: ["s1"] }),
      askFirst: true,
    });

    const out = await editStep(uid, run.id, "s1", { params: { prompt: "edited prompt" }, title: "renamed", rev: 0 });
    expect(out!.rev).toBe(1);

    // the previous spec landed in the audit table
    const revs = await sql<{ rev: number; endpoint_id: string; params: { prompt?: string }; status: string }>(
      `SELECT rev, endpoint_id, params, status FROM run_step_revisions WHERE run_id = $1 AND step_id = 's1'`, [run.id]);
    expect(revs).toHaveLength(1);
    expect(revs[0].rev).toBe(0);
    expect(revs[0].params.prompt).toBe("original");

    const view = (await getRunView(uid, run.id))!;
    const s1 = view.steps[0];
    expect(s1.params.prompt).toBe("edited prompt");
    expect(s1.title).toBe("renamed");
    expect(s1.rev).toBe(1);
    expect(s1.input_hash).toBeNull(); // recomputed at submit - no stale hash

    // approve → the job runs the edited spec
    await controlRun(uid, run.id, "approve");
    const v2 = (await getRunView(uid, run.id))!;
    const [job] = await sql<{ params: { prompt?: string } }>(`SELECT params FROM jobs WHERE id = $1`, [v2.steps[0].job_id]);
    expect(job.params.prompt).toBe("edited prompt");
  }, 30000);

  it("a live run refuses edits outright; a stale rev is a 409 that reports the current rev", async () => {
    const uid = await makeUser();
    const run = await createRun(uid, {
      plan: plan(
        { id: "s1", endpoint_id: T2I, params: { prompt: "a" } },
        { id: "s2", endpoint_id: IMG2IMG, params: { prompt: "b", image_url: "$step:s1.outputs[0]" }, depends_on: ["s1"] }),
    });
    // the run is running → any edit is 409 before it even reaches the step
    await expect(editStep(uid, run.id, "s1", { params: { prompt: "x" }, rev: 0 }))
      .rejects.toMatchObject({ status: 409 });
    await expect(editStep(uid, run.id, "s2", { params: { prompt: "x" }, rev: 0 }))
      .rejects.toMatchObject({ status: 409 });

    // parked run: stale rev → 409 carrying the step's current rev
    const parked = await createRun(uid, {
      plan: plan({ id: "s1", endpoint_id: T2I, params: { prompt: "a" } }), askFirst: true,
    });
    await expect(editStep(uid, parked.id, "s1", { params: { prompt: "x" }, rev: 7 }))
      .rejects.toMatchObject({ status: 409, rev: 0 });

    // spec would be invalid (undeclared param) → 422 inside the lock
    await expect(editStep(uid, parked.id, "s1", { params: { not_a_param: 1 }, rev: 0 }))
      .rejects.toMatchObject({ status: 422 });

    expect(await editStep(uid, parked.id, "nope", { params: {}, rev: 0 })).toBeNull();
    expect(await editStep(uid, "00000000-0000-0000-0000-000000000000", "s1", { params: {}, rev: 0 })).toBeNull();
    // the run is untouched by the refused edits
    const view = (await getRunView(uid, parked.id))!;
    expect(view.steps[0].rev).toBe(0);
  }, 30000);

  it("editing a done run resets the step and its descendants, snapshots the superseded rows, and reopens it", async () => {
    const uid = await makeUser();
    const run = await createRun(uid, {
      plan: plan(
        { id: "s1", endpoint_id: T2I, params: { prompt: "a" } },
        { id: "s2", endpoint_id: T2I, params: { prompt: "b" }, depends_on: ["s1"] },
        { id: "s3", endpoint_id: T2I, params: { prompt: "c" }, depends_on: ["s2"] }),
    });
    // run it to done - sequential executor: each settle advances one step's
    // job lifecycle (submit tick then reconcile tick)
    for (let i = 0; i < 5; i++) { await settle(run.id); }
    await tickRun(run.id);
    let view = (await getRunView(uid, run.id))!;
    expect(view.status).toBe("done");
    const s1Job = view.steps[0].job_id;
    const s1Hash = view.steps[0].input_hash;
    expect(s1Job).toBeTruthy();

    const before = (await jobsOf(uid)).length;
    const out = await editStep(uid, run.id, "s2", { params: { prompt: "edited" }, rev: 0 });
    expect(out!.rev).toBe(1);
    view = (await getRunView(uid, run.id))!;
    expect(view.status).toBe("running"); // terminal run reopened
    // s1 untouched - same job + hash; s2 and s3 reset with bumped revs
    expect(view.steps[0].job_id).toBe(s1Job);
    expect(view.steps[0].input_hash).toBe(s1Hash);
    expect(view.steps[2].status).toBe("pending");
    expect(view.steps[2].rev).toBe(1);
    // the kick tick already submitted the edited step under its new rev key -
    // a fresh job row, not a replay of the old spec's
    const s2Job = view.steps[1].job_id;
    expect(s2Job).toBeTruthy();
    expect(s2Job).not.toBe(s1Job);
    expect((await jobsOf(uid)).length).toBe(before + 1);

    // superseded rows are auditable - s2's and s3's done state, pre-reset
    const revs = await sql<{ step_id: string; rev: number; status: string }>(
      `SELECT step_id, rev, status FROM run_step_revisions WHERE run_id = $1 ORDER BY step_id`, [run.id]);
    expect(revs).toEqual([
      { step_id: "s2", rev: 0, status: "done" },
      { step_id: "s3", rev: 0, status: "done" },
    ]);
    expect(view.steps[1].revisions).toHaveLength(1);

    // the rerun produces exactly the two new jobs and lands on done again
    await settle(run.id);   // s2' reconciles done
    await tickRun(run.id);  // s3' submits
    await settle(run.id);   // s3' reconciles done
    await tickRun(run.id);  // run finalizes
    view = (await getRunView(uid, run.id))!;
    expect(view.status).toBe("done");
    expect((await jobsOf(uid)).length).toBe(before + 2);
    expect(view.steps[2].job_id).toBeTruthy();
  }, 60000);
});

describe("run events", () => {
  it("lifecycle events land in order: created → approved → step_running → step_done → run_done", async () => {
    const uid = await makeUser();
    const run = await createRun(uid, {
      plan: plan({ id: "s1", endpoint_id: T2I, params: { prompt: "a" } }), askFirst: true,
    });
    await controlRun(uid, run.id, "approve");
    await settle(run.id);
    await tickRun(run.id); // finalize
    expect((await getRunView(uid, run.id))!.status).toBe("done");

    const events = (await listRunEvents(uid, run.id))!;
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("run_created");
    expect(kinds).toContain("run_approved");
    expect(kinds).toContain("step_running");
    expect(kinds).toContain("step_done");
    expect(kinds).toContain("run_done");
    // strictly seq-ordered and monotonic
    for (let i = 1; i < events.length; i++) expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    const runningIdx = kinds.indexOf("step_running");
    expect(events[runningIdx].step_id).toBe("s1");
    // resume semantics - ?after skips the prefix
    const rest = (await listRunEvents(uid, run.id, events[0].seq))!;
    expect(rest.every((e) => e.seq > events[0].seq)).toBe(true);
  }, 30000);

  it("pause/resume/edit/stop all narrate events", async () => {
    const uid = await makeUser();
    const run = await createRun(uid, {
      plan: plan(
        { id: "s1", endpoint_id: T2I, params: { prompt: "a" } },
        { id: "s2", endpoint_id: T2I, params: { prompt: "b" }, depends_on: ["s1"] }),
      askFirst: true,
    });
    await editStep(uid, run.id, "s2", { params: { prompt: "edited" }, rev: 0 });
    await controlRun(uid, run.id, "approve");
    await controlRun(uid, run.id, "pause");
    await controlRun(uid, run.id, "resume");
    await controlRun(uid, run.id, "stop");
    const kinds = (await listRunEvents(uid, run.id))!.map((e) => e.kind);
    for (const k of ["step_edited", "run_approved", "run_paused", "run_resumed", "run_stopped"]) {
      expect(kinds).toContain(k);
    }
  }, 30000);
});
