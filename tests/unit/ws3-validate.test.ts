/**
 * scripts/runpod/validate.ts security rows (the pod instrument):
 *  - fake COMFY_API_KEY/HF_TOKEN never reach stdout/stderr - usage errors,
 *    guard refusals and the pre-submit failure path included
 *  - --workflow only accepts a bare safe name inside workflows/ - traversal,
 *    separators, absolute paths and non-.json names are refused
 *  - --from only accepts <branch>:workflows/<safe name> - traversal in either
 *    half is refused; a good spec reads the blob via `git show` (never a
 *    checkout - proven by reaching placeholder validation, not a git error)
 *  - streamProgress with a key set never logs it (console spy)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import path from "path";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { streamProgress } from "@/lib/generation/comfy";

const ROOT = process.cwd();
const VALIDATE = path.join(ROOT, "scripts/runpod/validate.ts");
const KEY = "cfk_test_9f8e7d6c5b4a3210";
const TOK = "hft_test_1a2b3c4d5e6f";
const ENV = { ...process.env, COMFY_API_KEY: KEY, HF_TOKEN: TOK };
const run = (args: string[]) =>
  spawnSync("npx", ["tsx", VALIDATE, ...args], { env: ENV, encoding: "utf8", timeout: 120_000 });
const blob = (r: ReturnType<typeof run>) => `${r.stdout}\n${r.stderr}`;

describe("runpod validate.ts", () => {
  it("never prints COMFY_API_KEY/HF_TOKEN - usage, guard and pre-submit error paths", () => {
    for (const args of [
      [],                                              // usage error
      ["--workflow", "../escape.json"],                // guard refusal
      ["--from", "no-such-branch-zz:workflows/x.json"],// git-show failure path
      ["--workflow", "wan22a14b-t2v.json"],            // reaches placeholder check
    ]) {
      const r = run(args);
      expect(r.status, `args ${args.join(" ")}`).not.toBe(0);
      const out = blob(r);
      expect(out).not.toContain(KEY);
      expect(out).not.toContain(TOK);
      // error output never echoes workflow file contents either
      expect(out).not.toContain("wan2.2_t2v_high_noise_14B_fp8_scaled");
    }
  }, 300_000);

  it("--workflow refuses traversal, separators and non-names", () => {
    for (const bad of ["../x.json", "..", "a/b.json", "/etc/passwd", "x.json/..", "UPPER.JSON", "x.json ", ".json", "x.jso"]) {
      const r = run(["--workflow", bad]);
      expect(r.status, bad).not.toBe(0);
      const out = blob(r);
      expect(out, bad).toContain("--workflow: unsafe name");
      expect(out, bad).not.toContain("submitted");
    }
  }, 300_000);

  it("--from refuses traversal in branch or path; a good spec reads via git show", () => {
    for (const bad of [
      "b:workflows/../x.json",
      "b:etc/passwd",
      "b:workflows/",
      "b:workflows/UPPER.JSON",
      "bad branch:workflows/x.json",
      "..:workflows/x.json",
      "b..c:workflows/x.json",
      "-b:workflows/x.json",
      "b:x.json",
      ":workflows/x.json",
      "b:",
    ]) {
      const r = run(["--from", bad]);
      expect(r.status, bad).not.toBe(0);
      const out = blob(r);
      expect(out, bad).toMatch(/--from: (unsafe branch|want <branch>)/);
      expect(out, bad).not.toContain("submitted");
    }
    // positive control: HEAD's own blob parses and reaches the placeholder
    // check - git show worked, no checkout happened, nothing was submitted
    const ok = run(["--from", "HEAD:workflows/wan22a14b-t2v.json"]);
    expect(ok.status).not.toBe(0);
    const out = blob(ok);
    expect(out).toContain("missing placeholders");
    expect(out).not.toContain("git could not read");
    expect(out).not.toContain("submitted");
  }, 300_000);
});

describe("streamProgress console hygiene", () => {
  beforeEach(() => { process.env.COMFY_API_KEY = KEY; });
  afterEach(() => { delete process.env.COMFY_API_KEY; delete process.env.COMFY_BASE_URL; });

  it("with a key set, no console method ever logs it", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const)
      .map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('event: progress\ndata: {"value":0.5}\n\n');
    });
    try {
      await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done));
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/events`;
      process.env.COMFY_BASE_URL = url;
      const ac = new AbortController();
      await streamProgress(url, () => {}, ac.signal);
      const printed = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
      expect(printed).not.toContain(KEY);
    } finally {
      spies.forEach((s) => s.mockRestore());
      await new Promise<void>((done) => srv.close(() => done()));
    }
  });
});
