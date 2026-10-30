import { connection } from "next/server";
// Register character/restyle presets explicitly; route chunks must not rely
// on another page having initialized the shared catalog first.
import "@/lib/catalog/presets/person-swap";
import { specVisible, catalogSpecs, type PresetSpec } from "@/lib/catalog/presets/schema";
import { EFFECT_PRESETS } from "@/lib/catalog/presets/effects";
import { getSessionUser } from "@/lib/profiles";
import type { RestyleTile } from "./re-edit-client";
import ReCutShell from "./re-edit-shell";

export const metadata = { title: "Re-edit Video" };

/** Server wrapper - the restyle tiles are the currently-verified restyle
 *  mechanism specs (same gate the POST route enforces); ?mode=music opens
 *  the cut-to-music tab. */
export default async function ReCutPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const [sp, session] = await Promise.all([searchParams, getSessionUser().catch(() => null)]);
  const restyleTiles: RestyleTile[] = catalogSpecs("effect")
    .filter((s: PresetSpec) => s.mechanism.kind === "restyle" && specVisible(s))
    .map((s) => ({
      id: s.id,
      title: s.label,
      posterHue: EFFECT_PRESETS.find((p) => p.id === s.id)?.posterHue ?? 0,
      poster: EFFECT_PRESETS.find((p) => p.id === s.id)?.poster,
    }));
  return <ReCutShell restyleTiles={restyleTiles} initialMode={sp.mode === "music" ? "music" : "remake"} authed={!!session} />;
}
