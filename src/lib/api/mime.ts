/**
 * Single extension → MIME map shared by asset persistence (assets.mime), the
 * v1 job view, webhook payloads and the result route. Unknown or missing
 * extensions resolve to application/octet-stream.
 */

const EXT_MIME: Record<string, string> = {
  // raster + vector images
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", svg: "image/svg+xml", avif: "image/avif", tiff: "image/tiff",
  // video
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/x-m4v",
  // audio
  wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", ogg: "audio/ogg",
  m4a: "audio/mp4", aac: "audio/aac",
  // 3D + model outputs
  glb: "model/gltf-binary", gltf: "model/gltf+json", obj: "model/obj",
  usdz: "model/vnd.usdz+zip", ply: "application/x-ply", stl: "model/stl",
  // docs/data/3rd-party interchange
  zip: "application/zip", json: "application/json", pdf: "application/pdf",
  md: "text/markdown", jsx: "text/javascript", css: "text/css", html: "text/html",
};

export const OCTET_STREAM = "application/octet-stream";

/** Last-resort MIME per coarse provider kind - preserves the pre-typed-kinds
 *  defaults (image → png, video → mp4, audio → wav) when the URL has no known
 *  extension. */
const KIND_MIME: Record<string, string> = {
  image: "image/png",
  video: "video/mp4",
  audio: "audio/wav",
  model: "model/gltf-binary",
};

/** MIME for an output URL by extension; unknown/missing → octet-stream. */
export function mimeForUrl(url: string): string {
  const path = url.split(/[?#]/, 1)[0];
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return (m && EXT_MIME[m[1].toLowerCase()]) || OCTET_STREAM;
}

/** MIME for a job output: URL extension first, provider kind as tiebreak,
 *  octet-stream last. */
export function mimeForJobOutput(kind: string | undefined, url: string): string {
  const byExt = mimeForUrl(url);
  return byExt !== OCTET_STREAM ? byExt : KIND_MIME[kind ?? ""] ?? OCTET_STREAM;
}
