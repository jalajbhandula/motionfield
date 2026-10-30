/* motionfield subcommands. Every command talks to the v1 API through the TS SDK
 * - no fetch, no bespoke HTTP, no invented data. */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
  MotionField, MotionFieldError,
  type Job,
} from "../../sdk-ts/src/index.ts";
import { clearConfig, loadConfig, resolveAuth, saveConfig, configPath, DEFAULT_URL } from "./config.mts";
import {
  ExitError, UsageError, UUID_RE, assertUuid, extForMime, jobIdArg, kvParam, mimeForFilename, note, out, usage,
  type Ctx,
} from "./util.mts";

type Parsed = { values: Record<string, unknown>; positionals: string[] };
type Options = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

function parse(args: string[], options: Options, allowPositionals = true): Parsed {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals }) as unknown as Parsed;
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

const client = () => {
  const { url, key } = resolveAuth();
  return new MotionField({ baseUrl: url, apiKey: key, source: "cli" });
};

/** `-f name=path` - the right side is a literal path, never JSON-coerced. */
function kvPath(spec: string): [string, string] {
  const eq = spec.indexOf("=");
  if (eq <= 0) usage(`-f expects name=path, got "${spec}"`);
  return [spec.slice(0, eq), spec.slice(eq + 1)];
}

function num(value: unknown, flag: string, dflt: number): number {
  if (value == null) return dflt;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) usage(`${flag} expects a positive number, got "${value}"`);
  return n;
}

/** Capability gate - a group exists only when the server reports it. */
async function gate(c: MotionField, capability: string, group: string): Promise<void> {
  const caps = await c.capabilities();
  if (!caps.includes(capability))
    usage(`motionfield ${group} is not available yet - this server does not report the '${capability}' capability`);
}

/** Shared terminal handling for `generate --wait` and `wait`: print the job,
 *  download outputs when asked, exit 1 on a non-completed terminal state. */
async function finishJob(ctx: Ctx, c: MotionField, job: Job, outDir: string | undefined): Promise<void> {
  if (job.status !== "completed") {
    if (ctx.json) console.log(JSON.stringify(job));
    else note(`job ${job.id} ended ${job.status}${job.error ? `: ${job.error}` : ""}`);
    throw new ExitError(1);
  }
  if (!outDir) {
    out(ctx, job, `completed ${job.id} - ${job.outputs.length} output(s)`);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  assertUuid(job.id);
  const written: string[] = [];
  for (let i = 0; i < job.outputs.length; i++) {
    const { bytes, contentType } = await c.download(job.id, { index: i });
    const ext = extForMime(contentType ?? job.outputs[i].type, job.outputs[i].url);
    const p = join(outDir, `${job.id}-${i}.${ext}`);
    writeFileSync(p, bytes);
    written.push(p);
    note(`wrote ${p}`);
  }
  out(ctx, job, `completed ${job.id} - ${written.length} output(s) → ${outDir}`);
}

/* ------------------------------------------------ auth / identity ------- */

/** loopback hostnames we accept for a plaintext http:// login target. */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\./.test(h);
}

async function cmdLogin(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = parse(args, {
    url: { type: "string" }, key: { type: "string" }, insecure: { type: "boolean", default: false },
  }, false);
  const key = values.key as string | undefined;
  if (!key) usage("login requires --key <of_…>");
  if (!/^of_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/.test(key))
    usage("--key should look like of_<id>_<secret> - copied once from Settings → API keys");
  const url = ((values.url as string | undefined) ?? process.env.MOTIONFIELD_URL ?? DEFAULT_URL)
    .replace(/\/+$/, "");
  // The API key rides a Bearer header on every request - plaintext to a
  // remote host is a leak. http:// is fine for loopback; anything else needs
  // an explicit --insecure.
  let loginProto = "", loginHost = "";
  try { const u = new URL(url); loginProto = u.protocol; loginHost = u.hostname; } catch { usage(`--url "${url}" is not a URL`); }
  if (loginProto === "http:" && !isLoopbackHost(loginHost) && !values.insecure)
    usage(`refusing to send the API key over plaintext http to ${loginHost} - use https or pass --insecure`);
  // verify before persisting: a failed GET /api/v1/me exits 1 and no
  // config.json is written
  await new MotionField({ baseUrl: url, apiKey: key }).me();
  const path = saveConfig({ url, key });
  out(ctx, { url, config: path }, `logged in - credentials saved to ${path}`);
}

