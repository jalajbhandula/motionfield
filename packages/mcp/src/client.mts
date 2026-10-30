/* The one API client - every tool call goes through the TS SDK so the wire
 * contract, retry policy and error mapping stay identical to the CLI. */

import { MotionField } from "../../sdk-ts/src/index.ts";
import type { Env } from "./env.mts";

export function apiClient(env: Env): MotionField {
  return new MotionField({ baseUrl: env.url, apiKey: env.key, source: "mcp" });
}
