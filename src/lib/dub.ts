import { z } from "zod";
import type { Word } from "@/lib/captions/types";

/**
 * Dub - re-voice a talking clip in another language, in the speaker's own
 * voice, with the lips re-synced. Pure planning helpers; the pipeline lives
 * in src/lib/generation/recipes/dub.ts:
 *
 *   whisper words → spoken segments → local-LLM translation (line for line)
 *   → Kokoro speaks each line natively → Chatterbox voice conversion onto the
 *   speaker's timbre → time-fit into the original slots → MuseTalk lip-sync.
 */

export const DUB_ENDPOINT = "motionfield/dub/v1";
export const DUB_MAX_SECONDS = 120;
/** speed-up allowed to squeeze a long line into its slot (ffmpeg atempo) */
export const MAX_TEMPO = 1.3;

export type DubLanguage = { id: string; label: string; kokoro: string; female: string; male: string;
  /** native writing system - small LLMs romanize Hindi/Japanese/Chinese unless
   *  told the script by name; `scriptTest` validates the model actually used it */
  script: string; scriptTest?: RegExp };

/** Targets = every language Kokoro speaks natively with voices on this box. */
export const DUB_LANGUAGES: DubLanguage[] = [
  { id: "es", label: "Spanish", kokoro: "Spanish", female: "ef_dora", male: "em_alex", script: "Latin script" },
  { id: "fr", label: "French", kokoro: "French", female: "ff_siwis", male: "ff_siwis", script: "Latin script" },
  { id: "it", label: "Italian", kokoro: "Italian", female: "if_sara", male: "im_nicola", script: "Latin script" },
  { id: "pt", label: "Portuguese (Brazil)", kokoro: "Brazilian Portuguese", female: "pf_dora", male: "pm_alex", script: "Latin script" },
  { id: "hi", label: "Hindi", kokoro: "Hindi", female: "hf_alpha", male: "hm_omega",
    script: "Devanagari script (e.g. नमस्ते) - never romanize into Latin letters", scriptTest: /[ऀ-ॿ]/ },
  { id: "ja", label: "Japanese", kokoro: "Japanese", female: "jf_alpha", male: "jm_kumo",
    script: "Japanese script - kanji and kana (e.g. こんにちは) - never romaji", scriptTest: /[぀-ヿ一-鿿]/ },
  { id: "zh", label: "Mandarin Chinese", kokoro: "Mandarin Chinese", female: "zf_xiaoxiao", male: "zm_yunxi",
    script: "Chinese characters (e.g. 你好) - never pinyin", scriptTest: /[一-鿿]/ },
];
export const DUB_LANGUAGE_IDS = DUB_LANGUAGES.map((l) => l.id) as [string, ...string[]];
export const languageOf = (id: string) => DUB_LANGUAGES.find((l) => l.id === id);

export const dubParamsSchema = z.object({
  video_url: z.string().min(1),
  language: z.enum(DUB_LANGUAGE_IDS),
  /** auto = pick the base voice from the speaker's pitch */
  voice: z.enum(["auto", "female", "male"]).default("auto"),
  lipsync: z.boolean().default(true),
  /** 0 = replace the soundtrack; >0 keeps the original under the dub */
  original_volume: z.number().min(0).max(0.5).default(0),
  likeness_consent: z.literal(true, { error: "confirm you have the right to use this person's voice and likeness" }),
});
export type DubParams = z.infer<typeof dubParamsSchema>;

export type Segment = { start: number; end: number; text: string };

/** Words → spoken lines: break on a pause, at sentence ends once a line has
 *  some length, or when a line gets long. */
export function segmentWords(words: Word[], opts: { gap?: number; maxSec?: number; minSec?: number } = {}): Segment[] {
  const gap = opts.gap ?? 0.6, maxSec = opts.maxSec ?? 9, minSec = opts.minSec ?? 1.5;
  const out: Segment[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(" ").replace(/\s+([,.!?;:])/g, "$1").trim() });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > gap || w.end - cur[0].start > maxSec)) flush();
    cur.push(w);
    if (/[.!?]["')\]]?$/.test(w.text) && w.end - cur[0].start >= minSec) flush();
  }
  flush();
  return out.filter((s) => /\w/.test(s.text));
}

