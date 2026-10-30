import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { openaiChat } from "@/lib/llm/adapters/openai-chat";
import { ollama } from "@/lib/llm/adapters/ollama";
import type { WireAdapter } from "@/lib/llm/adapters/common";
import { LlmUnavailable, type ChatRequest, type ChatResponse } from "@/lib/llm/types";

/** Wire-level tests: a local node:http stub on 127.0.0.1 captures the exact
 *  request bytes and answers with canned provider payloads. No network. */

/** The parsed request JSON, typed to the loose union of every wire's fields
 *  the checks read - index signatures keep it permissive without `any`. */
type JsonSchemaNode = {
  type?: string; strict?: boolean; additionalProperties?: unknown;
  properties?: Record<string, JsonSchemaNode>; required?: string[];
};
type ContentPart = { type?: string; [k: string]: unknown };
type WireMsg = { role?: string; content?: string | ContentPart[]; images?: string[]; tool_name?: string; name?: string };
type WireTool = {
  name?: string;
  function?: { name?: string };
  input_schema?: JsonSchemaNode;
  functionDeclarations?: { name?: string; parameters?: unknown; parametersJsonSchema?: JsonSchemaNode }[];
};
type CapturedBody = {
  model?: string; stream?: boolean;
  messages?: WireMsg[];
  contents?: { role?: string; parts?: ContentPart[] }[];
  tools?: WireTool[];
  system?: unknown;
  systemInstruction?: { parts?: { text?: string }[] };
  tool_choice?: unknown;
  response_format?: { type?: string; json_schema?: { strict?: boolean; schema?: JsonSchemaNode } };
  generationConfig?: { responseMimeType?: string; responseSchema?: JsonSchemaNode };
  format?: JsonSchemaNode;
};
type Captured = { method?: string; url?: string; headers: Record<string, unknown>; body: CapturedBody };
type Reply = { status?: number; headers?: Record<string, string>; body: unknown };

const STALL = Symbol("stall");

async function withStub(
  respond: (req: Captured, n: number) => Reply | typeof STALL,
  fn: (baseUrl: string, seen: Captured[]) => Promise<void>,
) {
  const seen: Captured[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const cap: Captured = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) as CapturedBody : {} };
      seen.push(cap);
      const out = respond(cap, seen.length);
      if (out === STALL) return; // never answer - lets the client timeout fire
      res.writeHead(out.status ?? 200, { "Content-Type": "application/json", ...(out.headers ?? {}) });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const B64 = Buffer.from("fakepng").toString("base64");
const CTX = (baseUrl: string, apiKey = "test-key") => ({ baseUrl, apiKey, model: "test-model", label: "stub" });

