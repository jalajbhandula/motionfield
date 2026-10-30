import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { gameView, loadVisibleGame } from "@/lib/games/api";
import { CONTROLS } from "@/lib/games/spec";

type Props = { params: Promise<{ id: string }> };

async function visible(id: string) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null);
  const viewer = session?.user?.id ?? null;
  const row = await loadVisibleGame(viewer, id).catch(() => null);
  return row ? gameView(row, viewer) : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const g = await visible((await params).id);
  return { title: g?.spec ? `${g.spec.title} - play` : "Game" };
}

/** /games/play/<id> - the share page: the game full-width, nothing else to
 *  learn. Private games are 404 to everyone but their owner. */
export default async function PlayPage({ params }: Props) {
  const { id } = await params;
  const g = await visible(id);
  if (!g?.spec) notFound();
  return (
    <div className="mx-auto max-w-[1100px] px-4 py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight" data-testid="play-title">{g.spec.title}</h1>
          {g.spec.tagline && <p className="mt-1 text-sm text-[var(--color-dim)]">{g.spec.tagline}</p>}
        </div>
        <Link href="/games" className="btn btn-sm">Make your own game →</Link>
      </div>
      <div className="mt-5 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-black">
        <iframe src={`/api/games/${g.id}/play`} title={`${g.spec.title} - game`} sandbox="allow-scripts" allow="fullscreen"
          className="block aspect-video w-full" data-testid="play-frame" />
      </div>
      <p className="mt-3 text-xs text-[var(--color-dim)]">{CONTROLS[g.spec.genre]} · R restarts · click the game first so it gets your keys</p>
    </div>
  );
}
