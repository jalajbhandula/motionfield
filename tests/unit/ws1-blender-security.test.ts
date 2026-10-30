import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Blender add-on security set - the THREE tests this lane allows. Behavioural
 * only: each table row runs the add-on's own core.py through `python3 -I`
 * from the BUILT zip (built + unpacked once per file), never a source grep.
 * - the API key never reaches stdout/log text/files or filenames;
 * - the download path guard rejects traversal, absolute paths and
 *   server-supplied names;
 * - plain http off loopback is refused unless opted in.
 */

let tmp = "";
let extDir = "";

/** Run a python3 -I snippet against the unpacked extension; returns its
 *  stdout. Snippets print one `JSON {…}` line we parse back. */
const probe = (snippet: string, env: Record<string, string> = {}) =>
  execFileSync("python3", ["-I", "-c", snippet], {
    env: { ...process.env, ...env }, encoding: "utf8", timeout: 30_000,
  });

const probeJson = (snippet: string, env: Record<string, string> = {}) => {
  const out = probe(snippet, env);
  const line = out.split("\n").find((l) => l.startsWith("JSON "));
  return JSON.parse(line!.slice(5)) as Record<string, unknown>;
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "of-blender-sec-"));
  const distDir = join(tmp, "dist");
  execFileSync("python3", ["plugins/blender/build.py", "--out", distDir], { timeout: 60_000 });
  const zip = join(distDir, readdirSync(distDir).find((f) => f.endsWith(".zip"))!);
  extDir = join(tmp, "ext");
  execFileSync("python3", ["-c",
    "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
    zip, extDir], { timeout: 60_000 });
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const BOOT = (body: string) => `
import json, sys
sys.path.insert(0, ${JSON.stringify(extDir + "/vendor")})
sys.path.insert(0, ${JSON.stringify(extDir)})
import core
${body}
`;

describe("ws1-blender security", () => {
  it("the API key never reaches stdout text, error text or filenames", () => {
    const KEY = "of_secretKEY_99zzz";
    const out = probeJson(BOOT(`
from motionfield.client import MotionFieldError
key = ${JSON.stringify(KEY)}
res = {}
# an envelope error whose message mentions the key - mapped through the
# add-on's error surface it must come back redacted
e = core._map_error(MotionFieldError(401, "unauthorized", f"key {key} rejected"), key)
res["mapped"] = e.display()
# a generic exception carrying the key - same rule
e2 = core._map_error(Exception(f"boom {key}"), key)
res["generic"] = e2.display()
res["redact"] = core.redact(f"the {key} is in {key} twice", key)
# filenames are built from job id + index + declared MIME - never a key
res["fname"] = core.output_filename("abc123", 0, "image/png")
try:
    core.output_filename("../" + key, 0, "image/png")
    res["evil"] = "NOT-REFUSED"
except core.AddonError as x:
    res["evil"] = x.code
print("JSON " + json.dumps(res))
`));
    for (const [k, v] of Object.entries(out)) {
      expect(String(v), `${k} leaked the key`).not.toContain(KEY);
    }
    expect(out.fname).toBe("abc123-0.png");
    expect(out.evil).toBe("bad_job_id");
    expect(out.mapped).toContain("unauthorized");
  });

  it("the download path guard rejects ../, absolute paths and server-supplied names", () => {
    const out = probeJson(BOOT(`
import os, tempfile
out_dir = tempfile.mkdtemp()
res = {}
for name in ["../x.png", "..\\\\x.png", "a/b.png", "/abs/x.png",
             "/files/generated/abc.png", "/files/uploads/abc.png",
             "x/y/z.mp4", ".", "..", "", "../"]:
    try:
        core.resolve_output_path(out_dir, name)
        res[json.dumps(name)] = "NOT-REFUSED"
    except core.AddonError as e:
        res[json.dumps(name)] = e.code
    except Exception as e:
        res[json.dumps(name)] = type(e).__name__
good = core.resolve_output_path(out_dir, "job1-0.png")
res["good_inside"] = os.path.dirname(os.path.realpath(good)) == os.path.realpath(out_dir)
res["good_name"] = os.path.basename(good)
# a filename WE build always resolves inside - the guard can't fight itself
res["built"] = core.resolve_output_path(out_dir, core.output_filename("job-1", 2, "video/mp4"))
print("JSON " + json.dumps(res))
`));
    for (const key of Object.keys(out)) {
      if (key.startsWith("\"")) {
        expect(out[key], `${key} must be refused`).toBe("bad_path");
      }
    }
    expect(out.good_inside).toBe(true);
    expect(out.good_name).toBe("job1-0.png");
    expect(String(out.built)).toMatch(/job-1-2\.mp4$/);
  });

  it("plain http off loopback is refused unless allow-insecure is on", () => {
    const rows: { url: string; allow: boolean; want: string }[] = [
      { url: "http://example.com", allow: false, want: "insecure_url" },
      { url: "http://192.168.1.20:3000", allow: false, want: "insecure_url" },
      { url: "http://example.com", allow: true, want: "http://example.com" },
      { url: "http://192.168.1.20:3000", allow: true, want: "http://192.168.1.20:3000" },
      { url: "http://localhost:3110", allow: false, want: "http://localhost:3110" },
      { url: "http://127.0.0.1:3110", allow: false, want: "http://127.0.0.1:3110" },
      { url: "http://[::1]:3110", allow: false, want: "http://[::1]:3110" },
      { url: "https://of.example.com", allow: false, want: "https://of.example.com" },
      { url: "ftp://example.com", allow: false, want: "bad_url" },
    ];
    const out = probeJson(BOOT(`
res = {}
cases = ${JSON.stringify(rows.map((r) => [r.url, r.allow ? 1 : 0]))}
for url, allow in cases:
    key = url + "|" + ("true" if allow else "false")
    try:
        res[key] = core.normalize_base_url(url, allow_insecure=bool(allow))
    except core.AddonError as e:
        res[key] = e.code
print("JSON " + json.dumps(res))
`));
    for (const r of rows) {
      expect(out[`${r.url}|${r.allow}`], `${r.url} allow=${r.allow}`).toBe(r.want);
    }
  });
});
