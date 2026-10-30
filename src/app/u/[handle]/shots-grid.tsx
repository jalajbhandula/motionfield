"use client";
import { useState } from "react";
import { Lightbox, type LightboxItem } from "@/components/Lightbox";

type Shot = { id: string; kind: string; outputs: { url: string; type: string }[]; prompt: string | null };

export function ShotsGrid({ jobs }: { jobs: Shot[] }) {
  const [viewer, setViewer] = useState<LightboxItem | null>(null);
  return (
    <>
      <div className="mt-3 columns-2 gap-3 sm:columns-4 lg:columns-6 [&>*]:mb-3">
        {jobs.map((j) => {
          const out = j.outputs?.[0];
          if (!out) return null;
          return (
            <div key={j.id} className="media-tile break-inside-avoid cursor-pointer"
              onClick={() => setViewer({ url: out.url, type: out.type, label: j.prompt ?? undefined,
                recreateHref: `/ai/${j.kind === "video" ? "video" : "image"}?recreate=${encodeURIComponent(j.prompt ?? "")}` })}>
              {out.type === "video" ? <video src={out.url} muted loop autoPlay playsInline /> : <img src={out.url} alt={j.prompt ?? "published shot"} />}
            </div>
          );
        })}
      </div>
      <Lightbox item={viewer} onClose={() => setViewer(null)} />
    </>
  );
}
