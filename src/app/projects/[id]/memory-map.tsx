"use client";
import { useEffect, useState } from "react";
import { z } from "zod";

/**
 * The project page's memory map - memories down the left column, their
 * job/upload/ref targets down the right, edges between. Memory nodes are
 * focusable: click or Enter opens the detail pane - name, kind, content,
 * links, Edit (PATCH) and Forget (DELETE removes the node + its edges).
 * Target nodes show label, thumbnail, an open link, and which memories
 * link to them. All data reads through /api/agent/memories* - a foreign
 * or logged-out view renders nothing.
 */

/* wire shapes - parsed, never trusted; array fields .catch([]) so a
 * malformed element degrades to an empty list instead of throwing */
const NodeV = z.looseObject({
  id: z.string(),
  type: z.enum(["memory", "job", "upload", "ref"]),
  label: z.string(),
  detail: z.string(),
  url: z.string().optional(),
});
const EdgeV = z.looseObject({ from: z.string(), to: z.string() });
const GraphV = z.looseObject({
  nodes: z.array(NodeV).catch([]),
  edges: z.array(EdgeV).catch([]),
});
const LinkV = z.looseObject({ target_type: z.string(), target_id: z.string() });
const MemRowV = z.looseObject({
  id: z.string(), name: z.string(), kind: z.string(), content: z.string(),
  project_id: z.string().nullable(), links: z.array(LinkV).catch([]),
});
export const MemoriesV = z.looseObject({ memories: z.array(MemRowV).catch([]) });

export type MemoryNode = z.infer<typeof NodeV>;
export type MemoryEdge = z.infer<typeof EdgeV>;
export type MemoryGraphView = z.infer<typeof GraphV>;
export type MemoryRow = z.infer<typeof MemRowV>;

const NODE_W = 220;
const NODE_H = 46;
const ROW = 60;
const PAD = 20;

