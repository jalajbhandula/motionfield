import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import path from "node:path";

// ws4: the preset-honesty gate reads a fabricated fixture in e2e — real
// records never exist on a clean checkout (tests/fixtures/preset-verify-e2e.json)
process.env.PRESET_VERIFY_FILE ??= "tests/fixtures/preset-verify-e2e.json";
// ws3 vfx-lab: same pattern — the e2e fixture is seeded by the spec itself
// (real mechanism hashes, fabricated status) so the page can exercise the
// verified-preset path; the committed verify file stays honest
process.env.VFX_VERIFY_FILE ??= "tests/fixtures/vfx-verify-e2e.json";

const PORT = process.env.PORT || "3100";
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  globalSetup: "./tests/e2e/global-setup.ts",
  use: { baseURL, headless: true },
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      ...process.env,
      PORT,
      OF_ENABLE_UNVERIFIED: "1", // exercise gated executors with mock generation only
      WHISPER_CLI: path.resolve("tests/e2e/helpers/whisper-fixture.mjs"),
      WHISPER_MODEL: path.resolve("tests/fixtures/asr-e2e-model.txt"),
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || baseURL,
      // .env pins BETTER_AUTH_URL to :3000 for real dev; the e2e server binds
      // :3100 and better-auth would 403 every Origin'd call (signup included)
      // unless its trusted baseURL matches the test port.
      BETTER_AUTH_URL: baseURL,
      GENERATION_PROVIDER: process.env.GENERATION_PROVIDER || "mock",
      // Keep the developer's .env LLM out of deterministic template tests.
      // Specs needing an LLM supply a dedicated mock endpoint explicitly.
      ...Object.fromEntries([
        "LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY",
        "LLM_TASK_PLANNER", "LLM_TASK_WRITER", "LLM_TASK_VISION",
        "LLM_TASK_CODER", "LLM_TASK_ENHANCER", "LLM_TASK_JUDGE",
      ].map((key) => [key, process.env[key] || ""])),
      // no e2e may ever reach a real ComfyUI — recipes bypass
      // GENERATION_PROVIDER and drive comfy directly; port 9 (discard)
      // refuses instantly. Always pinned — live GPU work goes through
      // gpu-run, never through the e2e dev server.
      COMFY_BASE_URL: "http://127.0.0.1:9",
      COMFY_AUDIO_BASE_URL: "http://127.0.0.1:9",
      PGLITE_DIR: process.env.PGLITE_DIR || path.join(tmpdir(), "motionfield-e2e-pglite"),
      // .env may point the app at Docker Postgres. Tests stay on their own PGlite.
      DATABASE_URL: "",
      // the suite makes several sign-ups per minute from one IP — lift the
      // built-in /sign-* 3-per-10s rule for tests only (auth.ts)
      BETTER_AUTH_RATE_TEST: "1",
      // provider-key encryption requires the secret explicitly (lib/llm/crypto)
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || "e2e-secret-0123456789abcdef0123456789abcdef",
      // agent env vars leak into the dev server via process.env — Next's
      // upgrade nudge (@vercel/detect-agent) then STOPS the server mid-suite
      // to print an advisory. Strip them so the spawned `next dev` runs as a
      // plain non-agent process.
      AI_AGENT: "", CURSOR_AGENT: "", CURSOR_TRACE_ID: "", CURSOR_EXTENSION_HOST_ROLE: "",
      CLAUDECODE: "", CLAUDE_CODE: "", GEMINI_CLI: "", REPL_ID: "",
      CODEX_SANDBOX: "", CODEX_CI: "", CODEX_THREAD_ID: "",
      ANTIGRAVITY_AGENT: "", AUGMENT_AGENT: "", OPENCODE_CLIENT: "",
      COPILOT_MODEL: "", COPILOT_ALLOW_ALL: "", COPILOT_GITHUB_TOKEN: "",
    } as Record<string, string>,
  },
});
