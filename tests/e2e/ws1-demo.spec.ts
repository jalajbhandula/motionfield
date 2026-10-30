import { test, expect } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { shots, badgesForEndpoints, nodePackBadge } from "../../scripts/demo/shots";
import { loadProfile } from "../../scripts/demo/profile-guard";

/**
 * s18 demo:dry e2e - runs the full pipeline against the playwright dev
 * server (mock generation): shots → mcp-check → CLI line → cards →
 * assemble. Asserts the contract docs/DEMO.md promises:
 *  - demo.mp4 exists, 1920×1080, ≤120 s
 *  - timeline.json ordering = shots.ts order wrapped by hook/title/outro/credits
 *  - every badge's license string matches the catalog license data
 *  - every rendered clip probed at 1920×1080
 *  - no API-key material in any artifact or the runner's stdout/stderr
 */
const base = `http://localhost:${process.env.PORT || "3100"}`;
const OUT = path.join(tmpdir(), `of-demo-e2e-${process.pid}`);
const FFPROBE = process.env.MOTIONFIELD_FFPROBE || "ffprobe";

const probe = (f: string) =>
  JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", f], { encoding: "utf8" })) as {
    streams: { codec_type?: string; width?: number; height?: number }[];
    format?: { duration?: string };
  };

const videoDims = (f: string) => {
  const j = probe(f);
  const s = j.streams.find((x) => x.codec_type === "video");
  return { w: s?.width, h: s?.height, duration: Number(j.format?.duration ?? 0) };
};

const list = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).filter((f) => /\.(webm|mp4)$/.test(f)).map((f) => path.join(dir, f))
    : [];

test.describe.configure({ mode: "serial" });
test.setTimeout(660_000);

test("[#151] demo:dry assembles a real 1080p cut with honest badges and no key material", async () => {
  rmSync(OUT, { recursive: true, force: true });

  const run = spawnSync("npx", ["tsx", "scripts/demo/dry.ts", "--base", base, "--out", OUT], {
    env: { ...process.env, PORT: process.env.PORT || "3100" },
    encoding: "utf8",
    timeout: 600_000,
    cwd: path.resolve(__dirname, "../.."),
  });
  writeFileSync("/tmp/of-demo-e2e-stdout.log", `${run.stdout ?? ""}\n${run.stderr ?? ""}`);

  // no API-key material on the runner's stdout OR stderr - the provisioned
  // key is env-only and must stay invisible on every stream
  expect(run.stdout ?? "").not.toMatch(/of_[A-Za-z0-9_-]{8,}/);
  expect(run.stderr ?? "").not.toMatch(/of_[A-Za-z0-9_-]{8,}/);
  expect(run.status, `demo:dry exited ${run.status}\n${run.stderr?.slice(-2000) ?? ""}`).toBe(0);

  const report = JSON.parse(readFileSync(path.join(OUT, "dry-report.json"), "utf8")) as {
    ok: boolean; mcp: { ok: boolean; s1_reused: boolean; s2_reran: boolean; s2_revision: boolean };
    assemble: { ok: boolean; missing: string[]; total_s: number };
  };
  expect(report.ok, JSON.stringify(report)).toBe(true);
  expect(report.mcp.ok).toBe(true);
  expect(report.mcp.s1_reused).toBe(true);
  expect(report.mcp.s2_reran).toBe(true);
  expect(report.mcp.s2_revision).toBe(true);

  const mp4 = path.join(OUT, "demo.mp4");
  expect(existsSync(mp4)).toBe(true);
  const dims = videoDims(mp4);
  expect(dims.w).toBe(1920);
  expect(dims.h).toBe(1080);
  expect(dims.duration).toBeGreaterThan(10);
  expect(dims.duration).toBeLessThanOrEqual(120);

  // every captured clip + card is a real 1920×1080 file
  const clipsDir = path.join(OUT, "capture", "clips");
  const cardsDir = path.join(OUT, "cards", "mp4");
  const allMedia = [...list(clipsDir), ...list(cardsDir)];
  expect(allMedia.length).toBeGreaterThanOrEqual(5);
  for (const f of allMedia) {
    const d = videoDims(f);
    expect(d.w, path.basename(f)).toBe(1920);
    expect(d.h, path.basename(f)).toBe(1080);
  }

  // the timeline: hook + title + shots in declared order + outro + credits
  const timeline = JSON.parse(readFileSync(path.join(OUT, "timeline.json"), "utf8")) as {
    segments: { id: string; title: string; badges: { name: string; license: string; endpoint: string | null }[] }[];
    total_s: number;
  };
  const ids = timeline.segments.map((s) => s.id);
  const shotIds = shots().map((s) => s.id);
  const shotSegs = ids.filter((i) => shotIds.includes(i));
  expect(shotSegs).toEqual(shotIds.filter((id) => existsSync(path.join(clipsDir, `${id}.webm`))));
  expect(ids[0]).toBe("hook");
  expect(ids[1]).toBe("card:title");
  expect(ids.at(-2)).toBe("card:outro");
  expect(ids.at(-1)).toBe("card:credits");
  expect(timeline.total_s).toBeLessThanOrEqual(120);

  // every badge's license text is exactly what the catalog says - joined
  // component licenses for the endpoint, or the brain/pack entries
  const profile = loadProfile();
  const brainName = `${profile.brain.model} (${profile.brain.provider})`;
  for (const seg of timeline.segments) {
    for (const b of seg.badges) {
      if (b.endpoint) {
        const expected = badgesForEndpoints([b.endpoint])[0];
        expect(b.license, `${seg.id} ${b.name}`).toBe(expected.license);
        expect(b.name, `${seg.id} badge name`).toBe(expected.name);
      } else if (b.name === brainName) {
        expect(b.license).toBe(profile.brain.license);
      } else {
        expect(b.name).toBe(nodePackBadge().name);
        expect(b.license).toBe("MIT");
      }
    }
  }

  // captions file has one cue per segment, monotonic times
  const srt = readFileSync(path.join(OUT, "captions.srt"), "utf8");
  const cues = srt.trim().split(/\n\n+/);
  expect(cues.length).toBe(timeline.segments.length);
  let lastStart = -1;
  for (const c of cues) {
    const m = /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->/.exec(c);
    expect(m, c).toBeTruthy();
    const secs = +m![1] * 3600 + +m![2] * 60 + +m![3] + +m![4] / 1000;
    expect(secs).toBeGreaterThanOrEqual(lastStart);
    lastStart = secs;
  }

  // artifact hygiene - nothing under the out dir may carry the API key
  for (const f of ["timeline.json", "captions.srt", "dry-report.json", "mcp-check.json", "cli-run.json", "capture/index.json"]) {
    const p = path.join(OUT, f);
    expect(existsSync(p), f).toBe(true);
    expect(readFileSync(p, "utf8")).not.toMatch(/of_[A-Za-z0-9_-]{8,}/);
  }

  // mcp-check.json details: the tool sequence ran for real
  const mcp = JSON.parse(readFileSync(path.join(OUT, "mcp-check.json"), "utf8")) as {
    ok: boolean; tool_sequence: string[]; run_id: string; log: string[];
  };
  expect(mcp.ok).toBe(true);
  expect(mcp.tool_sequence).toEqual(["run_create", "run_get", "run_approve", "run_edit_step"]);
  expect(mcp.run_id).toMatch(/^[0-9a-f-]{36}$/);
});
