import type { Metadata } from "next";
import { connection } from "next/server";
import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { gameWriterReady } from "@/lib/games/writer";
import GamesStudio from "./games-studio";

export const metadata: Metadata = { title: "Game Builder" };

/** /games - prompt → playable browser game. `llmReady` is per-user: without a
 *  writer route games come from genre templates and the page says so. */
export default async function GamesPage() {
  await connection();
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null);
  const llmReady = await gameWriterReady(session?.user?.id);
  return <GamesStudio llmReady={llmReady} />;
}
