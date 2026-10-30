/**
 * mcp-check.ts — execute the profile's MCP tool_sequence for real over
 * stdio: run_create (literal 2-step plan, ask_first) → run_get → run_approve
 * → run_edit_step → re-approve → run_get to done. Asserts the edit re-ran
 * only shot 2 (s1 keeps its job), and that the edit landed a revision row
 * (the run's audit trail) via the session-authed /api/agent/runs/:id view.
 *
 * Writes `<out>/mcp-check.json` (redacted). The API key only ever travels in
 * the child env — never argv, never this file's output.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { DemoProfile } from "./profile-guard";
import { REPO, parseArgs, redactedStringify, resolveDemoOutDir } from "./util";
import { sessionGet } from "./capture";

const IMAGE_EP = "motionfield/z-image-turbo/text-to-image";
const I2V_EP = "motionfield/wan-vace/image-to-video";

export interface McpCheckResult {
  ok: boolean;
  tool_sequence: string[];
  run_id: string;
  plan_steps: number;
  s1_reused: boolean;       // s1 kept its original job after s2's edit
  s2_reran: boolean;        // s2 minted a second job
  s2_revision: boolean;     // the edit left an audit row
  log: string[];
  error?: string;
}

/** npm-link the CLI + MCP bins into <out>/prefix — the same install path a
 *  user runs, never the sources. */
export function installPrefix(prefixDir: string): string {
  fs.mkdirSync(prefixDir, { recursive: true });
  execFileSync(path.join(REPO, "scripts", "install-cli.sh"), [], {
    env: { ...process.env, PREFIX: prefixDir }, stdio: "pipe", timeout: 120_000,
  });
  const mcpBin = path.join(prefixDir, "bin", "motionfield-mcp");
  if (!fs.existsSync(mcpBin)) throw new Error(`install-cli.sh did not produce ${mcpBin}`);
  return mcpBin;
}

async function poll(client: Client, id: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const res = await client.callTool({ name: "run_get", arguments: { id } });
    const text = (res.content as { type: string; text?: string }[] | undefined)?.[0]?.text ?? "{}";
    const data = JSON.parse(text) as Record<string, unknown>;
    if (["done", "failed", "stopped", "canceled"].includes(String(data.status))) return data;
    if (Date.now() > end) throw new Error(`run ${id} did not settle inside ${timeoutMs}ms (status ${String(data.status)})`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as { type: string; text?: string }[] | undefined;
  const text = content?.[0]?.text ?? "";
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON payload stays raw */ }
  if (res.isError === true) throw new Error(`${name} → ${String(data.error ?? data.code ?? text).slice(0, 200)}`);
  return data;
}

