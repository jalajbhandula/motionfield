/* The node:http adapter - one WebStandardStreamableHTTPServerTransport +
 *  one McpServer per request (stateless mode forbids reuse). Every gate
 *  fires BEFORE any MCP handling: Host/Origin allowlist → 403, off-path →
 *  404, missing/refused bearer → 401, body over 4 MB → 413. The caller's
 *  key builds that request's ToolCtx - caps/models come from the ≤60 s
 *  per-key cache. */

import http from "node:http";
import { Readable } from "node:stream";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MotionField } from "../../../sdk-ts/src/index.ts";
import { createServer } from "../server.mts";
import { callerCtx } from "./auth.mts";
import type { HttpEnv } from "./env.mts";
import { log } from "../log.mts";

export const MCP_PATH = "/mcp";
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** The whole request (headers + body) must land inside the timeout - a
 *  slow-drip body never reaches MCP handling. Response time is uncapped:
 *  a tools/call legitimately waits up to the tools' own bounds. */
const REQUEST_TIMEOUT_MS = 60_000;
const HEADERS_TIMEOUT_MS = 30_000;

class HttpFail extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Host-header value or an Origin's authority → on the allowlist? Entries
 *  compare verbatim (name:port); a bare-name entry matches that name on any
 *  port. */
export function allowedAuthority(env: HttpEnv, authority: string | undefined): boolean {
  if (!authority) return false;
  const a = authority.trim().toLowerCase();
  if (env.allowedHosts.has(a)) return true;
  const bare = a.startsWith("[") ? a.slice(1, a.indexOf("]")) : a.split(":")[0];
  for (const allowed of env.allowedHosts)
    if (!allowed.includes(":") && allowed === bare) return true;
  return false;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    req.resume(); // drain so the 413 answer still fits on the socket
    throw new HttpFail(413, "body too large (4 MB max)");
  }
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).byteLength;
    if (n > MAX_BODY_BYTES) {
      req.destroy();
      throw new HttpFail(413, "body too large (4 MB max)");
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function handle(
  env: HttpEnv, req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  // 1 - DNS-rebinding guard: Host, and Origin when one was sent
  const host = req.headers.host;
  if (!allowedAuthority(env, host)) return json(403, { error: "forbidden host" });
  const origin = req.headers.origin;
  if (origin != null) {
    let oh: string | null = null;
    try { oh = new URL(origin).host; } catch { /* unparseable → refused below */ }
    if (!oh || !allowedAuthority(env, oh)) return json(403, { error: "forbidden origin" });
  }

  // 2 - /mcp is the only MCP surface on this listener
  let pathname = "/";
  try { pathname = new URL(req.url ?? "/", "http://x").pathname; } catch { /* keep "/" */ }
  if (pathname !== MCP_PATH) return json(404, { error: "not found" });

  // 3 - the caller's own bearer, before any MCP handling
  const challenge = { "www-authenticate": 'Bearer realm="motionfield-mcp"' };
  const m = /^Bearer\s+(of_\S+)\s*$/i.exec((req.headers.authorization ?? "").trim());
  if (!m) return json(401, { error: "unauthorized" }, challenge);
  const caller = await callerCtx(env, m[1]);
  // the app couldn't answer /api/v1/me at all - that's a 502, not a refused key
  if (caller.kind === "upstream") return json(502, { error: "upstream unavailable" });
  if (caller.kind === "refused") return json(401, { error: "unauthorized" }, challenge);

  // 4 - the capped body (a POST carries the JSON-RPC envelope)
  let body: Buffer | undefined;
  if (req.method === "POST") {
    try {
      body = await readBody(req);
    } catch (e) {
      if (e instanceof HttpFail) return json(e.status, { error: e.message });
      throw e;
    }
  }

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const request = new Request(`http://${host}${req.url}`, {
    method: req.method,
    headers,
    ...(body ? { body: new Uint8Array(body) } : {}),
  });

  // 5 - stateless: a fresh transport + server per request, built from THIS
  //     caller's key; they die when the response does
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = createServer({
    client: new MotionField({ baseUrl: env.url, apiKey: caller.ctx.key, source: "mcp" }),
    caps: caller.ctx.caps,
    toolsets: env.toolsets,
    endpoints: caller.ctx.endpoints,
    models: caller.ctx.models,
    outDir: env.outDir,
    transport: "http",
  });
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    void server.close().catch(() => {});
  };
  res.on("close", cleanup);
  res.on("finish", cleanup);
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (!response.body) { res.end(); return; }
  const web = response.body as unknown as import("node:stream/web").ReadableStream;
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(web)
      .on("error", reject)
      .pipe(res)
      .on("error", reject)
      .on("finish", resolve);
  });
}

/** The listening server - requestTimeout covers receiving the request
 *  (headersTimeout < requestTimeout per Node's contract). */
export function createHttpServer(env: HttpEnv): http.Server {
  return http.createServer(
    { requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: HEADERS_TIMEOUT_MS },
    (req, res) => {
      handle(env, req, res).catch((e) => {
        log(`motionfield-mcp-http: request failed - ${e instanceof Error ? e.message : String(e)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        } else {
          res.destroy();
        }
      });
    },
  );
}
