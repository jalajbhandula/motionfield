import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ChatRequest } from "@/lib/llm/types";

/**
 * Live LLM smoke for the WS5 spec-writer - runs ONLY under
 * `~/.motionfield/gpu-run` with LLM_LIVE=1:
 *
 *   ~/.motionfield/gpu-run ws5-llm -- env LLM_LIVE=1 \
 *     npx vitest run tests/smoke/ws5-motion-llm.test.ts
 *
 * Exercises the SHIPPED path end to end: generateMotionSpec() → the real
 * chatJson("writer") → ollama /api/chat → zod + one repair round, with the
 * production system prompt, template adaptation and temperature. A fetch
 * spy counts wire round trips so we can report how many repair rounds the
 * model actually needed. The hand-copied chatJson loop survives below ONLY
 * as that repair-round counter - run when the shipped path fails, to say
 * whether the model could have done it at all. It never decides pass/fail.
 */

const LIVE = process.env.LLM_LIVE === "1";
const OLLAMA = "http://127.0.0.1:11434";

async function pickModel(): Promise<string> {
  const tags = await fetch(`${OLLAMA}/api/tags`).then((r) => r.json());
  const names: string[] = (tags.models ?? []).map((m: { name: string }) => m.name);
  for (const want of ["qwen3.5:9b", "qwen3:8b", "qwen3"]) {
    const hit = names.find((n) => n.startsWith(want));
    if (hit) return hit;
  }
  if (names.length) return names[0];
  throw new Error("ollama has no models pulled");
}

/**
 * The copied chatJson loop - kept only as a repair-round counter for the
 * failure report. Sends the same [system,user] pair the generate route
 * would, applying the draft schema itself; returns the rounds the model
 * needed (0 = never produced a valid draft inside its attempt budget).
 */
async function countRoundsNeeded(
  base: ChatRequest["messages"],
  motionDraftSchema: z.ZodType,
  chat: (task: "writer", req: ChatRequest) => Promise<{ text: string }>,
  stripThink: (t: string) => string,
): Promise<number> {
  const js = z.toJSONSchema(motionDraftSchema);
  const responseSchema = (js as { type?: string }).type === "object" ? js : undefined;
  const extractJson = (text: string): unknown => {
    const t = stripThink(text);
    try { return JSON.parse(t); } catch { /* fall through to slicing */ }
    const a = t.search(/[[{]/), open = a >= 0 ? t[a] : "";
    const close = open === "[" ? "]" : "}";
    const b = t.lastIndexOf(close);
    if (a >= 0 && b > a) {
      try { return JSON.parse(t.slice(a, b + 1)); } catch { /* malformed slice */ }
    }
    return undefined;
  };
  const extra: ChatRequest["messages"] = [];
  let schemaDropped = false;
  const send = async (): Promise<{ text: string }> =>
    chat("writer", {
      messages: [...base, ...extra],
      ...(responseSchema && !schemaDropped ? { responseSchema } : {}),
      temperature: 0.2,
      think: false,
    }).catch((e: unknown) => {
      const status = e instanceof Error && "status" in e ? (e as { status?: number }).status ?? 0 : 0;
      const msg = e instanceof Error ? `${e.message} ${(e as { body?: string }).body ?? ""}` : String(e);
      if (!schemaDropped && status >= 400 && status < 600
        && /response_?format|json_?schema|response_?schema|structured output|additionalproperties|is required|unsupported|unavailable/i.test(msg)) {
        schemaDropped = true;
        return send();
      }
      throw e;
    });
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await send();
    const parsed = motionDraftSchema.safeParse(extractJson(res.text));
    if (parsed.success) return attempt + 1;
    const issue = parsed.error.issues[0];
    const errStr = `${issue ? `${issue.path.join(".") || "(root)"}: ` : ""}${parsed.error.message}`.slice(0, 500);
    if (res.text) extra.push({ role: "assistant", content: res.text });
    extra.push({ role: "user", content: `That reply failed validation (${errStr}). Reply with ONLY the corrected JSON - no commentary.` });
  }
  return 0;
}

describe.skipIf(!LIVE)("ws5 motion llm live smoke (ollama)", () => {
  it("generateMotionSpec → valid SceneSpec through the shipped chatJson path", async () => {
    const model = await pickModel();
    process.stderr.write(`[ws5-llm] model=${model}\n`);
    process.env.LLM_PROVIDER = "ollama";
    process.env.LLM_MODEL = model;
    const { generateMotionSpec, motionDraftSchema, motionSpecMessages } = await import("@/lib/render/generate");

    const format = { aspect: "16:9" as const, resolution: "720p" as const, fps: 24 as const, duration: 3 };
    const prompt = "launch title card for NOVA: rising 3D wordmark, drifting dust, warm accent";

    // count wire round trips on the real call: a POST to a chat endpoint is
    // a round; one whose body carries chatJson's repair text is a repair
    // round (a schema-drop retry resends the same messages - not a repair).
    let rounds = 0;
    let repairs = 0;
    const statuses: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const isChat = (init?.method ?? "GET").toUpperCase() === "POST"
        && /\/(api\/chat|v1\/chat\/completions|v1\/messages)/.test(url);
      if (isChat) {
        rounds++;
        if (typeof init?.body === "string" && init.body.includes("failed validation")) repairs++;
      }
      const res = await origFetch(input, init);
      // every wire round's HTTP status lands in the run report
      if (isChat) statuses.push(`round${rounds}=${res.status}`);
      return res;
    }) as typeof fetch;

    const t0 = Date.now();
    let spec: Awaited<ReturnType<typeof generateMotionSpec>> | undefined;
    let failErr: unknown;
    try {
      spec = await generateMotionSpec({ prompt, templateId: "presentation", format });
    } catch (e) {
      failErr = e;
    } finally {
      globalThis.fetch = origFetch;
    }
    const elapsed = Date.now() - t0;
    // stderr survives vitest's console interception on a green run
    process.stderr.write(`[ws5-llm] model=${model} elapsed=${(elapsed / 1000).toFixed(1)}s rounds=${rounds} repairs=${repairs} statuses=${statuses.join(",")}\n`);

    if (!spec) {
      // shipped path failed - run the copied loop once to count the rounds
      // the model actually needed (the failure class for the report)
      try {
        const { chat } = await import("@/lib/llm/index");
        const { stripThink } = await import("@/lib/llm");
        const base = motionSpecMessages(prompt, format, "presentation")
          .map((m) => ({ role: m.role as "system" | "user" | "assistant", content: m.content ?? "" }));
        const needed = await countRoundsNeeded(base, motionDraftSchema, chat, stripThink);
        process.stderr.write(`[ws5-llm] copied-loop rounds needed: ${needed}\n`);
      } catch (e2) {
        process.stderr.write(`[ws5-llm] copied loop also failed: ${(e2 as Error)?.message ?? e2}\n`);
      }
      throw failErr;
    }

    expect(spec.layers.length).toBeGreaterThan(0);
    expect(spec.params?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(repairs).toBeLessThanOrEqual(1);
    // cold model load + a thinking repair round can pass five minutes on an
    // M1 - the copied loop's 300 s ceiling was sized for the toy prompt
  }, 600_000);
});
