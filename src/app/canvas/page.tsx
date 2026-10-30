"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Panel,
  addEdge, reconnectEdge, useNodesState, useEdgesState, useReactFlow,
  Handle, Position,
  type Node, type Edge, type Connection, type NodeProps, type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Download, Play, Redo2, Undo2, Upload, X } from "lucide-react";
import { apiJson, uploadFile, userErrorFrom, type UserError } from "@/lib/user-error";
import { ErrNote } from "@/components/ErrNote";
import { CANVAS_NODES } from "@/lib/agent-defaults";
import { Lightbox, type LightboxItem } from "@/components/Lightbox";

/** Infinite canvas - node board: Prompt → Image/Video/Audio gen chains.
 *  Node inputs resolve by walking upstream edges: each runnable node pulls
 *  the nearest upstream prompt + the nearest upstream media output of each
 *  kind it needs. Same /api/jobs contract as the studios.
 *
 *  Boards autosave to this browser (volatile run state is stripped). Undo
 *  snapshots capture structure, not in-flight jobs - undoing a deleted node
 *  that was running leaves its job to finish server-side. */

type Kind = "prompt" | "image" | "video" | "audio" | "swap" | "character" | "lipsync";
type CanvasData = {
  kind: Kind; prompt: string; status: string; output?: string; jobId?: string; error?: UserError; consent?: boolean; progress?: number;
  onChange: (id: string, patch: Partial<CanvasData>) => void;
  onRun: (id: string) => void;
  onRemove: (id: string) => void;
  onView: (item: LightboxItem) => void;
};
type CanvasNode = Node<CanvasData, "canvasNode">;

/** Serializable board - everything except callbacks and run state. */
type SavedNode = { id: string; kind: Kind; x: number; y: number; prompt: string; output?: string; consent?: boolean };
type SavedEdge = { source: string; target: string };
type BoardDoc = { v: 1; nodes: SavedNode[]; edges: SavedEdge[] };
type Snapshot = { nodes: { id: string; position: { x: number; y: number }; data: Omit<CanvasData, "onChange" | "onRun" | "onRemove" | "onView" | "status" | "jobId" | "error" | "progress"> }[]; edges: SavedEdge[] };

const STORAGE_KEY = "motionfield.canvas.v1";
const HISTORY_CAP = 60;

const KIND_LABEL: Record<Kind, string> = { prompt: "Prompt", image: "Image", video: "Video", audio: "Audio", swap: "Swap", character: "Character", lipsync: "Lip sync" };
const KINDS = Object.keys(KIND_LABEL) as Kind[];
/** media kinds each node can consume from upstream */
const NEEDS: Partial<Record<Kind, Kind[]>> = {
  video: ["image"], swap: ["video", "image"], character: ["image"], lipsync: ["video", "audio"],
};
const OUT_KIND: Record<Kind, "image" | "video" | "audio" | null> = {
  prompt: null, image: "image", character: "image", video: "video", swap: "video", lipsync: "video", audio: "audio",
};
const RUNNABLE = new Set<Kind>(Object.keys(CANVAS_NODES) as Kind[]);

let nid = 0;
let eid = 0;
const mk = (kind: Kind, pos: { x: number; y: number }, prompt: string, cbs: Pick<CanvasData, "onChange" | "onRun" | "onRemove" | "onView">, extra: Partial<CanvasData> = {}): CanvasNode =>
  ({ id: `n${++nid}`, type: "canvasNode", position: pos, data: { kind, prompt, status: "idle", ...cbs, ...extra } });

/** Prewired starter boards - real chains, not decorations. Positions are
 *  relative; the board drops them in around the viewport center. */
