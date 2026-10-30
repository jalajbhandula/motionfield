import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { NAV_ENTRIES } from "@/lib/nav";
import { APP_SPECS } from "@/lib/catalog/presets/apps";
import { specVisible, loadVerifyRecords, posterFor } from "@/lib/catalog/presets/schema";
import { COLLECTIONS, collectionVisible } from "@/lib/catalog/presets/collections";

export const metadata = { title: "Studio tools" };

/** /apps - one-task tools. Only verification-visible tiles render; the count
 *  is real and an empty catalog gets an honest empty state. */
export default async function AppsPage({ searchParams }: { searchParams: Promise<{ col?: string }> }) {
  const { col } = await searchParams;
  const records = loadVerifyRecords();
  const visible = APP_SPECS.filter((s) => specVisible(s, records));
  const chips = COLLECTIONS
    .map((c) => ({ c, n: collectionVisible(c.id, records).filter((s) => s.catalog === "app").length }))
    .filter((x) => x.n > 0);
  const shown = col ? visible.filter((s) => s.collection === col) : visible;
  const cats = ["video", "image", "audio", "utility"] as const;

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-10">
      <h1 className="font-display text-3xl font-bold">Studio tools</h1>
      <p className="mt-1 text-[var(--color-dim)]">
        One-task tools - each deep-links into a studio with the right model &amp; preset.
      </p>

      {chips.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          <Link href="/apps" className={`chip ${!col ? "chip-on" : ""}`}>All</Link>
          {chips.map(({ c, n }) => (
            <Link key={c.id} href={`/apps?col=${c.id}`} className={`chip ${col === c.id ? "chip-on" : ""}`}>
              {c.label} · {n}
            </Link>
          ))}
        </div>
      )}

      <p className="mt-3 text-xs text-[var(--color-faint)]">
        {shown.length} verified app{shown.length === 1 ? "" : "s"}{shown.length ? "" : " · every studio tool below"}{col ? ` in ${COLLECTIONS.find((c) => c.id === col)?.label ?? col}` : ""}
      </p>

      {shown.length === 0 ? (
        /* no one-task app tiles are verified yet - list the studio tools themselves */
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="studio-tools">
          {(NAV_ENTRIES.find((e) => e.href === "/apps")?.children ?? []).filter((t) => t.ready).map((t) => (
            <Link key={t.href} href={t.href}
              className="group flex items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-4 text-sm font-semibold transition-colors hover:border-[var(--color-dim)]">
              {t.label}
              <ArrowRight size={15} className="text-[var(--color-faint)] transition-colors group-hover:text-white" />
            </Link>
          ))}
        </div>
      ) : (
        cats.map((c) => {
          const apps = shown.filter((s) => s.appCategory === c);
          if (!apps.length) return null;
          return (
            <section key={c} className="mt-10">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-dim)] capitalize">{c}</h2>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                {apps.map((a) => {
                  const poster = posterFor("app", a.id);
                  return (
                  <Link key={a.id} href={a.href}
                    className="media-tile group relative aspect-[4/3] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] transition-colors hover:border-[var(--color-dim)]">
                    {poster ? (
                      <>
                        {poster.endsWith(".mp4") ? (
                          <video src={poster} className="absolute inset-0 h-full w-full object-cover"
                            muted loop playsInline autoPlay preload="metadata" />
                        ) : (
                          <img src={poster} alt={a.label} className="absolute inset-0 h-full w-full object-cover" />
                        )}
                        <div className="absolute bottom-0 w-full border-t border-[var(--color-border)] bg-[var(--color-panel)]/85 p-2.5 backdrop-blur-sm">
                          <div className="text-sm font-semibold leading-tight">{a.label}</div>
                          <div className="line-clamp-1 text-[11px] text-[var(--color-dim)]">{a.blurb}</div>
                        </div>
                      </>
                    ) : (
                      /* no real output yet - spec-label tile, not a fake thumbnail */
                      <div className="flex h-full flex-col justify-between p-3">
                        <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-faint)]">
                          {a.mechanism.kind} · {a.inputs.join("+") || "prompt"}
                        </span>
                        <div>
                          <div className="text-sm font-semibold leading-tight transition-colors group-hover:text-white">{a.label}</div>
                          <div className="mt-1 line-clamp-2 text-[11px] text-[var(--color-dim)]">{a.blurb}</div>
                        </div>
                      </div>
                    )}
                  </Link>
                  );
                })}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
