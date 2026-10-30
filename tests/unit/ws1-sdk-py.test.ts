import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { signWebhookHeader } from "@/lib/api/webhooks";

// The suite runs the real python3 stdlib unittest discoverer; give it room.
vi.setConfig({ testTimeout: 120_000 });

const SECRET = "ofwh_wrap_test_secret";
const BODY = JSON.stringify({ id: "e1", type: "job.completed", created: 1, data: { id: "j1", status: "completed" } });

describe("sdk-py", () => {
  it("stdlib unittest suite passes - including a header signed by the app code", () => {
    const header = signWebhookHeader(SECRET, BODY);
    let out = "";
    try {
      out = execFileSync(
        "python3", ["-I", "-B", "-m", "unittest", "discover", "-s", "packages/sdk-py/tests"],
        {
          env: { ...process.env, OF_WH_SECRET: SECRET, OF_WH_HEADER: header, OF_WH_BODY: BODY },
          timeout: 90_000,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      ) as unknown as string;
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      console.error(err.stdout?.toString());
      console.error(err.stderr?.toString());
      throw e;
    }
    expect(out).toBeDefined();
  });
});
