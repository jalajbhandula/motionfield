import type { ParamField } from "@/lib/catalog/types";

/**
 * Media-param kind helpers - dependency-free so the Assistant page and the
 * run engine share one map (this file must stay import-clean: no jobs/db).
 */

export const MEDIA_TYPES = new Set(["image", "images", "video", "audio", "media"]);

/** Name-level overrides for params whose declared type isn't media-specific. */
export const MEDIA_PARAM_KIND: Record<string, "image" | "video" | "audio" | "images"> = {
  image_url: "image", end_image_url: "image", mask_url: "image", base_image_url: "image",
  swap_image_url: "image", character_image_url: "image", product_image_url: "image",
  image_reference_url: "image", reference_image_url: "image", pose_image_url: "image",
  video_url: "video", mask_video_url: "video", audio_url: "audio",
  image_urls: "images", reference_image_urls: "images",
  video_urls: "video", audio_urls: "audio",
};

export type MediaKind = "image" | "video" | "audio" | "images";
export type MediaBase = "image" | "video" | "audio";

/** The media kind a param consumes, or null when it isn't a media param.
 *  "media" is treated as image - the base kind that fills it by default. */
export function mediaKindOf(f: Pick<ParamField, "name" | "type">): MediaKind | null {
  const k: unknown = MEDIA_PARAM_KIND[f.name] ?? (MEDIA_TYPES.has(f.type) ? f.type : null);
  if (k == null) return null;
  return (k === "media" ? "image" : k) as MediaKind;
}

/** The output type a media param wants - `images` params take image items. */
export const mediaBaseKind = (k: MediaKind): MediaBase =>
  k === "video" ? "video" : k === "audio" ? "audio" : "image";

/** The kind a brief file (attachment/artifact) actually is - declared mime
 *  first, then the url's extension; unknown stays image (attKind's rule). */
export function attachmentKind(a: { url: string; mime?: string | null }): MediaBase {
  if (a.mime?.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(a.url)) return "video";
  if (a.mime?.startsWith("audio/") || /\.(wav|mp3|flac|ogg)$/i.test(a.url)) return "audio";
  return "image";
}
