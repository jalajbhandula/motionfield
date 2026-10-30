import { afterEach, describe, expect, it, vi } from "vitest";
import { backendConfig, backendFetch, backendFor } from "@/lib/generation/comfy-backend";
import { progressHeaders } from "@/lib/generation/comfy";
import type { SubmitInput } from "@/lib/generation/types";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("separate Mac audio and pod generation", () => {
  it("uses local audio only when explicitly configured, without changing the main environment", () => {
    vi.stubEnv("COMFY_BASE_URL", "http://127.0.0.1:18189");
    vi.stubEnv("COMFY_AUDIO_BASE_URL", "");
    const audio = { workflow: { kind: "audio" } } as SubmitInput;
    expect(backendFor(audio)).toBe("main");
    vi.stubEnv("COMFY_AUDIO_BASE_URL", "http://127.0.0.1:8189");
    expect(backendFor(audio)).toBe("audio");
    expect(backendFor({ workflow: { kind: "video" } } as SubmitInput)).toBe("main");
    expect(process.env.COMFY_BASE_URL).toBe("http://127.0.0.1:18189");
  });

  it("routes uploads, submits and polls to the chosen server with its own key", async () => {
    const calls: { url: string; authorization: string | null; body: BodyInit | null | undefined }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: URL, init: RequestInit) => {
      calls.push({ url: String(input), authorization: new Headers(init.headers).get("authorization"), body: init.body });
      return new Response("{}", { status: 200 });
    }));
    const local = backendFetch("http://127.0.0.1:18189/api", "http://127.0.0.1:8189/audio", "local-key");
    const paths = ["/api/assets?part=1", "/api/jobs", "/api/jobs/job-1"];
    await Promise.all(paths.map((path) => local("http://127.0.0.1:18189" + path, {
      method: "POST", headers: { authorization: "Bearer pod-key" }, body: "media-or-graph",
    })));
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:8189/audio/assets?part=1",
      "http://127.0.0.1:8189/audio/jobs", "http://127.0.0.1:8189/audio/jobs/job-1",
    ]);
    expect(calls.every((c) => c.authorization === "Bearer local-key" && c.body === "media-or-graph")).toBe(true);
    await local("https://foreign.example/events", { headers: { authorization: "Bearer pod-key" } });
    expect(calls.at(-1)?.authorization).toBeNull();
    const keyless = backendFetch("http://127.0.0.1:18189", "http://127.0.0.1:8189");
    await keyless("http://127.0.0.1:18189/jobs", { headers: { authorization: "Bearer pod-key" } });
    expect(calls.at(-1)?.authorization).toBeNull();
  });

  it("progress uses the selected key and never sends it to another origin", () => {
    vi.stubEnv("COMFY_BASE_URL", "http://127.0.0.1:18189");
    vi.stubEnv("COMFY_API_KEY", "pod-key");
    vi.stubEnv("COMFY_AUDIO_BASE_URL", "http://127.0.0.1:8189");
    vi.stubEnv("COMFY_AUDIO_API_KEY", "local-key");
    expect(progressHeaders("http://127.0.0.1:8189/events", "audio")).toEqual({ authorization: "Bearer local-key" });
    expect(progressHeaders("http://127.0.0.1:18189/events", "audio")).toEqual({});
    vi.stubEnv("COMFY_AUDIO_BASE_URL", "");
    expect(() => backendConfig("audio")).toThrow(/not configured/);
  });
  it("polls and cancels the backend stored on the job even when its kind is no longer available", async () => {
    vi.stubEnv("COMFY_BASE_URL", "http://127.0.0.1:18189");
    vi.stubEnv("COMFY_AUDIO_BASE_URL", "http://127.0.0.1:9");
    const { comfyClient } = await import("@/lib/generation/comfy-backend");
    const { comfyProvider } = await import("@/lib/generation/comfy");
    const cancel = vi.fn(async () => undefined);
    const audioGet = vi.spyOn(comfyClient("audio").jobs, "get")
      .mockResolvedValue({ status: "queued", cancel } as never);
    const mainGet = vi.spyOn(comfyClient("main").jobs, "get")
      .mockResolvedValue({ status: "queued", cancel } as never);
    expect(await comfyProvider.poll("audio-job", { comfyBackend: "audio" })).toEqual({ state: "queued", position: undefined });
    await comfyProvider.cancel("audio-job", { comfyBackend: "audio" });
    expect(audioGet).toHaveBeenCalledTimes(2);
    expect(mainGet).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    await comfyProvider.poll("legacy-main-job", {});
    expect(mainGet).toHaveBeenCalledWith("legacy-main-job");
  });

});
