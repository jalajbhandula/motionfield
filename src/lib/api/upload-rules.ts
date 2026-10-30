/**
 * Upload acceptance rules - pure data, no imports, so the standalone MCP
 * process can reuse the exact MIME/extension allowlist the API enforces.
 */

/**
 * Client-supplied filenames are never trusted for storage: the extension of the
 * stored file is derived from the validated MIME type, so e.g. an HTML payload
 * sent as image/png is saved - and served - as .png, never as HTML.
 */
export const UPLOAD_MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/webm": "webm",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** upload MIME for a media-file extension, or null when the extension isn't
 *  accepted for upload - used by local-path guards before any bytes are read. */
const MIME_BY_UPLOAD_EXT: Record<string, string> = {};
for (const [mime, ext] of Object.entries(UPLOAD_MIME_EXT)) MIME_BY_UPLOAD_EXT[ext] = mime;

export function uploadMimeForExt(ext: string): string | null {
  return MIME_BY_UPLOAD_EXT[ext.toLowerCase()] ?? null;
}
