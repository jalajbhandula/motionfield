import { promises as dns } from "dns";
import http from "http";
import https from "https";
import net from "net";
import { Readable } from "stream";

/**
 * SSRF-safe outbound fetch - the shared guard for every "fetch a URL the
 * user gave us" path (brand context today, stage/refs tomorrow).
 *
 * Rules enforced here: only http/https; every hop's DNS is resolved and
 * rejected if it lands in loopback/private/link-local/CGNAT/metadata space
 * (IPv6 included); redirects are followed manually (≤3, each re-checked);
 * responses are size-capped by the caller via readBody. Real requests go over
 * node http/https with a `lookup` that only ever returns vetted addresses -
 * a DNS answer that flips between the check and the connect can't redirect
 * the socket.
 */

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface SafeFetchDeps {
  lookup?: LookupFn;
  fetchImpl?: FetchFn;
  /** overall request budget (e.g. the API route's combined signal) - aborts
   *  every hop of the guarded fetch alongside the per-request timeout */
  signal?: AbortSignal;
}

const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;

/* ---------- IP guard ---------- */

function v4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    if (!/^\d{1,3}$/.test(o)) return null;
    const v = Number(o);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

/** expand an IPv6 (incl. "::" and embedded v4) into 8 hextets, or null */
function v6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v = v4ToInt(tail[1]);
    if (v == null) return null;
    s = s.slice(0, -tail[1].length) + `${((v >>> 16) & 0xffff).toString(16)}:${(v & 0xffff).toString(16)}`;
  }
  if (!/^[0-9a-f:]*$/.test(s) || !s.includes(":")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - left.length - right.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const parts = [...left, ...Array(fill).fill("0"), ...right];
  if (parts.length !== 8) return null;
  const out = parts.map((h) => parseInt(h, 16));
  return out.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : null;
}

const embeddedV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

export function isPublicIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip)!;
    const b = [24, 16, 8, 0].map((sh) => (n >>> sh) & 0xff);
    if (b[0] === 0 || b[0] === 127 || b[0] === 10 || b[0] >= 224) return false;      // this-net, loopback, private, multicast/reserved
    if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return false;                     // 172.16/12
    if (b[0] === 192 && b[1] === 168) return false;                                 // 192.168/16
    if (b[0] === 192 && b[1] === 0 && b[2] === 0) return false;                     // 192.0.0/24 IETF assignments
    if (b[0] === 198 && (b[1] === 18 || b[1] === 19)) return false;                 // 198.18/15 benchmarking
    if (b[0] === 169 && b[1] === 254) return false;                                 // link-local + cloud metadata
    if (b[0] === 100 && b[1] >= 64 && b[1] <= 127) return false;                    // CGNAT 100.64/10
    if (b[0] === 192 && b[1] === 0 && b[2] === 2) return false;                     // 192.0.2/24 TEST-NET-1
    if (b[0] === 198 && b[1] === 51 && b[2] === 100) return false;                  // 198.51.100/24 TEST-NET-2
    if (b[0] === 203 && b[1] === 0 && b[2] === 113) return false;                   // 203.0.113/24 TEST-NET-3
    if (b[0] === 192 && b[1] === 88 && b[2] === 99) return false;                   // 192.88.99/24 6to4 relay anycast
    if (b[0] === 192 && b[1] === 175 && b[2] === 48) return false;                  // 192.175.48/24 AS112 (blackhole)
    if (b[0] === 192 && b[1] === 31 && b[2] === 196) return false;                  // 192.31.196/24 AS112-v4
    if (b[0] === 192 && b[1] === 52 && b[2] === 193) return false;                  // 192.52.193/24 AS112-v4
    return true;
  }
  if (net.isIPv6(ip)) {
    const h = v6Hextets(ip);
    if (!h) return false;
    const w = h[0];
    if (h.every((x) => x === 0)) return false;                                      // ::
    if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return false;            // ::1
    if ((w & 0xffc0) === 0xfe80) return false;                                      // fe80::/10 link-local
    if ((w & 0xfe00) === 0xfc00) return false;                                      // fc00::/7 unique-local
    if ((w & 0xff00) === 0xff00) return false;                                      // ff00::/8 multicast
    if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
      // IPv4-mapped - apply the v4 rules to the embedded address
      return isPublicIp(embeddedV4(h[6], h[7]));
    }
    if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0) {
      return isPublicIp(embeddedV4(h[6], h[7]));                                    // v4-compatible ::
    }
    if (w === 0x64 && h[1] === 0xff9b) {
      return isPublicIp(embeddedV4(h[6], h[7]));                                    // 64:ff9b::/96 NAT64 - last 32 bits
    }
    if (w === 0x2002) {
      return isPublicIp(embeddedV4(h[1], h[2]));                                    // 2002::/16 6to4 - hextets 1-2
    }
    if (w === 0x2001 && h[1] === 0) {
      // Teredo 2001::/32 - the client v4 lives in the last 32 bits, XOR-obfuscated
      return isPublicIp(embeddedV4(h[6] ^ 0xffff, h[7] ^ 0xffff));
    }
    if (w === 0x2001 && h[1] === 0x0db8) return false;                              // 2001:db8::/32 documentation
    if (w === 0x2001 && h[1] === 0x0002) return false;                              // 2001:2::/48 benchmarking
    if (w === 0x2001 && (h[1] & 0xfff0) === 0x0020) return false;                   // 2001:20::/28 ORCHIDv2
    if (w === 0x3fff && h[1] < 0x1000) return false;                                // 3fff::/20 documentation
    if ((w & 0xffc0) === 0xfec0) return false;                                      // fec0::/10 site-local (deprecated)
    return true;
  }
  return false;
}

