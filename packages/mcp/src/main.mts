/* motionfield-mcp - stdio MCP server for the MotionField v1 API.
 *
 *  Stdout carries protocol only; every log line goes to stderr, redacted.
 *  Env: MOTIONFIELD_URL (default http://localhost:3000) · MOTIONFIELD_API_KEY
 *  (required) · MOTIONFIELD_TOOLSETS (default "core,3d"; "all" for everything)
 *  · MOTIONFIELD_MCP_OUT_DIR (default ./motionfield-out). */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Model } from "../../sdk-ts/src/index.ts";
import { parseEnv } from "./env.mts";
import { apiClient } from "./client.mts";
import { createServer } from "./server.mts";
import { log } from "./log.mts";
import { redact } from "../../cli/src/util.mts";

async function main(): Promise<void> {
  const env = parseEnv(); // exits 2 when MOTIONFIELD_API_KEY is missing
  const client = apiClient(env);

  // Read /api/v1/capabilities exactly once at startup - the advertised tool
  // set is computed from it; a server that can't answer leaves every
  // capability-gated tool callable-but-not_available.
  let caps: Set<string>;
  try {
    caps = new Set(await client.capabilities());
  } catch (e) {
    log(`motionfield-mcp: capabilities fetch failed (${e instanceof Error ? e.message : String(e)}) - capability-gated tools will report not_available`);
    caps = new Set();
  }

  // The model catalog once more - endpoint-gated tools list only when the
  // server really serves their endpoint (restricted-license models appear
  // only after the caller opts in server-side), and tools that must check a
  // live input schema read it from the same map. A failed fetch disables
  // endpoint-gated tools rather than guessing.
  let endpoints: Set<string> | null;
  let models: Map<string, Model> | null;
  try {
    const list = await client.models();
    endpoints = new Set(list.map((m) => m.id));
    models = new Map(list.map((m) => [m.id, m]));
  } catch (e) {
    log(`motionfield-mcp: models fetch failed (${e instanceof Error ? e.message : String(e)}) - endpoint-gated tools will report not_available`);
    endpoints = null;
    models = null;
  }

  const server = createServer({
    client, caps, toolsets: env.toolsets, endpoints, models,
    outDir: env.outDir, transport: "stdio",
  });
  await server.connect(new StdioServerTransport());
  log(`motionfield-mcp: connected on stdio → ${env.url}`);
}

main().catch((e) => {
  log(`motionfield-mcp: fatal - ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

// The process exits 2 with a redacted message on any uncaught error - the
// stdio transport must not inherit a traceback containing key material.
process.on("uncaughtException", (e) => {
  process.stderr.write(`motionfield-mcp: uncaught - ${redact(e.message)}\n`);
  process.exit(2);
});
process.on("unhandledRejection", (e) => {
  process.stderr.write(`motionfield-mcp: unhandled rejection - ${redact(e instanceof Error ? e.message : String(e))}\n`);
  process.exit(2);
});
