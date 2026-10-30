import { promises as dns } from "node:dns";
import type { LookupFunction } from "node:net";

/**
 * Shared outbound-target guard (SSRF). Pure Node - only node:dns/node:net -
 * so it runs identically inside the app and in the standalone MCP process.
 *
 * Two policies share the same IP parsers:
 *  - webhooks: "always" ranges (link-local, 0.0.0.0/8, multicast) are refused
 *    everywhere; private/loopback ranges are refused only on hosted
 *    deployments (MOTIONFIELD_HOSTED=1) so local dev can still POST to a
 *    listener on the same box.
 *  - MCP remote fetch (upload{url}): every non-public range is refused -
 *    the process runs on the user's own machine, where loopback/RFC1918/
 *    CGNAT/ULA targets are always internal services.
 */

function parseV4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** Parse an IPv6 literal into 16 bytes - handles "::" compression and a
 *  dotted-quad tail (IPv4-mapped `::ffff:a.b.c.d` / compatible `::a.b.c.d`). */
function v6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  let v4: number[] | null = null;
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (tail) {
    v4 = parseV4(tail[1]);
    if (!v4) return null;
    s = s.slice(0, s.length - tail[1].length);
    if (!s.endsWith(":")) return null;
  }
  const want = v4 ? 6 : 8;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const left = halves[0].split(":").filter(Boolean);
  const right = halves.length === 2 ? halves[1].split(":").filter(Boolean) : null;
  const total = left.length + (right?.length ?? 0);
  if (halves.length === 1 && total !== want) return null;
  if (halves.length === 2 && total > want) return null;
  const groups = [...left, ...(right ? new Array(want - total).fill("0").concat(right) : [])]
    .map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (groups.length !== want || groups.some((g) => !Number.isFinite(g))) return null;
  const bytes: number[] = [];
  for (const g of groups) bytes.push(g >> 8, g & 0xff);
  if (v4) bytes.push(...v4);
  return bytes.length === 16 ? bytes : null;
}

type Deny = "always" | "hosted" | null;