async function assertPublicHost(url: URL, lookup: LookupFn, checked: Map<string, boolean>) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (checked.has(host)) {
    if (!checked.get(host)) throw new Error(`URL blocked: "${host}" resolves to a private/local address`);
    return;
  }
  let ok = false;
  if (net.isIP(host)) {
    ok = isPublicIp(host);
  } else {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
      throw new Error(`URL blocked: "${host}" is not a public host`);
    }
    let addrs: { address: string; family: number }[];
    try {
      addrs = await lookup(host);
    } catch (e) {
      throw new Error(`can't resolve "${host}": ${e instanceof Error ? e.message : e}`);
    }
    ok = addrs.length > 0 && addrs.every((a) => isPublicIp(a.address));
  }
  checked.set(host, ok);
  if (!ok) throw new Error(`URL blocked: "${host}" resolves to a private/local address`);
}

/* ---------- fetch with manual redirects ---------- */

const realLookup: LookupFn = (host) => dns.lookup(host, { all: true });

/** The `lookup` option node http/https request() accepts (net.LookupFunction). */
export type RequestLookup = net.LookupFunction;

/**
 * A node `lookup` that only ever hands public addresses to the socket -
 * the vetting happens inside the connection attempt itself, so a DNS answer
 * that flips between the pre-check and the connect still can't redirect the
 * request onto a private address.
 */
export function publicOnlyLookup(resolve: LookupFn = realLookup): RequestLookup {
  return (host, opts, cb) => {
    const blocked = () => {
      const e = new Error(`URL blocked: "${host}" resolves to a private/local address`) as NodeJS.ErrnoException;
      e.code = "EAI_AGAIN"; // looked up, nothing usable - same surface as a failed lookup
      return cb(e, "");
    };
    const finish = (addrs: { address: string; family: number }[]) => {
      const ok = addrs.filter((a) => isPublicIp(a.address));
      if (!ok.length) return blocked();
      if ((opts as { all?: boolean }).all) cb(null, ok);
      else cb(null, ok[0].address, ok[0].family);
    };
    if (net.isIP(host)) {
      return finish([{ address: host, family: net.isIPv4(host) ? 4 : 6 }]);
    }
    resolve(host).then(finish, (e) => cb(e instanceof Error ? e as NodeJS.ErrnoException : new Error(String(e)), ""));
  };
}

/**
 * Minimal fetch stand-in over node http/https - real transports must take a
 * `lookup`, which fetch() can't express. Returns a real Response over the
 * raw stream so readBody's caps still apply; redirects are never followed
 * here (guardedFetch re-vets each hop itself).
 */
function nodeFetch(
  url: string,
  init: RequestInit | undefined,
  lookup: RequestLookup,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const headers: Record<string, string> = { "user-agent": "motionfield-brand/1.0" };
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const req = lib.request(u, { method: "GET", headers, lookup }, (res) => {
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        out.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      // 204/205/304 have no body by definition - constructing a Response with
      // a stream body at those statuses throws before our own checks can run
      const status = res.statusCode ?? 502;
      if (status === 204 || status === 205 || status === 304) {
        res.resume();
        resolve(new Response(null, { status, headers: out }));
        return;
      }
      resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
        status,
        headers: out,
      }));
    });
    const onAbort = () => req.destroy(new Error("request aborted"));
    init?.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", reject);
    req.end();
  });
}

/** drop an unread response body so its socket can close */
export function dropBody(res: Response) {
  void res.body?.cancel().catch(() => {});
}

export async function guardedFetch(
  url: string,
  deps: SafeFetchDeps,
  accept: string,
): Promise<{ res: Response; finalUrl: string }> {
  const lookup = deps.lookup ?? realLookup;
  const vettedLookup = publicOnlyLookup(lookup);
  const fetchImpl: FetchFn = deps.fetchImpl ?? ((u, init) => nodeFetch(u, init, vettedLookup));
  const signal = deps.signal
    ? AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), deps.signal])
    : AbortSignal.timeout(TIMEOUT_MS);
  const checked = new Map<string, boolean>();

  let current = url;
  for (let hop = 0; ; hop++) {
    const u = new URL(current);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`URL blocked: "${u.protocol}" is not http/https`);
    }
    await assertPublicHost(u, lookup, checked);
    let res: Response;
    try {
      res = await fetchImpl(current, { redirect: "manual", signal, headers: { Accept: accept } });
    } catch (e) {
      throw new Error(`can't reach ${u.host}: ${e instanceof Error ? e.message : e}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= MAX_REDIRECTS) {
        dropBody(res);
        throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
      }
      dropBody(res); // never read - release the socket before the next hop
      current = new URL(res.headers.get("location")!, current).toString();
      continue;
    }
    return { res, finalUrl: current };
  }
}

/** stream-capped body read - throws once the cap is crossed, returns raw bytes */
export async function readBody(res: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > cap) throw new Error(`response too large (>${cap} bytes)`);
  const body = res.body;
  if (!body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > cap) throw new Error(`response too large (>${cap} bytes)`);
    return buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new Error(`response too large (>${cap} bytes)`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return buf;
}
