/**
 * Same-origin `next` redirects only. A value is accepted only when it starts
 * with "/" AND parses back onto our own origin - `//host`, `/\host` and
 * literal control-char escapes all re-parse to a different origin and are
 * refused. Percent-encoded tab/newline bytes are refused as well: the URL
 * parser doesn't strip them, but a browser re-parsing `/%09/e.com` decodes the
 * tab, drops it, and lands on `//e.com`.
 */
export function safeNext(raw: string | null, fallback = "/"): string {
  if (raw == null || !raw.startsWith("/")) return fallback;
  let u: URL;
  try {
    u = new URL(raw, "http://x");
  } catch {
    return fallback;
  }
  if (u.origin !== "http://x") return fallback;
  try {
    if (/[\t\n\r]/.test(decodeURIComponent(raw))) return fallback;
  } catch {
    return fallback; // malformed percent-encoding - fail closed
  }
  return raw;
}
