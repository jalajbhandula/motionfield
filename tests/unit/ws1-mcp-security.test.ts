import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * MCP server security + gating - no API server needed: env parsing, output
 * redaction, local-path guards, the SSRF fetch guard (including redirect
 * re-checks), prompt-surface gating and the X-Forwarded-For trust policy.
 * (8 tests - the security set this lane is allowed.)
 */

const run = (code: string, env: Record<string, string | undefined> = {}) =>
  execFileSync("node", ["--experimental-strip-types", "-e", code], {
    env: { ...process.env, ...env }, encoding: "utf8", timeout: 30_000,
  }).trim();

const imp = (p: string) => `import("./packages/mcp/src/${p}")`;

describe("mcp env parsing", () => {
  it("exits 2 without MOTIONFIELD_API_KEY and never echoes it; toolsets parse", () => {
    let status: number | null = null, stderr = "", stdout = "";
    try {
      run(`${imp("env.mts")}.then(m => m.parseEnv())`);
    } catch (e) {
      const err = e as { status: number | null; stderr: Buffer | string; stdout: Buffer | string };
      status = err.status;
      stderr = String(err.stderr);
      stdout = String(err.stdout);
    }
    expect(status).toBe(2);
    expect(stderr).toContain("MOTIONFIELD_API_KEY");
    expect(stdout).toBe("");

    const out = run(
      `${imp("env.mts")}.then(m => { const e = m.parseEnv(); console.log(JSON.stringify({ url: e.url, ts: [...e.toolsets].sort(), out: e.outDir })) })`,
      { MOTIONFIELD_API_KEY: "of_test_abc" });
    expect(JSON.parse(out)).toEqual({ url: "http://localhost:3000", ts: ["3d", "core"], out: "./motionfield-out" });

    const all = run(
      `${imp("env.mts")}.then(m => console.log(JSON.stringify([...m.parseEnv().toolsets].sort())))`,
      { MOTIONFIELD_API_KEY: "k", MOTIONFIELD_TOOLSETS: "all" });
    expect(JSON.parse(all)).toEqual(["3d", "blender", "core", "sites", "studio"]);
  });
});

describe("mcp redaction + error contract", () => {
  it("tool results and error envelopes pass redact() - of_ secrets never reach the wire", () => {
    const out = run(
      `Promise.all([${imp("registry.mts")}, import("./packages/sdk-ts/src/index.ts")]).then(([r, sdk]) => {
        const leak = "of_abcd1234_x1y2Z-9";
        const okRes = r.ok({ note: "key is " + leak });
        const errRes = r.errorResult(new sdk.MotionFieldError({ status: 403, code: "restricted_license", message: "opt in " + leak, license: "BigModel-L", enableAt: "/settings/licenses" }));
        const plain = r.errorResult(new Error("boom " + leak));
        const tool = { name: "t", toolset: "core", capability: "runs", input: null, handler: async () => r.ok({}) };
        const ctx = { caps: new Set(["jobs"]), toolsets: new Set(["core"]), outDir: "." };
        const missingCap = r.gate(tool, ctx);
        const okCtx = { caps: new Set(["runs"]), toolsets: new Set(["core"]), outDir: "." };
        const offSet = r.gate(tool, { caps: new Set(["runs"]), toolsets: new Set(["studio"]), outDir: "." });
        console.log(JSON.stringify({ okRes, errRes, plain,
          missingCap: JSON.parse(missingCap.content[0].text),
          allowed: r.gate(tool, okCtx) === null,
          offSet: JSON.parse(offSet.content[0].text),
          listed: r.toolAvailable(tool, okCtx) }));
      })`);
    const res = JSON.parse(out);
    expect(JSON.stringify(res.okRes)).toContain("of_***");
    expect(JSON.stringify(res.okRes)).not.toContain("of_abcd1234");
    const errBody = JSON.parse(res.errRes.content[0].text);
    expect(res.errRes.isError).toBe(true);
    expect(errBody.code).toBe("restricted_license");
    expect(errBody.license).toBe("BigModel-L");
    expect(errBody.enable_at).toBe("/settings/licenses");
    expect(JSON.stringify(res.plain)).toContain("internal_error");
    expect(JSON.stringify(res.plain)).toContain("of_***");
    expect(res.missingCap.code).toBe("not_available");
    expect(res.missingCap.message).toContain("runs");
    expect(res.allowed).toBe(true);
    expect(res.offSet.code).toBe("not_available");
    expect(res.listed).toBe(true);
  });
});

