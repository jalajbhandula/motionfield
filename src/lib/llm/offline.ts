import { OfflineBlocked, type ChatRequest } from "./types";

/**
 * Offline enforcement. When MOTIONFIELD_OFFLINE=1 or the request is flagged
 * `offline`, every non-loopback base URL is rejected BEFORE any network call.
 * Local providers (Ollama, LM Studio, llama.cpp, vLLM on 127.0.0.1/::1) still work.
 */

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackUrl(baseUrl: string): boolean {
  let host: string;
  try { host = new URL(baseUrl).hostname; }
  catch { return false; }
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK_NAMES.has(h)) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // whole 127/8 block
  if (h === "0:0:0:0:0:0:0:1") return true; // ::1 fully expanded
  return false;
}

export const offlineMode = () => process.env.MOTIONFIELD_OFFLINE === "1";

/** Hosted deployment: user-supplied LLM base URLs must be https and pass the
 *  webhook SSRF deny rules; local and CLI providers are refused outright. */
export const hostedMode = () => process.env.MOTIONFIELD_HOSTED === "1";

/** Throws OfflineBlocked when offline applies and the URL isn't loopback. */
export function assertOfflineOk(baseUrl: string, req?: Pick<ChatRequest, "offline">): void {
  if (!offlineMode() && !req?.offline) return;
  if (isLoopbackUrl(baseUrl)) return;
  throw new OfflineBlocked(
    `offline mode - LLM endpoint ${baseUrl} is not loopback; pick a local provider or unset MOTIONFIELD_OFFLINE`,
  );
}
