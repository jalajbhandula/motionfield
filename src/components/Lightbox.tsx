"use client";
import { useEffect } from "react";
import { Download, RotateCcw, X } from "lucide-react";
import { GlbViewer } from "./GlbViewer";

export type LightboxItem = { url: string; type: string; label?: string; prompt?: string; recreateHref?: string };

/** Fullscreen media viewer - click backdrop or ESC to close.
 *  Recreate appears when the opener hands the item's prompt back. */
export function Lightbox({ item, onClose, onRecreate }: {
  item: LightboxItem | null;
  onClose: () => void;
  onRecreate?: (prompt: string) => void;
}) {
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [item, onClose]);

  if (!item) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85" onClick={onClose} role="dialog" aria-modal="true" aria-label={item.label ?? "Media viewer"}>
      <div className="absolute right-4 top-4 flex gap-2" onClick={(e) => e.stopPropagation()}>
        {onRecreate && item.prompt && (
          <button className="btn btn-sm bg-white text-black hover:bg-white/85" onClick={() => onRecreate(item.prompt!)} title="Recreate with the same prompt">
            <RotateCcw size={14} className="mr-1 inline-block" /> Recreate
          </button>
        )}
        {!onRecreate && item.recreateHref && (
          <a className="btn btn-sm bg-white text-black hover:bg-white/85" href={item.recreateHref} title="Recreate with the same prompt">
            <RotateCcw size={14} className="mr-1 inline-block" /> Recreate
          </a>
        )}
        <a className="btn btn-sm bg-white/10 hover:bg-white/20" href={item.url} download title="Save">
          <Download size={14} className="mr-1 inline-block" /> Save
        </a>
        <button className="btn btn-sm bg-white/10 hover:bg-white/20" onClick={onClose} title="Close (Esc)">
          <X size={14} />
        </button>
      </div>
      <div className="max-h-[90vh] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        {item.type === "video" ? (
          <video src={item.url} controls autoPlay loop playsInline className="max-h-[90vh] max-w-[92vw] rounded-lg" />
        ) : item.type === "audio" ? (
          <audio src={item.url} controls autoPlay className="w-[70vw] max-w-[560px]" />
        ) : item.type === "model" ? (
          <div className="h-[80vh] w-[80vw] max-w-[900px]"><GlbViewer url={item.url} className="h-full w-full" /></div>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={item.url} alt={item.label ?? "Generated media"} className="max-h-[90vh] max-w-[92vw] rounded-lg object-contain" />
        )}
        {item.label && <p className="mt-2 text-center text-xs text-white/60">{item.label}</p>}
      </div>
    </div>
  );
}
