import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WIRES } from "@/lib/llm/adapters";
import { isLoopbackUrl } from "@/lib/llm/offline";
import { PROVIDERS } from "@/lib/llm/providers";

/**
 * Open-weights-only guard. The app ships no hosted closed-model API: the LLM
 * presets are runtimes you run yourself, the only wires are the open
 * OpenAI-compatible and Ollama protocols, and no source file names a closed
 * provider's API host. If one of these fails, a closed provider crept back in.
 */

const CLOSED_API_HOSTS = [
  "api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com",
  "api.x.ai", "api.deepseek.com", "api.groq.com", "openrouter.ai",
  "api.mistral.ai", "api.minimax.io", "api.moonshot.ai", "dashscope.aliyuncs.com",
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

describe("open-weights only", () => {
  it("LLM presets are self-hosted runtimes plus your own custom endpoint", () => {
    expect(PROVIDERS.map((p) => p.id).sort()).toEqual(["custom", "llamacpp", "lmstudio", "ollama", "vllm"]);
    for (const p of PROVIDERS) {
      if (p.id === "custom") expect(p.baseUrl).toBe("");
      else expect(isLoopbackUrl(p.baseUrl), p.id).toBe(true);
    }
  });

  it("only open wire protocols exist", () => {
    expect(Object.keys(WIRES).sort()).toEqual(["ollama", "openai-chat"]);
  });

  it("no subscription-CLI bridge to a closed model", () => {
    expect(existsSync(join(process.cwd(), "src/lib/llm/cli"))).toBe(false);
  });

  it("no source file names a closed provider's API host", () => {
    const hits: string[] = [];
    for (const f of sourceFiles(join(process.cwd(), "src"))) {
      const text = readFileSync(f, "utf8");
      for (const host of CLOSED_API_HOSTS) if (text.includes(host)) hits.push(`${f}: ${host}`);
    }
    expect(hits).toEqual([]);
  });
});