async function cmdLogout(ctx: Ctx, args: string[]): Promise<void> {
  parse(args, {}, false);
  const removed = clearConfig();
  out(ctx, { logged_out: removed }, removed ? "logged out" : "not logged in - nothing stored");
}

async function cmdWhoami(ctx: Ctx, args: string[]): Promise<void> {
  parse(args, {}, false);
  const me = await client().me();
  out(ctx, me,
    `${me.email} · plan ${me.plan ?? "none"} · ${me.credits} credits · key "${me.key.label}" (${me.key.id})`);
}

/* ------------------------------------------------ catalog --------------- */

async function cmdModels(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = parse(args, { kind: { type: "string" } });
  const c = client();
  if (positionals[0] === "get") {
    const id = positionals[1];
    if (!id) usage("models get requires an endpoint id");
    const found = (await c.models()).find((m) => m.id === id);
    if (!found) throw new MotionFieldError({ status: 404, code: "not_found", message: `no endpoint "${id}" in the catalog` });
    out(ctx, found, [
      `${found.id} - ${found.label}`,
      `kind: ${found.kind} · tier: ${found.tier} · license: ${found.license.class}` +
        (found.license.components.length ? ` (${found.license.components.map((x) => x.license).join(", ")})` : ""),
      `estimate: ~${found.estimate.credits ?? "?"} credits`,
      `inputs: ${JSON.stringify(found.inputs, null, 2)}`,
    ].join("\n"));
    return;
  }
  if (positionals.length) usage(`unknown models subcommand "${positionals[0]}" - try "models get <endpoint>"`);
  let models = await c.models();
  const kind = values.kind as string | undefined;
  if (kind) models = models.filter((m) => m.kind === kind);
  out(ctx, { models }, models.map((m) =>
    `${m.id.padEnd(52)} ${m.kind.padEnd(10)} ~${m.estimate.credits ?? "?"}cr  ${m.label}`).join("\n"));
}

async function cmdEstimate(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = parse(args, { p: { type: "string", short: "p", multiple: true, default: [] } });
  const endpoint = positionals[0];
  if (!endpoint) usage("estimate requires an endpoint id");
  const params: Record<string, unknown> = {};
  for (const spec of values.p as string[]) { const [k, v] = kvParam(spec); params[k] = v; }
  const est = await client().estimate(endpoint, params);
  out(ctx, est, `~${est.credits ?? "?"} credits ($${est.usd})${est.unlimited ? " · unlimited on your plan" : ""}`);
}

/* ------------------------------------------------ jobs ------------------ */

async function cmdGenerate(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {
    p: { type: "string", short: "p", multiple: true, default: [] },
    f: { type: "string", short: "f", multiple: true, default: [] },
    webhook: { type: "string" },
    "idempotency-key": { type: "string" },
    wait: { type: "boolean", default: false },
    timeout: { type: "string" },
    interval: { type: "string" },
    o: { type: "string", short: "o" },
  });
  const endpoint = positionals[0];
  if (!endpoint) usage("generate requires an endpoint id - see `motionfield models`");
  if (values.o && !values.wait) usage("-o only makes sense with --wait (outputs exist once the job completes)");
  const c = client();
  const params: Record<string, unknown> = {};
  for (const spec of values.p as string[]) { const [k, v] = kvParam(spec); params[k] = v; }
  for (const spec of values.f as string[]) {
    const [name, p] = kvPath(spec);
    note(`uploading ${p}…`);
    const up = await c.upload(readFileSync(p), { filename: basename(p), contentType: mimeForFilename(p) });
    params[name] = up.url;
    note(`  → ${up.url}`);
  }
  const created = await c.submit(endpoint, params, {
    webhookUrl: values.webhook as string | undefined,
    idempotencyKey: values["idempotency-key"] as string | undefined,
  });
  if (!values.wait) {
    out(ctx, created, `submitted ${created.id} (${created.status}) - poll with \`motionfield status ${created.id}\``);
    return;
  }
  note(`waiting for ${created.id}…`);
  const job = await c.wait(created.id, {
    timeoutMs: num(values.timeout, "--timeout", 600) * 1000,
    intervalMs: num(values.interval, "--interval", 3) * 1000,
  });
  await finishJob(ctx, c, job, values.o as string | undefined);
}

