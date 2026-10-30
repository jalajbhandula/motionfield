import Link from "next/link";

export const metadata = { title: "Campaign Kit" };

const TOOLS = [
  { t: "Ad creatives", d: "Batch product ads from a photo + brief.", h: "/product-ads" },
  { t: "Product placement", d: "Place your product into generated scenes.", h: "/ai/image?model=product-placement" },
  { t: "Packshots", d: "Clean studio product photography.", h: `/ai/image?model=z-image-turbo&params=${encodeURIComponent('{"prompt":"clean studio product shot, seamless backdrop, soft key light"}')}` },
  /* Apache path - the director endpoint is Open RAIL-M restricted */
  { t: "Video ads", d: "Cinematic product clips with camera moves.", h: "/ai/video?model=wan-2-2&flow=image-to-video" },
  { t: "Brand voice", d: "TTS voiceovers for spots.", h: "/audio" },
  { t: "Talking spokesperson", d: "Lip-synced presenter videos.", h: "/audio?model=lipsync" },
];

export default function Campaigns() {
  return (
    <div className="mx-auto max-w-[1100px] px-4 py-10">
      <h1 className="font-display text-3xl font-bold">Campaign Kit</h1>
      <p className="mt-1 text-[var(--color-dim)]">The ads toolchain - products, voice, spokespeople, campaign cuts.</p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TOOLS.map((t) => (
          <Link key={t.t} href={t.h} className="panel p-5 transition-colors hover:border-[var(--color-accent)]">
            <div className="font-semibold">{t.t}</div>
            <div className="mt-1 text-sm text-[var(--color-dim)]">{t.d}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
