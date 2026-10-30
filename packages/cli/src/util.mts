/* Shared CLI plumbing - exit codes, output contract, value coercion, MIME. */

/** Exit codes: 0 ok · 1 API error (or a --wait ending non-completed) · 2 usage. */
export class UsageError extends Error {}

/** Raised by a command that has already printed its result and only needs a
 *  non-zero process exit (e.g. --wait on a failed job). */
export class ExitError extends Error {
  readonly code: number;
  constructor(code: number, message = "") { super(message); this.code = code; }
}

export interface Ctx {
  /** --json: only the machine-readable object may go to stdout */
  json: boolean;
}

export function usage(msg: string): never {
  throw new UsageError(msg);
}

/** `of_<id>_<secret>` key material must never reach a stream - mask it in
 *  anything the CLI is about to print (error messages echo argv). */
export function redact(text: string): string {
  return text.replace(/of_[A-Za-z0-9]+_[A-Za-z0-9_-]+/g, "of_***");
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A job id must be a UUID before it can reach a request path - anything else
 *  is usage noise (or, worse, a path-smuggling string). */
export function jobIdArg(id: string | undefined, what = "a job id"): string {
  if (!id) usage(`requires ${what}`);
  if (!UUID_RE.test(id)) usage(`${what} must be a UUID, got "${id.slice(0, 64)}"`);
  return id;
}

/** A job id that came back from the server and is about to compose a filename
 * - a hostile or buggy server string must not inject path separators. */
export function assertUuid(value: string, what = "job id"): void {
  if (!UUID_RE.test(value)) usage(`server returned a malformed ${what}: "${value.slice(0, 64)}"`);
}

/** Print the primary result: JSON object with --json, one human line otherwise.
 *  Progress and chatter always go to stderr so --json streams stay clean. */
export function out(ctx: Ctx, obj: unknown, text: string): void {
  if (ctx.json) console.log(typeof obj === "string" ? obj : JSON.stringify(obj));
  else console.log(text);
}

export function note(msg: string): void {
  console.error(msg);
}

/** `-p name=value` - the value is coerced: JSON first ("4", "true", "[…]"),
 *  a raw string otherwise. */
export function kvParam(spec: string, flag = "-p"): [string, unknown] {
  const eq = spec.indexOf("=");
  if (eq <= 0) usage(`${flag} expects name=value, got "${spec}"`);
  const name = spec.slice(0, eq);
  const raw = spec.slice(eq + 1);
  try { return [name, JSON.parse(raw)]; } catch { return [name, raw]; }
}

/* ---- MIME <-> extension ---- */

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", svg: "image/svg+xml",
  wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", ogg: "audio/ogg",
  m4a: "audio/mp4", aac: "audio/aac", webma: "audio/webm",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  glb: "model/gltf-binary", gltf: "model/gltf+json",
  zip: "application/zip", html: "text/html", json: "application/json",
  pdf: "application/pdf",
};

const EXT_BY_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext]),
);
EXT_BY_MIME["image/jpg"] = "jpg";
EXT_BY_MIME["audio/x-wav"] = "wav";
EXT_BY_MIME["audio/x-m4a"] = "m4a";
EXT_BY_MIME["audio/x-flac"] = "flac";
EXT_BY_MIME["application/octet-stream"] = "bin";

/** Best upload Content-Type for a filename; octet-stream when unknown (the
 *  server validates the MIME allowlist and will answer 415). */
export function mimeForFilename(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** File extension for a downloaded output: response MIME first, then any
 *  extension already on the output URL, then "bin". */
export function extForMime(mime: string | null | undefined, url?: string): string {
  const bare = mime?.split(";")[0].trim().toLowerCase();
  if (bare && EXT_BY_MIME[bare]) return EXT_BY_MIME[bare];
  if (url) {
    const m = /\.([a-z0-9]{1,5})(?:$|\?)/i.exec(url);
    if (m) return m[1].toLowerCase();
  }
  return "bin";
}
