import Link from "next/link";
import { ArrowRight } from "lucide-react";
import Showcase from "@/components/home/Showcase";
import { EXAMPLE_GAME } from "@/lib/games/example";

export const metadata = { title: "MotionField - AI Creative Studio" };

/** Real generations. The rail under Made with starts where the old top four left off. */
const CARDS = [
  { title: "Edit with words", desc: "Change the scene, keep the person", href: "/ai/image?example=motionfield%2Fflux2-klein%2Fedit",
    media: { kind: "image", src: "/examples/feature/flux2-klein-edit.jpg" } },
  { title: "Image Editor", desc: "Move a photo into a new scene", href: "/image-editor",
    media: { kind: "image", src: "/examples/feature/qwen-image-edit-character.jpg" } },
  { title: "Object Swap", desc: "Swap the thing, keep the shot", href: "/object-swap",
    media: { kind: "video", src: "/examples/feature/wan-vace-object-swap.mp4" } },
  { title: "Product Ads", desc: "Your product, a new set", href: "/product-ads",
    media: { kind: "image", src: "/examples/feature/product-placement.jpg" } },
  { title: "Remove Background", desc: "One click, transparent cutout", href: "/ai/image?model=birefnet",
    media: { kind: "image", src: "/examples/feature/birefnet-remove-background.webp" } },
  { title: "Color Grade", desc: "A film look in one tap", href: "/color-grade",
    media: { kind: "image", src: "/examples/feature/palette-grade-image.jpg" } },
  { title: "Lip Sync", desc: "A portrait that says your line", href: "/audio?model=lipsync",
    media: { kind: "video", src: "/examples/feature/musetalk-portrait-says.mp4" } },
  { title: "Dub & Translate", desc: "New language, lips re-synced", href: "/dub-translate",
    media: { kind: "video", src: "/examples/feature/dub-es.mp4" } },
] as const;

/** The four cards that used to lead the rail. They sit under the showcase. */
const PREVIOUS_FOUR = [
  { title: "Visual effects", desc: "A photo becomes an effect shot - LTX-2.5", href: "/ai/video?example=motionfield%2Fltx-video%2Fvfx-keyframe",
    media: { kind: "video", src: "/examples/feature/ltx-video-vfx-keyframe.mp4" } },
  { title: "Person Swap", desc: "Your actor, the same performance", href: "/person-swap",
    media: { kind: "video", src: "/examples/feature/wan-animate-character-swap.mp4" } },
  { title: "Photo to video", desc: "Bring a still to life", href: "/ai/video?example=motionfield%2Fwan-vace%2Fimage-to-video",
    media: { kind: "video", src: "/examples/feature/wan-vace-image-to-video.mp4" } },
  { title: "Image", desc: "Photoreal text to image", href: "/ai/image",
    media: { kind: "image", src: "/examples/feature/z-image-turbo-text-to-image.jpg" } },
] as const;

const MADE_WITH = [
  { src: "/examples/feature/flux2-klein-text-to-image.jpg", title: "Lisbon morning · FLUX.2 klein", href: "/ai/image?example=motionfield%2Fflux2-klein%2Ftext-to-image" },
  { src: "/examples/feature/flux2-klein-edit.jpg", title: "Neon night edit · FLUX.2 klein", href: "/ai/image?example=motionfield%2Fflux2-klein%2Fedit" },
  { src: "/examples/feature/wan22-a14b-t2v.jpg", title: "Coastal drive · Wan 2.2 A14B", href: "/ai/video?example=motionfield%2Fwan-2.2%2Fa14b-t2v" },
  { src: "/examples/feature/product-placement.jpg", title: "Sneaker packshot · Product Ads", href: "/ai/image?example=motionfield%2Fproduct-placement" },
] as const;

function Card({ c }: { c: (typeof CARDS)[number] | (typeof PREVIOUS_FOUR)[number] }) {
  return (
    <Link href={c.href}
      className="group relative block w-[78vw] shrink-0 snap-start overflow-hidden rounded-2xl bg-[var(--color-panel)] transition-transform duration-200 hover:-translate-y-1 sm:w-[340px]">
      <div className="aspect-[3/4] w-full">
        {c.media.kind === "video" ? (
          <video src={c.media.src} autoPlay loop muted playsInline
            className="h-full w-full object-cover" />
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={c.media.src} alt={c.title} width={864} height={1152} loading="lazy" className="h-full w-full object-cover" />
        )}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 p-5 pt-16" style={{ background: "linear-gradient(to top, rgba(0,0,0,.78), transparent)" }}> {/* taste-skill-ignore - neutral scrim over media for readable card text */}
        <h3 className="text-lg font-semibold text-white">{c.title}</h3>
        <p className="mt-0.5 text-sm text-white/70">{c.desc}</p>
      </div>
      <span className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        <ArrowRight size={15} />
      </span>
    </Link>
  );
}

