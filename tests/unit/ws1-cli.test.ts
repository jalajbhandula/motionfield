import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

/**
 * [OF-0821] login/config/whoami/logout · [OF-0822] status/system
 * [OF-0823] -p/-f param handling · [OF-0824] generate --wait --json
 * [OF-0825] estimate · [OF-0826] skills · [OF-0827] models · [OF-0829] upload
 * Every command is exercised against a fake v1 server - no invented data.
 */
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

const BIN = join(process.cwd(), "packages/cli/bin/motionfield.mjs");
const API_KEY = "of_TESTSECRETkey_0123456789abcdef0123456789abcdef";
const ENDPOINT = "motionfield/z-image-turbo/text-to-image";

const JOB_VIEW = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111", status, progress: status === "completed" ? 100 : 42,
  outputs: status === "completed"
    ? [{ url: "/files/generated/11111111-1111-4111-8111-111111111111.png", type: "image/png", bytes: 4 }]
    : [],
  error: status === "failed" ? "provider blew up" : null,
  created_at: "2030-01-01T00:00:00Z", updated_at: "2030-01-01T00:00:00Z",
  ...extra,
});

const seen: { method: string; path: string; body: string }[] = [];
let polls = 0;

function reply(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" }).end(text);
}

let server: Server;
let base = "";
let cfgDir = "";
let workDir = "";

/** spawn (not spawnSync) - a sync spawn would block this process's event
 *  loop and the fake v1 server inside it could never answer the child. */
