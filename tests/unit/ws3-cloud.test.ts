/**
 * scripts/runpod - the cloud weight manifest + setup.sh dry-run contract:
 *  - every manifest entry carries name/repo/path/target/bytes/sha256/licence/
 *    class/tier/optional/used_by; sha256 is 64-hex; class equals
 *    licenseClassForSpdx(license); repos are official or Comfy-Org repacks
 *  - `setup.sh --dry-run` prints sha256 + licence per file and downloads
 *    nothing (a CURL override records any fetch attempt)
 *  - the NC fixture manifest is refused (exit non-zero, names the entries)
 *  - HF_TOKEN never reaches stdout/stderr
 *  - ComfyUI is checked out BEFORE the weights land in its models/ dir - a
 *    pre-filled $COMFY_HOME without .git is adopted (init+fetch+checkout -f)
 *  - a missing tool (uv, rsync, git, python3, curl) exits 5 naming it before
 *    the first fetch
 *  - start.sh resolves PROXY_BIN, passes --token "$COMFY_API_KEY" when set,
 *    and never prints the key
 *  - watchdog.sh --dry-run prints a decision and exits 0; a setup lock whose
 *    pid is gone is stale and ignored
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "fs";
import os from "os";
import path from "path";

import { licenseClassForSpdx } from "@/lib/catalog/licenses";
import { LICENSE_CLASS_ORDER } from "@/lib/catalog/types";
import type { LicenseClass } from "@/lib/catalog/types";

const ROOT = process.cwd();
const SETUP = path.join(ROOT, "scripts/runpod/setup.sh");
const START = path.join(ROOT, "scripts/runpod/start.sh");
const WATCHDOG = path.join(ROOT, "scripts/runpod/watchdog.sh");
const MANIFEST = path.join(ROOT, "scripts/runpod/models.cloud.json");
const NC_MANIFEST = path.join(ROOT, "tests/fixtures/ws3-cloud-nc.json");

interface CloudEntry {
  name: string; repo: string; path: string; target: string;
  bytes: number; sha256: string; license: string; license_url: string;
  class: LicenseClass; tier: string; optional?: boolean; used_by: string[];
  pack?: string;
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { models: CloudEntry[] };

// every mkdtemp dir registers here and is removed after the suite - the
// tests used to leak a handful of fixture dirs per run under $TMPDIR
const TMP_DIRS: string[] = [];
const tmpdir = async (prefix: string) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
};
afterAll(() => Promise.all(TMP_DIRS.map((d) => fs.rm(d, { recursive: true, force: true }))));

/* repos must be official sources or Comfy-Org repacks - no mirrors/Kijai */
const OFFICIAL_ORGS = new Set([
  "Comfy-Org", "Wan-AI", "alibaba-pai", "Lightricks", "Qwen", "google",
  "ewrfcas", "JunhaoZhuang", "meituan-longcat", "openai",
  "ByteDance-Seed", "HiDream-ai", "VAST-AI", "microsoft",
  "huawei-bayerlab", "facebook",
  "yzd-v",        // canonical HF home of the DWPose ONNX exports (IDEA-Research)
  "TMElyralab",   // MuseTalk authors
  "ResembleAI",   // Chatterbox authors - the weights the pack itself pulls
  "stabilityai",  // sd-vae-ft-mse upstream
  "xinntao",      // Real-ESRGAN author (GitHub release asset via "url")
  "taylorchu",    // kokoro-onnx author - the onnx export the node itself fetches
  "ggerganov",    // whisper.cpp author - canonical ggml-* model host
]);

