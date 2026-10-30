/* Server assembly - tools registered once, the advertised set computed from
 * (enabled toolsets) ∩ (reported capabilities OR catalog endpoints), prompts
 * gated on the tools their instructions call. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TOOLS } from "./tools/index.mts";
import { PROMPTS } from "./prompts.mts";
import { errorResult, gate, toolAvailable, type ToolCtx } from "./registry.mts";
import { GuardError } from "./guards.mts";
import { log } from "./log.mts";
import { redact } from "../../cli/src/util.mts";

export function createServer(ctx: ToolCtx): McpServer {
  const server = new McpServer({ name: "motionfield", version: "0.1.0" });

  const listed = new Map(TOOLS.filter((t) => toolAvailable(t, ctx)).map((t) => [t.name, t]));

  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      {
        title: t.name,
        description: t.description,
        inputSchema: t.input,
      },
      async (args) => {
        try {
          const denied = gate(t, ctx);
          if (denied) return denied;
          return await t.handler(args, ctx);
        } catch (e) {
          if (e instanceof GuardError)
            return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ code: "guard", message: redact(e.message) }) }] };
          return errorResult(e);
        }
      },
    );
  }

  // tools/list advertises only the usable set - the SDK's handler is replaced
  // with one that filters, while every registered name still answers calls
  // (a disabled tool yields a not_available tool error, not a crash).
  server.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const { cursor } = (request.params ?? {}) as { cursor?: string };
    const names = [...listed.keys()].sort();
    const PAGE = 100;
    const start = cursor ? Math.max(0, names.indexOf(cursor) + 1) : 0;
    const page = names.slice(start, start + PAGE);
    return {
      tools: page.map((name) => {
        const t = listed.get(name)!;
        return {
          name: t.name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.input),
        };
      }),
      ...(start + PAGE < names.length ? { nextCursor: names[start + PAGE - 1] } : {}),
    };
  });

  for (const p of PROMPTS) {
    const reg = server.registerPrompt(
      p.name,
      { title: p.title, description: p.description, argsSchema: p.argsSchema },
      async (args) => {
        const parsed = p.argsSchema ? z.object(p.argsSchema).parse(args) : {};
        const strings: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") strings[k] = v;
        return {
          messages: [{
            role: "user" as const,
            content: { type: "text" as const, text: p.text(strings) },
          }],
        };
      },
    );
    // A prompt is listed only when every tool its instructions call is
    // advertised AND every capability it declares is reported - an agent
    // should never see a recipe it can't run, and a prompt whose surface has
    // no capability yet stays hidden.
    if (!p.tools.every((name) => listed.has(name)) ||
        !p.requires.every((cap) => ctx.caps.has(cap))) reg.disable();
  }

  log(`motionfield-mcp: ${listed.size}/${TOOLS.length} tools listed (${[...ctx.toolsets].join("+")} toolsets, ${ctx.caps.size} capabilities)`);
  return server;
}
