/**
 * Unit/e2e-adjacent vitest files must never reach a real ComfyUI. Tonight's
 * incident: agent tests queued 14 real Wan/LTX video jobs on the shared GPU.
 *
 * Unless an explicit live flag is set (LLM_LIVE / LLM_CLI_LIVE / COMFY_LIVE /
 * SMOKE_LIVE = "1") AND the file under collection sits under tests/smoke/,
 * every vitest file runs with:
 *   - GENERATION_PROVIDER=mock - even a file that forgets to pin it
 *   - COMFY_BASE_URL at an unroutable loopback port - so a code path that
 *     bypasses the env provider (the recipe provider drives comfy directly)
 *     or a test that flips the env mid-run fails fast with ECONNREFUSED
 *     instead of queueing real GPU work. Port 9 is the discard port -
 *     guaranteed closed. (comfy.ts honors a set COMFY_BASE_URL.)
 *
 * Live smoke invocations always name the file on the CLI
 * (`npx vitest run tests/smoke/x.test.ts`), so argv is the flag the guard
 * keys on; `expect.getState().testPath` (the file being collected) is used
 * first when the runtime already knows it. A plain `npm test` with a stray
 * live flag still pins - the smoke file skips itself by flag anyway.
 */
import { expect } from "vitest";

const LIVE = ["LLM_LIVE", "LLM_CLI_LIVE", "COMFY_LIVE", "SMOKE_LIVE"].some(
  (k) => process.env[k] === "1",
);

const SMOKE_PATH = /(^|[\\/])tests[\\/]smoke([\\/]|$)/;

function fileIsSmoke(): boolean {
  try {
    const p = (expect.getState() as { testPath?: unknown }).testPath;
    if (typeof p === "string" && p) return SMOKE_PATH.test(p);
  } catch {
    /* state not initialized yet - fall back to argv */
  }
  return process.argv.some((a) => SMOKE_PATH.test(a));
}

if (!(LIVE && fileIsSmoke())) {
  process.env.GENERATION_PROVIDER = "mock";
  // force, not ??: an inherited real COMFY_BASE_URL is exactly what must be
  // neutralized - a test that needs a stub Comfy sets its own URL later
  process.env.COMFY_BASE_URL = "http://127.0.0.1:9";
  process.env.COMFY_AUDIO_BASE_URL = "http://127.0.0.1:9";
}
