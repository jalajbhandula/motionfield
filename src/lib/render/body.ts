import { JobError } from "@/lib/jobs";

/**
 * Size-capped request-body read for JSON routes.
 * A declared content-length over the cap short-circuits 413; an undeclared
 * (chunked) body still gets cut mid-stream - the reader stops pulling once
 * the cap is crossed instead of buffering the whole thing.
 */
export async function readCappedBytes(req: Request, cap: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > cap) throw new JobError(`body too large (>${cap} bytes)`, 413);
  const body = req.body;
  if (!body) return new Uint8Array(await req.arrayBuffer());
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new JobError(`body too large (>${cap} bytes)`, 413);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return buf;
}

export async function readCappedText(req: Request, cap: number): Promise<string> {
  return new TextDecoder().decode(await readCappedBytes(req, cap));
}

/* ---------- capped multipart/form-data ---------- */

export interface MultipartPart {
  name: string;
  /** present only for file parts */
  filename?: string;
  contentType: string;
  data: Buffer;
}
export interface MultipartForm {
  fields: Record<string, string>;
  files: MultipartPart[];
}

/** Content-Disposition params - `;`-separated key="value" pairs parsed with
 *  quoted-string awareness, so a `; name="…"` sequence inside a quoted
 *  filename can't inject a param (the naive /name="…"/ regex reads it). */
function dispositionParams(head: string): Record<string, string> {
  const line = /content-disposition:[^\r\n]*/i.exec(head)?.[0] ?? "";
  const params: Record<string, string> = {};
  let i = line.indexOf(":") + 1;
  while (i < line.length) {
    // the segment runs to the next ';' OUTSIDE a quoted string
    let end = i;
    let inQ = false;
    for (; end < line.length; end++) {
      const c = line[end];
      if (c === '"') inQ = !inQ;
      else if (c === ";" && !inQ) break;
    }
    const seg = line.slice(i, end).trim();
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;]*))/.exec(seg);
    if (m) params[m[1].toLowerCase()] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
    i = end + 1;
  }
  return params;
}

/**
 * Minimal binary-safe multipart parser over a size-capped read - the
 * built-in req.formData() would buffer the whole body with no cap. Parts
 * are split on the declared boundary; field names/filenames are
 * header-decoded latin1, bodies are raw bytes.
 */
export async function readCappedForm(req: Request, cap: number): Promise<MultipartForm> {
  const ct = req.headers.get("content-type") ?? "";
  const m = /multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(ct);
  if (!m) throw new JobError("expected multipart/form-data", 400);
  const boundary = m[1] ?? m[2];
  const buf = Buffer.from(await readCappedBytes(req, cap));

  const dash = Buffer.from(`--${boundary}`, "latin1");
  const out: MultipartForm = { fields: {}, files: [] };

  let pos = buf.indexOf(dash);
  if (pos < 0) throw new JobError("malformed multipart body", 400);
  for (;;) {
    let p = pos + dash.length;
    if (buf[p] === 0x2d && buf[p + 1] === 0x2d) break; // "--" terminator
    if (buf[p] === 0x0d && buf[p + 1] === 0x0a) p += 2;
    const headEnd = buf.indexOf("\r\n\r\n", p);
    if (headEnd < 0) throw new JobError("malformed multipart part", 400);
    const head = buf.subarray(p, headEnd).toString("latin1");
    const params = dispositionParams(head);
    const name = params.name;
    const filename = params.filename;
    const contentType = (/content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? "application/octet-stream").trim();
    const bodyStart = headEnd + 4;
    pos = buf.indexOf(dash, bodyStart);
    if (pos < 0) throw new JobError("malformed multipart body", 400);
    // the CRLF immediately before a delimiter belongs to the delimiter
    const data = buf.subarray(bodyStart, Math.max(bodyStart, pos - 2));
    if (name === undefined) continue;
    if (filename === undefined) out.fields[name] = data.toString("utf8");
    else out.files.push({ name, filename, contentType, data });
  }
  return out;
}