export default function Landing() {

  return (
    <div className="mx-auto max-w-[1440px] px-5 pb-10 pt-10 sm:px-8 lg:pt-14">

      {/* hero - what this is, in one sentence */}
      <section className="grid items-center gap-8 lg:grid-cols-2">
        <div>
          <h1 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">
            An open-source AI studio that runs on your machine.
          </h1>
          <p className="mt-3 text-sm font-medium uppercase tracking-widest text-[var(--color-faint)]">
            MotionField - an open-source creative studio built on ComfyUI
          </p>
          <p className="mt-5 max-w-[52ch] text-lg leading-relaxed text-[var(--color-dim)]">
            Image, video, audio and 3D in one place. Use your own machine or connect a remote GPU,
            with swappable models and visible licenses.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/ai/image" className="btn btn-primary rounded-full px-6 py-3">
              Start creating <ArrowRight size={15} className="ml-1" />
            </Link>
            <Link href="/apps" className="btn btn-ghost rounded-full px-6 py-3">Browse tools</Link>
          </div>
          <nav aria-label="Featured creative tools" className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
            <span className="text-[var(--color-dim)]">Featured:</span>
            <Link href="/ai/image" className="font-medium text-[var(--color-text)] underline decoration-white/25 underline-offset-4 hover:decoration-white">Image</Link>
            <Link href="/ai/video?example=motionfield%2Fltx-video%2Fvfx-keyframe" className="font-medium text-[var(--color-text)] underline decoration-white/25 underline-offset-4 hover:decoration-white">Video & VFX</Link>
            <Link href="/product-ads" className="font-medium text-[var(--color-text)] underline decoration-white/25 underline-offset-4 hover:decoration-white">Product Ads</Link>
            <Link href="/dub-translate" className="font-medium text-[var(--color-text)] underline decoration-white/25 underline-offset-4 hover:decoration-white">Dub & Lip sync</Link>
            <Link href="/games" className="font-medium text-[var(--color-text)] underline decoration-white/25 underline-offset-4 hover:decoration-white">Game Builder</Link>
          </nav>
          <p className="mt-3 text-sm text-[var(--color-faint)]">
            Also on this page: the{" "}
            <Link href="/ai/image?example=motionfield%2Ftrellis2%2Fimage-to-3d" className="underline decoration-white/25 underline-offset-4 hover:decoration-white">3D perfume model</Link>
            , orbitable in the browser.
          </p>
          <p className="mt-6 text-sm text-[var(--color-faint)]">MIT-licensed · every model keeps its own license, shown before you run it</p>
        </div>
        <div className="overflow-hidden rounded-2xl bg-[var(--color-panel)] ring-1 ring-white/[0.06]">
          <video src="/examples/feature/ltx-video-text-to-video.mp4" autoPlay loop muted playsInline className="aspect-video w-full object-cover" />
          <p className="px-4 py-2.5 text-xs text-[var(--color-faint)]">Generated on our GPU · LTX-2.5 (LTX-2.x Community License) · text to video</p>
        </div>
      </section>

      <section className="mt-12">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold">Made with MotionField</h2>
          <Link href="/community" className="text-sm text-[var(--color-dim)] transition-colors hover:text-[var(--color-text)]">
            Community <ArrowRight size={13} className="mb-0.5 inline-block" />
          </Link>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {MADE_WITH.map((m) => (
            <Link key={m.src} href={m.href} className="group overflow-hidden rounded-2xl bg-[var(--color-panel)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={m.src} alt={m.title} width={864} height={576}
                className="aspect-[4/5] w-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.03]" />
              <p className="px-4 py-3 text-sm font-medium text-[var(--color-dim)]">{m.title}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* tool rail - the product is the pitch */}
      <div className="mt-12 flex snap-x gap-4 overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {CARDS.map((c) => <Card key={c.title} c={c} />)}
      </div>

      {/* playable game, generated media and orbitable 3D */}
      <Showcase gameTitle={EXAMPLE_GAME.title} />

      <div className="mt-16 flex snap-x gap-4 overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {PREVIOUS_FOUR.map((c) => <Card key={c.title} c={c} />)}
      </div>

      {/* footer */}
      <footer className="mt-24 flex flex-col gap-4 text-sm text-[var(--color-faint)] sm:flex-row sm:items-center sm:justify-between">
        <p><span className="font-semibold text-[var(--color-text)]">MotionField</span> - MIT-licensed. Models keep their own licenses.</p>
        <nav className="flex flex-wrap gap-5">
          <Link href="/ai/image" className="transition-colors hover:text-[var(--color-text)]">Image</Link>
          <Link href="/ai/video" className="transition-colors hover:text-[var(--color-text)]">Video</Link>
          <Link href="/audio" className="transition-colors hover:text-[var(--color-text)]">Audio</Link>
          <Link href="/apps" className="transition-colors hover:text-[var(--color-text)]">Tools</Link>
          <Link href="/mcp" className="transition-colors hover:text-[var(--color-text)]">Developers</Link>
        </nav>
      </footer>
    </div>
  );
}
