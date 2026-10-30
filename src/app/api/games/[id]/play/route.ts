import { NextRequest, NextResponse } from "next/server";
import { gamesViewer, loadVisibleGame, gameView } from "@/lib/games/api";
import { buildPlayHtml, playCsp } from "@/lib/games/play";
import { EXAMPLE_GAME, EXAMPLE_GAME_ID } from "@/lib/games/example";

export const runtime = "nodejs";

/** GET /api/games/<id>/play - the game document for the sandboxed iframe
 *  (owner, or anyone when shared). Locked down by CSP; never cached. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let spec = id === EXAMPLE_GAME_ID ? EXAMPLE_GAME : null;
  if (!spec) {
    const viewer = await gamesViewer(req).catch(() => null);
    const row = await loadVisibleGame(viewer, id).catch(() => null);
    spec = row ? gameView(row, viewer).spec : null;
  }
  if (!spec) return new NextResponse("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new NextResponse(buildPlayHtml(spec), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": playCsp(req.nextUrl.origin),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}