async function cmdStatus(ctx: Ctx, args: string[]): Promise<void> {
  const { positionals } = parse(args, {});
  const c = client();
  const id = positionals[0];
  if (!id) {
    const sys = await c.system();
    out(ctx, sys, [
      `queue: ${sys.queue.queued} queued / ${sys.queue.in_progress} in-progress` +
      ` · gpu ${sys.gpu.busy ? "busy" : "idle"} · tier ${sys.tier}` +
      ` · disk ${sys.disk.free_gb == null ? "n/a" : `${sys.disk.free_gb}GB free`}`,
    ].join("\n"));
    return;
  }
  const job = await c.get(jobIdArg(id));
  const outs = job.outputs.length ? ` · ${job.outputs.length} output(s)` : "";
  out(ctx, job, `${job.id}  ${job.status} ${job.progress}%${job.error ? `  ${job.error}` : ""}${outs}`);
}

async function cmdWait(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {
    timeout: { type: "string" },
    interval: { type: "string" },
    o: { type: "string", short: "o" },
  });
  const id = jobIdArg(positionals[0]);
  const c = client();
  note(`waiting for ${id}…`);
  const job = await c.wait(id, {
    timeoutMs: num(values.timeout, "--timeout", 600) * 1000,
    intervalMs: num(values.interval, "--interval", 3) * 1000,
  });
  await finishJob(ctx, c, job, values.o as string | undefined);
}

async function cmdCancel(ctx: Ctx, args: string[]): Promise<void> {
  const { positionals } = parse(args, {});
  const id = jobIdArg(positionals[0]);
  const job = await client().cancel(id);
  out(ctx, job, `${job.id} - ${job.status}`);
}

async function cmdList(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = parse(args, {
    status: { type: "string" },
    limit: { type: "string" },
    before: { type: "string" },
    kind: { type: "string" },
    source: { type: "string" },
  });
  const res = await client().listJobs({
    limit: Math.trunc(num(values.limit, "--limit", 50)),
    status: values.status as Job["status"] | undefined,
    kind: values.kind as string | undefined,
    source: values.source as Job["source"] | undefined,
    before: values.before as string | undefined,
  });
  out(ctx, res, [
    ...res.jobs.map((j) =>
      `${j.id}  ${j.status.padEnd(11)} ${String(j.progress).padStart(3)}%  ${j.created_at}`),
    res.next_cursor ? `next_cursor: ${res.next_cursor}` : "end of list",
  ].join("\n"));
}

