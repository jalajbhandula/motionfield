import { NextRequest } from "next/server";
import { json, requireApiUser } from "@/lib/api";
import { hostedMode } from "@/lib/llm/offline";
import { ollamaBase, PullBody, pullOllamaModel } from "@/lib/llm/settings";
import { llmErr } from "../../route-utils";

export const runtime = "nodejs";

/** Ollama pull proxy: streams normalized progress events as NDJSON. Loopback
 *  only, hosted mode refuses outright. */
export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    if (hostedMode()) return json({ error: "local model pull is not available in hosted mode" }, 403);
    const parsed = PullBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return json({ error: parsed.error?.issues?.[0]?.message ?? "invalid name" }, 400);
    }
    const baseUrl = await ollamaBase(user.id);
    const name = parsed.data.name;
    const signal = req.signal;
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const enc = new TextEncoder();
        const send = (o: unknown) => ctrl.enqueue(enc.encode(`${JSON.stringify(o)}\n`));
        try {
          await pullOllamaModel(name, { baseUrl, signal, onEvent: send });
        } catch (e) {
          send({
            status: "error",
            error: e instanceof Error ? e.message.slice(0, 200) : "pull failed",
            done: true,
          });
        } finally {
          ctrl.close();
        }
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
    });
  } catch (e) {
    return llmErr(e);
  }
}
