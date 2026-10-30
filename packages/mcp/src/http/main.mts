/* motionfield-mcp-http - Streamable HTTP MCP server for the MotionField v1 API.
 *
 *  Stateless: every request carries its own `Authorization: Bearer of_…`,
 *  verified against GET /api/v1/me (≤60 s cache keyed by sha256). No
 *  server-side key, no sessions, no OAuth. Loopback-only by default -
 *  exposing it safely means a TLS reverse proxy in front plus a tight
 *  MOTIONFIELD_MCP_ALLOWED_HOSTS.
 *
 *  Env: MOTIONFIELD_URL (the app, default http://localhost:3000)
 *       MOTIONFIELD_MCP_HTTP_HOST (default 127.0.0.1)
 *       MOTIONFIELD_MCP_HTTP_PORT (default 8790)
 *       MOTIONFIELD_MCP_ALLOWED_HOSTS (default localhost:<port>,127.0.0.1:<port>)
 *       MOTIONFIELD_TOOLSETS (default "core,3d") */

import { parseHttpEnv } from "./env.mts";
import { createHttpServer } from "./server.mts";
import { log } from "../log.mts";
import { redact } from "../../../cli/src/util.mts";

async function main(): Promise<void> {
  const env = parseHttpEnv();
  const server = createHttpServer(env);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(env.port, env.host, resolve);
  });
  log(`motionfield-mcp-http: http://${env.host}:${env.port}/mcp → ${env.url} ` +
    `(${[...env.toolsets].join("+")} toolsets)`);
}

main().catch((e) => {
  log(`motionfield-mcp-http: fatal - ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

process.on("uncaughtException", (e) => {
  process.stderr.write(`motionfield-mcp-http: uncaught - ${redact(e.message)}\n`);
  process.exit(2);
});
process.on("unhandledRejection", (e) => {
  process.stderr.write(`motionfield-mcp-http: unhandled rejection - ${redact(e instanceof Error ? e.message : String(e))}\n`);
  process.exit(2);
});
