/**
 * WS2 explainer-recipe checks:
 *  - fitToSchema keeps only declared params and snaps selects to the enum;
 *  - a restricted motion pick ("ltx") fails the license gate before any
 *    scene work - no opt-in row → RestrictedLicenseError - and a missing
 *    userId fails closed the same way;
 *  - an open default motion pick passes the gate (stubbed provider);
 *  - still-path dims per aspect; keyframe steps carry aspect_ratio;
 *  - no LLM + a topic (not a script) → the actionable NEEDS_LLM error.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { explainerRecipe, captionStitch, fitToSchema, stillDims } from "@/lib/generation/recipes/explainer";
import { findEndpoint } from "@/lib/catalog/video-models";
import { RestrictedLicenseError } from "@/lib/catalog/license-gate";
import { comfyProvider } from "@/lib/generation/comfy";
import { AsrError, transcribeWords, burnCaptions } from "@/lib/captions";
import { sql } from "@/db";

/* The caption stage's real ASR + renderer stay out of the unit loop: ASR
 *  always reports NEEDS_ASR so the script-estimated timing path runs, and
 *  the burn is a file-copy stub that records its call. wordsFromScript and
 *  AsrError stay real - the timing math under test is the real thing. */
vi.mock("@/lib/captions", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/lib/captions")>();
  return {
    ...m,
    transcribeWords: vi.fn(async () => { throw new m.AsrError("NEEDS_ASR", "no whisper on this box"); }),
    burnCaptions: vi.fn(async (args: { out: string }) => {
      const { promises: fsp } = await import("node:fs");
      await fsp.writeFile(args.out, "MP4");
      await fsp.writeFile(`${args.out}.ass`, "ASS");
      await fsp.writeFile(`${args.out}.srt`, "SRT");
      await fsp.writeFile(`${args.out}.vtt`, "VTT");
      return { mp4: args.out, ass: `${args.out}.ass`, srt: `${args.out}.srt`, vtt: `${args.out}.vtt` };
    }),
  };
});

/* saveBytes is stubbed so caption sidecars never land in real storage -
 * filePathFor stays real (the stitch paths resolve through it). */
vi.mock("@/lib/storage", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/lib/storage")>();
  return { ...m, saveBytes: vi.fn(async (key: string) => `/files/${key}`) };
});

const ENV_KEYS = ["LLM_PROVIDER", "LLM_MODEL", "LLM_BASE_URL", "LLM_API_KEY", "LLM_WIRE",
  "LLM_API_KEY_CUSTOM",
  "LLM_TASK_PLANNER", "LLM_TASK_WRITER", "LLM_TASK_VISION", "LLM_TASK_CODER",
  "LLM_TASK_ENHANCER", "LLM_TASK_JUDGE", "MOTIONFIELD_OFFLINE"];

beforeAll(() => {
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws2-explainer-"));
  process.env.BETTER_AUTH_SECRET = "test-secret-ws2-0123456789abcdef0123456789ab";
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
}, 60_000);

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const ctx = { signal: new AbortController().signal, progress: () => {} };

describe("fitToSchema", () => {
  const vace = findEndpoint("motionfield/wan-vace/image-to-video")!.workflow;
  const zimg = findEndpoint("motionfield/z-image-turbo/text-to-image")!.workflow;
  const ltx = findEndpoint("motionfield/ltx-video/image-to-video")!.workflow;

  it("drops undeclared params, keeps seed, snaps selects to the enum", () => {
    const fit = fitToSchema(vace.params, {
      prompt: "p", image_url: "/files/x.png", resolution: "1080p", duration: 12,
      fps: 30, seed: 42, bogus: "nope",
    });
    expect(fit.prompt).toBe("p");
    expect(fit.image_url).toBe("/files/x.png");
    expect(fit.resolution).toBe("480p");       // 1080p not offered → field default
    expect(fit.duration).toBe(5);              // snapped into [1,2,3,4,5]
    expect(fit.fps).toBe(24);                  // snapped into [16,24]
    expect(fit.bogus).toBeUndefined();
    expect(fit.seed).toBe(42);                 // placeholder-layer param survives
  });

  it("aspect_ratio kept iff declared - survives a schema that adds it", () => {
    // a later ws3 schema merge adds arVideo to vace i2v; this must not hard-code
    // "dropped" - derive the expectation from the declared params.
    const declared = vace.params.some((f) => f.name === "aspect_ratio");
    const fit = fitToSchema(vace.params, { prompt: "p", aspect_ratio: "9:16" });
    expect(fit.aspect_ratio).toBe(declared ? "9:16" : undefined);
    const zfit = fitToSchema(zimg.params, { prompt: "p", aspect_ratio: "9:16" });
    expect(zfit.aspect_ratio).toBe("9:16"); // declared on z-image-turbo
  });

  it("z-image resolution enum: 480p falls back to the declared default", () => {
    const fit = fitToSchema(zimg.params, { prompt: "p", resolution: "480p", steps: 8 });
    expect(fit.resolution).toBe("1K");
    expect(fit.steps).toBe(8);
  });

  it("ltx duration enum snaps to nearest declared", () => {
    const fit = fitToSchema(ltx.params, { prompt: "p", duration: 2 });
    expect(fit.duration).toBe(3); // [3,4,5,8,10]
  });
});

