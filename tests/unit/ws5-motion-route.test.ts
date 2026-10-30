import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ llm: false }));
const inserted = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
const spies = vi.hoisted(() => ({ fetchBrand: vi.fn(), generate: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  requireApiUser: async () => ({ user: { id: "u-route" } }),
}));

vi.mock("@/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db")>()),
  getDb: async () => ({
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.rows.push(v);
        return { returning: async () => [{ id: "6b5b1c2e-3f7a-4b0c-9d1e-2a3b4c5d6e7f" }] };
      },
    }),
  }),
}));

vi.mock("@/lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm")>()),
  llmOn: () => state.llm,
}));

vi.mock("@/lib/render/brand", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/render/brand")>()),
  fetchBrandContext: (u: string) => spies.fetchBrand(u),
}));

vi.mock("@/lib/render/generate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/render/generate")>();
  return { ...real, generateMotionSpec: (a: unknown) => spies.generate(a) };
});

import { POST } from "@/app/api/render/motion/route";
import { NeedsLlm } from "@/lib/render/generate";
import { parseSceneSpec } from "@/lib/render/spec";
import featuresSpec from "../fixtures/ws5-features.json";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/render/motion", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const kfTimes = (ls: { type: string; keyframes?: { t: number }[]; props: { children?: never[] } }[]): number[] =>
  ls.flatMap((l) => [
    ...(l.keyframes ?? []).map((k) => k.t),
    ...(l.type === "group" ? kfTimes((l.props as { children: typeof ls }).children) : []),
  ]);

beforeEach(() => {
  state.llm = false;
  inserted.rows.length = 0;
  spies.fetchBrand.mockReset();
  spies.generate.mockReset();
});

describe("POST /api/render/motion - LLM off", () => {
  it("no template → 503 NEEDS_LLM before any fetch", async () => {
    const res = await POST(req({ prompt: "a title", url: "https://brand.example" }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("NEEDS_LLM");
    expect(spies.fetchBrand).not.toHaveBeenCalled();
    expect(inserted.rows).toHaveLength(0);
  });

  it("template → deterministic spec: format wins, keyframes rescaled, no brand fetch", async () => {
    const res = await POST(req({
      template_id: "presentation", duration: 2, aspect: "9:16", resolution: "720p",
      url: "https://brand.example", // supplied but must NOT be fetched
    }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(spies.fetchBrand).not.toHaveBeenCalled();
    expect(spies.generate).not.toHaveBeenCalled();
    // the request's format wins over the template's 1280×720/4s
    expect(data.spec.width).toBe(720);
    expect(data.spec.height).toBe(1280);
    expect(data.spec.duration).toBe(2);
    // presentation.json: duration 4 → ×0.5, camera [0,4] → [0,2]
    expect(data.spec.camera.keyframes.map((k: { t: number }) => k.t)).toEqual([0, 2]);
    expect(Math.max(...kfTimes(data.spec.layers))).toBeLessThanOrEqual(2);
    expect(data.spec.params.length).toBeGreaterThanOrEqual(2);
    // no prompt → titled after the template
    expect(inserted.rows[0].title).toBe("Presentation");
    expect(inserted.rows[0].prompt).toBeNull();
  });

  it("template + prompt still stores the prompt + title", async () => {
    const res = await POST(req({ template_id: "presentation", prompt: "quarterly results title" }));
    expect(res.status).toBe(201);
    expect(inserted.rows[0].title).toBe("quarterly results title");
    expect(inserted.rows[0].prompt).toBe("quarterly results title");
  });
});

describe("POST /api/render/motion - LLM on", () => {
  it("template becomes the example: generateMotionSpec gets prompt+brand+templateId+signal", async () => {
    state.llm = true;
    spies.fetchBrand.mockResolvedValue({ url: "https://brand.example", colors: ["#112233"] });
    spies.generate.mockResolvedValue(parseSceneSpec(featuresSpec));
    const res = await POST(req({
      prompt: "launch card", url: "https://brand.example", template_id: "presentation", duration: 3,
    }));
    expect(res.status).toBe(201);
    expect(spies.fetchBrand).toHaveBeenCalledWith("https://brand.example");
    expect(spies.generate).toHaveBeenCalledTimes(1);
    const arg = spies.generate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.prompt).toBe("launch card");
    expect(arg.templateId).toBe("presentation");
    expect((arg.brand as { colors: string[] }).colors).toEqual(["#112233"]);
    expect((arg.format as { duration: number }).duration).toBe(3);
    expect(arg.signal).toBeInstanceOf(AbortSignal);
  });

  it("template, no prompt → deterministic spec even with an LLM set up", async () => {
    state.llm = true;
    const res = await POST(req({ template_id: "presentation" }));
    expect(res.status).toBe(201);
    expect(spies.generate).not.toHaveBeenCalled();
  });

  it("no prompt and no template → 400 (the LLM can't write from nothing)", async () => {
    state.llm = true;
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(spies.generate).not.toHaveBeenCalled();
  });

  it("brand fetch failure → 400; NeedsLlm race → 503", async () => {
    state.llm = true;
    spies.fetchBrand.mockRejectedValue(new Error("blocked"));
    let res = await POST(req({ prompt: "x", url: "https://nope.example" }));
    expect(res.status).toBe(400);
    expect(spies.generate).not.toHaveBeenCalled();

    spies.generate.mockRejectedValue(new NeedsLlm());
    res = await POST(req({ prompt: "x" }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("NEEDS_LLM");
  });

  it("unknown template_id → 400 in both modes", async () => {
    for (const on of [false, true]) {
      state.llm = on;
      const res = await POST(req({ prompt: "x", template_id: "not-a-template" }));
      expect(res.status).toBe(400);
    }
  });
});
