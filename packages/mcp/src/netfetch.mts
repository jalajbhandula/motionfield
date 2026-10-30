/* Guarded remote fetch for upload{url} - the SSRF posture:
 *  - http/https only; DNS resolved up front through the shared net-guard
 *    (loopback, RFC1918, CGNAT, ULA, link-local/metadata, multicast refused -
 *    always, on this host, not just hosted deployments);
 *  - the connection is pinned to the approved address set, so an answer that
 *    flips between check and connect can only reach an allowed IP;
 *  - redirects are followed at most 3 hops, re-checked through the guard;
 *  - the body is capped at the upload limit; content-type must already be on
 *    the upload allowlist. */

import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { guardFetchTarget, type LookupAll } from "../../../src/lib/api/net-guard.ts";
import { UPLOAD_MIME_EXT, MAX_UPLOAD_BYTES } from "../../../src/lib/api/upload-rules.ts";
import { GuardError } from "./guards.mts";

const MAX_REDIRECTS = 3;
const IDLE_TIMEOUT_MS = 30_000;
/** Whole-operation cap across every redirect hop - the idle timeout alone
 *  lets a slow-drip body or a redirect chain run forever. */
const TOTAL_TIMEOUT_MS = 60_000;

export interface FetchedFile {
  bytes: Buffer;
  contentType: string;
  /** the final URL after any redirects */
  url: string;
}

/** lookup() that returns only the guard-approved addresses - a literal pin:
 *  the resolver is never re-consulted for this connection. */
function pinnedLookup(addrs: { address: string; family: number }[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, addrs.map((a) => ({ address: a.address, family: a.family })));
    else callback(null, addrs[0]!.address, addrs[0]!.family);
  };
}

export interface RequestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** The raw GET - injectable so tests can fake responses without a socket.
 *  `deadlineAt` is the fetch's total-budget expiry (ms epoch) - a request that
 *  outlives it is destroyed with "remote fetch timed out". */
export type RequestOnce = (
  url: string,
  addrs: { address: string; family: number }[],
  deadlineAt: number,
) => Promise<RequestResponse>;

const requestOnce: RequestOnce = (url, addrs, deadlineAt) => {
  return new Promise((resolveP, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { reject(new GuardError("destination not allowed")); return; }
    const left = deadlineAt - Date.now();
    if (left <= 0) { reject(new GuardError("remote fetch timed out")); return; }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname.replace(/^\[|\]$/g, ""),
        port: u.port ? Number(u.port) : undefined,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: { "user-agent": "motionfield-mcp/0.1", accept: "*/*" },
        lookup: pinnedLookup(addrs),
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > MAX_UPLOAD_BYTES) {
            req.destroy(new GuardError("remote file too large (200MB max)"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          clearTimeout(killer);
          resolveP({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on("error", (e) => { clearTimeout(killer); reject(e); });
      },
    );
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new GuardError("remote fetch timed out")));
    // Total deadline: the socket idle timeout above can't stop a request that
    // keeps trickling bytes - this hard cap can.
    const killer = setTimeout(() => req.destroy(new GuardError("remote fetch timed out")), left);
    req.on("error", (e) => {
      clearTimeout(killer);
      reject(e instanceof GuardError ? e : new GuardError(e.message));
    });
    req.end();
  });
};

/** Fetch `url` through the guard chain above. Throws GuardError on any
 *  refusal - the caller maps it to a tool error. `request` is the raw GET,
 *  injectable for tests; `lookup` overrides DNS. */
export async function fetchRemoteFile(
  rawUrl: string,
  lookup?: LookupAll,
  request: RequestOnce = requestOnce,
): Promise<FetchedFile> {
  let url = rawUrl;
  const deadlineAt = Date.now() + TOTAL_TIMEOUT_MS;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (Date.now() >= deadlineAt) throw new GuardError("remote fetch timed out");
    const target = await guardFetchTarget(url, lookup);
    if ("reason" in target) throw new GuardError(target.reason);
    const res = await request(url, target.addrs, deadlineAt);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.location;
      if (!loc) throw new GuardError(`redirect without Location (http ${res.status})`);
      try {
        url = new URL(loc, url).toString();
      } catch {
        throw new GuardError("redirect target is not a URL");
      }
      continue;
    }
    if (res.status < 200 || res.status > 299)
      throw new GuardError(`remote answered http ${res.status}`);
    const ct = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (!ct || !UPLOAD_MIME_EXT[ct])
      throw new GuardError(`remote content-type "${ct || "unknown"}" is not an accepted upload type`);
    return { bytes: res.body, contentType: ct, url };
  }
  throw new GuardError(`too many redirects (>${MAX_REDIRECTS})`);
}
