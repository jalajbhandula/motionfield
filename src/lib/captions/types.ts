/** Shared caption types - pure data, no node imports (safe to reuse). */

/** one timed word: `text` spoken during [start, end) seconds */
export interface Word {
  text: string;
  start: number;
  end: number;
}

/** a group of words shown together on screen */
export interface Cue {
  /** seconds */
  start: number;
  /** seconds */
  end: number;
  words: Word[];
}

/** how the captions look when burned in (and how the ASS style block reads) */
export interface CaptionStyle {
  /** font size in px (ASS fontsize) - default round(frameHeight × 0.055) */
  size: number;
  /** base word color, "#rrggbb" */
  color: string;
  /** karaoke/punch active-word color, "#rrggbb" */
  highlightColor: string;
  /** stroke width px (0 = none) */
  outline: number;
  /** px lift for bottom-anchored captions - default round(frameHeight × 0.08) */
  marginBottom: number;
  uppercase: boolean;
  /** chars per caption line */
  maxChars: number;
  /** max caption lines (1|2) */
  lines: 1 | 2;
}

/** Frame-relative caption metrics - the renderer uses the same ratios. */
export const CAPTION_SIZE_RATIO = 0.055;
export const CAPTION_MARGIN_RATIO = 0.08;

/** Static fallback (~720p-equivalent of the ratios) - contexts without a
 *  probed frame, e.g. a bare toSrt/toVtt call. burnCaptions and toAss scale
 *  size/marginBottom off the real frame height instead. */
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  size: Math.round(720 * CAPTION_SIZE_RATIO),
  color: "#ffffff",
  highlightColor: "#ffd34d",
  outline: 2,
  marginBottom: Math.round(720 * CAPTION_MARGIN_RATIO),
  uppercase: false,
  maxChars: 32,
  lines: 2,
};

/** cue grouping knobs - shared between toCues and the renderer's overlay */
export interface GroupOptions {
  /** chars per caption line - default 32 */
  maxChars?: number;
  /** max caption lines - default 2 */
  lines?: 1 | 2;
  /** max cue length in seconds - default 3.5 */
  maxCue?: number;
  /** silent gap (s) that forces a cue break - default 0.35 */
  breakGap?: number;
}

export type CaptionMode = "karaoke" | "pop" | "punch";

/** ASR failure codes - callers branch on these, never on message text. */
export type AsrErrorCode = "NEEDS_ASR" | "ASR_LANGUAGE" | "ASR_PATH" | "ASR_FAILED";

export class AsrError extends Error {
  code: AsrErrorCode;
  constructor(code: AsrErrorCode, message: string) {
    super(message);
    this.name = "AsrError";
    this.code = code;
  }
}