const TOOL_REQ: ChatRequest = {
  messages: [
    { role: "system", content: "sys prompt" },
    { role: "user", content: "make a job" },
  ],
  tools: [{
    name: "create_job",
    description: "submit a job",
    parameters: { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
  }],
};
const IMG_REQ: ChatRequest = {
  messages: [
    { role: "user", content: [{ type: "text", text: "describe" }, { type: "image", mime: "image/png", base64: B64 }] },
  ],
};
const SCHEMA = { type: "object", properties: { x: { type: "string" } }, required: ["x"], additionalProperties: false };
const JSON_REQ: ChatRequest = { messages: [{ role: "user", content: "json pls" }], responseSchema: SCHEMA };

interface WireSpec {
  id: string;
  call: WireAdapter;
  /** expected URL path suffix */
  path: string;
  /** canned provider bodies */
  ok: unknown;
  tool: unknown;
  json: unknown;
  /** per-wire request assertions */
  checkAuth: (h: Record<string, unknown>) => void;
  checkImage: (body: CapturedBody) => void;
  checkSchema: (body: CapturedBody) => void;
  checkToolReq: (body: CapturedBody) => void;
  checkUsage: (res: ChatResponse) => void;
  /** canned body for a JSON-schema reply */
}

const specs: WireSpec[] = [
  {
    id: "openai-chat",
    call: openaiChat,
    path: "/chat/completions",
    ok: { choices: [{ message: { role: "assistant", content: "hello" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    tool: { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "create_job", arguments: "{\"a\":1}" } }] } }] },
    json: { choices: [{ message: { content: "{\"x\":\"ok\"}" } }] },
    checkAuth: (h) => expect(h.authorization).toBe("Bearer test-key"),
    checkImage: (b) => {
      const img = (b.messages![0].content as ContentPart[]).find((p) => p.type === "image_url")!;
      expect((img.image_url as { url: string }).url).toBe(`data:image/png;base64,${B64}`);
    },
    checkSchema: (b) => {
      expect(b.response_format!.type).toBe("json_schema");
      expect(b.response_format!.json_schema!.schema!.properties!.x.type).toBe("string");
      expect(b.response_format!.json_schema!.strict).toBe(true);
    },
    checkToolReq: (b) => expect(b.tools![0].function!.name).toBe("create_job"),
    checkUsage: (r) => { expect(r.usage?.inputTokens).toBe(3); expect(r.usage?.outputTokens).toBe(2); },
  },
  {
    id: "ollama",
    call: ollama,
    path: "/api/chat",
    ok: { message: { role: "assistant", content: "hello" }, prompt_eval_count: 3, eval_count: 2 },
    tool: { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "create_job", arguments: { a: 1 } } }] } },
    json: { message: { content: "{\"x\":\"ok\"}" } },
    checkAuth: () => { /* ollama preset sends no key by default */ },
    checkImage: (b) => {
      expect(b.messages![0].images).toEqual([B64]);
      expect(b.messages![0].content).toBe("describe");
      expect(b.stream).toBe(false);
    },
    checkSchema: (b) => {
      expect(b.format!.properties!.x.type).toBe("string");
      expect(b.format!.type).toBe("object");
    },
    checkToolReq: (b) => {
      expect(b.tools![0].function!.name).toBe("create_job");
      expect(b.messages![0]).toMatchObject({ role: "system", content: "sys prompt" });
    },
    checkUsage: (r) => { expect(r.usage?.inputTokens).toBe(3); expect(r.usage?.outputTokens).toBe(2); },
  },
];

for (const w of specs) {
  describe(`wire adapter: ${w.id}`, () => {
    it("sends the exact request shape and parses a plain-text reply", async () => {
      await withStub(() => ({ body: w.ok }), async (base, seen) => {
        const ctx = w.id === "ollama" ? { ...CTX(base), apiKey: undefined } : CTX(base);
        const res = await w.call(ctx, {
          messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }],
          temperature: 0.4, maxTokens: 64,
        });
        expect(res.text).toBe("hello");
        expect(res.toolCalls).toEqual([]);
        w.checkUsage(res);
        expect(seen).toHaveLength(1);
        const r = seen[0];
        expect(r.method).toBe("POST");
        expect(r.url!.endsWith(w.path)).toBe(true);
        w.checkAuth(r.headers);
        if (w.id !== "gemini") expect(r.body.model).toBe("test-model"); // gemini puts the model in the URL
      });
    });

    it("declares tools and parses a tool call", async () => {
      await withStub(() => ({ body: w.tool }), async (base, seen) => {
        const res = await w.call(CTX(base), TOOL_REQ);
        expect(res.toolCalls).toHaveLength(1);
        expect(res.toolCalls[0].name).toBe("create_job");
        expect(res.toolCalls[0].arguments).toEqual({ a: 1 });
        w.checkToolReq(seen[0].body);
      });
    });

    it("encodes an image input part", async () => {
      await withStub(() => ({ body: w.ok }), async (base, seen) => {
        await w.call(CTX(base), IMG_REQ);
        w.checkImage(seen[0].body);
      });
    });

    it("sends a JSON-schema constraint and reads the JSON reply", async () => {
      await withStub(() => ({ body: w.json }), async (base, seen) => {
        const res = await w.call(CTX(base), JSON_REQ);
        expect(JSON.parse(res.text)).toEqual({ x: "ok" });
        w.checkSchema(seen[0].body);
      });
    });

    it("sends strict:false unmangled when the schema can't be strictified", async () => {
      if (w.id !== "openai-chat") return; // strict mode is an OpenAI knob
      // optional field (b) + a record (additionalProperties is a schema) -
      // strict mode can't express either; the schema must go out as-is
      const loose = {
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "string" }, // not required
          r: { type: "object", additionalProperties: { type: "number" } },
        },
        required: ["a"],
      };
      await withStub(() => ({ body: w.json }), async (base, seen) => {
        await w.call(CTX(base), { messages: [{ role: "user", content: "go" }], responseSchema: loose });
        const js = seen[0].body.response_format!.json_schema!;
        expect(js.strict).toBe(false);
        expect(js.schema).toEqual(loose); // untouched - no injected seals
      });
    });

    it("retries a 429 (honoring Retry-After) then succeeds", async () => {
      await withStub(
        (_r, n) => (n === 1 ? { status: 429, headers: { "Retry-After": "0" }, body: { error: "slow down" } } : { body: w.ok }),
        async (base, seen) => {
          const res = await w.call(CTX(base), { messages: [{ role: "user", content: "hi" }] });
          expect(res.text).toBe("hello");
          expect(seen).toHaveLength(2);
        },
      );
    });

    it("surfaces a persistent 500 as a typed LlmUnavailable", async () => {
      await withStub(() => ({ status: 500, body: { error: "boom" } }), async (base, seen) => {
        const err = await w.call(CTX(base), { messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
        expect(err).toBeInstanceOf(LlmUnavailable);
        expect(err.status).toBe(500);
        expect(seen.length).toBeGreaterThan(1); // retried before giving up
      });
    }, 20_000);

    it("gives every attempt a fresh timeout signal - stall then success", async () => {
      await withStub(
        (_r, n) => (n === 1 ? STALL : { body: w.ok }),
        async (base, seen) => {
          const res = await w.call(CTX(base), {
            messages: [{ role: "user", content: "hi" }],
            timeoutMs: 1000,
          });
          expect(res.text).toBe("hello");
          expect(seen).toHaveLength(2); // exactly one retry
        },
      );
    });
  });
}

