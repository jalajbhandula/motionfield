import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Live LLM smoke - runs ONLY under `~/.motionfield/gpu-run` with LLM_LIVE=1:
 *   ~/.motionfield/gpu-run ws2-llm-smoke -- env LLM_LIVE=1 \
 *     npx vitest run tests/smoke/ws2-llm-live.test.ts
 * Exercises one tool call and one chatJson plan against local Ollama
 * (qwen3.5:9b, falling back to qwen3:8b when absent).
 */

const LIVE = process.env.LLM_LIVE === "1";
const OLLAMA = "http://127.0.0.1:11434";

async function pickModel(): Promise<string> {
  const tags = await fetch(`${OLLAMA}/api/tags`).then((r) => r.json());
  const names: string[] = (tags.models ?? []).map((m: { name: string }) => m.name);
  // pick only the models this smoke is validated on - never a surprise fallback
  for (const want of ["qwen3.5:9b", "qwen3:8b"]) {
    const hit = names.find((n) => n.startsWith(want));
    if (hit) return hit;
  }
  throw new Error("ollama has neither qwen3.5:9b nor qwen3:8b pulled");
}

describe.skipIf(!LIVE)("ws2 llm live smoke (ollama)", () => {
  it("does one tool call and one chatJson plan", async () => {
    const model = await pickModel();
    console.log(`[ws2-llm-live] model=${model}`);
    process.env.LLM_PROVIDER = "ollama";
    process.env.LLM_MODEL = model;
    const { chat, chatJson } = await import("@/lib/llm/index");

    let t0 = Date.now();
    const toolRes = await chat("planner", {
      messages: [{ role: "user", content: "Call the echo tool with {\"x\": 1}. Only call the tool." }],
      tools: [{
        name: "echo",
        description: "Echo back the JSON you are given",
        parameters: {
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        },
      }],
      toolChoice: { name: "echo" },
      think: false,
      temperature: 0,
    });
    console.log(`[ws2-llm-live] tool call ${Date.now() - t0}ms`);
    expect(toolRes.toolCalls.length).toBeGreaterThan(0);
    expect(toolRes.toolCalls[0].name).toBe("echo");
    expect(toolRes.toolCalls[0].arguments).toMatchObject({ x: 1 });

    t0 = Date.now();
    const { data: plan } = await chatJson(
      "writer",
      z.object({ scenes: z.array(z.object({ title: z.string(), narration: z.string() })).min(1).max(3) }),
      {
        messages: [
          { role: "system", content: "Reply with ONLY JSON matching the schema." },
          { role: "user", content: "Write a 2-scene explainer plan about rainbows." },
        ],
        temperature: 0.2,
        think: false,
      },
    );
    console.log(`[ws2-llm-live] chatJson plan ${Date.now() - t0}ms`);
    expect(plan.scenes.length).toBeGreaterThanOrEqual(1);
    expect(plan.scenes.length).toBeLessThanOrEqual(3);
    expect(plan.scenes[0].title.length).toBeGreaterThan(0);
  }, 300_000);
});