/** Median pitch (Hz) of voiced 40 ms frames by autocorrelation; 0 if none. */
export function medianPitch(samples: Float32Array, rate: number): number {
  const frame = Math.round(rate * 0.04), minLag = Math.floor(rate / 400), maxLag = Math.ceil(rate / 70);
  let energy = 0;
  for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
  const floor = 0.3 * Math.sqrt(energy / Math.max(1, samples.length));
  const f0s: number[] = [];
  for (let s = 0; s + frame + maxLag < samples.length; s += frame) {
    let rms = 0;
    for (let i = 0; i < frame; i++) rms += samples[s + i] ** 2;
    rms = Math.sqrt(rms / frame);
    if (rms < floor) continue;
    let zero = 0;
    for (let i = 0; i < frame; i++) zero += samples[s + i] * samples[s + i];
    const corr = new Float64Array(maxLag + 2);
    let best = 0;
    for (let lag = minLag; lag <= maxLag + 1; lag++) {
      let c = 0;
      for (let i = 0; i < frame; i++) c += samples[s + i] * samples[s + i + lag];
      corr[lag] = c;
      if (lag <= maxLag && c > best) best = c;
    }
    if (best <= 0.5 * zero) continue;
    // a periodic voice correlates at every multiple of its period - take the
    // shortest-lag peak that is nearly as strong, not the global max (octave errors)
    for (let lag = minLag + 1; lag <= maxLag; lag++)
      if (corr[lag] >= 0.9 * best && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) { f0s.push(rate / lag); break; }
  }
  if (!f0s.length) return 0;
  f0s.sort((a, b) => a - b);
  return f0s[Math.floor(f0s.length / 2)];
}

/** Base Kokoro voice for the speaker: below ~165 Hz reads as a lower voice. */
export function baseVoice(lang: DubLanguage, choice: DubParams["voice"], pitchHz: number): string {
  const low = choice === "male" || (choice === "auto" && pitchHz > 0 && pitchHz < 165);
  return low ? lang.male : lang.female;
}

export type Placement = { start: number; tempo: number; length: number };

/** Fit each dubbed line into its slot (until the next line starts, or the
 *  clip ends): speed up to MAX_TEMPO when long, and if it still runs over,
 *  start the following line a beat after it instead of overlapping. */
export function fitPlan(segs: Segment[], durations: number[], total: number): Placement[] {
  const out: Placement[] = [];
  let free = 0;
  segs.forEach((s, i) => {
    const start = Math.max(s.start, free);
    const slotEnd = i + 1 < segs.length ? segs[i + 1].start : total;
    const slot = Math.max(0.3, slotEnd - start - 0.05);
    const d = durations[i];
    const tempo = d > slot ? Math.min(MAX_TEMPO, d / slot) : 1;
    const length = d / tempo;
    out.push({ start: round3(start), tempo: round3(tempo), length: round3(length) });
    free = start + length + 0.08;
  });
  return out;
}
const round3 = (x: number) => Math.round(x * 1000) / 1000;

export const translationSchema = z.object({ lines: z.array(z.string()) });

/** Line-for-line translation request - keeps count, order and spoken length. */
export function translationMessages(lines: string[], lang: DubLanguage) {
  return [
    {
      role: "system" as const,
      content: `You translate video dialogue from English into ${lang.label} for dubbing. ` +
        "Translate each numbered line on its own, keeping meaning, tone, names and numbers. " +
        "Each translation must take about as long to say as the original line, because it replaces it in the same time slot - prefer natural, concise phrasing. " +
        `Write the ${lang.label} in ${lang.script}. Return JSON {"lines": [...]} with exactly one translation per input line, in order, and nothing else.`,
    },
    { role: "user" as const, content: lines.map((l, i) => `${i + 1}. ${l}`).join("\n") },
  ];
}

/** Subtitle file for the dubbed track (SRT, placement timing). */
export function dubSrt(lines: string[], plan: Placement[]): string {
  const t = (s: number) => {
    const ms = Math.round(s * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return lines.map((l, i) => `${i + 1}\n${t(plan[i].start)} --> ${t(plan[i].start + plan[i].length)}\n${l}\n`).join("\n");
}