async function cmdDownload(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {
    i: { type: "string", short: "i" },
    o: { type: "string", short: "o" },
  });
  const id = jobIdArg(positionals[0]);
  const dest = values.o as string | undefined;
  if (!dest) usage("download requires -o <file|dir>");
  // -i is a zero-based output index - 0 is the first output, so it cannot
  // ride num()'s positive-number check
  const spec = values.i as string | undefined;
  if (spec != null && !/^\d+$/.test(spec))
    usage(`-i expects a non-negative integer, got "${spec}"`);
  const index = spec != null ? Number(spec) : null;

  const c = client();
  const job = await c.get(id);
  if (job.status !== "completed")
    throw new MotionFieldError({ status: 409, code: "not_ready", message: `job ${id} is ${job.status} - results land when it completes` });
  if (!job.outputs.length)
    throw new MotionFieldError({ status: 404, code: "not_found", message: `job ${id} produced no outputs` });

  const isDir = (existsSync(dest) && statSync(dest).isDirectory()) || dest.endsWith("/");
  const written: string[] = [];
  const indices = index != null ? [index] : job.outputs.map((_, i) => i);
  if (indices.length > 1 && !isDir)
    usage(`-o ${dest} must be a directory when saving ${indices.length} outputs`);
  if (index != null && index >= job.outputs.length)
    throw new MotionFieldError({ status: 404, code: "not_found", message: `job ${id} has no output at index ${index}` });
  if (isDir) mkdirSync(dest, { recursive: true });
  // the filename embeds the server-returned id - it must be a UUID before it
  // becomes a path segment (asserted again defensively on the echoed id)
  assertUuid(job.id);
  for (const i of indices) {
    const { bytes, contentType } = await c.download(id, { index: i });
    const ext = extForMime(contentType ?? job.outputs[i].type, job.outputs[i].url);
    const p = isDir ? join(dest, `${id}-${i}.${ext}`) : dest;
    writeFileSync(p, bytes);
    written.push(p);
    note(`wrote ${p} (${bytes.length}B)`);
  }
  out(ctx, { files: written }, written.map((p) => `wrote ${p}`).join("\n"));
}

async function cmdUpload(ctx: Ctx, args: string[]): Promise<void> {
  const { positionals } = parse(args, {});
  const file = positionals[0];
  if (!file) usage("upload requires a file path");
  if (!existsSync(file)) usage(`no such file: ${file}`);
  const up = await client().upload(readFileSync(file), {
    filename: basename(file),
    contentType: mimeForFilename(file),
  });
  out(ctx, up, `uploaded ${file} → ${up.url}`);
}

/* ------------------------------------------------ skills ---------------- */

async function cmdSkills(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = parse(args, { file: { type: "string" } });
  const sub = positionals[0] ?? "list";
  const c = client();
  if (sub === "list") {
    const skills = await c.skills();
    out(ctx, { skills }, skills.map((s) => `${s.slug.padEnd(28)} ${s.name} - ${s.description}`).join("\n"));
    return;
  }
  if (sub === "get") {
    const slug = positionals[1];
    if (!slug) usage("skills get requires a slug - see `motionfield skills list`");
    const detail = await c.skill(slug);
    const file = values.file as string | undefined;
    if (file) {
      writeFileSync(file, detail.skill_md);
      out(ctx, { slug: detail.slug, file }, `wrote ${file}`);
    } else {
      out(ctx, detail, detail.skill_md);
    }
    return;
  }
  if (sub === "import") {
    const folder = positionals[1];
    if (!folder) usage("skills import requires a folder path");
    await gate(c, "skills.import", "skills import");
    usage("motionfield skills import is not implemented yet - the capability exists but the CLI does not support it");
  }
  usage(`unknown skills subcommand "${sub}" - try list, get, import`);
}

/* ------------------------------------------------ runs ------------------ */

const RUN_ACTIONS = ["pause", "resume", "stop"] as const;

function runIdArg(id: string | undefined): string {
  return jobIdArg(id, "a run id");
}

/** One human line for a run - steps rendered compactly when present. */
function runLine(run: import("../../sdk-ts/src/index.ts").Run): string {
  const steps = run.steps.map((s) => `${s.id}:${s.status}${s.error ? `(${s.error})` : ""}`).join(" ");
  const planner = run.planner.fallback_reason ? ` · planner fallback: ${run.planner.fallback_reason}` : "";
  return `${run.id}  ${run.status} · ${run.steps.length} step(s) · ~${run.estimate.credits}cr${planner}` +
    (steps ? `\n  ${steps}` : "");
}