function run(args: string[], opts: { envAuth?: boolean | "key"; cfgDir?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, MOTIONFIELD_CONFIG_DIR: opts.cfgDir ?? cfgDir };
    if (opts.envAuth === "key") {
      // only the API key - no MOTIONFIELD_URL, so the CLI takes its default URL
      env.MOTIONFIELD_API_KEY = API_KEY;
      delete env.MOTIONFIELD_URL;
    } else if (opts.envAuth !== false) {
      env.MOTIONFIELD_URL = base;
      env.MOTIONFIELD_API_KEY = API_KEY;
    } else {
      delete env.MOTIONFIELD_URL;
      delete env.MOTIONFIELD_API_KEY;
    }
    const child = spawn("node", [BIN, ...args], {
      env,
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "?", path: path + (url.search || ""), body: Buffer.concat(chunks).toString("utf8") });
      if (req.method === "GET" && path === "/api/v1/me") {
        if (req.headers.authorization !== `Bearer ${API_KEY}`)
          return reply(res, 401, { error: { code: "unauthorized", message: "invalid API key" } });
        return reply(res, 200, { user_id: "u-cli", email: "cli@test.dev", plan: "pro", credits: 99.5, key: { id: "key-row-1", label: "ci" } });
      }
      if (req.method === "GET" && path === "/api/v1/system")
        return reply(res, 200, { queue: { queued: 2, in_progress: 1 }, gpu: { busy: true }, tier: "local", disk: { free_gb: 128.4 } });
      if (req.method === "GET" && path === "/api/v1/capabilities")
        return reply(res, 200, { capabilities: ["jobs", "jobs.list", "skills.read", "system"] });
      if (req.method === "GET" && path === "/api/v1/models")
        return reply(res, 200, { models: [{ id: ENDPOINT, kind: "image", label: "Z · Generate", inputs: { type: "object", properties: { prompt: { type: "string" } } }, license: { class: "open", components: [] }, estimate: { credits: 0.08 }, tier: "local" }] });
      if (req.method === "POST" && path === "/api/v1/estimate")
        return reply(res, 200, { credits: 0.08, usd: 0.001, unlimited: false });
      if (req.method === "POST" && path === "/api/v1/uploads")
        return reply(res, 201, { url: "/files/uploads/up.png" });
      if (req.method === "POST" && path === "/api/v1/jobs")
        return reply(res, 202, { id: "11111111-1111-4111-8111-111111111111", status: "queued", created_at: "2030-01-01T00:00:00Z", links: { self: "/api/v1/jobs/11111111-1111-4111-8111-111111111111", cancel: "/api/v1/jobs/11111111-1111-4111-8111-111111111111/cancel", result: "/api/v1/jobs/11111111-1111-4111-8111-111111111111/result" } });
      if (req.method === "GET" && path === "/api/v1/jobs/11111111-1111-4111-8111-111111111111") {
        polls += 1;
        return reply(res, 200, JOB_VIEW(polls >= 3 ? "completed" : polls >= 2 ? "in_progress" : "queued"));
      }
      if (req.method === "GET" && path === "/api/v1/jobs/22222222-2222-4222-8222-222222222222")
        return reply(res, 200, JOB_VIEW("failed", { id: "22222222-2222-4222-8222-222222222222" }));
      if (req.method === "POST" && path === "/api/v1/jobs/11111111-1111-4111-8111-111111111111/cancel")
        return reply(res, 200, JOB_VIEW("canceled"));
      if (req.method === "GET" && path === "/api/v1/jobs")
        return reply(res, 200, { jobs: [JOB_VIEW("completed"), JOB_VIEW("queued", { id: "44444444-4444-4444-8444-444444444444" })], next_cursor: null });
      if (req.method === "GET" && path === "/api/v1/jobs/11111111-1111-4111-8111-111111111111/result")
        return reply(res, 200, "PNGBYTES");
      if (req.method === "GET" && path === "/api/v1/skills")
        return reply(res, 200, { skills: [{ slug: "narrated-explainer", name: "Narrated Explainer", description: "Topic → narrated video" }] });
      if (req.method === "GET" && path === "/api/v1/skills/narrated-explainer")
        return reply(res, 200, { slug: "narrated-explainer", name: "Narrated Explainer", description: "Topic → narrated video", skill_md: "---\nname: Narrated Explainer\n---\n# Narrated Explainer\n" });
      return reply(res, 404, { error: { code: "not_found", message: `nothing at ${path}` } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cfgDir = mkdtempSync(join(tmpdir(), "of-cli-cfg-"));
  workDir = mkdtempSync(join(tmpdir(), "of-cli-work-"));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => { seen.length = 0; });

describe("[OF-0821] login / whoami / logout", () => {
  it("login writes config.json 0600, whoami reads it back, logout removes it - key never printed", async () => {
    // env auth cleared so the stored config is what gets used
    const cfg = { envAuth: false };

    const login = await run(["login", "--url", base, "--key", API_KEY], cfg);
    expect(login.code, login.stderr).toBe(0);
    const cfgPath = join(cfgDir, "config.json");
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    expect(statSync(cfgDir).mode & 0o777).toBe(0o700);
    const stored = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(stored).toEqual({ url: base, key: API_KEY });

    const whoami = await run(["whoami"], cfg);
    expect(whoami.code, whoami.stderr).toBe(0);
    expect(whoami.stdout).toContain("cli@test.dev");
    expect(whoami.stdout).toContain("ci");

    // the secret never leaks in either stream, in either mode
    for (const out of [login.stdout, login.stderr, whoami.stdout, whoami.stderr])
      expect(out).not.toContain("TESTSECRET");

    const json = await run(["whoami", "--json"], cfg);
    expect(JSON.parse(json.stdout)).toMatchObject({ user_id: "u-cli", key: { label: "ci" } });
    expect(json.stdout).not.toContain("TESTSECRET");

    const logout = await run(["logout"], cfg);
    expect(logout.code).toBe(0);
    expect(existsSync(cfgPath)).toBe(false);
  });

  it("a key /api/v1/me rejects exits 1 and writes no config.json", async () => {
    const r = await run(["login", "--url", base, "--key", "of_bad_deadbeefdeadbeef"], { envAuth: false });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unauthorized");
    expect(existsSync(join(cfgDir, "config.json"))).toBe(false);
  });

  it("a good login hits GET /api/v1/me before config.json exists; --url falls back to MOTIONFIELD_URL", async () => {
    // no --url flag: MOTIONFIELD_URL supplies it
    const r = await run(["login", "--key", API_KEY]);
    expect(r.code, r.stderr).toBe(0);
    expect(seen[0]).toMatchObject({ method: "GET", path: "/api/v1/me" });
    expect(JSON.parse(readFileSync(join(cfgDir, "config.json"), "utf8")))
      .toEqual({ url: base, key: API_KEY });
  });

  it("MOTIONFIELD_API_KEY alone is enough - no config, no MOTIONFIELD_URL, not a usage error", async () => {
    const emptyCfg = mkdtempSync(join(tmpdir(), "of-cli-cfg-envonly-"));
    const r = await run(["status", "--json"], { envAuth: "key", cfgDir: emptyCfg });
    expect(r.code).not.toBe(2); // hits the default http://localhost:3000
  });

  it("an unknown flag is a usage error with exit 2", async () => {
    const r = await run(["whoami", "--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown option|whoami/);
  });

  it("a bare call with no command prints usage and exits 2", async () => {
    const r = await run([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage:");
  });
});

describe("[OF-0823] generate params", () => {
  it("-p coerces JSON and repeats; -f uploads first then substitutes the url", async () => {
    const media = join(workDir, "shot.png");
    writeFileSync(media, "PNGBYTES");
    const r = await run([
      "generate", ENDPOINT,
      "-p", "prompt=a lighthouse",
      "-p", "batch_size=4",
      "-p", "seed=7",
      "-p", "flags={\"a\":1}",
      "-p", "prompt=last wins",
      "-f", `image=${media}`,
    ]);
    expect(r.code, r.stderr).toBe(0);

    const posts = seen.filter((s) => s.method === "POST");
    const upIdx = posts.findIndex((s) => s.path === "/api/v1/uploads");
    const jobIdx = posts.findIndex((s) => s.path === "/api/v1/jobs");
    expect(upIdx).toBeGreaterThanOrEqual(0);
    expect(jobIdx).toBeGreaterThan(upIdx); // upload landed before the submit

    const body = JSON.parse(posts[jobIdx].body);
    expect(body.endpoint).toBe(ENDPOINT);
    expect(body.params).toMatchObject({
      prompt: "last wins", // repeated -p: last wins
      batch_size: 4,       // JSON-coerced number
      seed: 7,
      flags: { a: 1 },     // JSON object
      image: "/files/uploads/up.png", // -f substitutes the upload url
    });
  });
});

describe("[OF-0824] generate --wait --json", () => {
  it("submits, polls to completed, prints only the job object, exits 0", async () => {
    polls = 0;
    const r = await run(["generate", ENDPOINT, "-p", "prompt=hi", "--wait", "--interval", "0.1", "--timeout", "30", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const job = JSON.parse(r.stdout); // whole stdout is the object
    expect(job.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(job.status).toBe("completed");
    expect(job.outputs[0].type).toBe("image/png");
    expect(seen.filter((s) => s.path === "/api/v1/jobs/11111111-1111-4111-8111-111111111111").length).toBeGreaterThanOrEqual(3);
  });

  it("a non-completed terminal exits 1 with the job on stdout", async () => {
    const r = await run(["wait", "22222222-2222-4222-8222-222222222222", "--interval", "0.05", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).status).toBe("failed");
  });

  it("API errors map to exit 1 - text form, or the envelope with --json", async () => {
    const text = await run(["status", "33333333-3333-4333-8333-333333333333"]);
    expect(text.code).toBe(1);
    expect(text.stderr).toContain("error: not_found:");

    const json = await run(["status", "33333333-3333-4333-8333-333333333333", "--json"]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout).error.code).toBe("not_found");
  });
});

describe("[OF-0825] estimate", () => {
  it("posts the coerced params and prints the quote", async () => {
    const r = await run(["estimate", ENDPOINT, "-p", "batch_size=4", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ credits: 0.08, usd: 0.001, unlimited: false });
    const body = JSON.parse(seen.find((s) => s.path === "/api/v1/estimate")!.body);
    expect(body).toEqual({ endpoint: ENDPOINT, params: { batch_size: 4 } });
  });
});

describe("[OF-0827] models", () => {
  it("lists the catalog and gets one endpoint", async () => {
    const list = await run(["models", "--json"]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout).models[0].id).toBe(ENDPOINT);

    const get = await run(["models", "get", ENDPOINT, "--json"]);
    expect(get.code).toBe(0);
    const m = JSON.parse(get.stdout);
    expect(m.id).toBe(ENDPOINT);
    expect(m.license.class).toBe("open");
    expect(m.estimate.credits).toBe(0.08);

    const missing = await run(["models", "get", "motionfield/none/nope"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("not_found");
  });
});

describe("[OF-0829] upload", () => {
  it("posts the file as multipart and prints the url", async () => {
    const f = join(workDir, "in.mp4");
    writeFileSync(f, "MP4BYTES");
    const r = await run(["upload", f, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).url).toBe("/files/uploads/up.png");
    const up = seen.find((s) => s.path === "/api/v1/uploads" && s.method === "POST");
    expect(up).toBeTruthy();
    expect(up!.body).toContain("in.mp4");
    expect(up!.body).toContain("MP4BYTES");
  });
});

describe("[OF-0822] status / wait / list / cancel", () => {
  it("status with no id reads /api/v1/system; --json prints queue/gpu/tier/disk", async () => {
    const r = await run(["status", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      queue: { queued: 2, in_progress: 1 },
      gpu: { busy: true }, tier: "local", disk: { free_gb: 128.4 },
    });
  });

  it("status <id>, wait, list and cancel each hit their real endpoint", async () => {
    const st = await run(["status", "11111111-1111-4111-8111-111111111111", "--json"]);
    expect(st.code).toBe(0);
    expect(JSON.parse(st.stdout).id).toBe("11111111-1111-4111-8111-111111111111");

    polls = 0;
    const w = await run(["wait", "11111111-1111-4111-8111-111111111111", "--interval", "0.05", "--json"]);
    expect(w.code).toBe(0);
    expect(JSON.parse(w.stdout).status).toBe("completed");

    const l = await run(["list", "--status", "completed", "--limit", "10", "--json"]);
    expect(l.code).toBe(0);
    const page = JSON.parse(l.stdout);
    expect(page.jobs).toHaveLength(2);
    const listCall = seen.find((s) => s.method === "GET" && s.path.startsWith("/api/v1/jobs?"));
    expect(listCall!.path).toContain("status=completed");
    expect(listCall!.path).toContain("limit=10");

    const c = await run(["cancel", "11111111-1111-4111-8111-111111111111", "--json"]);
    expect(c.code).toBe(0);
    expect(JSON.parse(c.stdout).status).toBe("canceled");
  });
});

describe("[OF-0826] skills", () => {
  it("list shows slugs; get returns the generated SKILL.md; --file writes it", async () => {
    const list = await run(["skills", "list", "--json"]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout).skills[0].slug).toBe("narrated-explainer");

    const get = await run(["skills", "get", "narrated-explainer"]);
    expect(get.code).toBe(0);
    expect(get.stdout).toContain("name: Narrated Explainer");

    const target = join(workDir, "SKILL.md");
    const wf = await run(["skills", "get", "narrated-explainer", "--file", target]);
    expect(wf.code).toBe(0);
    expect(readFileSync(target, "utf8")).toContain("# Narrated Explainer");
  });

  it("capability-gated groups exit 2 with 'not available yet'", async () => {
    for (const args of [
      ["skills", "import", "./some-folder"],
      ["runs", "create"], ["runs", "get", "r1"], ["runs", "approve", "r1"],
      ["runs", "edit", "r1"], ["runs", "control", "r1"],
      ["stage"], ["ads"], ["sites"],
    ]) {
      const r = await run(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr, args.join(" ")).toContain("not available yet");
    }
  });
});

describe("[OF-0821] the API key never reaches a stream", () => {
  it("of_<id>_<secret> material is masked on every error path", async () => {
    const cases: { args: string[]; code: number; masked: boolean }[] = [
      // the key as a positional → parseArgs echoes the argv back
      { args: ["login", "--url", base, API_KEY], code: 2, masked: true },
      // the key as the command → "unknown command" echoes the argv back
      { args: [API_KEY], code: 2, masked: true },
      // unknown flag after a valid --key - nothing may echo it either
      { args: ["login", "--url", base, "--key", API_KEY, "--bogus"], code: 2, masked: false },
      // a rejected key → the 401 API-error path (exit 1)
      { args: ["login", "--url", base, "--key", "of_bad_DEADSECRETbaddeadbeef"], code: 1, masked: false },
    ];
    for (const c of cases) {
      const r = await run(c.args, { envAuth: false });
      expect(r.code, `${c.args.join(" ")} → ${r.stderr}`).toBe(c.code);
      expect(r.stdout + r.stderr, c.args.join(" ")).not.toContain("TESTSECRET");
      expect(r.stdout + r.stderr, c.args.join(" ")).not.toContain("DEADSECRET");
      if (c.masked) expect(r.stderr, c.args.join(" ")).toContain("of_***");
    }
  });
});
