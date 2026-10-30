import { NextRequest } from "next/server";
import { json, requireApiUser } from "@/lib/api";
import { narrationScript } from "@/lib/llm/service";
import { ScriptBody } from "@/lib/llm/settings";
import { llmErr } from "../route-utils";

export const runtime = "nodejs";

/** "Reads your text" helper: writer-LLM narration script when a writer is
 *  configured, the source text verbatim otherwise (byLlm says which). */
export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const parsed = ScriptBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid body" }, 400);
    return json(await narrationScript(user.id, parsed.data.text, req.signal));
  } catch (e) {
    return llmErr(e);
  }
}
