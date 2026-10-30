/**
 * Ollama pull proxy: NDJSON events normalize to {status, percent, done},
 * errors surface as LlmUnavailable, and the base URL must stay loopback.
 * Uses a stub /api/pull - no model is ever downloaded in tests.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";

import { pullOllamaModel, PullBody, type PullEvent } from "@/lib/llm/settings";
import { LlmUnavailable } from "@/lib/llm/types";

async function stubOllama(chunks: string[], status = 200) {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": "application/x-ndjson" });
    for (const c of chunks) res.write(c + "\n");
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("pullOllamaModel", () => {
  it("forwards normalized progress events and ends done", async () => {
    const stub = await stubOllama([
      JSON.stringify({ status: "pulling manifest" }),
      JSON.stringify({ status: "downloading", total: 100, completed: 40 }),
      JSON.stringify({ status: "downloading", total: 100, completed: 100 }),
      JSON.stringify({ status: "success" }),
    ]);
    try {
      const events: PullEvent[] = [];
      await pullOllamaModel("qwen3.5:9b", { baseUrl: stub.url, onEvent: (e) => events.push(e) });
      expect(events[0].status).toBe("pulling manifest");
      expect(events.some((e) => e.percent === 40)).toBe(true);
      expect(events.at(-1)).toMatchObject({ done: true });
    } finally {
      await stub.close();
    }
  });

  it("surfaces an Ollama-side error line as LlmUnavailable", async () => {
    const stub = await stubOllama([JSON.stringify({ error: "pull model manifest: file does not exist" })]);
    try {
      await expect(pullOllamaModel("nope:latest", { baseUrl: stub.url }))
        .rejects.toThrow(/file does not exist/);
    } finally {
      await stub.close();
    }
  });

  it("non-2xx and non-loopback are refused before any stream", async () => {
    const stub = await stubOllama([], 404);
    try {
      await expect(pullOllamaModel("qwen3.5:9b", { baseUrl: stub.url })).rejects.toThrow(/404/);
    } finally {
      await stub.close();
    }
    await expect(pullOllamaModel("qwen3.5:9b", { baseUrl: "http://192.168.1.50:11434" }))
      .rejects.toBeInstanceOf(LlmUnavailable);
  });
});

describe("pull name validation", () => {
  it("accepts ollama tags and hf.co/<org>/<repo>[:quant], refuses junk", () => {
    for (const ok of ["qwen3.5:9b", "llama3.2", "hf.co/bartowski/Qwen3-GGUF:Q4_K_M", "org/model:fp16"]) {
      expect(PullBody.safeParse({ name: ok }).success, ok).toBe(true);
    }
    for (const bad of ["", "a b", "http://x", "../etc", "a/b/c/d"]) {
      expect(PullBody.safeParse({ name: bad }).success, bad).toBe(false);
    }
  });
});
