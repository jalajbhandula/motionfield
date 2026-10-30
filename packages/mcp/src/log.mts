/* stdout carries the MCP protocol and nothing else - every diagnostic line
 * goes to stderr, redacted first so of_<id>_<secret> material can never leak. */

import { redact } from "../../cli/src/util.mts";

export function log(msg: string): void {
  process.stderr.write(redact(msg) + "\n");
}
