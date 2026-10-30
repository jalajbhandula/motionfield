import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import { z } from "zod";
import { ROOT } from "@/lib/storage";
import { AsrError, type Word } from "./types";

/**
 * ASR via the host's own whisper-cli + a local ggml model - argv-only spawn,
 * no shell. mediaPath must resolve inside the storage root or os.tmpdir();
 * anything else is rejected before a child ever starts (no path is passed to
 * a subprocess that we didn't verify ourselves).
 *
 * whisper-cli writes "<out>.json" next to the -of base we give it; the
 * intermediate 16 kHz mono wav lives in a mkdtemp that is always removed.
 */

const FFMPEG = process.env.MOTIONFIELD_FFMPEG || "ffmpeg";
const WHISPER = process.env.WHISPER_CLI || "whisper-cli";
const DEFAULT_MODEL = path.join(os.homedir(), ".motionfield", "models", "whisper", "ggml-base.en.bin");

export interface AsrDeps {
  /** spawn override for tests - must match child_process.spawn semantics */
  spawn?: typeof spawn;
  whisperCli?: string;
  ffmpeg?: string;
  model?: string;
  tmpdir?: string;
}

/** whisper-cli -ojf output (the fields we read) */
const tokSchema = z.object({
  text: z.string(),
  offsets: z.object({ from: z.number(), to: z.number() }).partial(),
});
const segSchema = z.object({
  text: z.string().optional(),
  offsets: z.object({ from: z.number(), to: z.number() }).partial(),
  tokens: z.array(tokSchema).optional(),
});
const whisperJson = z.object({
  transcription: z.array(segSchema).optional(),
});

/**
 * Resolve `mediaPath` to a real filesystem location inside the allowed
 * roots. realpath() runs BEFORE the root check - a symlink inside tmpdir
 * that points at e.g. $HOME must fail the check, not pass it. The canonical
 * path is what subprocess argv receives.
 */
async function mediaPathInsideRoots(mediaPath: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await fs.realpath(mediaPath);
  } catch {
    throw new AsrError("ASR_PATH", `media not found: ${mediaPath}`);
  }
  // roots realpath'd the same way - macOS os.tmpdir() is /var → /private/var,
  // comparing resolved↔unresolved would reject every allowed file
  const roots = await Promise.all(
    [ROOT, os.tmpdir()].map(async (r) => {
      try { return await fs.realpath(r); } catch { return path.resolve(r); }
    }),
  );
  for (const root of roots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
  }
  throw new AsrError("ASR_PATH", `media path must resolve inside ${ROOT} or ${os.tmpdir()}`);
}

