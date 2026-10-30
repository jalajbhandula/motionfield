import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * motionfield-mcp-http security - the listener's gate order (host/origin →
 * path → bearer → body cap) against a stub app, per-key ctx isolation,
 * and the http-mode filesystem refusals. The stub answers /api/v1/me
 * per-key so isolation is observable end to end.
 */

const runJson = (code: string, env: Record<string, string> = {}) => {
  const r = spawnSync("node", ["--experimental-strip-types", "-e", code], {
    env: { ...process.env, ...env }, encoding: "utf8", timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`script failed: ${r.stderr}`);
  return { out: JSON.parse(r.stdout.trim()), stderr: r.stderr };
};

const imp = (p: string) => `import("./packages/mcp/src/${p}")`;

/** The stub listener's out dir is created by the parent (never the spawned
 *  script) and removed no matter how the probe ends. */
function withStubOut<T>(fn: (env: Record<string, string>) => T): T {
  const outDir = mkdtempSync(join(tmpdir(), "of-mcphttp-out-"));
  try {
    return fn({ OF_STUB_OUT: outDir });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** node script prelude: a stub app (me/caps/models/system per-key) plus a
 *  real createHttpServer listener on an ephemeral port. Prints probes JSON. */
const PRELUDE = `
  const http = await import("node:http");
  const { createHttpServer } = await ${imp("http/server.mts")};
  const KEYS = {
    "of_aaaa_k1": { u: "user-a", c: 100 },
    "of_bbbb_k2": { u: "user-b", c: 200 },
  };
  let flakyLeft = Number(process.env.OF_ME_FAIL ?? 0);
  const app = http.createServer((req, res) => {
    const key = (req.headers.authorization ?? "").replace(/^Bearer\\s+/i, "");
    const k = KEYS[key];
    const j = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/api/v1/me") {
      // OF_ME_FAIL=<n> makes the flaky key's /me answer 500 that many times
      if (key === "of_flaky_k9" && flakyLeft-- > 0) return j(500, { error: "boom" });
      const hit = k ?? (key === "of_flaky_k9" ? { u: "user-f", c: 50 } : null);
      return hit ? j(200, { user_id: hit.u, email: hit.u + "@t", plan: "pro", credits: hit.c, key: { id: "k", label: "l" } }) : j(401, { error: "unauthorized" });
    }
    if (!k) return j(401, { error: "unauthorized" });
    if (req.url === "/api/v1/capabilities") return j(200, { capabilities: ["jobs", "jobs.list", "jobs.source", "system", "models", "estimate", "uploads", "assets", "presets", "runs", "skills.read", "threed"] });
    if (req.url === "/api/v1/models") return j(200, { models: [] });
    if (req.url === "/api/v1/system") return j(200, { queue: { queued: 0, in_progress: 0 }, gpu: { busy: false }, tier: "local", disk: { free_gb: 1 } });
    return j(404, { error: "nope" });
  });
  await new Promise(r => app.listen(0, "127.0.0.1", r));
  const appPort = app.address().port;
  const env = { url: "http://127.0.0.1:" + appPort, host: "127.0.0.1", port: 0,
    allowedHosts: new Set(), toolsets: new Set(["core"]), outDir: process.env.OF_STUB_OUT };
  const srv = createHttpServer(env);
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  env.allowedHosts = new Set(["localhost:" + port, "127.0.0.1:" + port]);
  const post = (path, headers, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      const ch = []; res.on("data", c => ch.push(c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(ch).toString() }));
    });
    req.on("error", reject);
    if (body) req.write(body); req.end();
  });
  const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const CALL = (name, args) => JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const sseData = (body) => {
    const m = [...body.matchAll(/^data: (.*)$/gm)].map((x) => JSON.parse(x[1]));
    return m[m.length - 1];
  };
`;

describe("mcp-http gate order", () => {
  it("no/bad bearer → 401 before MCP; bad Host/Origin → 403; off-path → 404; valid init → 200", () => {
    const { out } = withStubOut((env) => runJson(`(async () => { ${PRELUDE}
      const probes = {
        noAuth: (await post("/mcp", H, INIT)).status,
        badKey: (await post("/mcp", { ...H, authorization: "Bearer of_dead_x" }, INIT)).status,
        notBearer: (await post("/mcp", { ...H, authorization: "Bearer notakey" }, INIT)).status,
        badHost: (await post("/mcp", { ...H, authorization: "Bearer of_aaaa_k1", host: "evil.example" }, INIT)).status,
        badOrigin: (await post("/mcp", { ...H, authorization: "Bearer of_aaaa_k1", origin: "http://evil.example" }, INIT)).status,
        offPath: (await post("/api/v1/jobs", { ...H, authorization: "Bearer of_aaaa_k1" }, INIT)).status,
        ok: (await post("/mcp", { ...H, authorization: "Bearer of_aaaa_k1" }, INIT)),
      };
      // a refused key stays refused on the second request (cached refusal ≤60 s)
      probes.badKeyAgain = (await post("/mcp", { ...H, authorization: "Bearer of_dead_x" }, INIT)).status;
      console.log(JSON.stringify({ ...probes, okStatus: probes.ok.status, okBody: probes.ok.body.slice(0, 200) }));
      app.close(); srv.close();
    })()`, env));
    expect(out.noAuth).toBe(401);
    expect(out.badKey).toBe(401);
    expect(out.notBearer).toBe(401);
    expect(out.badHost).toBe(403);
    expect(out.badOrigin).toBe(403);
    expect(out.offPath).toBe(404);
    expect(out.okStatus).toBe(200);
    expect(out.okBody).toContain('"name":"motionfield"');
    expect(out.badKeyAgain).toBe(401);
  });

  it("two keys → isolated ctxs; every request carries its own bearer end-to-end", () => {
    const { out } = withStubOut((env) => runJson(`(async () => { ${PRELUDE}
      const a = await post("/mcp", { ...H, authorization: "Bearer of_aaaa_k1" }, CALL("system_status", {}));
      const b = await post("/mcp", { ...H, authorization: "Bearer of_bbbb_k2" }, CALL("system_status", {}));
      const pa = sseData(a.body).result.structuredContent ?? JSON.parse(sseData(a.body).result.content[0].text);
      const pb = sseData(b.body).result.structuredContent ?? JSON.parse(sseData(b.body).result.content[0].text);
      console.log(JSON.stringify({ a: pa.account, b: pb.account }));
      app.close(); srv.close();
    })()`, env));
    expect(out.a.credits).toBe(100);
    expect(out.b.credits).toBe(200);
  });

  it("the caller's key never appears in responses or the server's stderr", () => {
    const { out, stderr } = withStubOut((env) => runJson(`(async () => { ${PRELUDE}
      const bodies = [];
      bodies.push((await post("/mcp", { ...H, authorization: "Bearer of_aaaa_k1" }, INIT)).body);
      bodies.push((await post("/mcp", { ...H, authorization: "Bearer of_dead_x" }, INIT)).body);
      bodies.push((await post("/mcp", { ...H, authorization: "Bearer of_aaaa_k1" }, CALL("system_status", {}))).body);
      bodies.push((await post("/mcp", { ...H, authorization: "Bearer of_aaaa_k1", host: "evil" }, INIT)).body);
      console.log(JSON.stringify({ bodies }));
      app.close(); srv.close();
    })()`, env));
    for (const body of out.bodies as string[]) {
      expect(body).not.toContain("of_aaaa_k1");
      expect(body).not.toContain("of_dead_x");
    }
    expect(stderr).not.toContain("of_aaaa_k1");
    expect(stderr).not.toContain("of_dead_x");
  });

  it("a 5xx on /api/v1/me → 502 upstream unavailable, never cached - the retry answers 200", () => {
    const { out } = withStubOut((env) => runJson(`(async () => { ${PRELUDE}
      // flaky key: the SDK retries a 5xx inside me() - fail all attempts so
      // the listener must answer 502, not a cached refusal
      const first = await post("/mcp", { ...H, authorization: "Bearer of_flaky_k9" }, INIT);
      // the same key right after: nothing was cached, so it re-verifies live
      const second = await post("/mcp", { ...H, authorization: "Bearer of_flaky_k9" }, INIT);
      // the app going away entirely is upstream too - 502, still not 401
      app.close();
      const third = await post("/mcp", { ...H, authorization: "Bearer of_aaaa_k1" }, INIT).then(
        (r) => r.status, () => -1);
      console.log(JSON.stringify({ first: first.status, second: second.status, third }));
      srv.close();
    })()`, { ...env, OF_ME_FAIL: "3" }));
    expect(out.first).toBe(502);
    expect(out.second).toBe(200);
    expect(out.third).toBe(502);
  });
});

describe("mcp-http fs guards", () => {
  it("upload{path} is a guard error; job_download returns a url and writes nothing", () => {
    const outDir = mkdtempSync(join(tmpdir(), "of-mcphttp-dl-"));
    try {
    const { out } = runJson(`(async () => {
      const [up, dl] = await Promise.all([
        ${imp("tools/core/upload.mts")},
        ${imp("tools/core/job_download.mts")},
      ]);
      const job = { id: "123e4567-e89b-42d3-a456-426614174000", status: "completed",
        outputs: [{ type: "image/png", bytes: 3, url: "/files/x.png" }] };
      const ctx = { transport: "http", outDir: ${JSON.stringify(outDir)},
        client: { baseUrl: "http://app", get: async () => job, download: async () => { throw new Error("must not download"); }, upload: async () => { throw new Error("must not upload"); } } };
      const upRes = await up.default.handler({ path: "/etc/hosts" }, ctx).then(
        (r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.constructor.name, msg: e.message }));
      const dlRes = await dl.default.handler({ id: job.id }, ctx);
      console.log(JSON.stringify({ upRes, dl: JSON.parse(dlRes.content[0].text) }));
    })()`);
    expect(out.upRes.ok).toBe(false);
    expect(out.upRes.code).toBe("GuardError");
    expect(out.upRes.msg).toContain("stdio-only");
    expect(out.dl.url).toBe("http://app/api/v1/jobs/123e4567-e89b-42d3-a456-426614174000/result?i=0");
    expect(out.dl.mime).toBe("image/png");
    expect(out.dl.bytes).toBe(3);
    expect(readdirSync(outDir)).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
