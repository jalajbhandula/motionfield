import { NextRequest } from "next/server";
import { json, requireApiUser } from "@/lib/api";
import { testConnection } from "@/lib/llm/service";
import { TestBody } from "@/lib/llm/settings";
import { llmErr } from "../route-utils";

export const runtime = "nodejs";

/** The Settings "Test" button is a real chat - cap it at 10/min per user. */
const hits = new Map<string, number[]>();
const LIMIT = 10;
const WINDOW_MS = 60_000;

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const list = (hits.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= LIMIT) {
    hits.set(userId, list);
    return true;
  }
  list.push(now);
  hits.set(userId, list);
  return false;
}

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    if (rateLimited(user.id)) return json({ error: "rate limited - wait a minute" }, 429);
    const parsed = TestBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "send exactly one of providerId or task" }, 400);
    const result = await testConnection(user.id, parsed.data);
    return json(result);
  } catch (e) {
    return llmErr(e);
  }
}
