import { saveUpload } from "@/lib/storage";
import { JobError } from "@/lib/jobs";
import { UPLOAD_MIME_EXT, MAX_UPLOAD_BYTES } from "./upload-rules";

export { UPLOAD_MIME_EXT, MAX_UPLOAD_BYTES };

/** Validate the multipart file against the accepted set and store it under a
 *  MIME-derived name (`upload.<ext>`). Throws JobError 415/413 on rejection. */
export async function saveCheckedUpload(file: File): Promise<{ url: string; key: string; bytes: number; mime: string }> {
  const ext = UPLOAD_MIME_EXT[file.type];
  if (!ext) throw new JobError(`unsupported type ${file.type || "unknown"}`, 415);
  if (file.size > MAX_UPLOAD_BYTES) throw new JobError("file too large (200MB max)", 413);
  const stored = await saveUpload(new File([file], `upload.${ext}`, { type: file.type }));
  return { ...stored, mime: file.type };
}
