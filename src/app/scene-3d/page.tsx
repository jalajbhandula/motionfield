import type { Metadata } from "next";
import { connection } from "next/server";
import StageHome from "./home";

export const metadata: Metadata = { title: "3D Scene" };

export default async function StagePage() {
  // scene list + LLM state are per-request - keep this page out of prerender
  await connection();
  return <StageHome />;
}
