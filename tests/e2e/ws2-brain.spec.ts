/**
 * WS2 "brain" e2e (GENERATION_PROVIDER=mock, no LLM_* configured):
 *  - an agent session's deterministic fallback planner produces a durable run
 *    picking the honest open-license default (wan-2.1 t2v) for a generic video
 *    brief - never LTX;
 *  - the declared params land on the step's job verbatim;
 *  - offline-mode sessions run the same deterministic path;
 *  - interrupt ends the session and stops its runs.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function messages(request: APIRequestContext, sid: string) {
  const r = await request.get(`/api/agent/sessions/${sid}/messages?after=0`);
  expect(r.ok()).toBeTruthy();
  const d = await r.json();
  return d as {
    session: { status: string };
    messages: { kind: string; role: string; content: Record<string, unknown> }[];
    runs: { id: string; status: string; steps: { status: string }[] }[];
  };
}

/** The pglite post-signup hook races the user row's commit on the run's first
 *  sign-up (pre-existing flake - ensureProfile already retries). Retry with a
 *  fresh email each attempt: a failed sign-up can still leave the user row. */
async function signUp(request: APIRequestContext, name: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await request.post("/api/auth/sign-up/email", {
      data: { email: `ws2-${Date.now()}-${attempt}-${Math.random().toString(36).slice(2, 6)}@test.local`, password: "test-pass-1234", name },
    });
    if (r.ok()) return;
    if (attempt === 3) expect(r.ok(), `sign-up: ${await r.text()}`).toBeTruthy();
    await new Promise((res) => setTimeout(res, 500));
  }
}

test.describe("ws2 agent brain", () => {
  test("generic video brief → durable run on wan-2.1 t2v via deterministic planner", async ({ request }) => {
    await signUp(request, "WS2 Brain");

    const sr = await request.post("/api/agent/sessions", { data: { mode: "auto" } });
    expect(sr.status()).toBe(201);
    const { session } = await sr.json();

    const pr = await request.post(`/api/agent/sessions/${session.id}/messages`, {
      data: { text: "generate a video of a neon city at night" },
    });
    expect(pr.status()).toBe(201);

    // planner ran synchronously - a plan card bound to a run must appear,
    // then a run_step tool_call carrying the job id
    const { messages: msgs, runs } = await messages(request, session.id);
    const planMsg = msgs.find((m) => m.kind === "plan" && m.content?.run_id);
    expect(planMsg, "no plan message bound to a run").toBeTruthy();
    const runId = String(planMsg!.content.run_id);
    expect(runs.some((r) => r.id === runId)).toBe(true);

    const call = msgs.find((m) => m.kind === "tool_call" && m.content?.job_id);
    expect(call, "no run_step tool_call with a job id").toBeTruthy();
    expect(call!.content.endpoint).toBe("motionfield/wan-2.1/text-to-video");
    expect(String(call!.content.endpoint)).not.toContain("ltx");
    const jobId = String(call!.content.job_id);

    // the job exists and runs the same endpoint (mock provider completes it)
    const jr = await request.get(`/api/jobs/${jobId}`);
    expect(jr.ok()).toBeTruthy();
    const { job } = await jr.json();
    expect(job.endpointId).toBe("motionfield/wan-2.1/text-to-video");
    expect(job.params.resolution).toBe("480p");
    expect(job.params.duration).toBe(3);
    expect(String(job.params.prompt)).toContain("neon city");

    // the run is reachable through its own API
    const rr = await request.get(`/api/agent/runs/${runId}`);
    expect(rr.ok()).toBeTruthy();
    expect((await rr.json()).run.id).toBe(runId);

    // interrupt ends the session and stops the run
    const ir = await request.post(`/api/agent/sessions/${session.id}/interrupt`);
    expect(ir.ok()).toBeTruthy();
    const post = await messages(request, session.id);
    expect(post.session.status).toBe("interrupted");
    const runAfter = await request.get(`/api/agent/runs/${runId}`);
    expect(["stopped", "done", "failed"]).toContain((await runAfter.json()).run.status);
  });

  test("offline-mode session still plans deterministically", async ({ request }) => {
    await signUp(request, "WS2 Offline");
    const sr = await request.post("/api/agent/sessions", { data: { mode: "offline" } });
    expect(sr.status()).toBe(201);
    const { session } = await sr.json();
    await request.post(`/api/agent/sessions/${session.id}/messages`, {
      data: { text: "make an image of a lighthouse" },
    });
    const { messages: msgs } = await messages(request, session.id);
    const call = msgs.find((m) => m.kind === "tool_call" && m.content?.job_id);
    expect(call).toBeTruthy();
    expect(call!.content.endpoint).toBe("motionfield/z-image-turbo/text-to-image");
  });
});
