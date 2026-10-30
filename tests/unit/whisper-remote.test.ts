import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/** whisper-remote.sh argv/path rewriting - fake ssh/scp on PATH simulate the
 *  pod; nothing touches a network. The fake pod FS is a local dir the fakes
 *  map remote paths onto. */
const SCRIPT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../scripts/runpod/whisper-remote.sh");
const dirs: string[] = [];

const FAKE_SSH = `#!/usr/bin/env bash
echo "ssh $*" >> "$CALLS_LOG"
[ -n "\${SSH_FAIL_ALL:-}" ] && exit 1
cmd="\${@: -1}"
case "$cmd" in
  mktemp*) mkdir -p "$PODFS/work"; echo "/tmp/of-asr.fake0000" ;;
  *whisper-cli*)
    [ -n "\${SSH_FAIL_WHISPER:-}" ] && exit 1
    printf '%s' '{"transcription":[{"text":"hello world","offsets":{"from":0,"to":500}}]}' > "$PODFS/work/out.json" ;;
  rm\\ -rf*) rm -rf "$PODFS/work" ;;
esac
exit 0
`;
const FAKE_SCP = `#!/usr/bin/env bash
echo "scp $*" >> "$CALLS_LOG"
src=""; dst=""
for a in "$@"; do case "$a" in -*) ;; *) src="$dst"; dst="$a" ;; esac; done
case "$dst" in
  root@*:*)
    cp "$src" "$PODFS/work/$(basename "\${dst#*:}")" || exit 1 ;;
  *)
    remote="\${src#*:}"
    [ -f "$PODFS/work/$(basename "$remote")" ] || exit 1
    cp "$PODFS/work/$(basename "$remote")" "$dst" || exit 1 ;;
esac
exit 0
`;

function sandpit(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "of-wr-"));
  dirs.push(dir);
  const bin = join(dir, "bin"), podfs = join(dir, "podfs");
  mkdirSync(bin); mkdirSync(podfs);
  writeFileSync(join(bin, "ssh"), FAKE_SSH); writeFileSync(join(bin, "scp"), FAKE_SCP);
  chmodSync(join(bin, "ssh"), 0o755); chmodSync(join(bin, "scp"), 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CALLS_LOG: join(dir, "calls.log"),
    PODFS: podfs,
    POD_HOST: "pod.example",
    POD_PORT: "12345",
    SSH_KEY: join(dir, "key"),
    ...extra,
  };
  return { dir, bin, podfs, env, log: join(dir, "calls.log") };
}

function run(env: NodeJS.ProcessEnv, argv: string[]) {
  try {
    const out = execFileSync("bash", [SCRIPT, ...argv], { env, encoding: "utf8" });
    return { code: 0, out, err: "" };
  } catch (e: any) {
    return { code: e.status as number, out: String(e.stdout ?? ""), err: String(e.stderr ?? "") };
  }
}

const ASR_ARGV = (wav: string, of: string, model = "remote:ggml-base.en.bin") =>
  ["-m", model, "-ml", "1", "-sow", "-ojf", "-np", "-l", "en", "-of", of, wav];

afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("whisper-remote", () => {
  it("rewrites the asr argv onto the pod and copies <of>.json back", () => {
    const { dir, env, log } = sandpit();
    const wav = join(dir, "audio.wav"); writeFileSync(wav, "RIFF-fake");
    const of = join(dir, "out");
    const r = run(env, ASR_ARGV(wav, of));
    expect(r.code).toBe(0);
    // <of>.json landed locally at the exact path asr.ts reads
    const back = JSON.parse(readFileSync(`${of}.json`, "utf8"));
    expect(back.transcription[0].text).toBe("hello world");

    const calls = readFileSync(log, "utf8");
    // pod whisper-cli ran with the pod model path, pod workdir paths, and the
    // forwarded flags verbatim - never a Mac path
    const line = calls.split("\n").find((l) => l.includes("whisper-cli"))!;
    expect(line).toContain("-m '/root/.motionfield/models/whisper/ggml-base.en.bin'");
    expect(line).toContain("-of '/tmp/of-asr.fake0000/out'");
    expect(line).toContain("'/tmp/of-asr.fake0000/in.wav'");
    for (const f of ["-ml 1", "-sow", "-ojf", "-np", "-l en"]) expect(line).toContain(f);
    // the remote command itself carries only pod paths - the local key path
    // in the ssh argv's own options is fine
    const remoteCmd = line.split("root@pod.example ")[1]!;
    expect(remoteCmd).not.toContain(dir);
    // scp carried the wav up and the json back - both keyed to the pod workdir
    expect(calls).toContain(`scp `);
    expect(calls).toContain(`${wav} root@pod.example:/tmp/of-asr.fake0000/in.wav`);
    expect(calls).toContain(`root@pod.example:/tmp/of-asr.fake0000/out.json ${of}.json`);
  });

  it("maps a local model path's basename onto POD_WHISPER_DIR", () => {
    const { dir, env, log } = sandpit();
    const wav = join(dir, "a.wav"); writeFileSync(wav, "x");
    const of = join(dir, "o");
    const r = run(env, ASR_ARGV(wav, of, "/Users/me/models/ggml-large-v3-turbo.bin"));
    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("-m '/root/.motionfield/models/whisper/ggml-large-v3-turbo.bin'");
  });

  it("exits non-zero when ssh is unreachable", () => {
    const { dir, env } = sandpit({ SSH_FAIL_ALL: "1" });
    const wav = join(dir, "a.wav"); writeFileSync(wav, "x");
    const r = run(env, ASR_ARGV(wav, join(dir, "o")));
    expect(r.code).not.toBe(0);
    expect(existsSync(join(dir, "o.json"))).toBe(false);
  });

  it("exits non-zero when the pod whisper-cli fails", () => {
    const { dir, env } = sandpit({ SSH_FAIL_WHISPER: "1" });
    const wav = join(dir, "a.wav"); writeFileSync(wav, "x");
    const r = run(env, ASR_ARGV(wav, join(dir, "o")));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("pod whisper-cli failed");
  });

  it("exits non-zero when no json comes back", () => {
    const { dir, env, podfs } = sandpit();
    // fake whisper that produces nothing: ssh writes no out.json → scp fails
    const fakebin = String(env.PATH).split(":")[0];
    writeFileSync(join(fakebin, "ssh"), FAKE_SSH.replace(
      `printf '%s' '{"transcription":[{"text":"hello world","offsets":{"from":0,"to":500}}]}' > "$PODFS/work/out.json"`,
      "true",
    ));
    chmodSync(join(fakebin, "ssh"), 0o755);
    const wav = join(dir, "a.wav"); writeFileSync(wav, "x");
    const r = run(env, ASR_ARGV(wav, join(dir, "o")));
    expect(r.code).not.toBe(0);
    expect(existsSync(join(dir, "o.json"))).toBe(false);
    void podfs;
  });

  it("requires POD_HOST / POD_PORT", () => {
    const { dir, env } = sandpit();
    delete env.POD_HOST;
    const wav = join(dir, "a.wav"); writeFileSync(wav, "x");
    const r = run(env, ASR_ARGV(wav, join(dir, "o")));
    expect(r.code).not.toBe(0);
  });

  it("answers -h like a real binary (asr.ts's existence probe)", () => {
    const { env } = sandpit();
    const r = run(env, ["-h"]);
    expect(r.code).toBe(0);
  });

  it("rejects missing input / missing -of", () => {
    const { dir, env } = sandpit();
    expect(run(env, ["-m", "remote:ggml-base.en.bin", "-of", join(dir, "o")]).code).not.toBe(0);
    const wav = join(dir, "a.wav"); writeFileSync(wav, "x");
    expect(run(env, ["-m", "remote:ggml-base.en.bin", wav]).code).not.toBe(0);
  });
});