/** `--params` accepts an inline JSON object or `@path` to one. */
function paramsJson(spec: string): Record<string, unknown> {
  const text = spec.startsWith("@") ? readFileSync(spec.slice(1), "utf8") : spec;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { usage(`--params must be a JSON object${spec.startsWith("@") ? ` (${spec.slice(1)} unreadable or bad JSON)` : ""}`); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    usage("--params must be a JSON object");
  return parsed as Record<string, unknown>;
}

async function cmdRuns(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {
    plan: { type: "string" },
    text: { type: "string" },
    planner: { type: "string" },
    skill: { type: "string" },
    brief: { type: "string" },
    a: { type: "string", short: "a", multiple: true, default: [] },
    input: { type: "string", multiple: true, default: [] },
    mode: { type: "string" },
    "ask-first": { type: "boolean", default: false },
    project: { type: "string" },
    rev: { type: "string" },
    title: { type: "string" },
    params: { type: "string" },
    p: { type: "string", short: "p", multiple: true, default: [] },
    "idempotency-key": { type: "string" },
    wait: { type: "boolean", default: false },
    timeout: { type: "string" },
    interval: { type: "string" },
  });
  const verb = positionals[0];
  if (!verb) usage("runs requires one of: create, get, approve, edit, control");
  const c = client();
  await gate(c, "runs", "runs");

  if (verb === "create") {
    const planFile = values.plan as string | undefined;
    const text = values.text as string | undefined;
    const skill = values.skill as string | undefined;
    const forms = [planFile != null, text != null, skill != null].filter(Boolean).length;
    if (forms !== 1) usage("runs create takes exactly one of --plan <file|->, --text <brief> or --skill <slug>");
    const mode = values.mode as string | undefined;
    if (mode != null && mode !== "auto" && mode !== "offline")
      usage(`--mode must be auto or offline, got "${mode}"`);
    const project = values.project as string | undefined;
    if (project != null && !UUID_RE.test(project))
      usage(`--project must be a UUID, got "${project.slice(0, 64)}"`);
    const body: Parameters<typeof c.createRun>[0] = {
      mode: mode as "auto" | "offline" | undefined,
      ask_first: (values["ask-first"] as boolean) || undefined,
      project_id: project,
    };
    if (planFile != null) {
      const raw = planFile === "-" ? readFileSync(0, "utf8") : readFileSync(planFile, "utf8");
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { usage(`--plan ${planFile} is not valid JSON`); }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        usage("--plan must be a JSON plan object: { title?, steps: […] }");
      body.plan = parsed as typeof body.plan;
    } else if (text != null) {
      body.text = text;
      body.planner = values.planner as string | undefined;
    } else {
      const brief = values.brief as string | undefined;
      if (!brief) usage("runs create --skill requires --brief <topic>");
      body.skill = skill;
      body.brief = brief;
      const answers: Record<string, string> = {};
      for (const spec of values.a as string[]) {
        const [k, v] = kvParam(spec, "-a");
        answers[k] = typeof v === "string" ? v : JSON.stringify(v);
      }
      if (Object.keys(answers).length) body.answers = answers;
    }
    // --input <path|/files/url> - local media uploads first, /files/ urls pass
    const inputs: { url: string; mime?: string }[] = [];
    for (const spec of values.input as string[]) {
      if (spec.startsWith("/files/")) {
        inputs.push({ url: spec });
        continue;
      }
      note(`uploading ${spec}…`);
      const mime = mimeForFilename(spec);
      const up = await c.upload(readFileSync(spec), { filename: basename(spec), contentType: mime });
      inputs.push({ url: up.url, mime });
      note(`  → ${up.url}`);
    }
    if (inputs.length) body.inputs = inputs;
    const run = await c.createRun(body, { idempotencyKey: values["idempotency-key"] as string | undefined });
    if (!values.wait) {
      out(ctx, run, `created ${run.id} (${run.status}) - poll with \`motionfield runs get ${run.id}\``);
      return;
    }
    note(`waiting for ${run.id}…`);
    const done = await c.waitRun(run.id, {
      timeoutMs: num(values.timeout, "--timeout", 600) * 1000,
      intervalMs: num(values.interval, "--interval", 3) * 1000,
    });
    out(ctx, done, runLine(done));
    if (done.status !== "done") throw new ExitError(1);
    return;
  }

  if (verb === "get") {
    const run = await c.getRun(runIdArg(positionals[1]));
    out(ctx, run, runLine(run));
    return;
  }

  if (verb === "approve") {
    const run = await c.approveRun(runIdArg(positionals[1]));
    out(ctx, run, runLine(run));
    return;
  }

  if (verb === "control") {
    const id = runIdArg(positionals[1]);
    let action = positionals[2] as (typeof RUN_ACTIONS)[number] | "cancel" | undefined;
    if (action === "cancel") action = "stop";
    if (!action || !(RUN_ACTIONS as readonly string[]).includes(action))
      usage(`runs control requires one of: ${RUN_ACTIONS.join(", ")} (alias: cancel)`);
    const run = await c.controlRun(id, action);
    out(ctx, run, runLine(run));
    return;
  }

  if (verb === "edit") {
    const id = runIdArg(positionals[1]);
    const stepId = positionals[2];
    if (!stepId) usage("runs edit requires a step id (s1, …)");
    const revRaw = values.rev as string | undefined;
    if (revRaw == null || !/^\d+$/.test(revRaw))
      usage("runs edit requires --rev <n> - the step's current revision (see runs get)");
    const title = values.title as string | undefined;
    const params: Record<string, unknown> = {
      ...(values.params ? paramsJson(values.params as string) : {}),
    };
    for (const spec of values.p as string[]) { const [k, v] = kvParam(spec); params[k] = v; }
    if (title == null && !Object.keys(params).length)
      usage("runs edit needs --title and/or params (-p name=value or --params <json|@file>)");
    const run = await c.editStep(id, stepId, {
      rev: Number(revRaw),
      title,
      ...(Object.keys(params).length ? { params } : {}),
    });
    out(ctx, run, runLine(run));
    return;
  }

  usage(`unknown runs subcommand "${verb}" - try create, get, approve, edit, control`);
}

