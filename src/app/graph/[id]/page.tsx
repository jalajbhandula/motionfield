"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import { ErrNote } from "@/components/ErrNote";
import { userError, userErrorFrom, type UserError } from "@/lib/user-error";

type GraphNode = { class_type: string; inputs: Record<string, unknown> };
type GraphResp = {
  job_id: string; endpoint_id: string; model_id: string; workflow: string;
  params: Record<string, unknown>; prompt: string | null;
  graph: Record<string, GraphNode> | null;
  lineage: {
    forked_from: { id: string; prompt: string | null; endpoint_id: string } | null;
    forks: number;
  };
};

export default function GraphPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: session } = useSession();
  const [data, setData] = useState<GraphResp | null>(null);
  const [err, setErr] = useState<UserError | string | null>(null);
  const [editing, setEditing] = useState(false);
  const [graphText, setGraphText] = useState("");
  const [forking, setForking] = useState(false);
  const [forkedId, setForkedId] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/jobs/${id}/graph`).then(async (r) => ({ r, d: await r.json().catch(() => ({})) }))
      .then(({ r, d }) => {
        if (!r.ok || d.error) setErr(userError(r.status, d.error ?? "failed to load"));
        else { setData(d); setGraphText(JSON.stringify(d.graph ?? {}, null, 2)); }
      }).catch(() => setErr("Couldn't reach the server - check your connection."));
  }, [id]);

  async function fork() {
    if (!data) return;
    setForking(true); setErr(null);
    try {
      let graph: unknown = data.graph;
      if (editing) {
        try { graph = JSON.parse(graphText); }
        catch { setErr("graph JSON is invalid"); setForking(false); return; }
      }
      const r = await fetch("/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint_id: data.endpoint_id,
          params: data.params,
          graph_json: graph,
          graph_forked_from: data.job_id,
          parent_job_id: data.job_id,
        }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(userError(r.status, d.error ?? "fork failed")); setForking(false); return; }
      setForkedId(d.job.id);
    } catch (e) {
      setErr(userErrorFrom(e)); setForking(false);
    }
  }

  if (err && !data) return <div className="mx-auto max-w-3xl p-12 text-center"><ErrNote err={err} /></div>;
  if (!data) return <div className="mx-auto max-w-3xl p-12"><div className="skeleton h-64 rounded-2xl" /></div>;

  const nodes = Object.entries(data.graph ?? {});
  const inputNodes = nodes.filter(([, n]) =>
    /load|input|image|video|audio/i.test(n.class_type));

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-8">
      <Link href="/community" className="text-xs text-[var(--color-dim)] hover:text-[var(--color-text)]">← Community</Link>
      <div className="mt-3 flex items-start justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold">Workflow graph</h1>
          <p className="mt-1 text-[var(--color-dim)]">
            {data.workflow} · {data.model_id} · {nodes.length} nodes
          </p>
        </div>
        <div className="flex gap-2">
          <button className={`chip ${editing ? "chip-on" : ""}`} onClick={() => setEditing((e) => !e)}>Edit</button>
          <button className="btn" disabled={!session?.user || forking || !!forkedId} onClick={fork}>
            {forkedId ? "Forked ✓" : forking ? "Forking…" : "Fork & run"}
          </button>
        </div>
      </div>
      {forkedId && (
        <div className="mt-3 rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-4 py-3 text-sm">
          Fork submitted - <Link className="underline" href={`/jobs/${forkedId}`}>track job {forkedId.slice(0, 8)}</Link>
        </div>
      )}
      <ErrNote err={err} className="mt-3" />

      {data.prompt && <p className="mt-4 line-clamp-3 max-w-3xl text-sm text-[var(--color-dim)]">“{data.prompt}”</p>}

      <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="panel overflow-hidden">
          {editing ? (
            <textarea
              className="h-[560px] w-full resize-none bg-transparent p-4 font-mono text-xs leading-relaxed text-[var(--color-text)] focus:outline-none"
              value={graphText} onChange={(e) => setGraphText(e.target.value)} spellCheck={false} />
          ) : (
            <div className="max-h-[560px] overflow-auto p-4">
              {nodes.map(([nid, n]) => (
                <div key={nid} className="mb-2 rounded-lg border border-[var(--color-border)] px-3 py-2">
                  <div className="flex items-baseline justify-between">
                    <span className="font-mono text-xs text-[var(--color-accent)]">{n.class_type}</span>
                    <span className="font-mono text-[10px] text-[var(--color-dim)]">#{nid}</span>
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {Object.entries(n.inputs).slice(0, 6).map(([k, v]) => (
                      <div key={k} className="flex gap-2 font-mono text-[11px] text-[var(--color-dim)]">
                        <span className="shrink-0 text-[var(--color-text)]/70">{k}</span>
                        <span className="truncate">{typeof v === "object" ? JSON.stringify(v) : String(v).slice(0, 80)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {nodes.length === 0 && <p className="p-8 text-center text-sm text-[var(--color-dim)]">No graph snapshot - job ran before graph capture or on a non-Comfy provider.</p>}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="panel p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-dim)]">Inputs</h3>
            {inputNodes.length === 0 && <p className="mt-2 text-xs text-[var(--color-dim)]">No media inputs.</p>}
            {inputNodes.map(([nid, n]) => (
              <div key={nid} className="mt-2 font-mono text-[11px]">
                <div className="text-[var(--color-accent)]">{n.class_type}</div>
                <div className="text-[var(--color-dim)] truncate">{JSON.stringify(n.inputs).slice(0, 120)}</div>
              </div>
            ))}
            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--color-dim)]">Params</h3>
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[11px] text-[var(--color-dim)]">
              {JSON.stringify(data.params, null, 1)}
            </pre>
          </div>

          <div className="panel p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-dim)]">Lineage</h3>
            <div className="mt-2 space-y-2 text-sm">
              {data.lineage.forked_from ? (
                <Link href={`/graph/${data.lineage.forked_from.id}`} className="block rounded-lg border border-[var(--color-border)] px-3 py-2 hover:border-[var(--color-accent)]">
                  <span className="text-[10px] uppercase text-[var(--color-dim)]">forked from</span>
                  <div className="truncate font-mono text-xs">{data.lineage.forked_from.id.slice(0, 8)} · {data.lineage.forked_from.endpoint_id}</div>
                  {data.lineage.forked_from.prompt && <div className="mt-0.5 line-clamp-1 text-xs text-[var(--color-dim)]">{data.lineage.forked_from.prompt}</div>}
                </Link>
              ) : (
                <div className="text-xs text-[var(--color-dim)]">Original workflow - not forked.</div>
              )}
              <div className="text-xs text-[var(--color-dim)]">{data.lineage.forks} fork{data.lineage.forks === 1 ? "" : "s"} of this graph</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