export function MemoryMap({ projectId, refresh = 0 }: { projectId: string; refresh?: number }) {
  const [g, setG] = useState<MemoryGraphView | null>(null);
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    fetch(`/api/agent/memories/graph?project_id=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!on) return;
        const p = GraphV.safeParse(d);
        setG(p.success ? p.data : { nodes: [], edges: [] });
      })
      .catch(() => { if (on) setG({ nodes: [], edges: [] }); });
    fetch(`/api/agent/memories?project_id=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!on) return;
        const p = MemoriesV.safeParse(d);
        if (p.success) setRows(p.data.memories);
      })
      .catch(() => {});
    return () => { on = false; };
  }, [projectId, refresh, tick]);

  if (!g) return <div className="p-8 text-center text-xs text-[var(--color-dim)]">Loading memory map…</div>;
  if (!g.nodes.length) {
    return <div className="p-8 text-center text-xs text-[var(--color-dim)]">No memories in this project yet - save one in chat ("remember …") or below.</div>;
  }

  const mems = g.nodes.filter((n) => n.type === "memory");
  const targets = g.nodes.filter((n) => n.type !== "memory");
  const memPos = new Map(mems.map((n, i) => [n.id, { x: PAD, y: PAD + i * ROW }]));
  const tgtPos = new Map(targets.map((n, i) => [n.id, { x: PAD + NODE_W + 180, y: PAD + i * ROW }]));
  const H = PAD * 2 + Math.max(mems.length, targets.length) * ROW;
  const W = PAD * 2 + NODE_W * 2 + 180;

  const node = sel ? g.nodes.find((n) => n.id === sel) ?? null : null;
  // mem:<uuid> → the full row (graph detail is truncated; the pane shows all of it)
  const memRow = node?.type === "memory" ? rows.find((r) => `mem:${r.id}` === node.id) ?? null : null;
  // which memories point at a selected target - edges arrive as mem:* -> <target>
  const linkedFrom = node && node.type !== "memory"
    ? g.edges.filter((e) => e.to === node.id)
        .map((e) => g.nodes.find((n) => n.id === e.from)?.label).filter((x): x is string => !!x)
    : [];

  const select = (id: string) => { setSel(id); setEditing(false); setNotice(null); };
  const nodeKey = (id: string) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(id); }
  };

  const saveEdit = async () => {
    if (!memRow) return;
    const r = await fetch(`/api/agent/memories/${memRow.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: draft }),
    });
    if (r.ok) { setEditing(false); setTick((t) => t + 1); setNotice("saved"); }
    else setNotice(`save failed (${r.status})`);
  };
  const forget = async () => {
    if (!memRow) return;
    const r = await fetch(`/api/agent/memories/${memRow.id}`, { method: "DELETE" });
    if (r.ok) { setSel(null); setTick((t) => t + 1); }
    else setNotice(`forget failed (${r.status})`);
  };

  const detail = node && (
    <div className="mt-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] p-3 text-xs"
      data-testid="memory-detail">
      {node.type === "memory" ? (
        <>
          <div className="flex items-center gap-2">
            <span className="font-semibold">{memRow?.name ?? node.label}</span>
            <span className="rounded bg-[var(--color-line)] px-1.5 py-0.5 text-[10px]">{memRow?.kind ?? "memory"}</span>
          </div>
          {editing ? (
            <div className="mt-2 space-y-1.5">
              <textarea data-testid="memory-edit-content" rows={3} value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="w-full resize-y rounded-md bg-[var(--color-panel2)] p-2 text-xs outline-none" />
              <div className="flex gap-1.5">
                <button className="rounded-md bg-[var(--color-line)] px-2.5 py-1 font-semibold"
                  data-testid="memory-edit-save" onClick={saveEdit}>Save</button>
                <button className="rounded-md px-2.5 py-1 text-[var(--color-dim)]" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="mt-1.5 whitespace-pre-wrap text-[var(--color-dim)]" data-testid="memory-detail-content">
              {memRow?.content ?? node.detail}
            </div>
          )}
          {!!memRow?.links.length && (
            <div className="mt-2 space-y-0.5 text-[10px] text-[var(--color-faint)]">
              {memRow.links.map((l, i) => {
                const tn = g.nodes.find((n) => n.id === `${l.target_type}:${l.target_id}`);
                return <div key={i}>→ {l.target_type} · {tn?.label ?? l.target_id.slice(0, 8)}</div>;
              })}
            </div>
          )}
          {!editing && (
            <div className="mt-2 flex gap-1.5">
              <button className="rounded-md bg-[var(--color-line)] px-2.5 py-1 font-semibold"
                data-testid="memory-edit" onClick={() => { setDraft(memRow?.content ?? ""); setEditing(true); }}>Edit</button>
              <button className="rounded-md px-2.5 py-1 text-red-300 hover:bg-red-400/10"
                data-testid="memory-forget-detail" onClick={forget}>Forget</button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            {node.url?.startsWith("/files/") && (
              <img src={node.url} alt="" className="h-10 w-10 rounded object-cover" data-testid="memory-target-thumb" />
            )}
            <div className="min-w-0">
              <div className="truncate font-semibold">{node.label}</div>
              <div className="text-[10px] text-[var(--color-dim)]">{node.detail}</div>
            </div>
          </div>
          {node.url && (
            <a href={node.url} target="_blank" rel="noreferrer"
              className="mt-1.5 inline-block text-[10px] text-[var(--color-accent)] hover:underline">open file →</a>
          )}
          <div className="mt-1.5 text-[10px] text-[var(--color-dim)]" data-testid="memory-target-backlinks">
            {linkedFrom.length
              ? <>linked from: {linkedFrom.join(", ")}</>
              : "no memories link here"}
          </div>
        </>
      )}
      {notice && <div className="mt-1 text-[10px] text-[var(--color-dim)]">{notice}</div>}
    </div>
  );

  return (
    <div>
      <svg data-testid="memory-map" viewBox={`0 0 ${W} ${H}`} className="w-full">
        {g.edges.map((e, i) => {
          const a = memPos.get(e.from);
          const b = tgtPos.get(e.to);
          if (!a || !b) return null;
          return (
            <line key={i} data-edge={`${e.from}->${e.to}`}
              x1={a.x + NODE_W} y1={a.y + NODE_H / 2}
              x2={b.x} y2={b.y + NODE_H / 2}
              stroke="var(--color-line)" strokeWidth={1.5} />
          );
        })}
        {mems.map((n) => {
          const p = memPos.get(n.id);
          if (!p) return null;
          const active = sel === n.id;
          return (
            <g key={n.id} data-node-id={n.id} data-node-type="memory"
              role="button" tabIndex={0} aria-label={`memory ${n.label}`}
              onClick={() => select(n.id)} onKeyDown={nodeKey(n.id)}
              className="cursor-pointer outline-none"
              style={{ outlineOffset: 2 }}>
              <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={10}
                fill="var(--color-panel2)" stroke={active ? "var(--color-accent)" : "var(--color-line)"}
                strokeWidth={active ? 2 : 1} />
              <text x={p.x + 12} y={p.y + 18} className="fill-current text-[11px] font-semibold" pointerEvents="none">
                {n.label.length > 26 ? `${n.label.slice(0, 26)}…` : n.label}
              </text>
              <text x={p.x + 12} y={p.y + 34} className="fill-current text-[9px] opacity-60" pointerEvents="none">
                {n.detail.length > 34 ? `${n.detail.slice(0, 34)}…` : n.detail}
              </text>
            </g>
          );
        })}
        {targets.map((n) => {
          const p = tgtPos.get(n.id);
          if (!p) return null;
          const active = sel === n.id;
          return (
            <g key={n.id} data-node-id={n.id} data-node-type={n.type}
              role="button" tabIndex={0} aria-label={`${n.type} ${n.label}`}
              onClick={() => select(n.id)} onKeyDown={nodeKey(n.id)}
              className="cursor-pointer outline-none">
              <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={10}
                fill="var(--color-panel)" stroke={active ? "var(--color-accent)" : "var(--color-line)"}
                strokeWidth={active ? 2 : 1} />
              {n.url?.startsWith("/files/") && (
                <image href={n.url} x={p.x + 6} y={p.y + 7} width={32} height={32} preserveAspectRatio="xMidYMid slice" />
              )}
              <text x={p.x + (n.url ? 46 : 12)} y={p.y + 18} className="fill-current text-[11px] font-semibold" pointerEvents="none">
                {n.label.length > 24 ? `${n.label.slice(0, 24)}…` : n.label}
              </text>
              <text x={p.x + (n.url ? 46 : 12)} y={p.y + 34} className="fill-current text-[9px] opacity-60" pointerEvents="none">
                {n.detail.length > 30 ? `${n.detail.slice(0, 30)}…` : n.detail}
              </text>
            </g>
          );
        })}
      </svg>
      {detail}
    </div>
  );
}