function v4Denied(o: number[]): Deny {
  if (o[0] === 0) return "always";                                   // 0.0.0.0/8
  if (o[0] === 169 && o[1] === 254) return "always";                 // link-local + cloud metadata
  if (o[0] >= 224) return "always";                                  // multicast + reserved/broadcast
  if (o[0] === 127 || o[0] === 10 ||
      (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
      (o[0] === 192 && o[1] === 168) ||
      (o[0] === 100 && o[1] >= 64 && o[1] <= 127)) return "hosted";  // loopback + RFC1918 + CGNAT
  return null;
}

function v6Denied(b: number[]): Deny {
  if (b.every((x) => x === 0)) return "always";                      // :: unspecified
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return "hosted"; // ::1 loopback
  if (b[0] === 0xff) return "always";                                // ff00::/8 multicast
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return "always";      // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return "hosted";                       // fc00::/7 unique-local
  const mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  const compat = b.slice(0, 12).every((x) => x === 0);
  if (mapped || compat) return v4Denied(b.slice(12));                // IPv4-mapped/compatible
  return null;
}

export type LookupAll = (host: string, opts: { all: true }) => Promise<{ address: string; family: number }[]>;

/** The OS resolver - injectable in tests. */
export const defaultLookup: LookupAll = (host) => dns.lookup(host, { all: true });

const LOOKUP_TIMEOUT_MS = 5_000;

/** Ends as a retryable "dns lookup timed out" - well under the 60 s stale
 *  claim window, so a stuck resolver can never cause a double send. */
export class LookupTimeoutError extends Error {
  constructor() { super("dns lookup timed out"); this.name = "LookupTimeoutError"; }
}

function lookupWithTimeout(lookup: LookupAll, host: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    lookup(host, { all: true }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LookupTimeoutError()), LOOKUP_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Classify one resolved address against the deny rules; null = allowed. */
function classifyAddress(address: string, family: number): Deny {
  if (family === 6) {
    const bytes = v6Bytes(address);
    return bytes ? v6Denied(bytes) : "always";
  }
  const octets = parseV4(address);
  return octets ? v4Denied(octets) : "always";
}

/** Any answer denied? `hosted` widens the denial to private/loopback/CGNAT/ULA
 *  space - the "hosted" class from the tables above. */
function deniedForHost(addrs: { address: string; family: number }[], hosted: boolean): boolean {
  return addrs.some(({ address, family }) => {
    const deny = classifyAddress(address, family);
    return deny === "always" || (deny === "hosted" && hosted);
  });
}

/**
 * Core check: parse the URL (http/https only), resolve the host (dns.lookup,
 * all answers) and classify. `denyPrivate` also refuses loopback/RFC1918/
 * CGNAT/ULA space. Returns null when allowed; `{ reason, retryable }` otherwise
 * - DNS failures are retryable, refusals are final.
 */
async function checkTarget(
  url: string,
  lookup: LookupAll,
  denyPrivate: boolean,
): Promise<{ reason: string; retryable: boolean } | null> {
  let u: URL;
  try { u = new URL(url); } catch { return { reason: "destination not allowed", retryable: false }; }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return { reason: "destination not allowed", retryable: false };
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookupWithTimeout(lookup, u.hostname.replace(/^\[|\]$/g, ""));
  } catch (e) {
    return e instanceof LookupTimeoutError
      ? { reason: e.message, retryable: true }
      : { reason: `dns lookup failed: ${e instanceof Error ? e.message : String(e)}`, retryable: true };
  }
  if (!addrs.length) return { reason: "dns lookup failed: no addresses", retryable: true };
  if (deniedForHost(addrs, denyPrivate)) return { reason: "destination not allowed", retryable: false };
  return null;
}

/**
 * Webhook policy: private/loopback space is refused only when hosted
 * (MOTIONFIELD_HOSTED=1) - a self-hosted box may legitimately deliver to a
 * listener on the same machine. Called before every delivery attempt.
 */
export async function webhookTargetDenied(
  url: string,
  lookup: LookupAll = defaultLookup,
): Promise<{ reason: string; retryable: boolean } | null> {
  return checkTarget(url, lookup, process.env.MOTIONFIELD_HOSTED === "1");
}

/** Raised by the connect-time resolver when a fresh DNS answer denies the
 *  target - mapped to a final (non-retryable) "destination not allowed". */
export class DestinationDeniedError extends Error {
  constructor() { super("destination not allowed"); this.name = "DestinationDeniedError"; }
}

/**
 * Guarded resolve for outbound fetches (MCP upload{url}): http(s) only, DNS
 * resolved and classified with ALL private space denied - loopback, RFC1918,
 * CGNAT, ULA, link-local/metadata, multicast. On success returns the approved
 * address set; callers pin the connection to these (and re-run the guard on
 * each redirect hop) so a DNS answer can't flip between check and connect.
 */
export async function guardFetchTarget(
  url: string,
  lookup: LookupAll = defaultLookup,
): Promise<{ addrs: { address: string; family: number }[] } | { reason: string }> {
  let u: URL;
  try { u = new URL(url); } catch { return { reason: "destination not allowed" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return { reason: "destination not allowed" };
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookupWithTimeout(lookup, u.hostname.replace(/^\[|\]$/g, ""));
  } catch (e) {
    return { reason: e instanceof LookupTimeoutError ? e.message : `dns lookup failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!addrs.length) return { reason: "dns lookup failed: no addresses" };
  if (deniedForHost(addrs, true)) return { reason: "destination not allowed" };
  return { addrs };
}

/**
 * The `lookup` handed to http(s).request: it resolves the host again through
 * the app's resolver, re-classifies every answer with the same rules, and
 * returns only approved addresses - so a DNS answer that flips between the
 * pre-flight guard and connect() can never reach a denied address. A denied
 * answer fails the request with DestinationDeniedError.
 */
export function pinningLookup(lookup: LookupAll, hosted: boolean): LookupFunction {
  return (hostname, options, callback) => {
    void lookupWithTimeout(lookup, hostname.replace(/^\[|\]$/g, "")).then(
      (addrs) => {
        if (!addrs.length) {
          callback(new Error("dns lookup failed: no addresses"), "");
          return;
        }
        if (deniedForHost(addrs, hosted)) {
          callback(new DestinationDeniedError(), "");
          return;
        }
        if (options?.all) {
          callback(null, addrs.map((a) => ({ address: a.address, family: a.family })));
        } else {
          callback(null, addrs[0].address, addrs[0].family);
        }
      },
      (e: unknown) => callback(e instanceof Error ? e : new Error(String(e)), ""),
    );
  };
}
