import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    // the suite exercises every route, including release-gated ones
    env: { OF_ENABLE_UNVERIFIED: "1" },
    setupFiles: ["tests/setup/no-live-comfy.ts", "tests/setup/tmp-cleanup.ts"],
    include: ["tests/unit/**/*.test.ts", "tests/smoke/**/*.test.ts", "src/**/*.test.ts", "packages/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
