import type { CaptionStyle, Cue, Word } from "./types";
import { CAPTION_MARGIN_RATIO, CAPTION_SIZE_RATIO, DEFAULT_CAPTION_STYLE } from "./types";

/**
 * Sidecar serializers - downloadable subtitle files next to a burned render.
 * ffmpeg on this project has no libass/drawtext, so these are for players and
 * editors, never piped through a subtitles filter (the canvas renderer does
 * the actual burn-in).
 */

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** seconds → ASS "h:mm:ss.cc" */
export function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${pad(m)}:${pad(s)}.${pad(c)}`;
}

/** seconds → SRT/VTT "HH:MM:SS,mmm" / "HH:MM:SS.mmm" */
export function srtTime(t: number, sep = ","): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

/** ASS text escaping: { } \ are override-tag syntax, newline → \N */
export function assEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\n/g, "\\N");
}

/** "#rrggbb" → ASS "&H00BBGGRR" */
function assColor(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return "&H00FFFFFF";
  return `&H00${m[3].toUpperCase()}${m[2].toUpperCase()}${m[1].toUpperCase()}`;
}

/** words → cue display text (honors uppercase + line wrapping at maxChars) */
export function cueText(cue: Cue, style: CaptionStyle): string {
  const words = cue.words.map((w) => (style.uppercase ? w.text.toUpperCase() : w.text));
  const lines: string[] = [""];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    const add = w.length + (cur.length ? 1 : 0);
    if (cur.length && cur.length + add > style.maxChars && lines.length < style.lines) {
      lines.push(w);
    } else {
      lines[lines.length - 1] = cur ? `${cur} ${w}` : w;
    }
  }
  return lines.join("\n");
}

/**
 * Karaoke {\k} tags: each word's tag holds the centiseconds until the NEXT
 * word starts (the last runs to the cue end). Cumulative rounding keeps the
 * sum exactly = round(cue length × 100) - no drift.
 */
export function karaokeText(cue: Cue, style: CaptionStyle): string {
  const cs = (x: number) => Math.round(x * 100);
  let acc = 0;
  const parts = cue.words.map((w: Word, i: number) => {
    const boundary = i + 1 < cue.words.length ? cue.words[i + 1].start : cue.end;
    const k = Math.max(0, cs(boundary - cue.start) - acc);
    acc += k;
    const text = style.uppercase ? w.text.toUpperCase() : w.text;
    return `{\\k${k}}${assEscape(text)}`;
  });
  return parts.join(" ");
}

/**
 * ASS document for a cue list - style block + karaoke Dialogue events.
 * `frame` is the video's pixel size: PlayRes is declared in frame pixels so
 * Fontsize/MarginV mean what they do in the burn. size/marginBottom default
 * to round(H × 0.055/0.08) - the same ratios the canvas renderer uses.
 */
export function toAss(
  cues: Cue[],
  style: Partial<CaptionStyle> = {},
  frame: { width: number; height: number } = { width: 1280, height: 720 },
): string {
  const st = { ...DEFAULT_CAPTION_STYLE, ...style };
  const size = style.size ?? Math.round(frame.height * CAPTION_SIZE_RATIO);
  const margin = style.marginBottom ?? Math.round(frame.height * CAPTION_MARGIN_RATIO);
  // ASS karaoke shows SecondaryColour BEFORE a word is sung and PrimaryColour
  // after - so Primary carries the highlight and Secondary the base color,
  // matching the burn's sung→highlight fill order
  const primary = assColor(st.highlightColor);
  const secondary = assColor(st.color);
  const fontSize = Math.max(8, Math.round(size));
  const outline = Math.max(0, st.outline);
  const marginV = Math.max(0, Math.round(margin));
  // Alignment 2 = bottom-center; karaoke \k fills SecondaryColour → Primary
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${frame.width}`,
    `PlayResY: ${frame.height}`,
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,Space Grotesk,${fontSize},${primary},${secondary},&H80000000,&H00000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,20,20,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const lines = cues.map(
    (c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${karaokeText(c, st)}`,
  );
  return `${header.join("\n")}\n${lines.join("\n")}\n`;
}

/** cue text for SRT/VTT: a literal "-->" inside a cue would be read as the
 *  next timestamp separator, and blank lines end the cue early - both are
 *  stripped from the payload. */
function plainCueText(cue: Cue, style: CaptionStyle): string {
  return cueText(cue, style)
    .replace(/-->/g, "")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .join("\n");
}

/** VTT payload escaping - & < > are entity-escaped (browsers parse cue HTML). */
function vttEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** SRT - plain cue text, numbered blocks. */
export function toSrt(cues: Cue[], style: Partial<CaptionStyle> = {}): string {
  const st = { ...DEFAULT_CAPTION_STYLE, ...style };
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${plainCueText(c, st)}`)
    .join("\n\n") + "\n";
}

/** WebVTT - entity-escaped cue text. */
export function toVtt(cues: Cue[], style: Partial<CaptionStyle> = {}): string {
  const st = { ...DEFAULT_CAPTION_STYLE, ...style };
  const body = cues
    .map((c) => `${srtTime(c.start, ".")} --> ${srtTime(c.end, ".")}\n${vttEscape(plainCueText(c, st))}`)
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}