export async function runMcpCheck(opts: {
  base: string;
  apiKey: string;
  out: string;
  profile: DemoProfile;
  storageState: unknown;
  prefixDir?: string;
}): Promise<McpCheckResult> {
  const log: string[] = [];
  const outDir = opts.out;
  fs.mkdirSync(outDir, { recursive: true });
  const prefixDir = opts.prefixDir ?? path.join(outDir, "prefix");
  const mcpBin = installPrefix(prefixDir);
  log.push(`installed motionfield-mcp at ${mcpBin}`);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.MOTIONFIELD_URL = opts.base;
  env.MOTIONFIELD_API_KEY = opts.apiKey;            // env only — never argv/disk
  env.MOTIONFIELD_MCP_OUT_DIR = path.join(outDir, "mcp-out");

  const stderrChunks: Buffer[] = [];
  const transport = new StdioClientTransport({ command: mcpBin, env, stderr: "pipe" });
  transport.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));
  const client = new Client({ name: "motionfield-demo-dry", version: "0" });
  const result: McpCheckResult = {
    ok: false, tool_sequence: [...opts.profile.mcp.tool_sequence],
    run_id: "", plan_steps: 0, s1_reused: false, s2_reran: false, s2_revision: false, log,
  };
  try {
    await client.connect(transport);

    const listed = await client.listTools();
    const names = new Set(listed.tools.map((t) => t.name));
    for (const t of opts.profile.mcp.tool_sequence)
      if (!names.has(t)) throw new Error(`profile tool ${t} is not advertised by tools/list`);
    log.push(`tools/list: ${names.size} tools advertised; sequence ${opts.profile.mcp.tool_sequence.join(" → ")} all present`);

    const made = await call(client, "run_create", {
      plan: {
        title: "demo mcp-check",
        steps: [
          { id: "s1", title: "shot 1 — still", endpoint_id: IMAGE_EP, params: { prompt: "a red kite over golden dunes, cinematic" }, depends_on: [] },
          { id: "s2", title: "shot 2 — animate", endpoint_id: I2V_EP, params: { prompt: "the kite wheeling", image_url: "$step:s1.outputs[0]" }, depends_on: ["s1"] },
        ],
      },
      ask_first: true,
    });
    const id = String(made.id);
    result.run_id = id;
    result.plan_steps = (made.steps as unknown[]).length;
    if (made.status !== "awaiting_approval") throw new Error(`run created at ${made.status}, expected awaiting_approval`);
    log.push(`run_create → ${id} awaiting_approval (${result.plan_steps} steps)`);

    await call(client, "run_approve", { id });
    log.push("run_approve → running");
    const first = await poll(client, id, 300_000);
    const steps1 = first.steps as { id: string; status: string; job_id: string | null; rev: number }[];
    const s1 = steps1.find((s) => s.id === "s1");
    const s2 = steps1.find((s) => s.id === "s2");
    if (!s1?.job_id || !s2?.job_id || s1.status !== "done" || s2.status !== "done")
      throw new Error(`first pass did not finish both steps: ${JSON.stringify(steps1.map((s) => [s.id, s.status]))}`);
    log.push(`run_get → done (s1 ${s1.job_id!.slice(0, 8)}…, s2 ${s2.job_id!.slice(0, 8)}…)`);

    // run-create idempotency on the v1 API the MCP tools wrap: same key +
    // same body replays the run; same key + different body refuses 422
    const idemKey = `demo-dry-${Date.now()}`;
    const plan = { title: "idem", steps: [{ id: "s1", title: "x", endpoint_id: IMAGE_EP, params: { prompt: "idem check" } }] };
    const planBody = JSON.stringify({ plan, ask_first: true });
    const planBody2 = JSON.stringify({ plan: { ...plan, title: "idem-different" }, ask_first: true });
    const apiFetch = (key: string, body: string) => fetch(`${opts.base}/api/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json", "idempotency-key": key },
      body,
    });
    const r1 = await apiFetch(idemKey, planBody);
    const j1 = (await r1.json()) as { run?: { id?: string }; id?: string; error?: { code?: string } };
    const runId1 = j1.run?.id ?? j1.id;
    if (!r1.ok || !runId1) throw new Error(`v1 run_create under idem key failed: ${r1.status}`);
    const r2 = await apiFetch(idemKey, planBody);
    const j2 = (await r2.json()) as { run?: { id?: string }; id?: string };
    const runId2 = j2.run?.id ?? j2.id;
    if (!r2.ok || runId2 !== runId1) throw new Error(`idempotent replay minted a different run (${String(runId2)} ≠ ${runId1})`);
    const r3 = await apiFetch(idemKey, planBody2);
    const j3 = (await r3.json()) as { error?: { code?: string } };
    if (r3.status !== 422 || j3.error?.code !== "idempotency_mismatch")
      throw new Error(`idempotency mismatch did not refuse 422 (got ${r3.status})`);
    log.push(`idempotency: replay → same run ${runId1.slice(0, 8)}…; different body under the key → 422 idempotency_mismatch`);

    // edit s2 → the run re-gates (ask_first) → approve → only s2 re-runs
    const edited = await call(client, "run_edit_step", {
      id, step_id: "s2", rev: s2.rev,
      params: { prompt: "the kite wheeling low over the dunes, golden hour" },
    });
    const edStatus = String((edited as { status?: string }).status);
    log.push(`run_edit_step s2 → status ${edStatus}`);
    if (edStatus === "awaiting_approval") {
      await call(client, "run_approve", { id });
      log.push("run_approve → running (edited delta)");
    }
    const second = await poll(client, id, 300_000);
    const steps2 = second.steps as { id: string; status: string; job_id: string | null }[];
    const s1b = steps2.find((s) => s.id === "s1");
    const s2b = steps2.find((s) => s.id === "s2");
    result.s1_reused = s1b?.job_id === s1.job_id && s1b?.status === "done";
    result.s2_reran = !!s2b && s2b.job_id !== s2.job_id && s2b.status === "done";
    if (!result.s1_reused) throw new Error("s1 was not reused — the edit re-ran more than shot 2");
    if (!result.s2_reran) throw new Error("s2 did not re-run after the edit");
    log.push("run_get → done; s1 kept its job, s2 minted a fresh one");

    // the edit's audit trail — run_step_revisions rows surface on the
    // session run view (the page's "earlier versions")
    const view = await sessionGet(opts.base, opts.storageState, `/api/agent/runs/${id}`) as {
      run?: { steps?: { step_id: string; revisions: unknown[] }[] };
    };
    const revRows = view.run?.steps?.find((s) => s.step_id === "s2")?.revisions?.length ?? 0;
    result.s2_revision = revRows >= 1;
    if (!result.s2_revision) throw new Error("run_edit_step left no run_step_revisions row for s2");
    log.push(`agent run view → s2 carries ${revRows} revision row(s)`);

    result.ok = true;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  } finally {
    await client.close().catch(() => {});
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    if (stderr.trim()) log.push(`mcp stderr (tail): ${stderr.trim().slice(-400)}`);
  }
  fs.writeFileSync(path.join(outDir, "mcp-check.json"), redactedStringify(result));
  return result;
}

/* -------------------------------- CLI ---------------------------------- */

const isMain = !!process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/demo/mcp-check.ts");
if (isMain) {
  void (async () => {
    const { opts } = parseArgs(process.argv.slice(2));
    const out = resolveDemoOutDir(String(opts.out ?? "/tmp/of-demo-dev"));
    const base = String(opts.base ?? "http://localhost:3110");
    const apiKey = String(opts.key ?? process.env.MOTIONFIELD_API_KEY ?? "");
    const { loadProfile } = await import("./profile-guard");
    const profile = loadProfile();
    // a standalone run provisions its own user just for the session view
    const { provisionUser } = await import("./capture");
    const sess = await provisionUser(base);
    const res = await runMcpCheck({ base, apiKey: apiKey || sess.apiKey, out, profile, storageState: sess.storageState });
    console.log(redactedStringify(res));
    if (!res.ok) process.exit(1);
  })().catch((e) => { console.error(`mcp-check: ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
