import Link from "next/link";
import MoveGlyph from "@/components/MoveGlyph";
import { EFFECT_PRESETS, EFFECT_SPECS } from "@/lib/catalog/presets/effects";
import { MOTION_PRESETS } from "@/lib/catalog/presets/trajectories";
import { MOTION_SPECS, specVisible, loadVerifyRecords } from "@/lib/catalog/presets/schema";
import { COLLECTIONS, collectionVisible } from "@/lib/catalog/presets/collections";

export const metadata = { title: "Effects" };

/** /effects - the grid is the verification-visible set only; counts are real
 *  and empty sections collapse instead of advertising presets that can't run. */
export default async function EffectsPage({ searchParams }: { searchParams: Promise<{ col?: string }> }) {
  const { col } = await searchParams;
  const records = loadVerifyRecords();

  const effects = EFFECT_SPECS
    .filter((s) => specVisible(s, records))
    .map((s) => EFFECT_PRESETS.find((p) => p.id === s.id)!)
    .filter(Boolean);
  const motion = MOTION_SPECS
    .filter((s) => specVisible(s, records))
    .map((s) => MOTION_PRESETS.find((p) => p.id === s.id)!)
    .filter(Boolean);

  const chips = COLLECTIONS
    .map((c) => ({
      c,
      n: collectionVisible(c.id, records).filter((s) => s.catalog === "effect" || s.catalog === "motion").length,
    }))
    .filter((x) => x.n > 0);
  const colEffects = col ? effects.filter((e) => EFFECT_SPECS.find((s) => s.id === e.id)?.collection === col) : effects;
  const colMotion = col ? motion.filter((m) => MOTION_SPECS.find((s) => s.id === m.id)?.collection === col) : motion;

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-10">
      <h1 className="font-display text-3xl font-bold">Effects</h1>
      <p className="mt-1 text-[var(--color-dim)]">One-click visual effects - upload a photo, get a cinematic clip.</p>

      {chips.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          <Link href="/effects" className={`chip ${!col ? "chip-on" : ""}`}>All</Link>
          {chips.map(({ c, n }) => (
            <Link key={c.id} href={`/effects?col=${c.id}`} className={`chip ${col === c.id ? "chip-on" : ""}`}>
              {c.label} · {n}
            </Link>
          ))}
        </div>
      )}

      {colEffects.length + colMotion.length === 0 ? (
        <div className="mt-10 grid place-items-center rounded-2xl border border-dashed border-[var(--color-border)] py-16 text-center">
          <div>
            <p className="text-sm font-semibold text-[var(--color-dim)]">Nothing here yet</p>
            <p className="mt-1 max-w-md text-xs text-[var(--color-faint)]">
              An effect is listed here after a real run of it passes review.
            </p>
          </div>
        </div>
      ) : (
        <>
          {colEffects.length > 0 && (
            <>
              <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-[var(--color-dim)]">
                Visual effects · {colEffects.length}
              </h2>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                {colEffects.map((e) => (
                  <Link key={e.id} href={`/effects/use/${e.id}`}
                    className="media-tile group relative aspect-[9/16] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] transition-colors hover:border-[var(--color-dim)]">
                    {e.poster ? (
                      e.poster.endsWith(".mp4") ? (
                        <video src={e.poster} className="absolute inset-0 h-full w-full object-cover"
                          muted loop playsInline autoPlay preload="metadata" />
                      ) : (
                        <img src={e.poster} alt={e.title} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
                      )
                    ) : (
                      /* no real output yet - spec-label tile, not a fake thumbnail */
                      <div className="flex h-full flex-col justify-center gap-1.5 px-3"
                        style={{ background: `linear-gradient(165deg, hsl(${e.posterHue ?? 200} 30% 15%), var(--color-panel) 75%)` }}>
                        <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-faint)]">
                          {EFFECT_SPECS.find((s) => s.id === e.id)?.mechanism.kind ?? "fx"}
                        </span>
                        <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-faint)]">
                          {e.inputRequired === "video" ? "video in" : "photo in"}
                        </span>
                      </div>
                    )}
                    <div className="absolute bottom-0 w-full border-t border-[var(--color-border)] bg-[var(--color-panel)]/85 p-2.5 backdrop-blur-sm">
                      <div className="text-sm font-semibold leading-tight">{e.title}</div>
                      <div className="mt-0.5 line-clamp-2 text-[11px] text-[var(--color-dim)] opacity-0 transition-opacity group-hover:opacity-100">{e.description}</div>
                    </div>
                  </Link>
                ))}
              </div>
            </>
          )}
          {colMotion.length > 0 && (
            <>
              <h2 className="mt-12 text-sm font-semibold uppercase tracking-wide text-[var(--color-dim)]">
                Camera motion · {colMotion.length}
              </h2>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
                {colMotion.map((m) => (
                  <Link key={m.id} href={`/ai/video?preset=${m.id}`}
                    className="media-tile group relative aspect-video overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] transition-colors hover:border-[var(--color-dim)]">
                    {m.poster ? (
                      m.poster.endsWith(".mp4") ? (
                        <video src={m.poster} className="absolute inset-0 h-full w-full object-cover"
                          muted loop playsInline autoPlay preload="metadata" />
                      ) : (
                        <img src={m.poster} alt={m.title} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
                      )
                    ) : (
                      /* no real render yet: the move's actual path diagram on a soft tinted tile */
                      <div className="absolute inset-0" style={{ background: `radial-gradient(120% 90% at 30% 20%, hsl(${m.posterHue ?? 200} 45% 22% / .55), transparent 70%), linear-gradient(160deg, hsl(${m.posterHue ?? 200} 30% 13%), var(--color-panel))` }}>
                        <MoveGlyph moves={(m.apply?.trajectory as readonly string[] | undefined) ?? [m.id]}
                          className="absolute inset-x-2 top-2 h-[70%] w-[calc(100%-1rem)] text-white/55 transition-colors group-hover:text-white" />
                      </div>
                    )}
                    <div className="absolute bottom-0 w-full border-t border-[var(--color-border)] bg-[var(--color-panel)]/80 p-2 backdrop-blur-sm">
                      <div className="text-[11px] font-semibold leading-tight">{m.title}</div>
                    </div>
                  </Link>
                ))}
              </div>
            </>
          )}
        </>
      )}

    </div>
  );
}