const TEMPLATES: { name: string; build: () => { kind: Kind; prompt: string; x: number; y: number }[]; wires: [number, number][] }[] = [
  { name: "Text to video",
    build: () => [
      { kind: "prompt", prompt: "A fishing boat cutting through fog at dawn, slow push-in", x: 0, y: 60 },
      { kind: "image", prompt: "", x: 340, y: 0 },
      { kind: "video", prompt: "keep the composition, gentle motion", x: 680, y: 90 },
    ], wires: [[0, 1], [1, 2]] },
  { name: "Character to video",
    build: () => [
      { kind: "prompt", prompt: "A street magician in a rain-soaked alley", x: 0, y: 60 },
      { kind: "character", prompt: "", x: 340, y: 0 },
      { kind: "video", prompt: "", x: 680, y: 90 },
    ], wires: [[0, 1], [1, 2]] },
  { name: "Dub a clip",
    build: () => [
      { kind: "video", prompt: "translate to Spanish", x: 0, y: 40 },
      { kind: "audio", prompt: "", x: 340, y: 160 },
      { kind: "lipsync", prompt: "", x: 680, y: 80 },
    ], wires: [[0, 2], [1, 2]] },
  { name: "Swap in a scene",
    build: () => [
      { kind: "image", prompt: "the person to place", x: 0, y: 160 },
      { kind: "video", prompt: "the source clip", x: 340, y: 40 },
      { kind: "swap", prompt: "", x: 680, y: 90 },
    ], wires: [[0, 2], [1, 2]] },
];

const STATUS_COLOR: Record<string, string> = {
  running: "var(--color-accent)", completed: "#8be06b", failed: "var(--color-danger)", idle: "var(--color-faint)",
};

function CanvasNodeCard({ id, data, selected }: NodeProps<CanvasNode>) {
  const running = data.status === "running" || data.status === "uploading" || data.status === "queued" || data.status === "in_progress";
  return (
    <div className={`canvas-node ${selected ? "canvas-node-sel" : ""} nodrag-default`}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: STATUS_COLOR[running ? "running" : data.status === "completed" ? "completed" : data.status === "failed" ? "failed" : "idle"], boxShadow: running ? "0 0 8px var(--color-accent)" : "none" }} />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-dim)]">{KIND_LABEL[data.kind]}</span>
        </span>
        <button className="text-[var(--color-faint)] hover:text-white nodrag" onClick={() => data.onRemove(id)} title="Remove node"><X size={12} /></button>
      </div>
      <textarea
        className="input mt-2 min-h-14 w-full resize-y text-xs nodrag nowheel"
        placeholder={data.kind === "prompt" ? "Prompt…" : "Override prompt (optional)"}
        value={data.prompt}
        onChange={(e) => data.onChange(id, { prompt: e.target.value })}
      />
      {(["image", "video", "audio"] as Kind[]).includes(data.kind) && (
        <label className="mt-2 block text-xs text-[var(--color-dim)] nodrag">
          Use a file
          <input type="file" aria-label={`Upload ${data.kind}`} accept={`${data.kind}/*`} disabled={running}
            className="mt-1 block w-full text-[11px]"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              data.onChange(id, { status: "uploading", error: undefined });
              try {
                const { url } = await uploadFile(file);
                data.onChange(id, { output: url, status: "completed" });
              } catch (error) {
                data.onChange(id, { status: "failed", error: userErrorFrom(error) });
              }
            }} />
        </label>
      )}
      {(data.kind === "swap" || data.kind === "lipsync") && (
        <label className="mt-2 flex gap-2 text-xs nodrag"><input type="checkbox" checked={!!data.consent} onChange={(e) => data.onChange(id, { consent: e.target.checked })} />I have the right to use this person's likeness</label>
      )}
      <ErrNote err={data.error} className="mt-2" />
      {data.output && (
        <button type="button" className="media-tile mt-2 block aspect-video w-full cursor-zoom-in nodrag" title="Open fullscreen"
          onClick={() => data.onView({ url: data.output!, type: OUT_KIND[data.kind] === "audio" ? "audio" : OUT_KIND[data.kind] === "video" ? "video" : "image", label: data.prompt, prompt: data.prompt })}>
          {OUT_KIND[data.kind] === "video" ? <video src={data.output} muted loop autoPlay playsInline />
            : OUT_KIND[data.kind] === "audio" ? <audio src={data.output} controls />
            : /* eslint-disable-next-line @next/next/no-img-element */ <img src={data.output} alt="Node output" />}
        </button>
      )}
      {running && data.progress != null && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--color-raised)]">
          <div className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-500" style={{ width: `${Math.max(2, Math.min(100, data.progress))}%` }} />
        </div>
      )}
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-[var(--color-dim)]">
          {running && data.progress != null ? `${data.status} · ${Math.round(data.progress)}%` : data.status}
        </span>
        {data.kind !== "prompt" && (
          <button className="btn btn-primary btn-sm nodrag" disabled={running} onClick={() => data.onRun(id)}>
            <Play size={11} className="mr-1 inline-block" /> Run
          </button>
        )}
      </div>
    </div>
  );
}

