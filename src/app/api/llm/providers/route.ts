import { NextRequest } from "next/server";
import { json, requireApiUser } from "@/lib/api";
import { buildProvidersView, type ProviderView } from "@/lib/llm/settings";
import { llmErr } from "../route-utils";

export const runtime = "nodejs";

const GROUPS: { id: ProviderView["group"]; label: string }[] = [
  { id: "local", label: "Local models" },
  { id: "endpoint", label: "Self-hosted endpoint" },
];

/** Grouped provider list for Settings → Models & LLMs. No key material ever
 *  leaves this response (ProviderView carries hasKey only). */
export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const view = await buildProvidersView(user.id);
    return json({
      hosted: view.hosted,
      suggested: view.suggested,
      groups: GROUPS.map((g) => ({
        id: g.id,
        label: g.label,
        providers: view.providers.filter((p) => p.group === g.id),
      })).filter((g) => g.providers.length > 0),
    });
  } catch (e) {
    return llmErr(e);
  }
}
