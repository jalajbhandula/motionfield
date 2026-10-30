/* Local-filesystem guards - the MCP process runs on the user's machine, so a
 * tool arg that is a path must be proven before any bytes move:
 *  - upload{path}: realpath → regular file → media ext in the API's allowlist
 *    → ≤200MB.
 *  - job_download: the job id is a UUID and the resolved write path stays
 *    inside MOTIONFIELD_MCP_OUT_DIR (symlinks resolved before comparing). */

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, extname, resolve, sep } from "node:path";
import { extForMime, UUID_RE } from "../../cli/src/util.mts";
import { uploadMimeForExt, MAX_UPLOAD_BYTES } from "../../../src/lib/api/upload-rules.ts";

/** A write path inside `root`, or null - resolves `..`, symlinks and case
 *  before deciding. `root` is realpath'd first so the comparison is real. */
export function pathInside(root: string, candidate: string): string | null {
  const r = realpathSync(root);
  const c = resolve(r, candidate);
  return c === r || c.startsWith(r + sep) ? c : null;
}

export function ensureOutDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

export class GuardError extends Error {}

/** Validate a tool-supplied job/run id - UUID or nothing, before it reaches a
 *  request path or a filename. */
export function jobIdArg(id: unknown, what = "job"): string {
  if (typeof id !== "string" || !UUID_RE.test(id))
    throw new GuardError(`id must be a ${what} UUID`);
  return id;
}

/** Proven local upload: returns the file's bytes + the MIME derived from its
 *  extension (the server's allowlist - a .html never becomes text/html).
 *  Checks and reads run on ONE open handle - a path swapped between stat and
 *  read can't smuggle a different file past the guard. */
export function provenLocalUpload(path: string): { bytes: Buffer; filename: string; mime: string } {
  const real = realpathSync(path); // throws ENOENT when absent
  const fd = openSync(real, "r");
  try {
    const st = fstatSync(fd);      // on the open handle - no symlink games
    if (!st.isFile()) throw new GuardError("not a regular file");
    const ext = extname(real).slice(1).toLowerCase();
    const mime = uploadMimeForExt(ext);
    if (!mime) throw new GuardError(`extension .${ext || "?"} is not an accepted upload type`);
    if (st.size > MAX_UPLOAD_BYTES) throw new GuardError("file too large (200MB max)");
    return { bytes: readFileSync(fd), filename: basename(real), mime };
  } finally {
    closeSync(fd);
  }
}

/** Write `bytes` as <outDir>/<jobId>-<index>.<ext>; the filename is built from
 *  the caller-checked UUID so no server-supplied string reaches the path. */
export function writeOutput(outDir: string, jobId: string, index: number, mime: string | null, url: string | undefined, bytes: Uint8Array): string {
  const root = ensureOutDir(outDir);
  const name = `${jobIdArg(jobId)}-${index}.${extForMime(mime, url)}`;
  const dest = pathInside(root, name);
  if (!dest) throw new GuardError("resolved path escapes the output directory");
  writeFileSync(dest, bytes);
  return dest;
}
