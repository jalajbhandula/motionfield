/**
 * WS1 s10 Chrome extension - security properties (OF-0875).
 *  - manifest declares exactly the permissions it needs, no content scripts,
 *    no wildcard required hosts, a module service worker;
 *  - no eval / new Function / remote <script> anywhere in the plugin;
 *  - lib/api.js authHeaders attaches the bearer only to the configured base
 *    origin - a different scheme/host/port means the request goes anonymous.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
// plain-JS module without type decls - imported for the unit surface
import { authHeaders } from "../../plugins/chrome/lib/api.js";

const EXT = resolve(__dirname, "../../plugins/chrome");
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

describe("manifest hygiene", () => {
  const cases: [string, () => void][] = [
    ["mv3", () => expect(manifest.manifest_version).toBe(3)],
    ["permissions exactly contextMenus+storage", () =>
      expect([...manifest.permissions].sort()).toEqual(["contextMenus", "storage"])],
    ["no content scripts", () => expect("content_scripts" in manifest).toBe(false)],
    ["module service worker", () =>
      expect(manifest.background).toEqual({ service_worker: "sw.js", type: "module" })],
    ["no web_accessible_resources", () =>
      expect("web_accessible_resources" in manifest).toBe(false)],
  ];
  for (const [name, fn] of cases) it(`declares ${name}`, fn);

  it("required host_permissions are loopback literals only", () => {
    for (const p of manifest.host_permissions as string[])
      expect(p, p).toMatch(/^http:\/\/(localhost|127\.0\.0\.1)\/\*$/);
  });

  it("optional hosts are broad but ONLY optional", () => {
    expect([...(manifest.optional_host_permissions as string[])].sort())
      .toEqual(["http://*/*", "https://*/*"]);
    // nothing optional may appear in the required set
    for (const p of manifest.host_permissions as string[])
      expect(p).not.toContain("*://");
  });
});

describe("no remote/eval'd code in the plugin", () => {
  const forbidden: [RegExp, string][] = [
    [/\beval\s*\(/, "eval("],
    [/new Function\s*\(/, "new Function("],
    [/src\s*=\s*["']https?:\/\//, "remote <script src>"],
    [/import\s*\(\s*["']https?:\/\//, "remote dynamic import"],
  ];
  const files = [...walk(EXT)].filter((f) => /\.(js|html)$/.test(f));
  it.each(files.map((f) => [f.replace(`${EXT}/`, ""), f] as [string, string]))(
    "%s", (_name, file) => {
      const src = readFileSync(file, "utf8");
      for (const [re, label] of forbidden)
        expect(re.test(src), `${label} in ${file}`).toBe(false);
    });
});

describe("bearer origin scoping", () => {
  const cases: [string, string, string | undefined, boolean][] = [
    ["same origin → key attached", "http://localhost:3000", "http://localhost:3000/api/v1/me", true],
    ["localhost ≠ 127.0.0.1 (different origins)", "http://localhost:3000", "http://127.0.0.1:3000/x", false],
    ["different port → anonymous", "http://localhost:3000", "http://localhost:4000/x", false],
    ["https vs http → anonymous", "http://localhost:3000", "https://localhost:3000/x", false],
    ["remote base → attached", "https://of.example.com", "https://of.example.com/api/v1/jobs", true],
    ["lookalike host → anonymous", "https://of.example.com", "https://of.example.com.evil.net/", false],
    ["other website → anonymous", "http://localhost:3000", "https://cdn.example.net/pic.png", false],
    ["relative path vs remote base → attached", "https://of.example.com", "https://of.example.com/api/v1/uploads", true],
  ];
  for (const [name, baseUrl, url, expectKey] of cases)
    it(name, () => {
      const h = authHeaders({ baseUrl, apiKey: "of_live_secret" }, url);
      if (expectKey) expect(h).toEqual({ authorization: "Bearer of_live_secret" });
      else expect(h).toEqual({});
    });

  it("no key configured → never a header", () => {
    expect(authHeaders({ baseUrl: "http://localhost:3000" }, "http://localhost:3000/x")).toEqual({});
    expect(authHeaders(null, "http://localhost:3000/x")).toEqual({});
  });

  it("malformed url → no header, no throw", () => {
    expect(authHeaders({ baseUrl: "not a url", apiKey: "k" }, "also not a url")).toEqual({});
  });
});