describe("mcp local-path guards", () => {
  it("upload{path}: regular file + media ext + ≤200MB; a symlink named .png at .html is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "of-mcp-up-"));
    const png = join(dir, "ok.png");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const html = join(dir, "evil.html");
    writeFileSync(html, "<html></html>");
    // a symlink wearing a media name - realpath resolves the true file, so
    // the .html target is what gets extension-checked and refused
    symlinkSync(html, join(dir, "x.png"));
    const sub = join(dir, "subdir");
    mkdirSync(sub);
    const out = run(
      `${imp("guards.mts")}.then(g => {
        const trial = (f) => { try { const r = g.provenLocalUpload(${JSON.stringify(dir)} + "/" + f); return { ok: true, mime: r.mime, name: r.filename, bytes: r.bytes.length }; } catch (e) { return { ok: false, code: e.name, msg: e.message }; } };
        console.log(JSON.stringify({ png: trial("ok.png"), html: trial("evil.html"), link: trial("x.png"), dir: trial("subdir"), missing: trial("nope.png") }));
      })`);
    const res = JSON.parse(out);
    expect(res.png).toEqual({ ok: true, mime: "image/png", name: "ok.png", bytes: 4 });
    expect(res.html.ok).toBe(false);
    expect(res.html.msg).toContain("upload type");
    expect(res.link.ok).toBe(false);
    expect(res.link.msg).toContain("upload type");
    expect(res.dir.ok).toBe(false);
    expect(res.missing.ok).toBe(false);
  });

  it("job_download writes stay inside MOTIONFIELD_MCP_OUT_DIR - ids are UUIDs, paths resolve", () => {
    const root = mkdtempSync(join(tmpdir(), "of-mcp-out-"));
    const outside = join(tmpdir(), `of-mcp-escape-${Date.now()}.png`);
    const out = run(
      `${imp("guards.mts")}.then(g => {
        const id = "123e4567-e89b-42d3-a456-426614174000";
        const trial = (jobId) => { try { return { ok: true, path: g.writeOutput(${JSON.stringify(root)}, jobId, 0, "image/png", undefined, new Uint8Array([1,2,3])) }; } catch (e) { return { ok: false, msg: e.message }; } };
        console.log(JSON.stringify({
          good: trial(id),
          badId: trial("../../../" + ${JSON.stringify(outside)}),
          dots: g.pathInside(g.ensureOutDir(${JSON.stringify(root)}), "../../etc/passwd") === null,
        }));
      })`);
    const res = JSON.parse(out);
    expect(res.good.ok).toBe(true);
    expect(res.good.path.startsWith(realpathSync(root))).toBe(true);
    expect(res.good.path.endsWith("123e4567-e89b-42d3-a456-426614174000-0.png")).toBe(true);
    expect(existsSync(res.good.path)).toBe(true);
    expect(readFileSync(res.good.path)).toEqual(Buffer.from([1, 2, 3]));
    expect(res.badId.ok).toBe(false);
    expect(res.dots).toBe(true);
    expect(existsSync(outside)).toBe(false);
  });
});

describe("mcp remote fetch guard", () => {
  // Echo-lookup returns the literal host as its own address - literal-IP URLs
  // are classified by the guard itself, so denial happens before any TCP.
  const ECHO = `(h) => Promise.resolve([{ address: h, family: h.includes(":") ? 6 : 4 }])`;
  const RFC1918 = `(h) => Promise.resolve([{ address: "10.9.9.9", family: 4 }])`;
  // names get a public address; literal IPs resolve to themselves so the
  // guard classifies the real target
  const ECHO_OR_PUB = `(h) => Promise.resolve(
    /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(h) || h.includes(":")
      ? [{ address: h, family: h.includes(":") ? 6 : 4 }]
      : [{ address: "93.184.216.34", family: 4 }])`;

  it("refuses private targets, re-checks each redirect hop, and pins approved addrs", async () => {
    const out = run(
      `Promise.all([${imp("netfetch.mts")}, import("./src/lib/api/net-guard.ts")]).then(async ([n, g]) => {
        const trials = {
          "file:///etc/passwd": ${ECHO},
          "gopher://x/1": ${ECHO},
          "http://127.0.0.1/x.png": ${ECHO},
          "http://169.254.169.254/latest/meta-data": ${ECHO},
          "http://[::1]/x": ${ECHO},
          "http://224.0.0.1/x": ${ECHO},
          "http://internal.service/x": ${RFC1918},
          "http://[fd00::1]/x": ${ECHO},
          "http://[fe80::1]/x": ${ECHO},
        };
        const res = {};
        for (const [u, lk] of Object.entries(trials)) {
          try { await n.fetchRemoteFile(u, lk); res[u] = "FETCHED"; }
          catch (e) { res[u] = e.message; }
        }
        // a 302 into private space must be refused by the guard BEFORE the
        // second request fires - the injected transport counts every call
        let calls = 0;
        const fake302 = async () => { calls++; return { status: 302, headers: { location: "http://10.0.0.1/" }, body: Buffer.alloc(0) }; };
        let redirectMsg = "FETCHED";
        try { await n.fetchRemoteFile("https://media.example/x.png", ${ECHO_OR_PUB}, fake302); }
        catch (e) { redirectMsg = e.message; }
        const pub = await g.guardFetchTarget("https://example.com/x.png", () => Promise.resolve([{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]));
        const mapped = await g.guardFetchTarget("http://x/", () => Promise.resolve([{ address: "::ffff:10.0.0.1", family: 6 }]));
        console.log(JSON.stringify({ res, redirectMsg, calls, pub, mapped }));
      })`);
    const { res, redirectMsg, calls, pub, mapped } = JSON.parse(out);
    for (const [u, msg] of Object.entries(res) as [string, string][]) {
      expect(msg).not.toBe("FETCHED");
      expect(msg, `url=${u}`).toMatch(/not allowed|dns lookup|timeout/i);
    }
    expect(redirectMsg).toBe("destination not allowed");
    expect(calls).toBe(1);
    expect(pub.addrs).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    expect(mapped.reason).toBe("destination not allowed");
  });
});

