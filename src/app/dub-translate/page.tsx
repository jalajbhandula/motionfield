import type { Metadata } from "next";
import { connection } from "next/server";
import { getSessionUser } from "@/lib/profiles";
import DubStudio from "./dub-studio";

export const metadata: Metadata = { title: "Dub & Translate" };

/** /dub-translate - an English talking clip in another language, same voice, lips re-synced. */
export default async function DubPage() {
  await connection();
  const s = await getSessionUser().catch(() => null);
  return <DubStudio authed={!!s} />;
}
