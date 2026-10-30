import { NextRequest } from "next/server";
import { z } from "zod";
import { createHash } from "crypto";
import { json, err, requireApiUser } from "@/lib/api";
import { getRunView, listRunEvents, newViewShared, ownsRun, tickRun, TERMINAL_RUN } from "@/lib/runs";

export const runtime = "nodejs";

const RUN_ID = z.string().uuid();
const POLL_MS = 1500;
const HEARTBEAT_MS = 15_000;
/** No stream lives forever - at the cap the server sends a final `done`
 *  frame and closes; the client reconnects or keeps polling. */
const STREAM_MS = 10 * 60_000;

/**
 * GET /api/agent/runs/:id/events - the run's durable event feed as SSE.
 * Owner-scoped (404 for anyone else's run - same as the JSON routes), framed
 * as `id: <seq>` + `event: <kind>` + `data: {seq,kind,step_id,payload,at}`.
 *
 * The stream opens with a `snapshot` event carrying the current run view so a
 * late joiner sees full state, then replays every stored event (Last-Event-ID
 * resumes), then tails: each poll ticks the run (the same lazily-fired tick
 * the session poll uses), forwards new events, and emits `run` frames - the
 * full run view - only when the view's digest actually changed (step/job
 * churn is narrated by the durable events themselves; identical polls push
 * nothing). A terminal run closes the stream after a final `done` event;
 * a stream that reaches the 10-minute cap closes the same way (capped:true);
 * `:hb` comments keep proxies alive.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const parsed = RUN_ID.safeParse(rawId);
  if (!parsed.success) return json({ error: "not found" }, 404);
  const runId = parsed.data;
  try {
    const { user } = await requireApiUser(req);
    // cheap owner check before the stream/tick machinery starts - a
    // cross-user id answers 404 without touching the run
    if (!(await ownsRun(user.id, runId))) return json({ error: "not found" }, 404);

    // EventSource resume: honor Last-Event-ID; ?after= does the same manually
    const lastId = req.headers.get("last-event-id");
    const qAfter = Number(req.nextUrl.searchParams.get("after") ?? NaN);
    let after = Number.isFinite(qAfter) ? qAfter : (lastId ? Number(lastId) || 0 : 0);

    const signal = req.signal;
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const enc = new TextEncoder();
        const frame = (event: string, data: unknown, id?: number) =>
          ctrl.enqueue(enc.encode(
            `${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        const hb = () => ctrl.enqueue(enc.encode(`: hb\n\n`));
        const closed = () => { try { ctrl.close(); } catch { /* already */ } };
        try {
          // ETA medians + the custom-mode picker ctx live for the stream's
          // lifetime - frames stop re-querying per poll once computed (C2)
          const shared = newViewShared();
          const view = await getRunView(user.id, runId, shared);
          if (!view) { frame("done", { error: "not found" }); return closed(); }
          frame("snapshot", { run: view });
          let lastBeat = Date.now();
          const deadline = lastBeat + STREAM_MS;
          // run frames go out only when the view actually changed - a poll
          // with no transitions pushes nothing but the heartbeat
          let lastDigest = "";
          for (;;) {
            if (signal.aborted) return closed();
            // lazily-fired tick - same driver as the session poll; paused runs
            // still reconcile their in-flight step through this tick
            await tickRun(runId).catch(() => {});
            const events = await listRunEvents(user.id, runId, after).catch(() => []);
            for (const ev of events ?? []) {
              after = Math.max(after, ev.seq);
              frame(ev.kind, ev, ev.seq);
              lastBeat = Date.now();
            }
            const cur = await getRunView(user.id, runId, shared);
            if (!cur) { frame("done", { error: "gone" }); return closed(); }
            const digest = createHash("sha256").update(JSON.stringify(cur)).digest("hex");
            if (digest !== lastDigest) { lastDigest = digest; frame("run", { run: cur }); }
            // drain: if events are still arriving (final writes), one more
            // pass catches them next iteration; terminal + quiet → done.
            // The cap answers the same way so a long-lived run doesn't pin
            // the handler forever - the client reconnects or falls back.
            const quiet = !(events ?? []).length;
            if ((TERMINAL_RUN.has(cur.status) && quiet) || Date.now() > deadline) {
              frame("done", { status: cur.status, ...(quiet && TERMINAL_RUN.has(cur.status) ? {} : { capped: true }) });
              return closed();
            }
            if (Date.now() - lastBeat > HEARTBEAT_MS) { hb(); lastBeat = Date.now(); }
            await new Promise((r) => setTimeout(r, POLL_MS));
          }
        } catch (e) {
          if (!signal.aborted) {
            frame("error", { error: e instanceof Error ? e.message.slice(0, 200) : "stream failed" });
          }
          closed();
        }
      },
      cancel() { /* client disconnected */ },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  } catch (e) {
    return err(e);
  }
}
