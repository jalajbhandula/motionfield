/* motionfield entry point - arg dispatch + the stdout/exit-code contract. */

import { readFileSync } from "node:fs";
import { MotionFieldError } from "../../sdk-ts/src/index.ts";
import { COMMANDS, GENERAL_HELP, HELP, ExitError, UsageError } from "./commands.mts";
import { redact, type Ctx } from "./util.mts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

function reportError(e: unknown, ctx: Ctx, cmd: string): number {
  if (e instanceof ExitError) {
    if (e.message) console.error(redact(e.message));
    return e.code;
  }
  if (e instanceof UsageError) {
    console.error(`error: ${redact(e.message)}`);
    const help = HELP[cmd];
    if (help) console.error(`\n${help}`);
    return 2;
  }
  if (e instanceof MotionFieldError) {
    if (ctx.json) {
      console.log(redact(JSON.stringify({
        error: {
          code: e.code, message: e.message,
          ...(e.license != null ? { license: e.license } : {}),
          ...(e.enableAt != null ? { enable_at: e.enableAt } : {}),
          ...(e.headRev != null ? { head_rev: e.headRev } : {}),
        },
      })));
    } else {
      // a stale edit tells the human the head rev too - --json already
      // carries it as head_rev; without it the retry is guesswork
      console.error(redact(`error: ${e.code}: ${e.message}${e.headRev != null ? ` (head rev ${e.headRev})` : ""}`));
    }
    return 1;
  }
  console.error(redact(`error: ${e instanceof Error ? e.message : String(e)}`));
  return 1;
}

async function main(): Promise<number> {
  // global flags are position-independent: peel them off before dispatch
  let json = false;
  let wantHelp = false;
  let wantVersion = false;
  const args: string[] = [];
  for (const a of process.argv.slice(2)) {
    if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") wantHelp = true;
    else if (a === "--version" || a === "-V") wantVersion = true;
    else args.push(a);
  }

  if (wantVersion) { console.log(`motionfield ${pkg.version}`); return 0; }
  if (args[0] === "help") { wantHelp = true; args.shift(); }
  if (wantHelp) {
    const topic = args[0];
    if (topic && HELP[topic]) { console.log(HELP[topic]); return 0; }
    console.log(GENERAL_HELP);
    return topic ? 2 : 0;
  }

  const cmd = args.shift();
  if (!cmd || !(cmd in COMMANDS)) {
    console.error(redact(`error: ${cmd ? `unknown command "${cmd}"` : "no command given"}\n`));
    console.error(GENERAL_HELP);
    return 2;
  }

  const ctx: Ctx = { json };
  try {
    await COMMANDS[cmd](ctx, args);
    return 0;
  } catch (e) {
    return reportError(e, ctx, cmd);
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    console.error(redact(`error: ${e instanceof Error ? e.message : String(e)}`));
    process.exitCode = 1;
  });