/* ------------------------------------------------ stage ----------------- */

const STAGE_INSPECT_VIEWS = ["meta", "tree", "shots", "physics", "problems"] as const;

function stageIdArg(id: string | undefined): string {
  return jobIdArg(id, "a scene id");
}

function revArg(v: unknown, flag: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) usage(`${flag} expects a revision number ≥ 1, got "${v}"`);
  return n;
}

async function cmdStage(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {
    prompt: { type: "string" },
    empty: { type: "boolean", default: false },
    ref: { type: "string", multiple: true, default: [] },
    duration: { type: "string" },
    aspect: { type: "string" },
    fps: { type: "string" },
    t: { type: "string" },
    view: { type: "string" },
    rev: { type: "string" },
    "base-revision": { type: "string" },
    ops: { type: "string" },
    selection: { type: "string" },
    "idempotency-key": { type: "string" },
  });
  const verb = positionals[0];
  const c = client();
  await gate(c, "stage", "stage");
  if (!verb) usage("stage requires one of: list, create, get, inspect, apply, revisions, restore");

  if (verb === "list") {
    const scenes = await c.stageList();
    out(ctx, { scenes },
      scenes.map((s) => `${s.id}  rev ${s.revision}  ${s.title ?? ""}`.trimEnd()).join("\n") || "no scenes");
    return;
  }
  if (verb === "create") {
    const prompt = values.prompt as string | undefined;
    const empty = values.empty as boolean;
    if (empty === (prompt != null)) usage("stage create takes exactly one of --empty or --prompt <text>");
    const created = await c.stageCreate({
      ...(empty ? { empty: true } : {}),
      ...(prompt != null ? { prompt } : {}),
      ...((values.ref as string[]).length ? { refs: values.ref as string[] } : {}),
      ...(values.duration != null ? { duration: num(values.duration, "--duration", 0) } : {}),
      ...(values.aspect != null ? { aspect: values.aspect as string } : {}),
      ...(values.fps != null ? { fps: num(values.fps, "--fps", 0) } : {}),
    });
    out(ctx, created, `created ${created.id}  rev ${created.revision}`);
    return;
  }
  if (verb === "get") {
    const scene = await c.stageGet(stageIdArg(positionals[1]));
    out(ctx, scene, `${scene.id}  rev ${scene.revision}\n${JSON.stringify(scene.scene, null, 2)}`);
    return;
  }
  if (verb === "inspect") {
    const t = (values.view as string | undefined) ?? (values.t as string | undefined) ?? "tree";
    if (!(STAGE_INSPECT_VIEWS as readonly string[]).includes(t))
      usage(`--view must be one of ${STAGE_INSPECT_VIEWS.join(", ")}`);
    const view = await c.stageInspect(
      stageIdArg(positionals[1]), t,
      values.rev != null ? revArg(values.rev, "--rev") : undefined);
    out(ctx, view, JSON.stringify(view, null, 2));
    return;
  }
  if (verb === "ops")
    usage("`stage ops` was renamed - use `stage apply <id> --base-revision <n> --ops <ops.json|->`");
  if (verb === "apply") {
    const id = stageIdArg(positionals[1]);
    const file = values.ops as string | undefined;
    if (!file) usage("stage apply needs --ops <ops.json|->");
    const base = values["base-revision"] != null ? revArg(values["base-revision"], "--base-revision")
      : usage("stage apply needs --base-revision <n> - the rev you last saw");
    const raw = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { usage(`--ops ${file} is not valid JSON`); }
    const ops = Array.isArray(parsed) ? parsed
      : (parsed !== null && typeof parsed === "object" ? (parsed as { ops?: unknown }).ops : undefined);
    if (!Array.isArray(ops) || ops.length === 0)
      usage("--ops must be a JSON array of ops (or {ops: […]})");
    const res = await c.stageApplyOps(id, {
      baseRevision: base,
      ops: ops as Record<string, unknown>[],
      ...(values.selection != null ? { selection: values.selection as string } : {}),
      ...(values["idempotency-key"] != null ? { idempotencyKey: values["idempotency-key"] as string } : {}),
    });
    out(ctx, res, `applied ${ops.length} op(s) → rev ${res.revision}`);
    return;
  }
  if (verb === "revisions") {
    const revisions = await c.stageRevisions(stageIdArg(positionals[1]));
    out(ctx, { revisions },
      revisions.map((r) => `rev ${r.revision}  ${r.source}  ${r.title ?? ""}  ${r.node_count} node(s)  ${r.created_at}`).join("\n") || "no revisions");
    return;
  }
  if (verb === "restore") {
    const id = stageIdArg(positionals[1]);
    const rev = positionals[2] != null ? revArg(positionals[2], "restore <rev>")
      : usage("stage restore needs <id> <rev>");
    const base = values["base-revision"] != null ? revArg(values["base-revision"], "--base-revision")
      : usage("stage restore needs --base-revision <n> - the rev you last saw");
    const res = await c.stageRestore(id, rev, base);
    out(ctx, res, `restored rev ${rev} → new head rev ${res.revision}`);
    return;
  }
  usage(`unknown stage subcommand "${verb}" - try list, create, get, inspect, apply, revisions, restore`);
}

