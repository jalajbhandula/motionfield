"use client";
import { useEffect, useRef, useState } from "react";

/** Before/after comparison: input left of the divider, output right. Same
 *  styling as the Color Grade split (white rule + native range input, so
 *  mouse, touch and arrow keys all move it). Video pairs play muted on one
 *  clock - the "before" clip follows the "after" clip's currentTime. */
export function BeforeAfter({ before, after, kind, alt = "", maxH = 460, className = "", withAudio = false }: {
  before: string; after: string; kind: "image" | "video"; alt?: string; maxH?: number; className?: string; withAudio?: boolean;
}) {
  const [split, setSplit] = useState(0.5);
  const [audible, setAudible] = useState<"before" | "after" | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  const img = useRef<HTMLImageElement>(null);
  // cached media can finish loading before React attaches onLoad - read it here too
  useEffect(() => {
    const v = a.current, i = img.current;
    if (v && v.readyState >= 1 && v.videoWidth) setRatio(v.videoWidth / v.videoHeight);
    if (i && i.complete && i.naturalWidth) setRatio(i.naturalWidth / i.naturalHeight);
  }, [after]);

  useEffect(() => {
    if (kind !== "video") return;
    const av = a.current, bv = b.current;
    if (!av || !bv) return;
    let raf = 0;
    const tick = () => {
      if (bv.duration && Math.abs(bv.currentTime - (av.currentTime % bv.duration)) > 0.08)
        bv.currentTime = av.currentTime % bv.duration;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [kind, before, after]);

  // an image-to-video example's "before" is a still - <video src=.jpg> is blank
  const isStill = (src: string) => /\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(src);
  const media = (src: string, which: "before" | "after") => kind === "video" && !isStill(src)
    ? <video ref={which === "after" ? a : b} src={src} muted={!withAudio || audible !== which} loop playsInline autoPlay preload="auto"
        onLoadedMetadata={which === "after" ? (e) => setRatio(e.currentTarget.videoWidth / e.currentTarget.videoHeight) : undefined}
        className="absolute inset-0 h-full w-full object-contain" />
    // eslint-disable-next-line @next/next/no-img-element
    : <img ref={which === "after" ? img : undefined} src={src} alt={`${which}${alt ? ` - ${alt}` : ""}`} draggable={false}
        onLoad={which === "after" ? (e) => setRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight) : undefined}
        className="absolute inset-0 h-full w-full object-contain" />;

  return (
    <div className={`relative mx-auto shrink-0 select-none overflow-hidden bg-black ${className}`}
      style={{ aspectRatio: ratio ?? 1, width: Math.round(maxH * (ratio ?? 1)), maxWidth: "100%" }} data-testid="before-after">
      {/* checkerboard under the output so transparent cutouts read as transparent */}
      {kind === "image" && <div className="absolute inset-0" style={{ backgroundColor: "#1a1a1a", backgroundImage: "linear-gradient(45deg,#262626 25%,transparent 25%,transparent 75%,#262626 75%),linear-gradient(45deg,#262626 25%,transparent 25%,transparent 75%,#262626 75%)", backgroundSize: "20px 20px", backgroundPosition: "0 0,10px 10px" }} />}
      {media(after, "after")}
      <div className="absolute inset-0 bg-black" style={{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }}>{media(before, "before")}</div>
      <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white/90 shadow-[0_0_0_1px_rgba(0,0,0,.35)]" style={{ left: `${split * 100}%` }}>
        <div className="absolute top-1/2 left-1/2 grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-[11px] font-bold text-black shadow-lg">‹ ›</div>
      </div>
      <span className="pointer-events-none absolute top-3 left-3 rounded-md bg-black/60 px-2 py-0.5 text-[11px] font-medium tracking-wide text-white backdrop-blur">Before</span>
      <span className="pointer-events-none absolute top-3 right-3 rounded-md bg-black/60 px-2 py-0.5 text-[11px] font-medium tracking-wide text-white backdrop-blur">After</span>
      <input type="range" min={0} max={1} step={0.001} value={split} aria-label="Before / after divider"
        onChange={(e) => setSplit(Number(e.target.value))}
        className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0" />
      {kind === "video" && withAudio && (
        <div className="absolute bottom-3 left-3 z-20 flex gap-1 rounded-lg bg-black/80 p-1 text-xs text-white" aria-label="Compare audio">
          {([null, "before", "after"] as const).map((value) => (
            <button key={value ?? "off"} type="button" aria-pressed={audible === value}
              className={`rounded px-2 py-1.5 ${audible === value ? "bg-white/20" : "hover:bg-white/10"}`}
              onClick={() => setAudible(value)}>
              {value === null ? "Sound off" : value === "before" ? "Hear before" : "Hear after"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