function setup(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync("bash", [SETUP, ...args], {
    encoding: "utf8", cwd: ROOT, env: { ...process.env, ...env }, timeout: 60_000,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

describe("ws3 cloud manifest", () => {
  it("every entry is fully specified - sha256, bytes, licence, class, tier, used_by", () => {
    expect(manifest.models.length).toBeGreaterThanOrEqual(30);
    for (const e of manifest.models) {
      for (const k of ["name", "repo", "path", "target", "license", "license_url", "class", "tier"] as const)
        expect(e[k], `${e.name}: missing ${k}`).toBeTruthy();
      expect(e.bytes, e.name).toBeGreaterThan(0);
      if (e.sha256 === "pending") {
        // gated upstream - sha256 is only resolvable via authenticated
        // paths-info; fill-hashes.py fills it, setup.sh refuses download while pending
        expect(e.repo, e.name).toMatch(/^(Lightricks\/|facebook\/sam3)/);
      } else {
        expect(e.sha256, e.name).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(["open", "permissive-terms", "restricted"], e.name).toContain(e.class);
      expect(Array.isArray(e.used_by) && e.used_by.length > 0, e.name).toBe(true);
      const want = licenseClassForSpdx(e.license).class;
      if (want === "refused") expect.unreachable(`${e.name}: licence '${e.license}' is refused`);
      if (e.class !== want) {
        // stricter than the licence id is allowed only for a named pack
        // (trellis2's MIT DiT runs restricted beside its bundled DINOv3 clip)
        expect(e.pack, `${e.name}: class '${e.class}' stricter than licence class '${want}' needs a pack`).toBeTruthy();
        expect(LICENSE_CLASS_ORDER[e.class], `${e.name}: class '${e.class}' weaker than licence class '${want}'`)
          .toBeGreaterThan(LICENSE_CLASS_ORDER[want as LicenseClass]);
      }
      expect(OFFICIAL_ORGS.has(e.repo.split("/")[0]), `${e.name}: repo ${e.repo} is not an official/Comfy-Org source`).toBe(true);
      expect(e.repo).not.toMatch(/kijai/i);
      // name/path must be collision-free within the same target dir
    }
    const seen = new Map<string, string>();
    for (const e of manifest.models) {
      const key = `${e.target}/${e.name}`;
      expect(seen.has(key), `duplicate target+name ${key}`).toBe(false);
      seen.set(key, e.repo);
    }
  });

  it("tier A default dry-run prints sha256 + licence per file and downloads nothing", async () => {
    // CURL override: a sentinel binary that only records invocations - if
    // setup.sh ever calls it during a dry run, the log file proves a fetch
    // was attempted.
    const dir = await tmpdir("of-curl-");
    const log = path.join(dir, "calls.log");
    const fake = path.join(dir, "curl");
    await fs.writeFile(fake, `#!/bin/bash\necho "$@" >> "${log}"\nexit 0\n`);
    await fs.chmod(fake, 0o755);

    const r = setup(["--dry-run", "--download-only", "--tier", "A,B,C,3d", "--with-restricted", "--with-optional"], { CURL: fake });
    expect(r.code, r.out.slice(-1500)).toBe(0);
    expect(r.out).toMatch(/plan/);
    // one line per file: tier, name, bytes, sha256, licence, class, target
    expect(r.out).toContain("wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors");
    expect(r.out).toContain("6122e79d55e0f235698d11d657f3b196c5273c830da00b2b013c5a048d5e6a42");
    expect(r.out).toContain("apache-2.0");
    expect(r.out).toContain("ltx-2.x-community");
    expect(r.out).toContain("ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors");
    expect(r.out).toContain("dinov3");
    expect(await fs.stat(log).catch(() => null)).toBeNull();
  });

  it("restricted entries are skipped unless --with-restricted, and say so", () => {
    const bare = setup(["--dry-run", "--tier", "A"]);
    expect(bare.code).toBe(0);
    // not in the plan lines (the skip note may still name the file)
    expect(bare.out).not.toMatch(/^\s+A\s+ltx-2\.5-22b-distilled-transformer-comfy-int8-convrot\.safetensors\s+\d/m);
    expect(bare.out).toMatch(/restricted.*--with-restricted/i);
    expect(bare.out).toMatch(/Settings -> Licenses/);
    const opted = setup(["--dry-run", "--tier", "A", "--with-restricted"]);
    expect(opted.out).toMatch(/^\s+A\s+ltx-2\.5-22b-distilled-transformer-comfy-int8-convrot\.safetensors\s+21504034224/m);
  });

  it("optional entries only appear with --with-optional", () => {
    const bare = setup(["--dry-run", "--tier", "A"]);
    expect(bare.out).not.toContain("wan2.1_fun_camera_v1.1_1.3B_bf16");
    const opted = setup(["--dry-run", "--tier", "A", "--with-optional"]);
    expect(opted.out).toContain("wan2.1_fun_camera_v1.1_1.3B_bf16.safetensors");
  });

  it("the non-canonical manifest is refused with exit 3, naming every offender", () => {
    const r = setup(["--dry-run", "--manifest", NC_MANIFEST]);
    expect(r.code, r.out).toBe(3);
    for (const name of [
      "nc_contaminated.safetensors",          // cc-by-nc licence, class open
      "unlicensed_class_other.safetensors",   // class 'other' may not ship
      "cc_nc_upper.safetensors",              // uppercase CC-BY-NC-4.0
      "bria-rmbg-2.0.safetensors",            // banned name/repo pattern
      "kijai_short_sha.safetensors",          // Kijai repo + sha 'dd' + target '../..'
      "hunyuan_community.safetensors",        // hunyuan/tencent licence refused before the community rule
    ]) expect(r.out, name).toContain(name);
  });

  it("HF_TOKEN is never printed", () => {
    const r = setup(["--dry-run", "--tier", "A,B,C,3d", "--with-restricted", "--with-optional"], { HF_TOKEN: "sekrit-test-value" });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("sekrit");
  });

  it("tier 3d on a dry run reports the 3d plan", () => {
    const r = setup(["--dry-run", "--tier", "3d"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/tier 3d/i);
  });

  it("--download-only adopts a pre-filled $COMFY_HOME: ComfyUI checkout lands before weights, existing models/ survive", async () => {
    const dir = await tmpdir("of-setup-");
    const comfy = path.join(dir, "ComfyUI");
    // the bug this guards: weights already inside $COMFY_HOME/models before
    // any checkout - `git clone` would refuse the non-empty dir.
    await fs.mkdir(path.join(comfy, "models", "vae"), { recursive: true });
    await fs.writeFile(path.join(comfy, "models", "vae", "x.safetensors"), "weights");

    // a local repo stands in for COMFYUI_REPO; COMFYUI_REF=HEAD fetches it
    const repo = path.join(dir, "comfy-src");
    spawnSync("git", ["init", "-q", repo]);
    await fs.writeFile(path.join(repo, "main.py"), "# comfy\n");
    spawnSync("git", ["-C", repo, "add", "-A"]);
    spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

    // one manifest weight whose bytes we control, so the sha256 verifies
    const payload = path.join(dir, "payload.bin");
    await fs.writeFile(payload, "fake weights");
    const sha = createHash("sha256").update(readFileSync(payload)).digest("hex");
    const man = path.join(dir, "manifest.json");
    await fs.writeFile(man, JSON.stringify({
      base_url: "https://huggingface.co/{repo}/resolve/main/{path}",
      models: [{
        tier: "A", name: "y.safetensors", repo: "Comfy-Org/test",
        path: "y.safetensors", target: "checkpoints",
        bytes: Buffer.byteLength("fake weights"), sha256: sha,
        license: "apache-2.0", license_url: "https://huggingface.co/Comfy-Org/test",
        class: "open", used_by: ["test"],
      }],
    }));

    // curl stub: records the call, writes our payload to the -o destination
    const calls = path.join(dir, "curl-calls.log");
    const stub = path.join(dir, "curl");
    await fs.writeFile(stub, [
      "#!/bin/bash",
      `echo "called" >> "${calls}"`,
      'out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done',
      `[ -n "$out" ] && cp "${payload}" "$out"`,
      "exit 0",
    ].join("\n"));
    await fs.chmod(stub, 0o755);

    const r = setup(["--download-only", "--manifest", man], {
      COMFY_HOME: comfy, COMFYUI_REPO: repo, COMFYUI_REF: "HEAD",
      CURL: stub, SETUP_LOCK: path.join(dir, "of-setup.lock"),
    });
    expect(r.code, r.out.slice(-2000)).toBe(0);
    expect(await fs.stat(path.join(comfy, ".git")).then(() => true).catch(() => false),
      "checkout must exist before downloads").toBe(true);
    expect(readFileSync(path.join(comfy, "models", "vae", "x.safetensors"), "utf8")).toBe("weights");
    expect(readFileSync(path.join(comfy, "models", "checkpoints", "y.safetensors"), "utf8")).toBe("fake weights");
    expect(readFileSync(path.join(comfy, "main.py"), "utf8")).toBe("# comfy\n");
  });

  it("a still-pending sha256 is skipped, never fetched - the run reaches the install and exits 0", async () => {
    const dir = await tmpdir("of-pending-");
    const comfy = path.join(dir, "ComfyUI");

    const repo = path.join(dir, "comfy-src");
    spawnSync("git", ["init", "-q", repo]);
    await fs.writeFile(path.join(repo, "main.py"), "# comfy\n");
    spawnSync("git", ["-C", repo, "add", "-A"]);
    spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

    const payload = path.join(dir, "payload.bin");
    await fs.writeFile(payload, "fake weights");
    const sha = createHash("sha256").update(readFileSync(payload)).digest("hex");
    const man = path.join(dir, "manifest.json");
    await fs.writeFile(man, JSON.stringify({
      base_url: "https://huggingface.co/{repo}/resolve/main/{path}",
      models: [
        {
          tier: "A", name: "y.safetensors", repo: "Comfy-Org/test",
          path: "y.safetensors", target: "checkpoints",
          bytes: Buffer.byteLength("fake weights"), sha256: sha,
          license: "apache-2.0", license_url: "https://huggingface.co/Comfy-Org/test",
          class: "open", used_by: ["test"],
        },
        {
          tier: "A", name: "gated.safetensors", repo: "facebook/sam3.1",
          path: "gated.safetensors", target: "sam3",
          bytes: 1234, sha256: "pending",
          license: "sam-license", license_url: "https://huggingface.co/facebook/sam3.1",
          class: "restricted", used_by: ["test"],
        },
      ],
    }));

    const calls = path.join(dir, "curl-calls.log");
    const stub = path.join(dir, "curl");
    await fs.writeFile(stub, [
      "#!/bin/bash",
      `echo "$@" >> "${calls}"`,
      'out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done',
      `[ -n "$out" ] && cp "${payload}" "$out"`,
      "exit 0",
    ].join("\n"));
    await fs.chmod(stub, 0o755);

    const r = setup(["--download-only", "--with-restricted", "--manifest", man], {
      COMFY_HOME: comfy, COMFYUI_REPO: repo, COMFYUI_REF: "HEAD",
      CURL: stub, SETUP_LOCK: path.join(dir, "of-setup.lock"), HF_TOKEN: "",
    });
    // a selected gated entry with sha256 still pending fails the run with a
    // clear HF_TOKEN/licence message - a silent skip would ship a broken pod
    expect(r.code, r.out.slice(-2000)).toBe(3);
    expect(r.out).toContain("gated.safetensors");
    expect(r.out).toMatch(/HF_TOKEN is not set|gated weights/i);
    // nothing is handed to curl - the run refuses before any fetch
    expect(await fs.stat(calls).catch(() => null)).toBeNull();
    expect(await fs.stat(path.join(comfy, "models", "checkpoints", "y.safetensors")).catch(() => null)).toBeNull();
  });

  it("a missing tool exits 5 naming it before the first fetch (PATH without uv)", async () => {
    const dir = await tmpdir("of-nopath-");
    // minimal PATH: everything the script needs to reach the preflight,
    // resolved to real binaries - minus uv (and minus rsync-adjacent gaps)
    const bindir = path.join(dir, "bin");
    await fs.mkdir(bindir);
    for (const t of ["bash", "dirname", "sed", "python3", "git", "rsync", "cat", "ls", "mkdir", "stat", "cut", "shasum", "cp", "sleep", "date", "curl"]) {
      const real = spawnSync("/usr/bin/env", ["bash", "-lc", `command -v ${t}`], { encoding: "utf8" });
      const p = real.stdout.trim();
      if (p) await fs.symlink(p, path.join(bindir, t));
    }
    const calls = path.join(dir, "curl-calls.log");
    const stub = path.join(dir, "curl-stub");
    await fs.writeFile(stub, `#!/bin/bash\necho called >> "${calls}"\n`);
    await fs.chmod(stub, 0o755);

    const r = setup(["--tier", "A"], {
      PATH: bindir, CURL: stub, SETUP_LOCK: path.join(dir, "of-setup.lock"),
      COMFY_HOME: path.join(dir, "ComfyUI"),
    });
    expect(r.code, r.out.slice(-1000)).toBe(5);
    expect(r.out).toMatch(/missing required tool: uv/);
    expect(await fs.stat(calls).catch(() => null)).toBeNull();
  });
});

describe("ws3 start.sh", () => {
  const makePod = async () => {
    const dir = await tmpdir("of-start-");
    const log = path.join(dir, "argv.log");
    const proxy = path.join(dir, "proxy-stub");
    // records argv, releases inherited fds, stays alive past the 2s probe
    await fs.writeFile(proxy, `#!/bin/bash\nprintf '%s\\n' "$@" >> "${log}"\nexec sleep 5 </dev/null >/dev/null 2>&1\n`);
    await fs.chmod(proxy, 0o755);
    const venv = path.join(dir, "venv");
    await fs.mkdir(path.join(venv, "bin"), { recursive: true });
    await fs.writeFile(path.join(venv, "bin", "python"), "#!/bin/bash\nexit 0\n");
    await fs.chmod(path.join(venv, "bin", "python"), 0o755);
    const comfy = path.join(dir, "comfy");
    await fs.mkdir(comfy);
    return { dir, log, proxy, venv, comfy };
  };

  const start = (env: Record<string, string>) => {
    const r = spawnSync("bash", [START], {
      encoding: "utf8", cwd: ROOT, env: { ...process.env, ...env }, timeout: 30_000,
    });
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
  };

  it("with COMFY_API_KEY the proxy gets --token <key>, and the key is never printed", async () => {
    const p = await makePod();
    const r = start({
      PROXY_BIN: p.proxy, COMFY_API_KEY: "sekrit", STATE_DIR: path.join(p.dir, "state"),
      COMFY_HOME: p.comfy, VENV: p.venv,
    });
    expect(r.code, r.out).toBe(0);
    const argv = await fs.readFile(p.log, "utf8");
    expect(argv).toMatch(/--token\nsekrit\n/);
    expect(r.out).not.toContain("sekrit");
  }, 60_000);

  it("without COMFY_API_KEY no --token is passed", async () => {
    const p = await makePod();
    const r = start({
      PROXY_BIN: p.proxy, STATE_DIR: path.join(p.dir, "state"),
      COMFY_HOME: p.comfy, VENV: p.venv, COMFY_API_KEY: "",
    });
    expect(r.code, r.out).toBe(0);
    expect(await fs.readFile(p.log, "utf8")).not.toContain("--token");
  }, 60_000);

  it("a missing proxy binary exits 1 with a clear message", async () => {
    const p = await makePod();
    const r = start({
      PROXY_BIN: path.join(p.dir, "no-such-bin"), STATE_DIR: path.join(p.dir, "state"),
      COMFY_HOME: p.comfy, VENV: p.venv,
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/comfy-api-proxy not found/);
    expect(r.out).toMatch(/PROXY_BIN/);
  }, 60_000);
});

describe("ws3 watchdog", () => {
  it("--dry-run unreachable: reports the idle-after-limit rule and exits 0", () => {
    const r = spawnSync("bash", [WATCHDOG, "--dry-run"], {
      encoding: "utf8", cwd: ROOT,
      env: { ...process.env, QUEUE_URL: "http://127.0.0.1:1/queue", CURL: "curl" },
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/unreachable/i);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/idle/);
  });

  it("--dry-run unreachable with a live setup lock: setup in progress, no stop", async () => {
    const dir = await tmpdir("of-lock-");
    const lock = path.join(dir, "of-setup.lock");
    await fs.writeFile(lock, `${process.pid}\n`);
    const r = spawnSync("bash", [WATCHDOG, "--dry-run"], {
      encoding: "utf8", cwd: ROOT,
      env: { ...process.env, QUEUE_URL: "http://127.0.0.1:1/queue", CURL: "curl", SETUP_LOCK: lock },
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/setup in progress/i);
  });

  it("--dry-run unreachable with a dead-pid lock: stale lock is ignored, idle rule applies", async () => {
    const dir = await tmpdir("of-lock-");
    const lock = path.join(dir, "of-setup.lock");
    await fs.writeFile(lock, "99999999\n");
    const r = spawnSync("bash", [WATCHDOG, "--dry-run"], {
      encoding: "utf8", cwd: ROOT,
      env: { ...process.env, QUEUE_URL: "http://127.0.0.1:1/queue", CURL: "curl", SETUP_LOCK: lock },
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/stale/i);
    expect(out).not.toMatch(/setup in progress/i);
    expect(out).toMatch(/unreachable/i);
  });
});

describe("workflow-scoped cloud downloads", () => {
  it("downloads only files used by actual selected graph inputs", () => {
    const r = setup(["--dry-run", "--tier", "A", "--with-restricted", "--with-optional",
      "--workflows", "director-wan.json,wan-animate-character-swap.json"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("wan2.2_animate_14B_bf16.safetensors");
    expect(r.out).toContain("wan2.2_animate_14B_relight_lora_bf16.safetensors");
    expect(r.out).toContain("wan2.1_vace_1.3B_fp16.safetensors");
    expect(r.out).toContain("depth_anything_3_mono_large.safetensors");
    // not a plan row (the PENDING-sha warning may still name it on stderr)
    expect(r.out).not.toMatch(/^\s+[A-Z]\s+ltx-2\.5-22b-distilled/m);
    expect(r.out).not.toContain("flashvsr");
    expect(r.out).not.toContain("wan2.2_t2v_high_noise");
    expect(r.out).toContain("no downloads");
  });

  it("refuses unknown and unsafe workflow selections before any download", () => {
    for (const workflow of ["../.env", "missing.json", "director-wan.json,"]) {
      const r = setup(["--dry-run", "--workflows", workflow]);
      expect(r.code, r.out).toBe(2);
      expect(r.out).toMatch(/workflow/i);
    }
  });
});

describe("pod spending guard", () => {
  it.each(["idle", "busy"])("stops with the current RunPod CLI syntax (%s queue)", async (state) => {
    const dir = await tmpdir("of-stop-");
    const log = path.join(dir, "stop.log");
    const cli = path.join(dir, "runpodctl");
    const curl = path.join(dir, "curl");
    await fs.writeFile(cli, `#!/bin/bash\nprintf '%s\\n' "$@" > "${log}"\n`);
    const queue = state === "busy" ? { queue_running: [["job"]], queue_pending: [] } : { queue_running: [], queue_pending: [] };
    await fs.writeFile(curl, `#!/bin/bash\nprintf '%s' '${JSON.stringify(queue)}'\n`);
    await fs.chmod(cli, 0o755);
    await fs.chmod(curl, 0o755);
    const r = spawnSync("bash", [WATCHDOG], { encoding: "utf8", timeout: 10_000,
      env: { ...process.env, CURL: curl, RUNPODCTL_BIN: cli, RUNPOD_POD_ID: "test-pod",
        POLL_SECS: "1", EMPTY_LIMIT_SECS: "0", MAX_RUNTIME_SECS: "1" } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(await fs.readFile(log, "utf8")).toBe("pod\nstop\ntest-pod\n");
    if (state === "busy") expect(r.stdout).toContain("runtime limit");
  });
});