async function run(bin: string, argv: string[], deps: AsrDeps, signal?: AbortSignal): Promise<void> {
  const spawnImpl = deps.spawn ?? spawn;
  await new Promise<void>((res, rej) => {
    let proc: ChildProcess;
    try {
      proc = spawnImpl(bin, argv, { signal });
    } catch (e) {
      rej(e);
      return;
    }
    let tail = "";
    proc.stderr?.on("data", (d) => { tail = (tail + String(d)).slice(-4000); });
    proc.on("error", rej);
    proc.on("close", (code) => {
      if (code === 0) res();
      else if (signal?.aborted) rej(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      else rej(new Error(`${bin} exited ${code}: ${tail.slice(-400)}`));
    });
  });
}

/**
 * Transcribe word timestamps from a media file.
 * Throws AsrError: NEEDS_ASR (binary/model missing), ASR_LANGUAGE (".en"
 * model + non-English request), ASR_PATH (media outside allowed roots),
 * ASR_FAILED (whisper/ffmpeg non-zero or unparseable output).
 */
export async function transcribeWords(
  mediaPath: string,
  opts: { signal?: AbortSignal; language?: string; deps?: AsrDeps } = {},
): Promise<{ words: Word[]; estimated: false }> {
  const deps = opts.deps ?? {};
  const lang = opts.language ?? "en";
  // the language lands in whisper argv - only a real ISO-639 code or "auto"
  // may pass; anything else could smuggle a flag ("-ot" etc.)
  if (!/^(auto|[a-z]{2,3})$/.test(lang)) {
    throw new AsrError("ASR_LANGUAGE", `language must be "auto" or a 2-3 letter code - got "${lang}"`);
  }
  const model = deps.model ?? process.env.WHISPER_MODEL ?? DEFAULT_MODEL;
  const whisperCli = deps.whisperCli ?? WHISPER;
  const ffmpeg = deps.ffmpeg ?? FFMPEG;

  // a ".en" ggml model only knows English - fail loud, don't mistranscribe
  if (path.basename(model).includes(".en.") && lang !== "en") {
    throw new AsrError("ASR_LANGUAGE", `model ${path.basename(model)} is English-only - use a multilingual ggml model for language "${lang}"`);
  }

  const src = await mediaPathInsideRoots(mediaPath); // realpath'd - see above

  const whichOk = async (bin: string) => {
    if (bin.includes(path.sep)) return fs.access(bin).then(() => true).catch(() => false);
    // PATH lookup: ask the shell-free `which`? - do a cheap spawn -version probe
    try {
      await run(bin, ["-h"], { spawn: deps.spawn }, opts.signal);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      return true; // ran but nonzero/help-text exit - binary exists
    }
  };
  if (!(await whichOk(whisperCli))) {
    throw new AsrError("NEEDS_ASR", `whisper-cli not found - install whisper.cpp (e.g. brew install whisper-cpp)`);
  }
  if (!(await whichOk(ffmpeg))) {
    throw new AsrError("NEEDS_ASR", `ffmpeg not found - install ffmpeg (e.g. brew install ffmpeg)`);
  }
  // "remote:<name>" marks a pod-side model (WHISPER_CLI=whisper-remote.sh) -
  // nothing to fs.access locally; the wrapper maps the basename onto the pod.
  const modelOk = model.startsWith("remote:") || await fs.access(model).then(() => true).catch(() => false);
  if (!modelOk) {
    throw new AsrError("NEEDS_ASR", `whisper model missing - download a ggml model to ${model}`);
  }

  const dir = await fs.mkdtemp(path.join(deps.tmpdir ?? os.tmpdir(), "of-asr-"));
  try {
    const wav = path.join(dir, "audio.wav");
    await run(ffmpeg, ["-v", "error", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", wav], deps, opts.signal);

    const outBase = path.join(dir, "out");
    // -ml 1 (one line per word) + -sow (split on word) + -ojf (json out)
    await run(whisperCli, ["-m", model, "-ml", "1", "-sow", "-ojf", "-np", "-l", lang, "-of", outBase, wav], deps, opts.signal);

    const raw = await fs.readFile(`${outBase}.json`, "utf8").catch(() => null);
    if (!raw) throw new AsrError("ASR_FAILED", "whisper-cli produced no JSON output");
    let parsed: z.infer<typeof whisperJson>;
    try {
      parsed = whisperJson.parse(JSON.parse(raw));
    } catch {
      throw new AsrError("ASR_FAILED", "whisper-cli JSON output failed schema validation");
    }

    /* -ml 1 -sow makes each segment exactly one word; its tokens are the
     * sub-word pieces plus punctuation - splitting them is what produced
     * "Americans" + "," and "world .". Emit one word per segment: trimmed
     * segment text over segment offsets, skipping only control markers
     * ([_BEG_], [_TT_*]) and segments with no usable span. */
    const words: Word[] = [];
    for (const seg of parsed.transcription ?? []) {
      const text = (seg.text ?? "").trim();
      // skip control markers ([_BEG_], [_TT_*]) and non-speech segments
      // ([BLANK_AUDIO], (silence), …) - anything whisper bracket-wraps
      if (!text || /^\[_.*_\]$/.test(text) || /^[\[(].*[\])]$/.test(text)) continue;
      let from = seg.offsets?.from;
      let to = seg.offsets?.to;
      if (from == null || to == null) {
        // no segment span - fall back to the token extent
        const usable = (seg.tokens ?? []).filter((t) => t.offsets?.from != null && t.offsets?.to != null);
        if (!usable.length) continue;
        from = Math.min(...usable.map((t) => t.offsets.from!));
        to = Math.max(...usable.map((t) => t.offsets.to!));
      }
      const start = from / 1000;
      words.push({ text, start, end: Math.max(start + 0.01, to / 1000) });
    }
    if (!words.length) throw new AsrError("ASR_FAILED", "whisper-cli returned no word timestamps");
    return { words, estimated: false };
  } catch (e) {
    if (e instanceof AsrError) throw e;
    if (opts.signal?.aborted) throw e;
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AsrError("NEEDS_ASR", `required binary missing: ${(e as Error).message}`);
    }
    throw new AsrError("ASR_FAILED", e instanceof Error ? e.message : String(e));
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
