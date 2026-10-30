import { NextRequest } from "next/server";
import { json, requireApiUser } from "@/lib/api";
import { getPrefs, PrefsPutBody, setPrefs, setSearxngUrl } from "@/lib/llm/settings";
import { llmErr } from "../route-utils";

export const runtime = "nodejs";

/** {offline, locked, searxngUrl} - `locked` means MOTIONFIELD_OFFLINE=1 forces
 *  the offline flag on. searxngUrl is the caller's own SearXNG base (external
 *  AGPL service, never bundled); null disables web_search. */
export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    return json(await getPrefs(user.id));
  } catch (e) {
    return llmErr(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const parsed = PrefsPutBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid body" }, 400);
    const body = parsed.data;
    if (body.offline !== undefined) {
      const out = await setPrefs(user.id, body.offline);
      if (body.searxngUrl === undefined) return json(out);
    }
    if (body.searxngUrl !== undefined) {
      const out = await setSearxngUrl(user.id, body.searxngUrl);
      if (body.offline === undefined) return json({ ...out });
    }
    return json(await getPrefs(user.id));
  } catch (e) {
    return llmErr(e);
  }
}
