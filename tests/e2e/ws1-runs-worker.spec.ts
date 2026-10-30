import { expect, request, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * WS1 E8 - runs advance on the standalone worker, not on reads.
 *
 * Only meaningful against a real Postgres (DATABASE_URL): on PGlite the
 * in-process lazy ticks would do the work anyway and a second process on the
 * same data dir is forbidden (docs/SETUP.md). Without DATABASE_URL this spec
 * skips entirely.
 *
 * The run is created auto-mode and NEVER read through /api/v1/runs/{id}
 * until the end - the worker process we spawn is the only thing that can
 * drive it. The final GET asserts `done`; the list route used while waiting
 * reads without ticking.
 */

const EP = "motionfield/z-image-turbo/text-to-image";

const plan = (prompt: string) => ({
  title: "worker e2e",
  steps: [{ id: "s1", title: "frame", endpoint_id: EP, params: { prompt }, depends_on: [] }],
});

test("[#122] scripts/worker.ts drives an auto run to done with zero run-view reads", async ({ baseURL }) => {
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL unset - the worker e2e only runs against real Postgres");
  test.setTimeout(240_000);

  const ctx = await request.newContext({ baseURL });
  let worker: ChildProcess | null = null;
  try {
    const email = `ws1worker-${Date.now()}@e2e.test`;
    const su = await ctx.post("/api/auth/sign-up/email", {
      data: { email, password: "e2e-password-123", name: "WS1 Worker E2E" },
    });
    expect(su.ok(), `signup: ${await su.text()}`).toBeTruthy();
    const up = await ctx.post("/api/billing", { data: { action: "subscribe", plan_id: "pro" } });
    expect(up.ok()).toBeTruthy();
    const k = await ctx.post("/api/keys", { data: { label: "worker-e2e" } });
    const key = ((await k.json()) as { key: string }).key;
    const auth = { Authorization: `Bearer ${key}` };

    /* our own worker - env mirrors the e2e dev server: mock provider, ComfyUI
     * pinned at the discard port, the SAME DATABASE_URL the server runs on */
    worker = spawn(process.execPath, ["--import", "tsx", "scripts/worker.ts"], {
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL!,
        GENERATION_PROVIDER: "mock",
        COMFY_BASE_URL: "http://127.0.0.1:9",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const workerLog: Buffer[] = [];
    worker.stdout?.on("data", (d: Buffer) => workerLog.push(d));
    worker.stderr?.on("data", (d: Buffer) => workerLog.push(d));

    const made = await ctx.post("/api/v1/runs", {
      data: { plan: plan("a lighthouse the worker renders") },
      headers: auth,
    });
    expect(made.status(), `create: ${await made.text()}`).toBe(201);
    const runId = ((await made.json()) as { id: string }).id;

    /* wait on the session list view only - it reads run status without ever
     * ticking it; /api/v1/runs/{id} stays untouched until the final assert */
    let listed = "running";
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const list = await ctx.get("/api/agent/runs");
      expect(list.status()).toBe(200);
      listed = (((await list.json()) as { runs: { id: string; status: string }[] }).runs
        .find((r) => r.id === runId))?.status ?? "missing";
      if (listed === "done" || listed === "failed" || listed === "stopped") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(listed,
      `worker did not finish the run - worker log:\n${Buffer.concat(workerLog).toString("utf8")}`)
      .toBe("done");

    // the first and only run-view read - after the worker already drove it
    const view = await ctx.get(`/api/v1/runs/${runId}`, { headers: auth });
    expect(view.status()).toBe(200);
    const body = (await view.json()) as { status: string; steps: { status: string }[] };
    expect(body.status).toBe("done");
    expect(body.steps.every((s) => s.status === "done")).toBe(true);
  } finally {
    // kill ONLY the worker we spawned - nothing else on this box gets touched
    if (worker && !worker.killed) {
      worker.kill("SIGTERM");
      await new Promise<void>((r) => {
        const t = setTimeout(r, 5000);
        worker!.once("exit", () => { clearTimeout(t); r(); });
      });
    }
    await ctx.dispose();
  }
});
