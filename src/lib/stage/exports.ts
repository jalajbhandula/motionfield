import { NodeIO } from "@gltf-transform/core";

/**
 * Server-side validators for POST /api/stage/:id/exports - the bytes a
 * browser just rendered get structural checks before they ever reach
 * storage. Both return an error string (400) or null when clean; byte caps
 * are enforced by the route's reader first.
 */

/* ---------- PNG ---------- */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG signature + IHDR width/height, or null when the bytes aren't a PNG. */
export function readPngSize(buf: Uint8Array): { w: number; h: number } | null {
  if (buf.length < 24) return null;
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) return null;
  // first chunk must be IHDR
  if (buf[12] !== 0x49 || buf[13] !== 0x48 || buf[14] !== 0x44 || buf[15] !== 0x52) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

/** null when `buf` is a PNG whose declared IHDR dims equal w×h. */
export function validatePng(buf: Uint8Array, w: number, h: number): string | null {
  const dims = readPngSize(buf);
  if (!dims) return "not a PNG (bad signature or missing IHDR)";
  if (dims.w !== w || dims.h !== h) {
    return `PNG is ${dims.w}×${dims.h} - expected ${w}×${h}`;
  }
  return null;
}

/* ---------- GLB ---------- */

export interface GlbCheck { maxNodes: number; maxBytes: number }
export const GLB_LIMITS: GlbCheck = { maxNodes: 300, maxBytes: 32 * 1024 * 1024 };

/**
 * Structural GLB gate: parses via gltf-transform, glTF 2.0 only, ≤300 nodes,
 * and fully self-contained - external file references and data: URIs are
 * both rejected (a stored export must never phone home). The uri check reads
 * the JSON chunk directly: gltf-transform silently inlines data: URIs on
 * parse, so the reference is gone from the parsed document.
 */
export async function validateGlb(buf: Uint8Array, limits: GlbCheck = GLB_LIMITS): Promise<string | null> {
  if (buf.byteLength > limits.maxBytes) return `glb too large (max ${Math.round(limits.maxBytes / 1024 / 1024)} MB)`;
  // magic + version before the parser: 'glTF' 2.0
  if (buf.byteLength < 12
    || buf[0] !== 0x67 || buf[1] !== 0x6c || buf[2] !== 0x54 || buf[3] !== 0x46) {
    return "not a GLB (bad magic)";
  }
  // readBinary indexes the data with aligned typed-array views - a Buffer
  // sliced out of a multipart body can carry an odd byteOffset, which
  // throws "start offset of Uint32Array should be a multiple of 4". One
  // copy into a fresh (0-offset) array is cheaper than the parse anyway.
  const data = new Uint8Array(buf);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(4, true) !== 2) return "not glTF 2.0";

  // first chunk must be JSON - parse it ourselves for the uri scan
  if (data.byteLength < 20) return "truncated GLB (no chunks)";
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a) return "first GLB chunk isn't JSON";
  if (20 + jsonLen > data.byteLength) return "truncated GLB (JSON chunk overruns)";
  let json: { buffers?: { uri?: unknown }[]; images?: { uri?: unknown }[]; nodes?: unknown[] };
  try {
    json = JSON.parse(new TextDecoder().decode(data.subarray(20, 20 + jsonLen)));
  } catch {
    return "unparseable GLB: bad JSON chunk";
  }
  for (const b of json.buffers ?? []) {
    if (typeof b.uri === "string") return "GLB must not reference external or data: URIs (buffer)";
  }
  for (const im of json.images ?? []) {
    if (typeof im.uri === "string") return "GLB must not reference external or data: URIs (image)";
  }
  if (Array.isArray(json.nodes) && json.nodes.length > limits.maxNodes) {
    return `too many nodes (${json.nodes.length} > ${limits.maxNodes})`;
  }

  let doc;
  try {
    doc = await new NodeIO().readBinary(data);
  } catch (e) {
    return `unparseable GLB: ${e instanceof Error ? e.message : e}`;
  }
  const root = doc.getRoot();
  const version = String(root.getAsset()?.version ?? "");
  if (!version.startsWith("2.")) return `unsupported glTF version "${version}"`;
  if (root.listNodes().length > limits.maxNodes) {
    return `too many nodes (${root.listNodes().length} > ${limits.maxNodes})`;
  }
  for (const b of root.listBuffers()) {
    if (b.getURI()) return "GLB must not reference external or data: URIs (buffer)";
  }
  for (const tex of root.listTextures()) {
    if (tex.getURI()) return "GLB must not reference external or data: URIs (texture)";
  }
  return null;
}