function FlowNode(props: NodeProps<CanvasNode>) {
  const { data } = props;
  return (
    <>
      {data.kind !== "prompt" && <Handle type="target" position={Position.Left} className="canvas-handle" />}
      <CanvasNodeCard {...props} />
      <Handle type="source" position={Position.Right} className="canvas-handle" />
    </>
  );
}

const nodeTypes: NodeTypes = { canvasNode: FlowNode };

/** nearest upstream nodes of each kind (BFS over incoming edges) */
function upstream(nodeId: string, nodes: CanvasNode[], edges: Edge[]): CanvasNode[] {
  const seen = new Set<string>([nodeId]);
  const out: CanvasNode[] = [];
  const queue = edges.filter((e) => e.target === nodeId).map((e) => e.source);
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = nodes.find((x) => x.id === id);
    if (!n) continue;
    out.push(n);
    queue.push(...edges.filter((e) => e.target === id).map((e) => e.source));
  }
  return out;
}

/** Kahn's algorithm over runnable nodes - the order a chain must execute in. */
function chainOrder(nodes: CanvasNode[], edges: Edge[]): string[] {
  const runnable = new Map(nodes.filter((n) => RUNNABLE.has(n.data.kind)).map((n) => [n.id, n]));
  const indeg = new Map<string, number>([...runnable.keys()].map((id) => [id, 0]));
  for (const e of edges) if (runnable.has(e.target)) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of edges.filter((x) => x.source === id)) {
      if (!runnable.has(e.target)) continue;
      const d = (indeg.get(e.target) ?? 1) - 1;
      indeg.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  return order;
}

const stripData = ({ onChange: _c, onRun: _r, onRemove: _x, onView: _v, status: _s, jobId: _j, error: _e, progress: _p, ...keep }: CanvasData): Snapshot["nodes"][number]["data"] => keep;

const isTypingTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