/* ------------------------------------------------ gated groups ---------- */

const gated = (name: string) => async (_ctx: Ctx, args: string[]): Promise<void> => {
  parse(args, {});
  await gate(client(), name, name);
  usage(`motionfield ${name} is not implemented yet - the capability exists but the CLI does not support it`);
};

/* ------------------------------------------------ table ----------------- */

export const COMMANDS: Record<string, (ctx: Ctx, args: string[]) => Promise<void>> = {
  login: cmdLogin,
  logout: cmdLogout,
  whoami: cmdWhoami,
  models: cmdModels,
  estimate: cmdEstimate,
  generate: cmdGenerate,
  status: cmdStatus,
  wait: cmdWait,
  cancel: cmdCancel,
  list: cmdList,
  download: cmdDownload,
  upload: cmdUpload,
  skills: cmdSkills,
  runs: cmdRuns,
  stage: cmdStage,
  ads: gated("ads"),
  sites: gated("sites"),
};

export const HELP: Record<string, string> = {
  login:
    "motionfield login [--url <url>] --key <of_…> [--insecure]\n" +
    "  verifies the key against /api/v1/me, then stores url+key in <config-dir>/config.json (0600)\n" +
    "  --url falls back to MOTIONFIELD_URL, then " + DEFAULT_URL + "\n" +
    "  http:// is accepted on loopback only - remote http needs --insecure",
  logout: "motionfield logout\n  removes the stored config",
  whoami: "motionfield whoami [--json]\n  GET /api/v1/me - user, plan, credits, key label",
  models: "motionfield models [--kind image|video|audio|…] [--json]\nmotionfield models get <endpoint> [--json]",
  estimate: "motionfield estimate <endpoint> [-p name=value]… [--json]",
  generate:
    "motionfield generate <endpoint> [-p name=value]… [-f name=./path]…\n" +
    "  [--webhook <url>] [--idempotency-key <key>]\n" +
    "  [--wait] [--timeout <sec>=600] [--interval <sec>=3] [-o <dir>] [--json]",
  status: "motionfield status [<job id>] [--json]\n  no id → /api/v1/system; id → job view",
  wait: "motionfield wait <job id> [--timeout <sec>=600] [--interval <sec>=3] [-o <dir>] [--json]",
  cancel: "motionfield cancel <job id> [--json]",
  list: "motionfield list [--status <status>] [--kind <kind>] [--source <src>] [--limit <n>] [--before <cursor>] [--json]",
  download: "motionfield download <job id> [-i <n>] -o <file|dir> [--json]\n  -i is a zero-based output index - 0 is the first output; no -i saves them all",
  upload: "motionfield upload <file> [--json]",
  skills:
    "motionfield skills list [--json]\n" +
    "motionfield skills get <slug> [--file <path>] [--json]\n" +
    "motionfield skills import <folder>   (capability-gated)",
  runs:
    "motionfield runs create (--plan <file|-> | --text <brief> [--planner <pick>] | --skill <slug> --brief <topic> [-a k=v]…)\n" +
    "  [--input <path|/files/url>]… [--mode auto|offline] [--ask-first] [--project <uuid>] [--idempotency-key <key>]\n" +
    "  [--wait] [--timeout <sec>=600] [--interval <sec>=3] [--json]\n" +
    "motionfield runs get <run id> [--json]\n" +
    "motionfield runs approve <run id> [--json]\n" +
    "motionfield runs control <run id> <pause|resume|stop> [--json]   (alias: cancel)\n" +
    "motionfield runs edit <run id> <step id> --rev <n> [--title <t>] [-p name=value]… [--params <json|@file>] [--json]",
  stage:
    "motionfield stage list [--json]\n" +
    "motionfield stage create (--empty | --prompt <text>) [--ref </files/…>]… [--duration <s>] [--aspect <a>] [--fps <n>] [--json]\n" +
    "motionfield stage get <scene id> [--json]\n" +
    "motionfield stage inspect <scene id> [--view meta|tree|shots|physics|problems] [--rev <n>] [--json]\n" +
    "motionfield stage apply <scene id> --base-revision <rev> --ops <ops.json|-> [--selection <node>] [--idempotency-key <k>] [--json]\n" +
    "motionfield stage revisions <scene id> [--json]\n" +
    "motionfield stage restore <scene id> <rev> --base-revision <rev> [--json]",
  ads: "motionfield ads   (capability-gated)",
  sites: "motionfield sites   (capability-gated)",
};

export const GENERAL_HELP = [
  "motionfield - CLI for the MotionField v1 API",
  "",
  "usage: motionfield [--json] <command> [options]",
  "",
  "config:  login · logout · whoami",
  "catalog: models · models get · estimate",
  "jobs:    generate · status · wait · cancel · list · download · upload",
  "skills:  skills list · skills get · skills import",
  "runs:    runs create · runs get · runs approve · runs control · runs edit",
  "stage:   stage list · create · get · inspect · apply · revisions · restore   (needs the 'stage' capability)",
  "gated:   ads · sites   (exit 2 until the API reports them)",
  "",
  "global:  --json (machine output only on stdout) · --help · --version",
  "env:     MOTIONFIELD_URL · MOTIONFIELD_API_KEY · MOTIONFIELD_CONFIG_DIR",
  "exit:    0 ok · 1 API error / failed wait · 2 usage or capability gate",
].join("\n");

/* re-export for main.mts */
export { loadConfig, configPath, UsageError, ExitError };