describe("mcp prompt surface", () => {
  it("a server reporting every capability lists all 13 prompts", () => {
    const out = run(
      `Promise.all([
        ${imp("server.mts")},
        import("@modelcontextprotocol/sdk/inMemory.js"),
        import("@modelcontextprotocol/sdk/client/index.js")
      ]).then(async ([s, mem, sdk]) => {
        // every capability the surface can name - including 'runs',
        // 'skills.import' and 'threed', which the real API doesn't report yet
        const caps = new Set([
          "jobs", "jobs.list", "jobs.source", "skills.read", "system", "models",
          "estimate", "uploads", "assets", "presets", "runs", "skills.import",
          "threed",
        ]);
        const server = s.createServer({ client: {}, caps, toolsets: new Set(["core"]), outDir: "." });
        const [ct, st] = mem.InMemoryTransport.createLinkedPair();
        const client = new sdk.Client({ name: "sec-test", version: "0" });
        await Promise.all([server.connect(st), client.connect(ct)]);
        const { prompts } = await client.listPrompts();
        console.log(JSON.stringify(prompts.map((p) => p.name).sort()));
        await client.close();
        await server.close();
      })`);
    expect(JSON.parse(out)).toEqual([
      "ad-pack", "direct-shot", "explainer", "launch-motion", "make-3d-character",
      "make-game", "podcast-cut", "re-edit-edit", "reshoot-angle", "skill-run",
      "stage-scene", "swap-performer", "ugc-ad", "vfx-plate",
    ]);
  });
});

describe("x-forwarded-for trust policy", () => {
  it("no proxies: spoofed headers share one key; configured proxy resolves the real client IP", { timeout: 20_000 }, async () => {
    // getIP's declared types want Request|Headers + BetterAuthOptions, but the
    // runtime reads a plain {headers} record - cast to drive it with the same
    // option object buildAuth passes.
    const { getIP } = (await import("@better-auth/core/utils/ip")) as unknown as {
      getIP: (req: { headers: Record<string, string> }, options: unknown) => string | null;
    };
    const { ipAddressOptions } = await import("@/lib/auth");
    const saved = process.env.MOTIONFIELD_TRUSTED_PROXIES;
    try {
      delete process.env.MOTIONFIELD_TRUSTED_PROXIES;
      const none = { advanced: { ipAddress: ipAddressOptions() } };
      const a = getIP({ headers: { "x-forwarded-for": "1.2.3.4" } }, none);
      const b = getIP({ headers: { "x-forwarded-for": "9.9.9.9, 8.8.8.8" } }, none);
      // every spoofed value collapses to the same non-null key - nobody can
      // borrow another client's rate-limit bucket
      expect(a).not.toBeNull();
      expect(a).toBe(b);

      process.env.MOTIONFIELD_TRUSTED_PROXIES = "10.0.0.0/8";
      const proxied = { advanced: { ipAddress: ipAddressOptions() } };
      expect(getIP({ headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.2" } }, proxied))
        .toBe("203.0.113.7");
      expect(getIP({ headers: { "x-forwarded-for": "10.0.0.2" } }, proxied)).not.toBeNull();
    } finally {
      if (saved === undefined) delete process.env.MOTIONFIELD_TRUSTED_PROXIES;
      else process.env.MOTIONFIELD_TRUSTED_PROXIES = saved;
    }
  });
});
