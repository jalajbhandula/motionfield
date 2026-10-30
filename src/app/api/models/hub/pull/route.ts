import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { hubErr, hubUser } from "@/lib/model-hub/gate";
import { finishPull, preparePull, PullBody } from "@/lib/model-hub/downloads";
import { ollamaBase, pullOllamaModel } from "@/lib/llm/settings";

export const runtime = "nodejs";

/** Pull a GGUF into Ollama - hf.co/<repo>:<quant>. The H1 licence checks run
 *  first (a refused repo never reaches Ollama), then the 10 GB floor on the
 *  home volume, then the pull streams NDJSON progress like /api/llm/local/pull. */
export async function POST(req: NextRequest) {
  try {
    const user = await hubUser(req);
    const parsed = PullBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "send {repo, quant}" }, 400);
    const prep = await preparePull(user.id, parsed.data);
    const baseUrl = await ollamaBase(user.id);
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const enc = new TextEncoder();
        const send = (o: unknown) => ctrl.enqueue(enc.encode(`${JSON.stringify(o)}\n`));
        let sawSuccess = false;
        let streamErr: string | null = null;
        try {
          await pullOllamaModel(prep.pullName, {
            baseUrl,
            signal: prep.signal,
            onEvent: (e) => {
              if (typeof e.completed === "number") prep.onProgress(e.completed, e.total ?? prep.entry.size);
              if (e.status === "success") sawSuccess = true;
              if (e.error) streamErr = e.error;
              send(e);
            },
          });
          // only Ollama's own success line makes a pull "done" - an error
          // event or an early-ended stream always lands failed
          const ok = sawSuccess && streamErr === null;
          await finishPull(prep.row.id, ok, ok ? null : (streamErr ?? "no success line from Ollama"));
        } catch (e) {
          const msg = (e instanceof Error ? e.message : "pull failed").slice(0, 200);
          await finishPull(prep.row.id, false, prep.signal.aborted ? "canceled" : msg);
          send({ status: "error", error: msg, done: true });
        } finally {
          ctrl.close();
        }
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
    });
  } catch (e) {
    return hubErr(e);
  }
}
