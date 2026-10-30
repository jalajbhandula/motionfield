/* Tool registry - every tool is a plain data record the server wires up.
 * Listing is computed once at startup from (enabled toolsets) ∩ (reported
 * capabilities) ∩ (server model catalog); a tool not listed still answers
 * cleanly with a not_available tool error rather than a protocol crash. */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MotionFieldError, type Model, type MotionField, type JobSource } from "../../sdk-ts/src/index.ts";
import { redact } from "../../cli/src/util.mts";

export interface ToolCtx {
  client: MotionField;
  /** capabilities the server reported at startup - read once. */
  caps: Set<string>;
  /** toolsets enabled via MOTIONFIELD_TOOLSETS. */
  toolsets: Set<string>;
  /** endpoint ids the server's model catalog listed at startup - read once;
   *  null when the catalog couldn't be fetched (no endpoint-gated tool lists
   *  in that state). */
  endpoints: Set<string> | null;
  /** the same startup catalog keyed by endpoint id, input JSON Schemas
   *  included - tools that must check a live schema read it here instead of
   *  fetching again. null when the catalog fetch failed. */
  models: ReadonlyMap<string, Model> | null;
  /** download destination root - MOTIONFIELD_MCP_OUT_DIR. */
  outDir: string;
  /** which transport the call arrived on - "stdio" (motionfield-mcp) or "http"
   *  (motionfield-mcp-http). Http callers can't reach local paths: upload{path}
   *  and every other local-filesystem tool is refused, and job_download
   *  returns the result url instead of writing to disk. */
  transport: "stdio" | "http";
}

export interface ToolDef {
  name: string;
  toolset: string;
  /** capability string from /api/v1/capabilities - one side of the listing
   *  rule (capability OR endpoints). Unset = no capability demand. */
  capability?: string;
  /** endpoint ids this tool submits to - the tool lists when ANY of them is
   *  in the server's /api/v1/models catalog (the first listed one is the
   *  default the handler submits to). Restricted-license endpoints disappear
   *  unless the caller opted in server-side. */
  endpoints?: string[];
  /** owner step named in not_available reasons for capability-gated tools
   *  (e.g. "WS4 s8") - the lane whose merge adds the capability line. */
  owner?: string;
  /** set while the tool's real wrapper doesn't exist yet - never listed,
   *  whatever capabilities or endpoints the server reports (a capability
   *  line landing upstream must not advertise a dead tool). gate() answers
   *  not_available naming the capability, the owner step, and that the MCP
   *  wrapper isn't built yet; lifted together with the real wrapper. */
  pending?: true;
  description: string;
  /** zod 4 schema - serialized to JSON Schema for tools/list. */
  input: z.ZodObject<z.ZodRawShape>;
  handler: (args: unknown, ctx: ToolCtx) => Promise<CallToolResult>;
}

/* ---------- results ---------- */

/** Success payload - serialized once, then redacted so no `of_…` secret can
 *  ride a tool result back to the model. */
export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: redact(JSON.stringify(data)) }] };
}

export function toolError(code: string, message: string, extra?: Record<string, unknown>): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: redact(JSON.stringify({ code, message, ...extra })) }],
  };
}

export function notAvailable(reason: string): CallToolResult {
  return toolError("not_available", reason);
}

/** Map any thrown API/usage failure onto the {code,message[,license,enable_at]}
 *  contract - restricted_license and banned_license pass through verbatim, and
 *  a 409 stale_revision carries head_rev so the caller can refetch and resend. */
export function errorResult(e: unknown): CallToolResult {
  if (e instanceof MotionFieldError) {
    return toolError(e.code, e.message, {
      status: e.status,
      ...(e.license ? { license: e.license, enable_at: e.enableAt } : {}),
      ...(e.retryAfter != null ? { retry_after: e.retryAfter } : {}),
      ...(e.headRev != null ? { head_rev: e.headRev } : {}),
    });
  }
  return toolError("internal_error", e instanceof Error ? e.message : String(e));
}

/* ---------- gating ---------- */

/* The listing rule: enabled toolset AND (declared capability reported OR
 * any declared endpoint listed); a tool declaring neither lists whenever its
 * toolset is enabled. */
const capOk = (t: ToolDef, caps: Set<string>) => t.capability !== undefined && caps.has(t.capability);
const epOk = (t: ToolDef, eps: Set<string> | null) =>
  (t.endpoints ?? []).some((e) => eps?.has(e) ?? false);

export function toolAvailable(t: ToolDef, ctx: Pick<ToolCtx, "caps" | "toolsets" | "endpoints">): boolean {
  if (t.pending) return false;
  if (!ctx.toolsets.has(t.toolset)) return false;
  const declared = t.capability !== undefined || !!t.endpoints?.length;
  return !declared || capOk(t, ctx.caps) || epOk(t, ctx.endpoints);
}

/** The endpoint the handler submits to - the first declared endpoint the
 *  catalog listed, else the first declared one (gate() blocks the call when
 *  none was listed, so a handler only sees this when at least one is live). */
export function liveEndpoint(t: Pick<ToolDef, "endpoints">, ctx: Pick<ToolCtx, "endpoints">): string | undefined {
  if (!t.endpoints?.length) return undefined;
  return t.endpoints.find((e) => ctx.endpoints?.has(e)) ?? t.endpoints[0];
}

/** Pre-call gate - tools outside the advertised set answer not_available as a
 *  tool error, never a protocol crash. The reason names the missing
 *  capability and its owner step, or the unlisted endpoints. */
export function gate(t: ToolDef, ctx: Pick<ToolCtx, "caps" | "toolsets" | "endpoints">): CallToolResult | null {
  if (!ctx.toolsets.has(t.toolset))
    return notAvailable(`toolset "${t.toolset}" is disabled - list it in MOTIONFIELD_TOOLSETS to enable`);
  if (t.pending)
    return notAvailable(
      `the MCP wrapper for '${t.name}' isn't built yet` +
      (t.capability ? ` - it waits on capability '${t.capability}'` : "") +
      (t.owner ? `, which lands with its owner step (${t.owner})` : ""));
  if (t.capability !== undefined || t.endpoints?.length) {
    if (!capOk(t, ctx.caps) && !epOk(t, ctx.endpoints)) {
      if (t.capability !== undefined)
        return notAvailable(
          `capability '${t.capability}' is not reported by this server` +
          (t.owner ? ` - it lands when its owner step (${t.owner}) merges` : ""));
      return notAvailable(
        `none of this tool's endpoints is served by this deployment: ${(t.endpoints ?? []).join(", ")}` +
        " - restricted-license endpoints appear only after the caller opts in");
    }
  }
  return null;
}

export type { JobSource };
