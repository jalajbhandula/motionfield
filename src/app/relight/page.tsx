import type { Metadata } from "next";
import { connection } from "next/server";
import { getSessionUser } from "@/lib/profiles";
import RelightStudio from "./relight-studio";

export const metadata: Metadata = { title: "Relight" };

/** /relight - place lights around the subject, preview live, render with klein. */
export default async function RelightPage() {
  await connection();
  const s = await getSessionUser().catch(() => null);
  return <RelightStudio authed={!!s} />;
}
