import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Live "runs brain" smoke - runs ONLY under `~/.motionfield/gpu-run` with
 * LLM_LIVE=1:
 *   ~/.motionfield/gpu-run ws2-runs-brain -- env LLM_LIVE=1 \
 *     npx vitest run tests/smoke/ws2-runs-brain.test.ts
 *
 * qwen3.5:9b (falling back to qwen3:8b) plans three briefs through the
 * shipped llmPlan path; every returned Plan must survive the real
 * validatePlan on the mock provider - no jobs are submitted, so the GPU
 * carries only the LLM. PGLITE_DIR is a fresh tmpdir: the per-user route
 * lookups (llm_task_routes/llm_user_prefs) resolve to "no route / not
 * offline" and the env route (LLM_PROVIDER=ollama) takes over.
 */

const LIVE = process.env.LLM_LIVE === "1";
const OLLAMA = "http://127.0.0.1:11434";

/** Mirrors PLANNER_BUDGET_MS in src/lib/runs/planner.ts - the same env var,
 *  evaluated at shell-env time (before vitest loads modules), so the test
 *  timeout tracks the planner's real budget: 3 briefs + warmup margin. */
const BUDGET_MS = Math.max(30_000,
  Number(process.env.MOTIONFIELD_PLANNER_BUDGET_MS ?? 300_000) || 300_000);

async function pickModel(): Promise<string> {
  const tags = await fetch(`${OLLAMA}/api/tags`).then((r) => r.json());
  const names: string[] = (tags.models ?? []).map((m: { name: string }) => m.name);
  for (const want of ["qwen3.5:9b", "qwen3:8b"]) {
    const hit = names.find((n) => n.startsWith(want));
    if (hit) return hit;
  }
  throw new Error("ollama has neither qwen3.5:9b nor qwen3:8b pulled");
}

describe.skipIf(!LIVE)("ws2 runs-brain live smoke (ollama)", () => {
  it("plans 3 briefs into Plans that pass the real validatePlan", async () => {
    const model = await pickModel();
    console.log(`[ws2-runs-brain] model=${model}`);
    process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws2-brain-"));
    process.env.BETTER_AUTH_SECRET = "test-secret-ws2-0123456789abcdef0123456789ab";
    process.env.GENERATION_PROVIDER = "mock";
    process.env.LLM_PROVIDER = "ollama";
    process.env.LLM_MODEL = model;
    execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
      env: { ...process.env },
      stdio: "pipe",
    });
    const { llmPlan, turnEndpoints, validatePlan } = await import("@/lib/runs");
    const { STEP_REF } = await import("@/lib/runs");
    const { unloadLocalModel } = await import("@/lib/llm/index");

    const uid = "ws2-brain-smoke";
    const eps = await turnEndpoints("auto", uid);
    const briefs = [
      "make a short video of a lighthouse at dusk",
      "make an image of a neon city at night, then animate it into a short video",
      "read this aloud in a calm voice: the quick brown fox jumps over the lazy dog",
    ];
    try {
      for (const [i, brief] of briefs.entries()) {
        const t0 = Date.now();
        const turn = await llmPlan(uid, brief, [], {}, eps, false);
        expect(turn.kind, `brief "${brief}" → ${JSON.stringify(turn)}`).toBe("plan");
        if (turn.kind !== "plan") continue;
        const steps = validatePlan(turn.plan, eps, { mode: "auto", optIn: false });
        expect(steps.length).toBeGreaterThanOrEqual(1);
        expect(steps.length).toBeLessThanOrEqual(12);
        if (i === 1) {
          // brief 2 is the pipeline case - ≥2 steps chained by a $step ref
          expect(steps.length, "brief 2 should plan ≥2 chained steps").toBeGreaterThanOrEqual(2);
          const hasRef = turn.plan.steps.some((s) =>
            s.depends_on.length > 0
            && Object.values(s.params).some((v) => typeof v === "string" && STEP_REF.test(v)));
          expect(hasRef, "brief 2 should chain via a $step ref").toBe(true);
        }
        console.log(`[ws2-runs-brain] "${brief}" → ${steps.map((s) => s.endpointId).join(" → ")} (${Date.now() - t0}ms)`);
      }
    } finally {
      // release the planner model's VRAM - keep_alive:0 on /api/generate
      await unloadLocalModel({ providerId: "ollama", local: true, baseUrl: OLLAMA, model });
    }
  }, 3 * BUDGET_MS + 120_000);
});
