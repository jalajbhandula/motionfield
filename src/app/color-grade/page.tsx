import type { Metadata } from "next";
import { connection } from "next/server";
import { getSessionUser } from "@/lib/profiles";
import PaletteStudio from "./palette-studio";

export const metadata: Metadata = { title: "Color Grade" };

/** /color-grade - colour grade an image or video from a look, a reference or a palette. */
export default async function PalettePage() {
  await connection();
  const s = await getSessionUser().catch(() => null);
  return <PaletteStudio authed={!!s} />;
}
