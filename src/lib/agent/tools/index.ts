/**
 * Agent tools v2 - the catalog-driven tool layer.
 *
 *   registry.ts - AgentTool shape + builtin (agent/*) tool definitions
 *   catalog.ts - one tool per offered catalog endpoint + preset plumbing
 *   exec.ts - builtin executors (run as job-less steps, 0 cr)
 *   web.ts - guarded, redirect-safe, size/type-capped fetching
 *   refs.ts - user-scoped @ref resolution
 */
export { AGENT_TOOL_PREFIX, BUILTIN_TOOLS, toolArgsSchema, toolForEndpoint } from "./registry";
export type { AgentTool, ToolInputKind, ToolOutputKind } from "./registry";
export {
  catalogTools, endpointJsonSchema, isPresetParam, plannablePresets,
  plannerTools, presetGate, presetNamedIn, PRESET_PARAM_NAMES,
  searchTools, suggestedBriefs, toolTokens, visiblePresetIds,
} from "./catalog";
export type { PlannablePreset } from "./catalog";
export { execBuiltin } from "./exec";
export type { ToolExecCtx, ToolResult } from "./exec";
export { listRefs, refNamesIn, resolveRefsInText } from "./refs";
export type { ResolvedRef } from "./refs";
export { guardWebTarget, htmlToText, quoteUntrusted, webFetch } from "./web";
export type { FetchedPage } from "./web";

import { turnEndpoints } from "@/lib/runs/endpoints";
import { catalogTools } from "./catalog";
import { BUILTIN_TOOLS } from "./registry";
import type { AgentTool } from "./registry";

/** Everything the caller may name in a plan: catalog tools for the turn
 *  endpoint set plus the offered builtin tools. web_search only appears when
 *  the user configured a SearXNG base URL (it's disabled by default). */
export async function agentTools(
  mode: "auto" | "offline" | "custom" | undefined,
  userId: string,
): Promise<AgentTool[]> {
  const [eps, { getSearxngUrl }] = await Promise.all([
    turnEndpoints(mode, userId),
    import("@/lib/llm/settings"),
  ]);
  const searxng = await getSearxngUrl(userId).catch(() => null);
  return [
    ...catalogTools(eps),
    ...BUILTIN_TOOLS.filter((t) => t.builtin !== "web_search" || !!searxng),
  ];
}
