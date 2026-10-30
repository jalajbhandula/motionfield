import type { Metadata } from "next";
import { connection } from "next/server";
import { getSessionUser } from "@/lib/profiles";
import CharacterBuilder from "./character-builder";

export const metadata: Metadata = { title: "Character Creator" };

/** /character-creator - describe → pick a face → identity set → saved character. */
export default async function CharacterBuilderPage() {
  await connection();
  const s = await getSessionUser().catch(() => null);
  return <CharacterBuilder authed={!!s} />;
}
