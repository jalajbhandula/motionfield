import { Comfy } from "@comfyorg/sdk";
import type { SubmitInput } from "./types";

export type ComfyBackend = "main" | "audio";

/** Audio stays on the Mac when the main image/video backend is a pod.
 * Persist only this identifier on jobs: never URLs or credentials. */
export function backendFor(input: SubmitInput): ComfyBackend {
  return input.workflow.kind === "audio" && process.env.COMFY_AUDIO_BASE_URL?.trim() ? "audio" : "main";
}

export function backendConfig(backend: ComfyBackend = "main") {
  const baseUrl = (backend === "audio"
    ? process.env.COMFY_AUDIO_BASE_URL
    : process.env.COMFY_BASE_URL || "http://127.0.0.1:8189")?.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("The audio generation server is not configured.");
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Comfy server must be an HTTP(S) URL without credentials, query or fragment.");
  const apiKey = backend === "audio" ? process.env.COMFY_AUDIO_API_KEY : process.env.COMFY_API_KEY;
  return { baseUrl, apiKey };
}

/** SDK 0.5 reads its base URL from the environment at construction. Its
 * per-client fetch hook lets a second deployment coexist without changing
 * process.env (which would race concurrent jobs). All asset and job calls
 * use the same hook; the main server's key never reaches the audio host. */
export function backendFetch(source: string, target: string, apiKey?: string): typeof fetch {
  const from = new URL(source);
  const to = new URL(target);
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const prefix = from.pathname.replace(/\/$/, "");
    if (url.origin === from.origin && (url.pathname === prefix || url.pathname.startsWith(prefix + "/"))) {
      const suffix = url.pathname.slice(prefix.length);
      url.protocol = to.protocol;
      url.host = to.host;
      url.pathname = to.pathname.replace(/\/$/, "") + suffix;
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.delete("authorization");
    if (url.origin === to.origin && apiKey) headers.set("authorization", `Bearer ${apiKey}`);
    return fetch(input instanceof Request ? new Request(url, input) : url, { ...init, headers });
  };
}

const COMFY_REQUEST_TIMEOUT_MS = Number(process.env.COMFY_REQUEST_TIMEOUT_MS) || 180_000;
const clients = new Map<string, Comfy>();
export function comfyClient(backend: ComfyBackend = "main"): Comfy {
  if (!process.env.COMFY_BASE_URL?.trim()) process.env.COMFY_BASE_URL = "http://127.0.0.1:8189";
  const { baseUrl, apiKey } = backendConfig(backend);
  const source = backendConfig("main").baseUrl;
  const key = JSON.stringify([source, baseUrl, apiKey]);
  let client = clients.get(key);
  if (!client) {
    // the SDK's 30 s per-request default fails live jobs: ComfyUI's HTTP loop
    // stalls while it loads a multi-GB model, so an upload or submit landing
    // in that window aborted ("The operation was aborted due to timeout")
    client = new Comfy({ clientInfo: "motionfield", apiKey, timeoutMs: COMFY_REQUEST_TIMEOUT_MS,
      ...(backend === "audio" ? { fetch: backendFetch(source, baseUrl, apiKey) } : {}) });
    clients.set(key, client);
  }
  return client;
}
