import { NextResponse } from "next/server";
import { json, err } from "@/lib/api";
import { LlmHttpError } from "@/lib/llm/settings";

/** LLM routes translate LlmHttpError → its status; everything else → err(). */
export function llmErr(e: unknown): NextResponse {
  if (e instanceof LlmHttpError) return json({ error: e.message }, e.status);
  return err(e);
}