describe("explainer license gate", () => {
  const script = "First scene happens on a quiet street. Second scene follows at dusk.";
  const explainerInput = (params: Record<string, unknown>, userId?: string) => ({
    jobId: `j-expl-${Math.random().toString(36).slice(2, 8)}`,
    ...(userId ? { userId } : {}),
    appBaseUrl: "http://localhost:3120",
    model: findEndpoint("motionfield/explainer/video")!.model,
    workflow: findEndpoint("motionfield/explainer/video")!.workflow,
    params,
  });

  it("motion_model ltx + user without opt-in → RestrictedLicenseError before scene work", async () => {
    await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$1,$2,true) ON CONFLICT DO NOTHING`, ["u-exp", "u-exp@test.dev"]);
    await expect(explainerRecipe(explainerInput({ prompt: script, motion_model: "ltx" }, "u-exp"), ctx))
      .rejects.toBeInstanceOf(RestrictedLicenseError);
  });

  it("ltx without opt-in makes 0 comfyProvider.submit calls (no userId fails closed)", async () => {
    const submit = vi.spyOn(comfyProvider, "submit");
    const err = await explainerRecipe(explainerInput({ prompt: script, motion_model: "ltx" }), ctx)
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(RestrictedLicenseError);
    expect(err.code).toBe("restricted_license");
    expect(submit).not.toHaveBeenCalled();
  });

  it("default wan-vace params pass the gate - scene work reaches the provider (stubbed)", async () => {
    const stop = new Error("stub-stop");
    const submit = vi.spyOn(comfyProvider, "submit").mockRejectedValue(stop);
    await expect(explainerRecipe(explainerInput({ prompt: script }), ctx))
      .rejects.toThrow("stub-stop");
    expect(submit).toHaveBeenCalled();
    expect(submit.mock.calls[0][0].workflow.endpointId).toBe("motionfield/z-image-turbo/text-to-image");
  });

  it("keyframe step passes aspect_ratio through to the image endpoint", async () => {
    const submit = vi.spyOn(comfyProvider, "submit").mockRejectedValue(new Error("stub-stop"));
    await expect(explainerRecipe(explainerInput({ prompt: script, aspect_ratio: "1:1" }), ctx))
      .rejects.toThrow("stub-stop");
    expect(submit.mock.calls[0][0].params.aspect_ratio).toBe("1:1");
  });

  it("still-path dimensions per aspect", () => {
    expect(stillDims("16:9")).toEqual([864, 480]);
    expect(stillDims("9:16")).toEqual([480, 864]);
    expect(stillDims("1:1")).toEqual([480, 480]);
  });

  it("unknown motion_model fails loudly", async () => {
    const found = findEndpoint("motionfield/explainer/video")!;
    await expect(explainerRecipe({
      jobId: "j-expl-x", appBaseUrl: "http://localhost:3120",
      model: found.model, workflow: found.workflow,
      params: { prompt: script, motion_model: "sora" },
    }, ctx)).rejects.toThrow(/unknown motion_model/);
  });

  it("no LLM + topic (not a script) → actionable NEEDS_LLM error", async () => {
    const found = findEndpoint("motionfield/explainer/video")!;
    await expect(explainerRecipe({
      jobId: "j-expl-topic", appBaseUrl: "http://localhost:3120",
      model: found.model, workflow: found.workflow,
      params: { prompt: "explainer about a topic", motion_model: "still" },
    }, ctx)).rejects.toThrow(/LLM_BASE_URL|LLM_TASK_WRITER|Settings/);
  });
});

describe("explainer writer unload", () => {
  const SCENES = '[{"title":"S1","narration":"a line of narration.","visual":"a quiet street"}]';

  /** Writer-model stub - answers every request with a valid scene array in
   *  the wire's own reply shape; records every request. */
  function stubWriter(wire: "ollama" | "openai") {
    const reqs: { path: string; body: { keep_alive?: unknown; [k: string]: unknown } }[] = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        reqs.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) as { keep_alive?: unknown } : {} });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(wire === "ollama"
          ? { message: { content: SCENES } }
          : { choices: [{ message: { content: SCENES } }] }));
      });
    });
    return { server, reqs };
  }

  const explainerInput = (params: Record<string, unknown>) => {
    const found = findEndpoint("motionfield/explainer/video")!;
    return {
      jobId: `j-unl-${Math.random().toString(36).slice(2, 8)}`,
      appBaseUrl: "http://localhost:3120",
      model: found.model,
      workflow: found.workflow,
      params,
    };
  };

  it("local ollama writer → exactly one keep_alive:0, before the first submit", async () => {
    const { server, reqs } = stubWriter("ollama");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    process.env.LLM_PROVIDER = "ollama";
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.LLM_MODEL = "m";
    try {
      let unloadBeforeSubmit = false;
      const submit = vi.spyOn(comfyProvider, "submit").mockImplementation(() => {
        unloadBeforeSubmit = reqs.some((r) => r.path === "/api/generate" && r.body.keep_alive === 0);
        return Promise.reject(new Error("stub-stop"));
      });
      await expect(explainerRecipe(explainerInput({ prompt: "an explainer about tide pools" }), ctx))
        .rejects.toThrow("stub-stop");
      expect(submit).toHaveBeenCalledTimes(1);
      expect(reqs.filter((r) => r.path === "/api/generate" && r.body.keep_alive === 0)).toHaveLength(1);
      expect(unloadBeforeSubmit).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("cloud writer route → 0 unload requests", async () => {
    const { server, reqs } = stubWriter("openai");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    process.env.LLM_PROVIDER = "custom";
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.LLM_MODEL = "m";
    try {
      vi.spyOn(comfyProvider, "submit").mockRejectedValue(new Error("stub-stop"));
      await expect(explainerRecipe(explainerInput({ prompt: "an explainer about tide pools" }), ctx))
        .rejects.toThrow("stub-stop");
      expect(reqs.filter((r) => r.path === "/api/generate")).toHaveLength(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("pasted script, no LLM → 0 unload requests", async () => {
    const script = "First scene happens on a quiet street. Second scene follows at dusk.";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(comfyProvider, "submit").mockRejectedValue(new Error("stub-stop"));
    await expect(explainerRecipe(explainerInput({ prompt: script }), ctx))
      .rejects.toThrow("stub-stop");
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes("/api/generate"))).toHaveLength(0);
  });

  it("a route-lookup failure during writer unload never kills the job", async () => {
    const { server } = stubWriter("ollama");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    process.env.LLM_PROVIDER = "ollama";
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.LLM_MODEL = "m";
    try {
      // only the recipe's own resolveRoute (the post-script unload cleanup)
      // goes through the index namespace - llmConfigured/chatJson resolve via
      // router's internal binding, so rejecting every spied call hits exactly
      // the unload lookup. Its .catch must swallow it and keep the job going.
      const idx = await import("@/lib/llm/index");
      vi.spyOn(idx, "resolveRoute").mockRejectedValue(new Error("db gone"));
      const submit = vi.spyOn(comfyProvider, "submit").mockRejectedValue(new Error("stub-stop"));
      const script = "First scene happens on a quiet street. Second scene follows at dusk.";
      await expect(explainerRecipe(explainerInput({ prompt: script }), ctx))
        .rejects.toThrow("stub-stop"); // reached scene work - NOT "db gone"
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("explainer looks + captions", () => {
  const script = "First scene happens on a quiet street. Second scene follows at dusk.";
  const input = (params: Record<string, unknown>) => {
    const found = findEndpoint("motionfield/explainer/video")!;
    return {
      jobId: `j-look-${Math.random().toString(36).slice(2, 8)}`,
      appBaseUrl: "http://localhost:3120",
      model: found.model, workflow: found.workflow, params,
    };
  };

  it("an unknown look or captions value is refused before any graph submit", async () => {
    const submit = vi.spyOn(comfyProvider, "submit");
    await expect(explainerRecipe(input({ prompt: script, look: "nope" }), ctx))
      .rejects.toThrow(/unknown look "nope"/);
    await expect(explainerRecipe(input({ prompt: script, captions: "subtitles" }), ctx))
      .rejects.toThrow(/unknown captions "subtitles"/);
    expect(submit).not.toHaveBeenCalled();
  });

  it("caption stage: ASR and burn see only recipe-made tmp paths; scene text arrives as Word data", async () => {
    const { promises: fsp } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "of-cap-"));
    const stitched = join(dir, "stitch", "final.mp4");
    await fsp.mkdir(join(dir, "stitch"), { recursive: true });
    await fsp.writeFile(stitched, "FAKE-MP4");

    const cap = await captionStitch({
      stitchedPath: stitched,
      scenes: [
        { title: "S1", narration: "Hello brave new world.", visual: "a" },
        { title: "S2", narration: "Second line follows here.", visual: "b" },
      ],
      narrSecs: [3, 4], segSecs: [3, 4],
      captions: "pop", dir, jobId: "j-cap-1", base: "http://localhost:3120",
    });

    // ASR was offered only the stitch the recipe made - a path inside dir
    expect(vi.mocked(transcribeWords).mock.calls[0][0]).toBe(stitched);
    const burn = vi.mocked(burnCaptions).mock.calls[0][0];
    expect(burn.video).toBe(stitched);
    expect(burn.video.startsWith(dir)).toBe(true);
    expect(burn.out.startsWith(dir)).toBe(true);
    expect(burn.mode).toBe("pop");

    // scene narration reaches the burn only as Word[] data - every word is a
    // narration token, and the text never lands inside a filesystem path
    const text = burn.words.map((w) => w.text).join(" ");
    for (const tok of ["Hello", "brave", "world.", "Second", "line", "follows", "here."])
      expect(text).toContain(tok);
    expect(`${burn.video}${burn.out}`).not.toContain("Hello");

    // scene 2's estimated words start at the end of scene 1's segment
    const second = burn.words.find((w) => w.text === "Second");
    expect(second?.start).toBeGreaterThanOrEqual(3);
    expect(cap.timing).toBe("estimated");
    expect(cap.srtUrl).toBe("/files/generated/j-cap-1/explainer.srt");
    expect(cap.vttUrl).toBe("/files/generated/j-cap-1/explainer.vtt");
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("a non-fallback ASR failure propagates; a burn failure fails the job with the way out stated", async () => {
    const { promises: fsp } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "of-cap-"));
    const stitched = join(dir, "final.mp4");
    await fsp.writeFile(stitched, "FAKE-MP4");
    const scenes = [{ title: "S", narration: "one two.", visual: "v" }];

    vi.mocked(transcribeWords).mockRejectedValueOnce(new AsrError("ASR_FAILED", "whisper crashed"));
    await expect(captionStitch({ stitchedPath: stitched, scenes, narrSecs: [2], segSecs: [2],
      captions: "karaoke", dir, jobId: "j-cap-2" })).rejects.toThrow("whisper crashed");

    vi.mocked(burnCaptions).mockRejectedValueOnce(new Error("render crashed"));
    await expect(captionStitch({ stitchedPath: stitched, scenes, narrSecs: [2], segSecs: [2],
      captions: "karaoke", dir, jobId: "j-cap-3" }))
      .rejects.toThrow("captions couldn't be burned - render crashed; re-run with Captions: off");
    await fsp.rm(dir, { recursive: true, force: true });
  });
});
