import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * s18 demo-pipeline security/honesty unit tests - the dry run must be able
 * to prove: the out dir can't escape /tmp/of-demo*, the profile guard
 * refuses closed/hosted brains, the redactor strips keys/emails from every
 * artifact sink, and the shot list + cards resolve their badges and node
 * names from real data.
 */

const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(path.join(tmpdir(), "of-demo-sec-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("demo --out guard", () => {
  let resolveDemoOutDir: typeof import("../../scripts/demo/util").resolveDemoOutDir;
  beforeAll(async () => { ({ resolveDemoOutDir } = await import("../../scripts/demo/util")); });

  it("accepts an of-demo* dir under the OS temp dir", () => {
    const p = resolveDemoOutDir(path.join(tmpdir(), "of-demo-test-ok"));
    expect(p.startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(path.basename(p).startsWith("of-demo")).toBe(true);
  });
  it("accepts a nested of-demo* leaf and refuses a nested non-matching one", () => {
    const p = resolveDemoOutDir(path.join(tmpdir(), "of-demo-nest", "of-demo-inner"));
    expect(p.includes("of-demo-inner")).toBe(true);
    expect(() => resolveDemoOutDir(path.join(tmpdir(), "of-demo-nest", "sub"))).toThrow(/of-demo/);
  });
  it("accepts a bare of-demo name and refuses non-matching siblings", () => {
    expect(resolveDemoOutDir(path.join(tmpdir(), "of-demo"))).toContain("of-demo");
    expect(() => resolveDemoOutDir(path.join(tmpdir(), "not-demo"))).toThrow(/of-demo/);
  });
  it("refuses outside the temp dir entirely", () => {
    expect(() => resolveDemoOutDir("/etc/of-demo-x")).toThrow();
    expect(() => resolveDemoOutDir(path.join(process.cwd(), "of-demo-in-repo"))).toThrow();
  });
  it("refuses escapes that resolve back out of of-demo*", () => {
    expect(() => resolveDemoOutDir(path.join(tmpdir(), "of-demo-a", "..", "other"))).toThrow();
    expect(() => resolveDemoOutDir(`${tmpdir()}/of-demo-a/../../etc`)).toThrow();
  });
  it("accepts an already-existing of-demo dir (reruns nuke it)", () => {
    const d = mk();
    expect(resolveDemoOutDir(d)).toBe(realpathSync(d));
  });
});

describe("profile guard", () => {
  let profile: typeof import("../../scripts/demo/profile-guard");
  beforeAll(async () => { profile = await import("../../scripts/demo/profile-guard"); });

  const okProfile = {
    version: 1 as const,
    brain: { provider: "ollama", model: "qwen3.5:9b", license: "Apache-2.0", base_url: "http://127.0.0.1:11434" },
    mcp: { client: "opencode" as const, tool_sequence: ["run_create", "run_approve"] },
  };

  it("the shipped profile.json parses and passes", () => {
    const p = profile.loadProfile();
    expect(p.brain.provider).toBe("ollama");
  });
  it("accepts a local provider + open-weights model + loopback", () => {
    expect(profile.checkProfile(okProfile)).toEqual([]);
  });
  it("refuses hosted providers - closed API ids aren't even registered", () => {
    for (const id of ["openai", "anthropic", "gemini", "xai", "openrouter"]) {
      const probs = profile.checkProfile({ ...okProfile, brain: { ...okProfile.brain, provider: id } });
      expect(probs.join()).toMatch(/not a registered provider/);
    }
    const custom = profile.checkProfile({ ...okProfile, brain: { ...okProfile.brain, provider: "custom" } });
    expect(custom.join()).toMatch(/remote/i);
  });
  it("refuses a remote brain URL even on a local provider id", () => {
    const probs = profile.checkProfile({ ...okProfile, brain: { ...okProfile.brain, base_url: "https://api.openai.com/v1" } });
    expect(probs.join()).toMatch(/loopback/i);
  });
  it("refuses closed model names", () => {
    for (const m of ["gpt-4o", "claude-sonnet-4", "gemini-2.5-pro", "grok-4", "dall-e-3", "veo-3"]) {
      const probs = profile.checkProfile({ ...okProfile, brain: { ...okProfile.brain, model: m } });
      expect(probs.join(), m).toMatch(/closed/i);
    }
  });
  it("refuses unknown providers and bad schema", () => {
    expect(profile.checkProfile({ ...okProfile, brain: { ...okProfile.brain, provider: "bogus" } }).join()).toMatch(/not a registered provider/);
    const f = path.join(mk(), "p.json");
    writeFileSync(f, JSON.stringify({ version: 2, brain: {}, mcp: {} }));
    expect(() => profile.loadProfile(f)).toThrow(/invalid/);
  });
});

describe("redaction", () => {
  let redactSecrets: typeof import("../../scripts/demo/util").redactSecrets;
  let redactedStringify: typeof import("../../scripts/demo/util").redactedStringify;
  beforeAll(async () => { ({ redactSecrets, redactedStringify } = await import("../../scripts/demo/util")); });

  it("strips of_ api keys, bearer tokens and emails", () => {
    const s = "key of_abcdef12_abcdefghijklmnopqrstuvwxyz0123456789 done; Authorization: Bearer sk-live-abc123; user demo-1@demo.local";
    const out = redactSecrets(s);
    expect(out).not.toContain("of_abcdef12");
    expect(out).not.toContain("sk-live-abc123");
    expect(out).not.toContain("@demo.local");
    expect(out).toContain("·redacted·");
  });
  it("redactedStringify scrubs nested values", () => {
    const out = redactedStringify({ key: "of_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", meta: { email: "x@y.io" } });
    expect(out).not.toMatch(/of_[A-Za-z0-9_-]{4,}/);
    expect(out).not.toContain("x@y.io");
  });
});

describe("shots + cards resolve from real data", () => {
  it("every shot endpoint id resolves to a catalog workflow", async () => {
    const { shots, badgesForEndpoints } = await import("../../scripts/demo/shots");
    const { findEndpoint } = await import("@/lib/catalog/video-models");
    for (const s of shots()) for (const ep of s.endpoints) expect(findEndpoint(ep), ep).toBeTruthy();
    expect(badgesForEndpoints(["motionfield/person-swap/v1.0"])[0].license).toContain("Apache-2.0");
  });
  it("no shot duplicates, routes are sane, budgets bounded", async () => {
    const { shots } = await import("../../scripts/demo/shots");
    const ids = new Set<string>();
    for (const s of shots()) {
      expect(ids.has(s.id)).toBe(false); ids.add(s.id);
      expect(s.route.startsWith("/")).toBe(true);
      expect(s.budget_s).toBeGreaterThan(0); expect(s.budget_s).toBeLessThanOrEqual(60);
      expect(s.steps.length).toBeGreaterThan(0);
    }
  });
  it("node class names come from the shipped python pack", async () => {
    const { nodeClassNames } = await import("../../scripts/demo/shots");
    const names = nodeClassNames();
    expect(names.length).toBeGreaterThanOrEqual(8);
    expect(names).toContain("OF_CameraRig");
    expect(names).toContain("OF_MossSFX");
    expect(names).toContain("OF_DWPose");
    expect(names.every((n) => n.startsWith("OF_"))).toBe(true);
  });
  it("node pack badge comes from generated licenses (not hand-typed)", async () => {
    const { nodePackBadge } = await import("../../scripts/demo/shots");
    expect(nodePackBadge().license).toBe("MIT");
  });
  it("card specs resolve tokens and parse as SceneSpec v1", async () => {
    const { resolveCard } = await import("../../scripts/demo/cards");
    const title = resolveCard("title", { SUBLINE: "x" });
    expect(title.width).toBe(1920); expect(title.height).toBe(1080);
    const outro = resolveCard("outro", { NODES_A: "OF_A", NODES_B: "OF_B" });
    expect(outro.duration).toBe(4);
    // an unfilled token refuses to render
    expect(() => resolveCard("title", {})).toThrow(/unresolved/);
  });
  it("credit lines dedupe by model name", async () => {
    const { creditLines } = await import("../../scripts/demo/cards");
    const lines = creditLines([
      { name: "Wan VACE", license: "Apache-2.0", endpoint: "motionfield/director/generate" },
      { name: "Wan VACE", license: "Apache-2.0", endpoint: "motionfield/reshoot/video" },
      { name: "LTX", license: "Open RAIL-M", endpoint: "motionfield/ltx-video/text-to-video" },
    ]);
    expect(lines).toEqual(["Wan VACE · Apache-2.0", "LTX · Open RAIL-M"]);
  });
});
