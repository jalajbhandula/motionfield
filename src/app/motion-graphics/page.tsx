import type { Metadata } from "next";
import { connection } from "next/server";
import { headers } from "next/headers";
import { findEndpoint } from "@/lib/catalog/video-models";
import { MOTION_RENDER_ENDPOINT } from "@/lib/catalog/code/motion";
import { writerReady } from "@/lib/render/generate";
import { getAuth } from "@/lib/auth";
import MotionStudio from "./motion-studio";

export const metadata: Metadata = { title: "Motion Graphics" };

/**
 * /motion-graphics - prompt (+ optional brand URL) → LLM-written SceneSpec → live
 * preview → customize → render. `canRender` flips on once the catalog entry
 * lands in ALL_MODELS; until then the Render MP4 affordance stays hidden.
 * `llmReady` is per-user: a provider set in Settings counts the same as env -
 * with no writer route at all, a picked template is the only way to generate.
 */
export default async function MotionPage() {
  // llmReady/canRender read env + the user's routes at request time -
  // connection() keeps this page out of prerender so a later-configured LLM
  // isn't frozen out by next build
  await connection();
  const canRender = Boolean(findEndpoint(MOTION_RENDER_ENDPOINT));
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null);
  const llmReady = await writerReady(session?.user?.id).catch(() => false);
  return <MotionStudio canRender={canRender} llmReady={llmReady} />;
}
