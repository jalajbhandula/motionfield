import { promises as fs, realpathSync } from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Local disk storage rooted at ./public/files → served at /files/*.
 * Swap for S3/R2 in production by replacing these two functions.
 */
export const ROOT = path.join(process.cwd(), "public", "files");

/** symlink guard - the lexical `startsWith(ROOT)` check can't see a symlinked
 *  directory inside public/files. Walk `p`'s parent chain to the nearest
 *  existing ancestor and confirm its realpath still sits under `rootReal`; a
 *  leaf that doesn't exist yet (a save path) is judged by its parent chain.
 *  Returns the input when safe, null when the real path escapes the root. */
function realContainedUnder(p: string, rootReal: string): string | null {
  let cur = p;
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(cur);
      return real === rootReal || real.startsWith(rootReal + path.sep) ? p : null;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
  return null;
}

function realContained(p: string): string | null {
  let rootReal: string;
  try {
    rootReal = realpathSync(ROOT);
  } catch {
    return null; // ROOT itself unresolvable → nothing here is safe to touch
  }
  return realContainedUnder(p, rootReal);
}

export async function saveBytes(key: string, data: Buffer | Uint8Array): Promise<string> {
  // ROOT is gitignored - nothing else creates it, so a fresh checkout would
  // fail its first write with "refusing to write outside files root"
  await fs.mkdir(ROOT, { recursive: true });
  const p = path.join(ROOT, key);
  const safe = realContained(p);
  if (!safe) throw new Error(`refusing to write outside files root: ${key}`);
  await fs.mkdir(path.dirname(safe), { recursive: true });
  await fs.writeFile(safe, data);
  return `/files/${key}`;
}

export async function saveUpload(file: File, folder = "uploads"): Promise<{ url: string; key: string; bytes: number }> {
  const ext = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
  const key = `${folder}/${crypto.randomUUID()}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  const url = await saveBytes(key, buf);
  return { url, key, bytes: buf.length };
}

export async function downloadToStorage(url: string, folder = "generated"): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const ext = (() => {
    const m = url.split("?")[0].match(/\.([a-z0-9]{2,5})$/i);
    if (m) return m[1].toLowerCase();
    const ct = res.headers.get("content-type") || "";
    return ct.includes("video") ? "mp4" : ct.includes("audio") ? "wav" : "png";
  })();
  const key = `${folder}/${crypto.randomUUID()}.${ext}`;
  return saveBytes(key, Buffer.from(await res.arrayBuffer()));
}

export function filePathFor(urlPath: string) {
  if (!urlPath.startsWith("/files/")) return null;
  const rel = urlPath.slice("/files/".length);
  // refuse traversal outright - raw or percent-encoded (any level), backslashes,
  // control bytes - before path.join can normalize a ".." outside ROOT
  if (!rel || /[\\%]|\.\.|\0/.test(rel)) return null;
  const resolved = path.normalize(path.join(ROOT, rel));
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) return null;
  return realContained(resolved);
}

const GENERATED_ROOT = path.resolve(ROOT, "generated") + path.sep;

/** Resolve a /files/ url to a real path ONLY when it lands inside
 *  public/files/generated/ - anything else is null. Deletes of DB-derived
 *  urls must go through this: the stored string is data, never trusted input.
 *  The generated/ boundary is checked on realpaths too, so a symlink inside
 *  generated/ that points at e.g. uploads/ can't launder a delete. */
export function generatedPathFor(urlPath: string): string | null {
  const fp = filePathFor(urlPath);
  if (!fp) return null;
  const resolved = path.resolve(fp);
  if (!resolved.startsWith(GENERATED_ROOT)) return null;
  let genReal: string;
  try {
    genReal = realpathSync(path.resolve(ROOT, "generated"));
  } catch {
    return null; // can't prove the real target stays inside generated/
  }
  return realContainedUnder(resolved, genReal);
}