describe("ollama specifics", () => {
  it("tool result carries tool_name resolved from the earlier tool call", async () => {
    await withStub(
      (_r, n) => (n === 1
        ? { body: { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "create_job", arguments: { a: 1 } } }] } } }
        : { body: { message: { role: "assistant", content: "done" } } }),
      async (base, seen) => {
        const r1 = await ollama(CTX(base), TOOL_REQ);
        expect(r1.toolCalls).toHaveLength(1);
        await ollama(CTX(base), {
          messages: [
            ...TOOL_REQ.messages,
            { role: "assistant", content: "", toolCalls: r1.toolCalls },
            { role: "tool", toolCallId: r1.toolCalls[0].id, content: '{"jobId":"j1"}' },
          ],
        });
        const toolMsg = seen[1].body.messages!.at(-1)!;
        expect(toolMsg.role).toBe("tool");
        expect(toolMsg.tool_name).toBe("create_job"); // the wire field name
        expect(toolMsg.name).toBeUndefined();
      },
    );
  });

  it("strips a pasted /v1 suffix off the base URL before /api/chat", async () => {
    await withStub(() => ({ body: { message: { role: "assistant", content: "ok" } } }), async (base, seen) => {
      await ollama({ ...CTX(`${base}/v1`), apiKey: undefined }, { messages: [{ role: "user", content: "hi" }] });
      expect(seen[0].url).toBe("/api/chat");
    });
  });
});

describe("shared transport", () => {
  it("caps timeout retries at one - stall, stall, then LlmUnavailable", async () => {
    await withStub(() => STALL, async (base, seen) => {
      const err = await openaiChat(CTX(base), {
        messages: [{ role: "user", content: "hi" }], timeoutMs: 100,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(LlmUnavailable);
      expect(seen).toHaveLength(2); // exactly one retry, not three
    });
  });

  it("caller abort propagates unchanged (not converted to LlmUnavailable)", async () => {
    await withStub(() => STALL, async (base) => {
      const ctl = new AbortController();
      const p = openaiChat(CTX(base), {
        messages: [{ role: "user", content: "hi" }], signal: ctl.signal, timeoutMs: 60_000,
      }).catch((e) => e);
      ctl.abort();
      const err = await p;
      expect(err).not.toBeInstanceOf(LlmUnavailable);
    });
  });

  it("a body that isn't the wire's reply shape fails as LlmUnavailable", async () => {
    // e.g. an HTML error page or a payload missing the expected root -
    // never a bare JSON/SyntaxError
    await withStub(() => ({ body: "this is not a completion object" }), async (base) => {
      const err = await openaiChat(CTX(base), { messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
      expect(err).toBeInstanceOf(LlmUnavailable);
    });
    await withStub(() => ({ body: { choices: "definitely-not-an-array" } }), async (base) => {
      const err = await openaiChat(CTX(base), { messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
      expect(err).toBeInstanceOf(LlmUnavailable);
    });
  });
});
