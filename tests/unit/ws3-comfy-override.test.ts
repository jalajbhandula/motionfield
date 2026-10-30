/**
 * Override-graph input safety: a caller-supplied graph bypasses the bundled
 * workflow file AND param validation, and a fork's resolved graph carries real
 * prompt text - so the sweep is scoped to the only strings that are dangerous:
 * loader inputs (must be a ref, never a bare filename - and the only keys
 * attachMedia will ever read/fetch) and path-shaped inputs (filename_prefix,
 * *_name, *_path). Every other string is free text, never inspected.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const readFileSpy = vi.hoisted(() => vi.fn());
const fromJsonSpy = vi.hoisted(() => vi.fn((g: unknown) => g));
const submitSpy = vi.hoisted(() => vi.fn(async () => ({ id: "mock-job", urls: {} })));
const fromBytesSpy = vi.hoisted(() => vi.fn((b: unknown) => ({ asset: b })));
const fetchSpy = vi.hoisted(() => vi.fn());

vi.mock("fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("fs")>();
  return { ...orig, promises: { ...orig.promises, readFile: readFileSpy } };
});

vi.mock("@comfyorg/sdk", () => ({
  Comfy: class {
    workflows = { fromJson: fromJsonSpy };
    assets = { fromBytes: fromBytesSpy };
    submit = submitSpy;
  },
}));

import { comfyProvider, assertSafeGraphInputs, fetchRemoteMedia, __setRemoteMediaDeps } from "@/lib/generation/comfy";
import type { ModelDef, WorkflowDef } from "@/lib/catalog/types";
import type { SubmitInput } from "@/lib/generation/types";

/** Every injected remote fetch resolves its host to a public IP - DNS stays
 *  out of these tests entirely. */
const PUBLIC_RESOLVE = async () => [{ address: "93.184.216.34", family: 4 }];

const workflow = {
  endpointId: "test-video",
  params: [],
  providers: { comfy: { workflow: "x.json" } },
} as unknown as WorkflowDef;
const model = { id: "m" } as unknown as ModelDef;

const input = (graphOverride: Record<string, unknown>): SubmitInput => ({
  jobId: "job-test-1",
  model,
  workflow,
  params: { prompt: "a still frame" },
  appBaseUrl: "http://localhost:3100",
  graphOverride,
});

