/* motionfield-mcp-http env - the listener's own config, env-only like stdio.
 *  There is NO server-side key: every request carries its own
 *  `Authorization: Bearer of_…`, verified against GET /api/v1/me.
 *  OAuth is not supported. */

import { DEFAULT_OUT_DIR, DEFAULT_URL, TOOLSETS } from "../env.mts";

export interface HttpEnv {
  /** the MotionField app base url - MOTIONFIELD_URL. */
  url: string;
  /** bind address - MOTIONFIELD_MCP_HTTP_HOST (default 127.0.0.1). */
  host: string;
  /** bind port - MOTIONFIELD_MCP_HTTP_PORT (default 8790). */
  port: number;
  /** Host/Origin allowlist - MOTIONFIELD_MCP_ALLOWED_HOSTS, comma list of
   *  Host-header values (default: localhost:<port>,127.0.0.1:<port>). A
   *  bare hostname entry matches that name on any port. */
  allowedHosts: Set<string>;
  /** MOTIONFIELD_TOOLSETS (default "core,3d"; "all" for everything). */
  toolsets: Set<string>;
  /** MOTIONFIELD_MCP_OUT_DIR - parsed for ctx shape only; http tools never
   *  write to the local filesystem. */
  outDir: string;
}

export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 8790;

export function parseHttpEnv(): HttpEnv {
  const url = (process.env.MOTIONFIELD_URL ?? DEFAULT_URL).replace(/\/+$/, "");
  const host = process.env.MOTIONFIELD_MCP_HTTP_HOST ?? DEFAULT_HTTP_HOST;
  const rawPort = process.env.MOTIONFIELD_MCP_HTTP_PORT;
  const port = rawPort === undefined ? DEFAULT_HTTP_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(
      `motionfield-mcp-http: MOTIONFIELD_MCP_HTTP_PORT must be an integer 1-65535, got "${rawPort}"\n`);
    process.exit(2);
  }
  const rawHosts = process.env.MOTIONFIELD_MCP_ALLOWED_HOSTS;
  const allowedHosts = new Set(
    (rawHosts ?? `localhost:${port},127.0.0.1:${port}`)
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const raw = (process.env.MOTIONFIELD_TOOLSETS ?? "core,3d").trim();
  const toolsets = raw.toLowerCase() === "all"
    ? new Set<string>(TOOLSETS)
    : new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return {
    url, host, port, allowedHosts, toolsets,
    outDir: process.env.MOTIONFIELD_MCP_OUT_DIR ?? DEFAULT_OUT_DIR,
  };
}
