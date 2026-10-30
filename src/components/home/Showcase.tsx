"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Volume2, VolumeX } from "lucide-react";
import { GlbViewer } from "@/components/GlbViewer";

/** Mount heavy children (WebGL, a game iframe) only once the tile scrolls
 *  near the viewport; until then the real poster still shows. */
function useNear<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setNear(true); io.disconnect(); } }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near] as const;
}

function Tile({ title, desc, href, cta, children, testId, aspect = "aspect-video" }: { title: string; desc: string; href: string; cta: string; children: React.ReactNode; testId: string; aspect?: string }) {
  return (
    <article className="overflow-hidden rounded-2xl border border-white/[0.06] bg-[var(--color-panel)]" data-testid={testId}>
      <div className={`relative ${aspect} w-full bg-black`}>{children}</div>
      <div className="flex flex-col items-start gap-3 px-4 py-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold">{title}</h3>
          <p className="mt-0.5 text-sm text-[var(--color-dim)]">{desc}</p>
        </div>
        <Link href={href} className="btn btn-ghost btn-sm shrink-0 rounded-full">{cta} <ArrowRight size={13} className="ml-1" /></Link>
      </div>
    </article>
  );
}

function Model({ url, poster, alt }: { url: string; poster: string; alt: string }) {
  const [ref, near] = useNear<HTMLDivElement>();
  return (
    <div ref={ref} className="absolute inset-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {!near && <img src={poster} alt={alt} loading="lazy" className="h-full w-full object-contain" />}
      {near && <GlbViewer url={url} bare autoRotate className="h-full w-full cursor-grab" />}
      <span className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-white/50">Drag to orbit</span>
    </div>
  );
}

function GameTile({ title }: { title: string }) {
  const [ref, near] = useNear<HTMLDivElement>();
  return (
    <div ref={ref} className="absolute inset-0">
      {near ? (
        <iframe src="/api/games/example/play" title={`${title} - playable example`} sandbox="allow-scripts"
          loading="lazy" className="block h-full w-full border-0" data-testid="showcase-game-frame" />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-white/70">Loading playable example</div>
      )}
    </div>
  );
}

/** The real Render result loops by default; the orbitable blockout is one
 *  tap away. They are two different example scenes, and the labels say so. */
function SceneTile() {
  const [view, setView] = useState<"render" | "blockout">("render");
  const [ref, near] = useNear<HTMLDivElement>();
  return (
    <div ref={ref} className="absolute inset-0">
      {view === "render" ? (
        <>
          {near && <video src="/examples/feature/stage-render.mp4" autoPlay loop muted playsInline preload="metadata"
            className="h-full w-full object-cover" data-testid="showcase-scene-render" />}
          <span className="pointer-events-none absolute bottom-2 left-3 right-3 text-[11px] text-white/70">Render: a woman in a yellow raincoat crossing a sunlit plaza</span>
        </>
      ) : (
        <>
          <GlbViewer url="/examples/feature/scene-3d-lighthouse.glb" bare autoRotate className="h-full w-full cursor-grab" />
          <span className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-white/50">Blockout: lighthouse keeper scene · drag to orbit</span>
        </>
      )}
      <div className="absolute right-2 top-2 flex rounded-full border border-white/10 bg-black/60 p-0.5 text-[11px] backdrop-blur-sm" role="tablist" aria-label="3D Scene example">
        {([["render", "Render"], ["blockout", "3D blockout"]] as const).map(([v, label]) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} data-testid={`showcase-scene-${v}-tab`}
            className={`rounded-full px-2.5 py-1 ${view === v ? "bg-white/15 text-white" : "text-white/60 hover:text-white"}`}
            onClick={() => setView(v)}>{label}</button>
        ))}
      </div>
    </div>
  );
}

/** The real dub output plays silent by default; one tap unmutes it - the
 *  whole point of the tile is hearing the new language track. */
function DubTile() {
  const [muted, setMuted] = useState(true);
  const [ref, near] = useNear<HTMLDivElement>();
  const toggle = () => setMuted((current) => !current);
  return (
    <div ref={ref} className="absolute inset-0">
      {near && (
        <video src="/examples/feature/dub-es.mp4" autoPlay loop muted={muted} playsInline preload="metadata"
          className="h-full w-full cursor-pointer object-cover" data-testid="showcase-dub-video"
          onClick={toggle} />
      )}
      <button type="button" onClick={toggle} aria-label={muted ? "Unmute Spanish dub" : "Mute Spanish dub"}
        className="absolute bottom-2 right-2 grid h-11 w-11 place-items-center rounded-full bg-black/60 text-white backdrop-blur-sm"
        data-testid="showcase-dub-sound">
        {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </button>
      <span className="pointer-events-none absolute bottom-2 left-3 right-12 text-[11px] text-white/70">
        Dubbed to Spanish, lips re-synced{muted ? " · tap for sound" : ""}
      </span>
    </div>
  );
}

export default function Showcase({ gameTitle }: { gameTitle: string }) {
  return (
    <section className="mt-16" aria-label="Interactive examples">
      <h2 className="text-xl font-semibold">Make it, play it, see it in 3D</h2>
      <p className="mt-1 text-sm text-[var(--color-dim)]">Play an example game, orbit a generated model, and hear a translated clip.</p>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Tile title={`Game Builder · ${gameTitle}`} desc="Play a game created from a prompt. Tap to play, or use the arrow keys and space."
          href="/games" cta="Make a game" testId="showcase-game">
          <GameTile title={gameTitle} />
        </Tile>
        <Tile title="Image to 3D" desc="One photo of a perfume bottle, a textured GLB. TRELLIS.2."
          href="/ai/image?example=motionfield%2Ftrellis2%2Fimage-to-3d" cta="Make a model" testId="showcase-trellis">
          <Model url="/examples/feature/trellis2-image-to-3d.glb" poster="/examples/feature/trellis2-image-to-3d.jpg" alt="Perfume bottle reference for the generated 3D model" />
        </Tile>
        <Tile title="Dub & Translate" desc="The same actor, a new language - MuseTalk re-syncs the lips."
          href="/dub-translate" cta="Dub a clip" testId="showcase-dub">
          <DubTile />
        </Tile>
        <Tile title="3D Scene" desc="Block a shot in 3D, render it for real. Wan 2.1 VACE, depth-guided."
          href="/scene-3d" cta="Open" testId="showcase-scene">
          <SceneTile />
        </Tile>
      </div>
    </section>
  );
}
