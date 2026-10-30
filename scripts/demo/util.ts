/**
 * Shared plumbing for the demo capture pipeline (scripts/demo/*).
 * Import-safe: no process.exit at module scope — CLIs own their exits.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/** Repo root without import.meta — this file is also pulled into the
 *  playwright bundler (CJS transform) through the e2e spec's static import,
 *  where import.meta is a parse error. The demo CLIs and the e2e spawn both
 *  run from the repo root; argv[1] is the entry script's path otherwise. */
function repoRoot(): string {
  if (fs.existsSync(path.join(process.cwd(), "package.json"))) return process.cwd();
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : process.cwd();
  return path.resolve(path.dirname(entry), "..", "..");
}
export const REPO = repoRoot();

/* ------------------------------ binaries ------------------------------ */

export const FFMPEG = process.env.MOTIONFIELD_FFMPEG ?? "ffmpeg";
export const FFPROBE = process.env.MOTIONFIELD_FFPROBE ?? "ffprobe";

export function ffmpeg(args: string[]): void {
  execFileSync(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
}

const probeStream = z.object({
  codec_type: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
const probeOut = z.object({
  streams: z.array(probeStream),
  format: z.object({ duration: z.string().optional() }).optional(),
}).loose();

export function ffprobe(file: string): { width: number; height: number; duration: number } {
  const out = execFileSync(FFPROBE, [
    "-v", "error", "-print_format", "json", "-show_streams", "-show_format", file,
  ]).toString();
  const j = probeOut.parse(JSON.parse(out));
  const s = j.streams.find((x) => x.codec_type === "video" && x.width);
  if (!s?.width || !s.height) throw new Error(`ffprobe: no video stream in ${file}`);
  const duration = Number(j.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`ffprobe: no usable duration in ${file}`);
  return { width: s.width, height: s.height, duration };
}

/* ------------------------------ argv ---------------------------------- */

/** `--name value` / `--name=value` / bare `--flag` parser. */
export function parseArgs(argv: string[]): { opts: Record<string, string | true>; pos: string[] } {
  const opts: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) { opts[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { opts[a.slice(2)] = next; i++; continue; }
      opts[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { opts, pos };
}

/* ---------------------------- out dir guard ---------------------------- */

/**
 * `--out` must live under a temp root and be named of-demo*. macOS has two
 * real ones — os.tmpdir() (/private/var/folders/…/T) and /private/tmp —
 * and `/tmp` is a symlink, so every check runs on real paths.
 */
export function resolveDemoOutDir(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!raw || typeof raw !== "string") throw new Error("--out requires a directory path");
  const abs = path.resolve(process.cwd(), raw);
  const roots = [os.tmpdir(), "/tmp", env.MOTIONFIELD_TMPDIR].filter(Boolean).map((d) => {
    try { return fs.realpathSync(d!); } catch { return null; }
  }).filter((d): d is string => !!d);
  const deny = `--out must be a new of-demo* directory under a temp root (got ${abs})`;
  // resolve symlinks on the longest existing prefix, then re-join the rest.
  // `unshift` keeps tail in top-down order — join it straight, no reverse.
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      const resolved = tail.length ? path.join(real, ...tail) : real;
      const inside = roots.some((r) => {
        const rel = path.relative(r, resolved);
        return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
      });
      const leaf = resolved.split(path.sep).filter(Boolean).slice(-1)[0] ?? "";
      if (!inside || !leaf.startsWith("of-demo")) throw new Error(deny);
      return resolved;
    } catch (e) {
      if (e instanceof Error && e.message === deny) throw e;
      const next = path.dirname(cur);
      if (next === cur) throw new Error(deny);
      tail.unshift(path.basename(cur));
      cur = next;
    }
  }
}

/* ------------------------------- redact ------------------------------- */

const SECRET_PATTERNS = [
  /\bof_[A-Za-z0-9_-]{4,}_[A-Za-z0-9_-]{4,}\b/g,                    // motionfield api keys of_xxx_yyy
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}\b/gi,                          // bearer tokens
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,            // demo user e-mail
];
export function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "·redacted·");
  return out;
}

export function redactedStringify(v: unknown): string {
  return redactSecrets(JSON.stringify(v, null, 2));
}

/* ------------------------------- fixtures ------------------------------ */

/** Deterministic tiny fixtures — a person-ish test clip and a still image.
 *  Written under `<out>/fixtures` (the ffmpeg inputs, not app data). */
export function writeFixtures(outDir: string): Record<"clip" | "face", string> {
  const dir = path.join(outDir, "fixtures");
  fs.mkdirSync(dir, { recursive: true });
  const clip = path.join(dir, "clip.mp4");
  const face = path.join(dir, "face.png");
  if (!fs.existsSync(clip)) {
    ffmpeg([
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=480x270:rate=24:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=220:duration=2",
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
    ]);
  }
  if (!fs.existsSync(face)) {
    ffmpeg([
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=256x256",
      "-frames:v", "1", "-f", "image2", face,
    ]);
  }
  return { clip, face };
}