function Board() {
  const runRef = useRef<(id: string) => Promise<boolean>>(async () => false);
  const nodesRef = useRef<CanvasNode[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const active = useRef(new Map<string, { controller: AbortController; timer?: ReturnType<typeof setTimeout>; resolve?: (ok: boolean) => void }>());
  const stop = useCallback((id: string, ok = false) => {
    const run = active.current.get(id);
    if (!run) return;
    run.controller.abort();
    clearTimeout(run.timer);
    active.current.delete(id);
    run.resolve?.(ok);
  }, []);
  useEffect(() => () => { for (const id of active.current.keys()) stop(id); }, [stop]);
  const onViewRef = useRef<(i: LightboxItem) => void>(() => {});
  const [viewer, setViewer] = useState<LightboxItem | null>(null);
  onViewRef.current = setViewer;

  const snapshot = useCallback((): Snapshot => ({
    nodes: nodesRef.current.map((n) => ({ id: n.id, position: { ...n.position }, data: stripData(n.data) })),
    edges: edgesRef.current.map((e) => ({ source: e.source, target: e.target })),
  }), []);

  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const lastCommit = useRef(0);
  const commit = useCallback(() => {
    lastCommit.current = Date.now();
    past.current.push(snapshot());
    if (past.current.length > HISTORY_CAP) past.current.shift();
    future.current = [];
  }, [snapshot]);
  /** coalesce rapid edits (typing, dragging) into one history entry */
  const pendingSnapshot = useRef<Snapshot | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commitSoon = useCallback(() => {
    if (!pendingSnapshot.current) pendingSnapshot.current = snapshot();
    clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(() => {
      if (pendingSnapshot.current) {
        past.current.push(pendingSnapshot.current);
        if (past.current.length > HISTORY_CAP) past.current.shift();
        future.current = [];
        pendingSnapshot.current = null;
      }
    }, 900);
  }, [snapshot]);

  const patchNode = useCallback((id: string, patch: Partial<CanvasData>) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
  }, []);
  const editNode = useCallback((id: string, patch: Partial<CanvasData>) => {
    commitSoon();
    patchNode(id, patch);
  }, [commitSoon, patchNode]);
  const removeNode = useCallback((id: string) => {
    commit();
    stop(id);
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
  }, [commit, stop]);

  const cbs = useRef({ onChange: (id: string, p: Partial<CanvasData>) => editNode(id, p), onRun: (id: string) => { void runRef.current(id); }, onRemove: (id: string) => removeNode(id), onView: (i: LightboxItem) => onViewRef.current(i) }).current;

  const revive = useCallback((s: Snapshot): { nodes: CanvasNode[]; edges: Edge[] } => ({
    nodes: s.nodes.map((n) => ({ id: n.id, type: "canvasNode" as const, position: n.position, data: { ...n.data, status: n.data.output ? "completed" : "idle", ...cbs } })),
    edges: s.edges.map((e) => ({ id: `e${++eid}`, ...e, animated: false })),
  }), [cbs]);

  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { screenToFlowPosition, fitView } = useReactFlow();

  // restore the saved board, else seed the text→video chain - the ref guard
  // keeps StrictMode's dev double-mount from seeding a second copy
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    let doc: Snapshot | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as BoardDoc;
        if (parsed.v === 1 && Array.isArray(parsed.nodes)) {
          doc = {
            nodes: parsed.nodes.filter((n) => KINDS.includes(n.kind)).map((n) => ({
              id: n.id, position: { x: n.x, y: n.y },
              data: { kind: n.kind, prompt: n.prompt, output: n.output, consent: n.consent } as Snapshot["nodes"][number]["data"],
            })),
            edges: parsed.edges,
          };
        }
      }
    } catch { /* corrupt storage - start fresh */ }
    if (!doc || doc.nodes.length === 0) {
      const t = TEMPLATES[0];
      const made = t.build().map((n) => mk(n.kind, { x: n.x, y: n.y }, n.prompt, cbs));
      doc = {
        nodes: made.map((n) => ({ id: n.id, position: n.position, data: stripData(n.data) })),
        edges: t.wires.map(([a, b]) => ({ source: made[a].id, target: made[b].id })),
      };
    }
    const { nodes: ns, edges: es } = revive(doc);
    nid = Math.max(0, ...ns.map((n) => Number(n.id.slice(1)) || 0));
    setNodes(ns);
    setEdges(es);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  nodesRef.current = nodes;
  edgesRef.current = edges;

  // autosave: serialize after edits settle; run state never persists
  useEffect(() => {
    if (!nodes.length) return;
    const t = setTimeout(() => {
      const doc: BoardDoc = {
        v: 1,
        nodes: nodesRef.current.map((n) => ({ id: n.id, kind: n.data.kind, x: Math.round(n.position.x), y: Math.round(n.position.y), prompt: n.data.prompt, output: n.data.output, consent: n.data.consent })),
        edges: edgesRef.current.map((e) => ({ source: e.source, target: e.target })),
      };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(doc)); } catch { /* quota - skip */ }
    }, 600);
    return () => clearTimeout(t);
  }, [nodes, edges]);

  const onConnect = useCallback((c: Connection) => { commit(); setEdges((es) => addEdge({ ...c, animated: false }, es)); }, [commit, setEdges]);

  // re-wire: grab an edge's end and drop it on another handle to move the
  // connection; drop it on empty canvas to sever it (ComfyUI behaviour)
  const reconnectOk = useRef(true);
  const onReconnectStart = useCallback(() => { reconnectOk.current = false; }, []);
  const onReconnect = useCallback((oldEdge: Edge, conn: Connection) => {
    reconnectOk.current = true;
    commit();
    setEdges((es) => reconnectEdge(oldEdge, conn, es));
  }, [commit, setEdges]);
  const onReconnectEnd = useCallback((_: MouseEvent | TouchEvent, edge: Edge) => {
    if (!reconnectOk.current) { commit(); setEdges((es) => es.filter((e) => e.id !== edge.id)); }
  }, [commit, setEdges]);
  // deleted edges/nodes via the Delete key are history-worthy too; a node
  // removal also deletes its edges in the same tick, so commit once
  const onEdgesDelete = useCallback(() => { if (Date.now() - lastCommit.current > 50) commit(); }, [commit]);
  const onNodesDelete = useCallback((deleted: CanvasNode[]) => { if (Date.now() - lastCommit.current > 50) commit(); deleted.forEach((n) => stop(n.id)); }, [commit, stop]);
  const onNodeDragStart = useCallback(() => { if (!pendingSnapshot.current) pendingSnapshot.current = snapshot(); }, [snapshot]);
  const onNodeDragStop = useCallback(() => {
    const s = pendingSnapshot.current;
    pendingSnapshot.current = null;
    if (s) { past.current.push(s); if (past.current.length > HISTORY_CAP) past.current.shift(); future.current = []; }
  }, []);

  function addNode(kind: Kind, pos?: { x: number; y: number }) {
    commit();
    const p = pos ?? screenToFlowPosition({ x: window.innerWidth / 2 + (Math.random() * 160 - 80), y: window.innerHeight / 2 + (Math.random() * 120 - 60) });
    setNodes((ns) => [...ns, mk(kind, p, "", cbs)]);
  }

  function loadTemplate(ix: number) {
    const t = TEMPLATES[ix];
    if (!t) return;
    commit();
    const origin = screenToFlowPosition({ x: window.innerWidth / 2 - 340, y: window.innerHeight / 2 - 120 });
    const made = t.build().map((n) => mk(n.kind, { x: origin.x + n.x, y: origin.y + n.y }, n.prompt, cbs));
    setNodes((ns) => [...ns, ...made]);
    setEdges((es) => [...es, ...t.wires.map(([a, b]) => ({ id: `e${++eid}`, source: made[a].id, target: made[b].id, animated: false }))]);
    void fitView({ padding: 0.2, duration: 300 });
  }

  const undo = useCallback(() => {
    const s = past.current.pop();
    if (!s) return;
    future.current.push(snapshot());
    const { nodes: ns, edges: es } = revive(s);
    setNodes(ns); setEdges(es);
  }, [revive, setNodes, setEdges, snapshot]);
  const redo = useCallback(() => {
    const s = future.current.pop();
    if (!s) return;
    past.current.push(snapshot());
    const { nodes: ns, edges: es } = revive(s);
    setNodes(ns); setEdges(es);
  }, [revive, setNodes, setEdges, snapshot]);

  const clipboard = useRef<{ nodes: { kind: Kind; x: number; y: number; prompt: string; output?: string; consent?: boolean }[]; edges: [number, number][] } | null>(null);
  const copySelection = useCallback(() => {
    const sel = nodesRef.current.filter((n) => n.selected);
    if (!sel.length) return;
    const ix = new Map(sel.map((n, i) => [n.id, i]));
    clipboard.current = {
      nodes: sel.map((n) => ({ kind: n.data.kind, x: n.position.x, y: n.position.y, prompt: n.data.prompt, output: n.data.output, consent: n.data.consent })),
      edges: edgesRef.current.filter((e) => ix.has(e.source) && ix.has(e.target)).map((e) => [ix.get(e.source)!, ix.get(e.target)!]),
    };
  }, []);
  const pasteClipboard = useCallback(() => {
    const clip = clipboard.current;
    if (!clip?.nodes.length) return;
    commit();
    const made = clip.nodes.map((n) => mk(n.kind, { x: n.x + 48, y: n.y + 48 }, n.prompt, cbs, { output: n.output, consent: n.consent, status: n.output ? "completed" : "idle" }));
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), ...made]);
    setEdges((es) => [...es, ...clip.edges.map(([a, b]) => ({ id: `e${++eid}`, source: made[a].id, target: made[b].id, animated: false }))]);
  }, [cbs, commit, setNodes, setEdges]);

  const exportBoard = useCallback(() => {
    const doc: BoardDoc = {
      v: 1,
      nodes: nodesRef.current.map((n) => ({ id: n.id, kind: n.data.kind, x: Math.round(n.position.x), y: Math.round(n.position.y), prompt: n.data.prompt, output: n.data.output, consent: n.data.consent })),
      edges: edgesRef.current.map((e) => ({ source: e.source, target: e.target })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = "motionfield-board.json"; a.click();
    URL.revokeObjectURL(url);
  }, []);

  const importFile = useRef<HTMLInputElement>(null);
  const importBoard = useCallback(async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as BoardDoc;
      if (parsed.v !== 1 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) throw new Error("Not a MotionField board file.");
      commit();
      const doc: Snapshot = {
        nodes: parsed.nodes.filter((n) => KINDS.includes(n.kind)).map((n) => ({
          id: `n${++nid}`, position: { x: n.x, y: n.y },
          data: { kind: n.kind, prompt: n.prompt, output: n.output, consent: n.consent } as Snapshot["nodes"][number]["data"],
        })),
        edges: [],
      };
      const remap = new Map(parsed.nodes.map((n, i) => [n.id, doc.nodes[i]?.id]).filter(([, id]) => id) as [string, string][]);
      doc.edges = parsed.edges.filter((e) => remap.has(e.source) && remap.has(e.target)).map((e) => ({ source: remap.get(e.source)!, target: remap.get(e.target)! }));
      const { nodes: ns, edges: es } = revive(doc);
      setNodes(ns); setEdges(es);
      void fitView({ padding: 0.2, duration: 300 });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not import that file.");
    }
  }, [commit, revive, setNodes, setEdges, fitView]);

  const newBoard = useCallback(() => {
    commit();
    for (const id of active.current.keys()) stop(id);
    setNodes([]); setEdges([]);
    const t = TEMPLATES[0];
    const made = t.build().map((n) => mk(n.kind, { x: n.x, y: n.y }, n.prompt, cbs));
    setNodes(made);
    setEdges(t.wires.map(([a, b]) => ({ id: `e${++eid}`, source: made[a].id, target: made[b].id, animated: false })));
    void fitView({ padding: 0.2, duration: 300 });
  }, [cbs, commit, setNodes, setEdges, stop, fitView]);

  const [chainBusy, setChainBusy] = useState(false);
  const runChain = useCallback(async () => {
    if (chainBusy) return;
    setChainBusy(true);
    try {
      for (const id of chainOrder(nodesRef.current, edgesRef.current)) {
        const node = nodesRef.current.find((n) => n.id === id);
        if (!node || node.data.status === "completed" || node.data.status === "running" || node.data.status === "in_progress") continue;
        if (!(await runRef.current(id))) break; // a failed upstream dooms the rest
      }
    } finally {
      setChainBusy(false);
    }
  }, [chainBusy]);

  // shortcuts: undo/redo/copy/paste/duplicate - ignored while typing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
      else if (k === "c") copySelection();
      else if (k === "v" || k === "d") { e.preventDefault(); pasteClipboard(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, copySelection, pasteClipboard]);

  async function runNode(id: string): Promise<boolean> {
    const nodes = nodesRef.current, edges = edgesRef.current;
    const node = nodes.find((n) => n.id === id);
    if (!node || node.data.kind === "prompt" || active.current.has(id)) return true;
    const ups = upstream(id, nodes, edges);
    const prompt = node.data.prompt || ups.find((n) => n.data.prompt)?.data.prompt || "";
    const mediaOf = (kind: Kind) => ups.find((n) => OUT_KIND[n.data.kind] === kind && n.data.output)?.data.output;
    const params: Record<string, unknown> = { prompt };
    const fail = (e: unknown) => { patchNode(id, { status: "failed", error: userErrorFrom(e) }); return false; };
    for (const kind of NEEDS[node.data.kind] ?? []) {
      const media = mediaOf(kind);
      if (!media) return fail(new Error(`Connect a completed ${KIND_LABEL[kind].toLowerCase()} node first.`));
      if (kind === "image") {
        if (node.data.kind === "video") params.image_url = media;
        else params.image_urls = [media];
      } else params[`${kind}_url`] = media;
    }
    if (node.data.kind === "swap" || node.data.kind === "lipsync") {
      if (!node.data.consent) return fail(new Error("Confirm that you have the right to use this person's likeness."));
      params.likeness_consent = true;
    }
    if (node.data.kind === "character") params.batch_size = 2;
    let jobId = "";
    return new Promise<boolean>((resolvePromise) => {
      const run: { controller: AbortController; timer?: ReturnType<typeof setTimeout>; resolve?: (ok: boolean) => void } = { controller: new AbortController(), resolve: resolvePromise };
      active.current.set(id, run);
      patchNode(id, { status: "running", error: undefined, output: undefined, progress: 0 });
      const request = (url: string, init?: RequestInit) =>
        fetch(url, { ...init, signal: run.controller.signal }).then(apiJson<{ job: { id: string; status: string; progress?: number; error?: string; outputs?: { url: string }[] } }>);
      const finish = (ok: boolean) => { active.current.delete(id); clearTimeout(run.timer); resolvePromise(ok); };
      const poll = async () => {
        try {
          const { job } = await request(`/api/jobs/${jobId}`);
          if (run.controller.signal.aborted) return;
          if (["completed", "failed", "canceled"].includes(job.status)) {
            patchNode(id, { status: job.status, output: job.outputs?.[0]?.url, progress: job.status === "completed" ? 100 : job.progress,
              error: job.error ? userErrorFrom(new Error(job.error)) : undefined });
            finish(job.status === "completed");
          } else {
            patchNode(id, { status: job.status, progress: job.progress });
            run.timer = setTimeout(poll, 1200);
          }
        } catch (e) {
          if (!run.controller.signal.aborted) { patchNode(id, { status: "failed", error: userErrorFrom(e) }); finish(false); }
        }
      };
      void (async () => {
        try {
          const { job } = await request("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint_id: CANVAS_NODES[node.data.kind], params }) });
          if (run.controller.signal.aborted) return;
          jobId = job.id;
          patchNode(id, { jobId });
          run.timer = setTimeout(poll, 1200);
        } catch (e) {
          if (!run.controller.signal.aborted) { patchNode(id, { status: "failed", error: userErrorFrom(e) }); finish(false); }
        }
      })();
    });
  }
  runRef.current = runNode;

  return (
    <div className="h-[calc(100dvh-3.5rem)] w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onReconnectStart={onReconnectStart}
        onReconnect={onReconnect}
        onReconnectEnd={onReconnectEnd}
        edgesReconnectable
        reconnectRadius={20}
        connectionRadius={44}
        connectionLineStyle={{ stroke: "var(--color-accent)", strokeWidth: 1.5 }}
        defaultEdgeOptions={{ style: { stroke: "rgba(255,255,255,.35)", strokeWidth: 1.5 } }}
        deleteKeyCode={["Backspace", "Delete"]}
        colorMode="dark"
        fitView
        minZoom={0.2}
        maxZoom={2}
      >
        <Background gap={24} size={1} color="rgba(255,255,255,.08)" />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap position="bottom-right" pannable zoomable
          style={{ background: "var(--color-panel)" }}
          nodeColor="var(--color-panel2)"
          maskColor="rgba(0,0,0,.6)" />
        <Panel position="top-left" className="flex items-center gap-3">
          <h1 className="font-display text-sm font-semibold text-[var(--color-text)]">Canvas</h1>
          <p className="text-[11px] text-[var(--color-faint)]">drag to pan · scroll to zoom · pull a handle to connect · ⌘Z undo · ⌘C/V copy</p>
        </Panel>
        <Panel position="top-right" className="flex flex-wrap items-center justify-end gap-1.5">
          <select aria-label="Load a starter chain" defaultValue="" onChange={(e) => { const i = Number(e.target.value); e.target.value = ""; if (!Number.isNaN(i) && TEMPLATES[i]) loadTemplate(i); }}
            className="chip cursor-pointer border-0 bg-[var(--color-panel2)]">
            <option value="" disabled>+ Chain</option>
            {TEMPLATES.map((t, i) => <option key={t.name} value={i}>{t.name}</option>)}
          </select>
          {KINDS.map((t) => (
            <button key={t} className="chip capitalize hover:text-white" onClick={() => addNode(t)}>+ {KIND_LABEL[t].toLowerCase()}</button>
          ))}
          <button className="chip hover:text-white" onClick={undo} title="Undo (⌘Z)"><Undo2 size={12} /></button>
          <button className="chip hover:text-white" onClick={redo} title="Redo (⌘⇧Z)"><Redo2 size={12} /></button>
          <button className="chip hover:text-white" onClick={exportBoard} title="Download board JSON"><Download size={12} /></button>
          <button className="chip hover:text-white" onClick={() => importFile.current?.click()} title="Import board JSON"><Upload size={12} /></button>
          <input ref={importFile} type="file" accept="application/json" className="hidden" aria-label="Import board file"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importBoard(f); }} />
          <button className="chip hover:text-white" onClick={newBoard} title="Start a fresh board">New</button>
          <button className="btn btn-primary btn-sm" disabled={chainBusy} onClick={() => void runChain()} title="Run every node in order">
            <Play size={12} className="mr-1" />{chainBusy ? "Running…" : "Run all"}
          </button>
        </Panel>
      </ReactFlow>
      <Lightbox item={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}

export default function Canvas() {
  return <ReactFlowProvider><Board /></ReactFlowProvider>;
}