describe("comfy graphOverride input safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a /files/../.env traversal before any fs access", async () => {
    await expect(comfyProvider.submit(input({
      "1": { class_type: "LoadImage", inputs: { image: "/files/../.env" } },
    }))).rejects.toThrow(/traversal/);
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("rejects traversal hidden in other inputs too (filename_prefix)", async () => {
    await expect(comfyProvider.submit(input({
      "9": { class_type: "SaveVideo", inputs: { filename_prefix: "../../tmp/evil" } },
    }))).rejects.toThrow(/traversal/);
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it("rejects a loader input carrying a bare filename (reads another user's file)", async () => {
    await expect(comfyProvider.submit(input({
      "1": { class_type: "LoadImage", inputs: { image: "example.png" } },
    }))).rejects.toThrow(/media input/);
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("rejects traversal in a weight input (ckpt_name)", async () => {
    await expect(comfyProvider.submit(input({
      "3": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "../../x.safetensors" } },
    }))).rejects.toThrow(/traversal/);
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it("rejects an absolute filename_prefix", async () => {
    await expect(comfyProvider.submit(input({
      "9": { class_type: "SaveVideo", inputs: { filename_prefix: "/tmp/x" } },
    }))).rejects.toThrow(/traversal/);
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it("a forked graph with free-text punctuation submits - prompt text is never path-checked", async () => {
    readFileSpy.mockResolvedValueOnce(Buffer.from("png-bytes"));
    const r = await comfyProvider.submit(input({
      "1": { class_type: "LoadImage", inputs: { image: "/files/uploads/a.png" } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: "she turns... slowly, \\(smiles\\), 100%25" } },
      "9": { class_type: "SaveVideo", inputs: { filename_prefix: "of_ab12cd34" } },
    }));
    expect(r.providerJobId).toBe("mock-job");
    expect(readFileSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy).toHaveBeenCalled();
  });

  it("a weight path inside a model subdir passes (unet_name)", async () => {
    const r = await comfyProvider.submit(input({
      "3": { class_type: "UNETLoader", inputs: { unet_name: "wan/x.safetensors" } },
      "9": { class_type: "SaveVideo", inputs: { filename_prefix: "of_ab12cd34" } },
    }));
    expect(r.providerJobId).toBe("mock-job");
    expect(submitSpy).toHaveBeenCalled();
  });
});

/**
 * Media-key scoping: attachMedia only ever reads/fetches on loader input names
 * (image/audio/video/video_path/file/model_file). A URL in any other input is
 * free text - it must reach Comfy verbatim, never as a server-side fetch
 * (SSRF guard), and loader keys must never accept a bare filename.
 */
describe("media-key scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __setRemoteMediaDeps({ fetch: fetchSpy, resolve: PUBLIC_RESOLVE });
    fetchSpy.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
  });
  afterEach(() => {
    __setRemoteMediaDeps(null);
  });

  it("override text that starts with http(s):// is never fetched", async () => {
    const r = await comfyProvider.submit(input({
      "2": { class_type: "CLIPTextEncode", inputs: { text: "https://127.0.0.1:1/x" } },
    }));
    expect(r.providerJobId).toBe("mock-job");
    expect(fetchSpy).not.toHaveBeenCalled();
    const g = fromJsonSpy.mock.calls[0][0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(g["2"].inputs.text).toBe("https://127.0.0.1:1/x");
    expect(submitSpy).toHaveBeenCalled();
  });

  it("a {{PROMPT}} starting with http(s):// is never fetched on the normal path", async () => {
    readFileSpy.mockResolvedValueOnce(JSON.stringify({
      "1": { class_type: "CLIPTextEncode", inputs: { text: "{{PROMPT}}" } },
      "9": { class_type: "SaveVideo", inputs: { filename_prefix: "{{PREFIX}}", frames: ["1", 0] } },
    }));
    const r = await comfyProvider.submit({
      jobId: "job-test-1",
      model,
      workflow,
      params: { prompt: "https://127.0.0.1:1/x a cat" },
      appBaseUrl: "http://localhost:3100",
    });
    expect(r.providerJobId).toBe("mock-job");
    expect(fetchSpy).not.toHaveBeenCalled();
    const g = fromJsonSpy.mock.calls[0][0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(g["1"].inputs.text).toBe("https://127.0.0.1:1/x a cat");
  });

  it("override text with a URL plus '...' submits - free text is never path-checked", async () => {
    const r = await comfyProvider.submit(input({
      "2": { class_type: "CLIPTextEncode", inputs: { text: "https://x.y/a... she turns" } },
    }));
    expect(r.providerJobId).toBe("mock-job");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(submitSpy).toHaveBeenCalled();
  });

  it.each([
    ["LoadVideo", "file", "other.mp4"],
    ["LoadVideo", "file", "of_ab12cd34_00001_.mp4 [output]"],
    ["Load3D", "model_file", "3d/x.glb"],
    // annotated/bare paths into ComfyUI's folders - Painter.mask is a STRING
    // that resolves "[output]" annotations, MuseTalkRun.audio_path resolves
    // relative to ComfyUI's cwd, LoadLatent.latent reads the input dir
    ["Painter", "mask", "x.png [output]"],
    ["MuseTalkRun", "audio_path", "output/of_ab12cd34.wav"],
    ["MuseTalkRun", "audio_path", "x.wav [output]"],
    ["LoadLatent", "latent", "a.latent"],
  ])("refuses %s.%s bare filename %j before any fs access", async (cls, key, value) => {
    await expect(comfyProvider.submit(input({
      "1": { class_type: cls, inputs: { [key]: value } },
    }))).rejects.toThrow(/media input/);
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("a loader media ref still goes through fetch exactly once", async () => {
    const r = await comfyProvider.submit(input({
      "1": { class_type: "LoadImage", inputs: { image: "https://example.com/a.png" } },
    }));
    expect(r.providerJobId).toBe("mock-job");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://example.com/a.png");
    expect(submitSpy).toHaveBeenCalled();
  });

  it("refuses an oversize remote media ref on the declared length before buffering", async () => {
    const MAX = 200 * 1024 * 1024;
    fetchSpy.mockResolvedValue({
      ok: true,
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? String(MAX + 1) : null) },
      arrayBuffer: async () => { throw new Error("must never buffer"); },
    });
    await expect(comfyProvider.submit(input({
      "1": { class_type: "LoadImage", inputs: { image: "https://example.com/huge.mov" } },
    }))).rejects.toThrow(/too large/);
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("refuses a remote media ref whose streamed body overruns the cap", async () => {
    const MAX = 200 * 1024 * 1024;
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    fetchSpy.mockResolvedValue({
      ok: true,
      headers: { get: () => null }, // no declared length - the streamed count catches it
      body: {
        getReader: () => ({
          read: async () => sent > MAX
            ? { done: true, value: undefined }
            : (sent += chunk.byteLength, { done: false, value: chunk }),
        }),
      },
    });
    await expect(comfyProvider.submit(input({
      "1": { class_type: "LoadImage", inputs: { image: "https://example.com/huge.mov" } },
    }))).rejects.toThrow(/upload cap/);
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["a literal loopback ref", "http://127.0.0.1:8188/x.png"],
    ["a literal private ref", "http://192.168.1.10/x.png"],
  ])("refuses %s before any socket opens", async (_name, url) => {
    await expect(comfyProvider.submit(input({
      "1": { class_type: "LoadImage", inputs: { image: url } },
    }))).rejects.toThrow(/blocked|public/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("refuses a public host whose redirect lands on the link-local metadata IP", async () => {
    fetchSpy.mockResolvedValue({
      status: 302,
      headers: { get: (k: string) => (k.toLowerCase() === "location" ? "http://169.254.169.254/latest/meta-data" : null) },
      body: { cancel: async () => {} },
    });
    await expect(comfyProvider.submit(input({
      "1": { class_type: "LoadImage", inputs: { image: "https://example.com/a.png" } },
    }))).rejects.toThrow(/blocked|private|local/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // the hop onto 169.254 is never fetched
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it.each([["file:///etc/passwd"], ["ftp://example.com/x.png"]])(
    "refuses the non-http(s) scheme %s before any socket opens", async (url) => {
      await expect(fetchRemoteMedia(url)).rejects.toThrow(/http\/https|blocked/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

  it("a Windows-style COMFY_MODEL_MAP target submits normalised to forward slashes", async () => {
    const prev = process.env.COMFY_MODEL_MAP;
    process.env.COMFY_MODEL_MAP = JSON.stringify({ "wan2.1_vace_1.3B_fp16.safetensors": "wan\\x.safetensors" });
    try {
      const r = await comfyProvider.submit(input({
        "3": { class_type: "UNETLoader", inputs: { unet_name: "wan2.1_vace_1.3B_fp16.safetensors" } },
        "9": { class_type: "SaveVideo", inputs: { filename_prefix: "of_ab12cd34" } },
      }));
      expect(r.providerJobId).toBe("mock-job");
      const g = fromJsonSpy.mock.calls[0][0] as Record<string, { inputs: Record<string, unknown> }>;
      expect(g["3"].inputs.unet_name).toBe("wan/x.safetensors");
      expect(submitSpy).toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.COMFY_MODEL_MAP; else process.env.COMFY_MODEL_MAP = prev;
    }
  });
});

describe("assertSafeGraphInputs", () => {
  it("rejects unsafe strings, passes safe refs and non-strings", () => {
    const bad = {
      "1": { class_type: "LoadImage", inputs: { image: "/files/%2e%2e/x.png" } },
    };
    expect(() => assertSafeGraphInputs(bad)).toThrow(/traversal/);
    const good = {
      "1": { class_type: "LoadImage", inputs: { image: "/files/uploads/a.png", w: 512 } },
      _meta: { title: "skipped" },
    };
    expect(() => assertSafeGraphInputs(good as never)).not.toThrow();
  });

  it("passes prompt-shaped strings that only LOOK dangerous", () => {
    const free = {
      "2": { class_type: "CLIPTextEncode", inputs: { text: "a woman turns... and smiles, \\(close-up\\), 100%25 crop" } },
      "4": { class_type: "PrimitiveNode", inputs: { value: "C:\\fake\\..\\path %2e" } },
    };
    expect(() => assertSafeGraphInputs(free)).not.toThrow();
  });
});
