"use client";
import Link from "next/link";
import { usePopoverGroup } from "@/lib/use-dismiss";
import { Box, Camera, Pause, PersonStanding, Play, Shapes, Sun, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Viewport, { type StageView, type ViewportApi, type XformMode } from "./viewport";
import {
  ASPECTS,
  ASPECT_SIZE,
  LIGHT_KINDS,
  MANNEQUIN_POSES,
  NODE_KINDS,
  PRIMITIVE_SHAPES,
  makeNode,
  newNodeId,
  nodeById,
  renderCamera,
  stageSceneSchema,
  SENSORS_LIST,
  type Aspect,
  type LightKind,
  type MannequinPose,
  type PrimitiveShape,
  type StageNode,
  type StageScene,
  type Vec3,
} from "@/lib/stage/scene";
import { applyMoveToCamera, MOVE_IDS } from "@/lib/stage/moves";
import { userError } from "@/lib/user-error";
import { applyCameraPreset, CAMERA_PRESETS, overviewCameraPose, presetSubjects } from "@/lib/stage/presets";
import { poseThumb } from "@/lib/stage/pose-thumbs";
import { cameraAt, sampleNodeLocal, sampleScene } from "@/lib/stage/sample";
import { inspectScene } from "@/lib/stage/inspect";
import { focalForHFov, hFov, type SensorName } from "@/lib/camera/lens";
import { exportCameraPath } from "@/lib/stage/export-path";
import {
  STAGE_RENDER_FPS, STAGE_OVERLAP, STAGE_MAX_DURATION_S,
  composeRenderPrompt, stageFrameCount, stageRenderSize, stageWindows,
} from "@/lib/stage/render-plan";
import { comingSoonReason } from "@/lib/catalog/coming-soon";

/** Video render rides the stage-render GPU recipe; while that is gated the
 *  editor (LLM blocking, orbit, stills, export) still works and says so. */
const RENDER_GATE = comingSoonReason("motionfield/stage/render");

/**
 * /scene-3d/[id] - the blocking editor. The scene document lives in React state;
 * every mutation goes through mutate() → clone → validate → undo-snapshot →
 * 2 s autosave debounce → PUT with base_revision (409 = server won, surface
 * a reload banner rather than clobber). Gestures (gizmo/path drags, numeric
 * field typing) preview through preview() and commit once at gesture end so
 * undo stays per-gesture. Autosaves serialize through a queue (out-of-order
 * PUTs could ping-pong 409s) and carry the editor's session_id so the server
 * can collapse one editing session into one 'save' revision row.
 */

interface SceneRow {
  id: string; title: string; scene: unknown;
  refs: { url: string; description?: string }[];
  refs_read?: boolean;
  revision: number; created_at: string; updated_at: string;
}

interface RevListItem {
  revision: number; source: string; title: string | null;
  node_count: number; created_at: string;
}

type SaveState = "saved" | "dirty" | "saving" | "conflict" | "error";

/** export dims: clamp raw field text into the PNG/GIF 64…4096 window */
const expDims = (w: string, h: string) => ({
  w: Math.min(4096, Math.max(64, Math.round(Number(w)) || 64)),
  h: Math.min(4096, Math.max(64, Math.round(Number(h)) || 64)),
});
const expValid = (w: string, h: string) => {
  const nw = Number(w), nh = Number(h);
  return Number.isFinite(nw) && Number.isFinite(nh) && nw >= 64 && nw <= 4096 && nh >= 64 && nh <= 4096;
};

const clone = (s: StageScene) => JSON.parse(JSON.stringify(s)) as StageScene;

export default function StageEditor({ sceneId }: { sceneId: string }) {
  const [row, setRow] = useState<SceneRow | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "unauth">("loading");
  const [scene, setScene] = useState<StageScene | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  /** the timeline diamond selection - owned here so the one keydown handler
   *  can tell "Delete keys" from "Delete node" without a second listener */
  const [selKey, setSelKey] = useState<{ node: string; t: number } | null>(null);
  const [view, setView] = useState<StageView>("persp");
  const [xform, setXform] = useState<XformMode>("translate");
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [save, setSave] = useState<SaveState>("saved");
  const [toast, setToast] = useState<string | null>(null);
  const [moveId, setMoveId] = useState("dolly-in");
  const [promptText, setPromptText] = useState("");
  const [promptBusy, setPromptBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  usePopoverGroup(addOpen, () => setAddOpen(false));
  const [glbRefs, setGlbRefs] = useState<string[]>([]);
  /** revision-preview mode - {rev, scene} of the stored revision being viewed;
   *  while set, the document, selection and all edits stay frozen */
  const [previewRev, setPreviewRevState] = useState<{ rev: number; scene: StageScene } | null>(null);
  const [revOpen, setRevOpen] = useState(false);
  const [revList, setRevList] = useState<RevListItem[] | null>(null);
  const [expOpen, setExpOpen] = useState(false);
  usePopoverGroup(expOpen, () => setExpOpen(false));
  const [expW, setExpW] = useState("1920");
  const [expH, setExpH] = useState("1080");
  const [expBusy, setExpBusy] = useState<string | null>(null);
  const [rndOpen, setRndOpen] = useState(false);
  const [rndStart, setRndStart] = useState("0");
  const [rndDur, setRndDur] = useState("3");
  const [rndControl, setRndControl] = useState<"depth" | "pose">("depth");
  const [rndPrompt, setRndPrompt] = useState("");
  const [rndSeed, setRndSeed] = useState("0");
  const [rndBusy, setRndBusy] = useState(false);
  /** undo-stack depth as state - the Undo button disables at 0 */
  const [undoLen, setUndoLen] = useState(0);

  const timeRef = useRef(0);
  const sceneRef = useRef<StageScene | null>(null);
  const selRef = useRef<string | null>(null);
  const revRef = useRef(0);
  const saveRef = useRef<SaveState>("saved");
  const undoRef = useRef<StageScene[]>([]);
  const redoRef = useRef<StageScene[]>([]);
  const previewBaseRef = useRef<StageScene | null>(null);
  const previewRevRef = useRef<{ rev: number; scene: StageScene } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** serialize autosave PUTs - two in flight at once could land out of
   *  revision order; pending holds only the LATEST scene snapshot */
  const saveQ = useRef<{ chain: Promise<void> | null; pending: StageScene | null }>({ chain: null, pending: null });
  /** this editor-load's session id - every save PUT carries it */
  const sessionRef = useRef<string | null>(null);
  if (sessionRef.current === null) sessionRef.current = crypto.randomUUID();
  const vpApi = useRef<ViewportApi | null>(null);

  sceneRef.current = scene;
  selRef.current = sel;
  previewRevRef.current = previewRev;
  saveRef.current = save;

  /** setSave + the ref in one write - an async caller that just awaited a
   *  save (runPrompt's flush, the pagehide flush) can't wait for the
   *  render-line above; the ref must read true before React has painted */
  const markSave = useCallback((v: SaveState) => {
    saveRef.current = v;
    setSave(v);
  }, []);

  const setPreviewRev = useCallback((v: { rev: number; scene: StageScene } | null) => {
    previewRevRef.current = v;
    setPreviewRevState(v);
  }, []);

  /** the only selection entry point - a diamond survives a same-node select;
   *  any other selection change clears it (it can never go stale) */
  const select = useCallback((id: string | null) => {
    if (previewRevRef.current) return; // preview mode: read-only
    setSelKey((k) => (id !== null && k?.node === id ? k : null));
    setSel(id);
  }, []);

  /* ---------- load ---------- */
  useEffect(() => {
    (async () => {
      const r = await fetch(`/api/stage/${sceneId}`);
      if (r.status === 401) { setStatus("unauth"); return; }
      if (r.status === 404) { setStatus("missing"); return; }
      if (!r.ok) { setStatus("missing"); return; }
      const data = (await r.json()) as SceneRow;
      try {
        setScene(stageSceneSchema.parse(data.scene));
        setRow(data);
        revRef.current = data.revision;
        setStatus("ready");
      } catch {
        setStatus("missing");
      }
    })();
  }, [sceneId]);

  /* ---------- save ---------- */
  const putScene = useCallback(async (s: StageScene) => {
    markSave("saving");
    const r = await fetch(`/api/stage/${sceneId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_revision: revRef.current, scene: s, session_id: sessionRef.current }),
    });
    if (r.status === 409) {
      // the server won - queued snapshots are all stale now; drop them and
      // let the conflict banner own the editor until a reload
      saveQ.current.pending = null;
      markSave("conflict");
      return;
    }
    if (!r.ok) { markSave("error"); setToast(userError(r.status, "save failed").message); return; }
    const d = await r.json();
    revRef.current = d.revision;
    markSave("saved");
  }, [sceneId, markSave]);

  const saveNow = useCallback((s: StageScene) => {
    const q = saveQ.current;
    q.pending = s;
    if (!q.chain) {
      q.chain = (async () => {
        try {
          while (q.pending) {
            const sc = q.pending;
            q.pending = null;
            try {
              await putScene(sc);
            } catch {
              // a thrown fetch (offline, aborted PUT) is a save failure like a
              // 5xx - surface it and keep draining: newer queued snapshots may
              // still land, and flushSave retries "error" state explicitly
              markSave("error");
              setToast("Save failed - the next flush retries");
            }
          }
        } finally {
          q.chain = null;
        }
      })();
    }
  }, [putScene, markSave]);

  const scheduleSave = useCallback((s: StageScene) => {
    if (previewRevRef.current) return; // preview mode: no autosave
    markSave("dirty");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveNow(sceneRef.current ?? s), 2000);
  }, [saveNow, markSave]);

  /** flush a pending debounce + await the in-flight PUT - restores, exports
   *  and unmount all take this path so nothing saves after them out of order */
  const flushSave = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      if (sceneRef.current && !previewRevRef.current) saveNow(sceneRef.current);
    }
    await saveQ.current.chain;
    // a flush that failed (throw or 5xx) leaves the state "error" - retry the
    // live scene once so callers waiting on a real verdict aren't handed a
    // stale failure
    if (saveRef.current === "error" && sceneRef.current && !previewRevRef.current) {
      saveNow(sceneRef.current);
      await saveQ.current.chain;
    }
  }, [saveNow]);

  /* unload can't await the debounce - on pagehide (and on unmount, which is
   * SPA nav) push the latest pending snapshot straight at PUT with
   * keepalive so the last edit survives instead of dying with the timer */
  useEffect(() => {
    const flushSync = () => {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      if (previewRevRef.current) return;
      const pending = saveQ.current.pending ?? (saveRef.current === "dirty" ? sceneRef.current : null);
      // a PUT already in flight owns the flush - a newer pending snapshot
      // queued behind it is dropped on pagehide by design (a racing
      // keepalive could land out of order / on a stale base_revision)
      if (!pending || saveQ.current.chain) return;
      const body = JSON.stringify({ base_revision: revRef.current, scene: pending, session_id: sessionRef.current });
      // keepalive's ~64 KB budget is shared - a doc too big to send is
      // skipped, not sent half-way
      if (new TextEncoder().encode(body).byteLength > 60 * 1024) return;
      fetch(`/api/stage/${sceneId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      })
        .then(async (r) => { if (r.ok) revRef.current = (await r.json()).revision; })
        .catch(() => {});
    };
    window.addEventListener("pagehide", flushSync);
    return () => { window.removeEventListener("pagehide", flushSync); flushSync(); };
  }, [sceneId]);

  /* ---------- mutation plumbing ---------- */
  const pushUndo = useCallback((s: StageScene) => {
    undoRef.current.push(s);
    if (undoRef.current.length > 500) undoRef.current.shift();
    setUndoLen(undoRef.current.length);
  }, []);

  const mutate = useCallback((fn: (sc: StageScene) => void) => {
    const cur = sceneRef.current;
    if (!cur || previewRevRef.current) return;
    const next = clone(cur);
    fn(next);
    const chk = stageSceneSchema.safeParse(next);
    if (!chk.success) { setToast(`Edit rejected: ${chk.error.issues[0]?.message}`); return; }
    pushUndo(cur);
    redoRef.current = [];
    previewBaseRef.current = null;
    setScene(next);
    scheduleSave(next);
  }, [scheduleSave, pushUndo]);

  const preview = useCallback((fn: (sc: StageScene) => void) => {
    const cur = sceneRef.current;
    if (!cur || previewRevRef.current) return;
    if (!previewBaseRef.current) previewBaseRef.current = cur;
    const next = clone(cur);
    fn(next);
    if (stageSceneSchema.safeParse(next).success) setScene(next);
  }, []);

  /** end a live preview without committing - the scene snaps back to the
   *  gesture's base (NumField Escape / a blur that typed nothing) */
  const discardPreview = useCallback(() => {
    const base = previewBaseRef.current;
    previewBaseRef.current = null;
    if (base) setScene(base);
  }, []);

  /** commit a gesture: snapshot the PRE-preview scene for undo */
  const commitGesture = useCallback((fn: (sc: StageScene) => void) => {
    const cur = sceneRef.current;
    if (!cur || previewRevRef.current) return;
    pushUndo(previewBaseRef.current ?? cur);
    redoRef.current = [];
    previewBaseRef.current = null;
    const next = clone(cur);
    fn(next);
    const chk = stageSceneSchema.safeParse(next);
    if (!chk.success) { setToast(`Edit rejected: ${chk.error.issues[0]?.message}`); return; }
    setScene(next);
    scheduleSave(next);
  }, [scheduleSave, pushUndo]);

  const undo = useCallback(() => {
    if (previewRevRef.current) return;
    const cur = sceneRef.current;
    const prev = undoRef.current.pop();
    if (!cur || !prev) return;
    setUndoLen(undoRef.current.length);
    redoRef.current.push(cur);
    previewBaseRef.current = null;
    setSelKey(null);
    setScene(prev);
    scheduleSave(prev);
  }, [scheduleSave]);

  const redo = useCallback(() => {
    if (previewRevRef.current) return;
    const cur = sceneRef.current;
    const nxt = redoRef.current.pop();
    if (!cur || !nxt) return;
    pushUndo(cur);
    setSelKey(null);
    setScene(nxt);
    scheduleSave(nxt);
  }, [scheduleSave, pushUndo]);

  /* ---------- playhead ---------- */
  const seek = useCallback((v: number) => {
    const dur = sceneRef.current?.meta.duration ?? 15;
    const clamped = Math.min(dur, Math.max(0, v));
    timeRef.current = clamped;
    setT(clamped);
    vpApi.current?.paint();
  }, []);
  const onTick = useCallback((v: number) => { setT(v); }, []);

  // framing problems at the scrubbed time - the same inspect the API runs,
  // surfaced where the user actually looks (the canvas corner)
  const framingProblems = useMemo(() => {
    const doc = previewRev?.scene ?? scene;
    if (!doc) return [];
    const r = inspectScene(doc, t, "problems");
    const FRAMING = new Set(["subject-underframed", "subject-off-center", "outside-frustum"]);
    return r.view === "problems" ? r.problems.filter((p) => FRAMING.has(p.code)) : [];
  }, [previewRev, scene, t]);

  /* ---------- node ops ---------- */
  const addNode = useCallback((kind: (typeof NODE_KINDS)[number], props?: Partial<StageNode["props"]>) => {
    mutate((sc) => {
      const id = newNodeId(new Set(sc.nodes.map((n) => n.id)));
      const node = makeNode(kind, {
        id,
        name: `${kind} ${sc.nodes.length + 1}`,
        transform: kind === "camera"
          ? { pos: [4, 3, 6], rot: [-16, -146, 0], scale: [1, 1, 1] }
          : { pos: [0, kind === "light" ? 3 : 0.5, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
        props,
      });
      sc.nodes.push(node);
    });
    select(null);
  }, [mutate, select]);

  const removeNode = useCallback((id: string) => {
    mutate((sc) => {
      const i = sc.nodes.findIndex((n) => n.id === id);
      if (i < 0) return;
      const dead = sc.nodes[i];
      sc.nodes.splice(i, 1);
      for (const n of sc.nodes) if (n.parent === dead.id) n.parent = dead.parent;
      for (const n of sc.nodes) if (n.kind === "camera" && n.props.lookAt === dead.id) delete n.props.lookAt;
    });
    select(null);
  }, [mutate, select]);

  /** drop every key a node carries at time kt - the Delete-key edit */
  const removeKeysAt = useCallback((nodeId: string, kt: number) => {
    mutate((sc) => {
      const n = sc.nodes.find((x) => x.id === nodeId);
      if (n?.keys) n.keys = n.keys.filter((k) => Math.abs(k.t - kt) >= 1e-6);
    });
    setSelKey(null);
  }, [mutate]);

  const applyMove = useCallback(() => {
    const cam = scene && renderCamera(scene);
    if (!cam) return;
    mutate((sc) => applyMoveToCamera(sc, cam!.id, moveId));
    setToast(`Move applied - the camera's keys now carry "${moveId}"`);
  }, [scene, moveId, mutate]);

  /** the bird's-eye layout helper - parked above the content bounding box,
   *  NEVER isRender. Existing "Layout cam" nodes refresh in place. */
  const layoutCam = useCallback(() => {
    mutate((sc) => {
      const pose = overviewCameraPose(sc);
      const existing = sc.nodes.find(
        (n): n is Extract<StageNode, { kind: "camera" }> => n.kind === "camera" && n.name === "Layout cam");
      if (existing) {
        existing.transform.pos = pose.pos;
        existing.transform.rot = pose.rot as Vec3;
        existing.props.focalMm = pose.focalMm;
        existing.props.isRender = false; // the helper never becomes the shot
      } else {
        sc.nodes.push(makeNode("camera", {
          id: newNodeId(new Set(sc.nodes.map((n) => n.id))),
          name: "Layout cam",
          transform: { pos: pose.pos, rot: pose.rot as Vec3, scale: [1, 1, 1] },
          props: { focalMm: pose.focalMm, sensor: "full_frame", isRender: false },
        }));
      }
    });
    setToast("Layout cam parked overhead - pick it to check the blocking top-down");
  }, [mutate]);

  const runPrompt = useCallback(async () => {
    if (!scene || !promptText.trim() || previewRevRef.current) return;
    setPromptBusy(true); setToast(null);
    /* a queued autosave must land BEFORE the prompt: it carries base_revision,
     * and an unflushed edit would silently drop - the server's new scene
     * replaces the local one and the pending edit never existed */
    await flushSave();
    // a flushed save that failed or lost the head race must block the prompt:
    // it would run on the server's stale head and the unsaved edit is gone
    if (saveRef.current === "conflict" || saveRef.current === "error") {
      if (saveRef.current === "error") setToast("prompt not sent - save failed");
      setPromptBusy(false);
      return;
    }
    const r = await fetch(`/api/stage/${sceneId}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: promptText.trim(), selection: sel ?? undefined, base_revision: revRef.current }),
    });
    setPromptBusy(false);
    if (r.status === 503) { setToast("No writer model configured - set one in Settings → Models & LLMs."); return; }
    if (r.status === 409) { markSave("conflict"); return; }
    if (!r.ok) { const d = await r.json().catch(() => ({})); setToast(userError(r.status, d.error ?? "prompt failed").message); return; }
    const d = await r.json();
    const next = stageSceneSchema.parse(d.scene);
    if (sceneRef.current) pushUndo(sceneRef.current);
    redoRef.current = [];
    setScene(next);
    revRef.current = d.revision;
    markSave("saved");
    setPromptText("");
  }, [scene, promptText, sel, sceneId, flushSave, pushUndo, markSave]);

  const exportPath = useCallback(() => {
    if (!scene) return;
    const data = exportCameraPath(scene);
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${scene.meta.title.replace(/[^\w-]+/g, "_")}-path.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [scene]);

  /* ---------- revisions drawer + preview/restore ---------- */
  const openRevisions = useCallback(async () => {
    setRevOpen(true);
    setRevList(null);
    const r = await fetch(`/api/stage/${sceneId}/revisions`);
    if (r.ok) setRevList(((await r.json()).revisions ?? []) as RevListItem[]);
    else setRevList([]);
  }, [sceneId]);

  /** enter read-only preview of a stored revision - the document is untouched */
  const openPreview = useCallback(async (rev: number) => {
    await flushSave(); // head must be current before the base_revision check
    const r = await fetch(`/api/stage/${sceneId}/revisions/${rev}`);
    if (!r.ok) { setToast(`Revision ${rev} failed to load`); return; }
    const d = await r.json();
    const parsed = stageSceneSchema.safeParse(d.scene);
    if (!parsed.success) { setToast("Stored revision won't parse"); return; }
    previewBaseRef.current = null; // a live preview can't leak into the frozen doc
    setSel(null); setSelKey(null);
    setPreviewRev({ rev, scene: parsed.data });
  }, [sceneId, flushSave, setPreviewRev]);

  const exitPreview = useCallback(() => {
    setPreviewRev(null);
    vpApi.current?.paint();
  }, [setPreviewRev]);

  /** restore the previewed revision as a new head - same as "reloading the
   *  editor": undo/redo history, selection and preview state all reset */
  const restoreRevision = useCallback(async () => {
    const pv = previewRevRef.current;
    if (!pv) return;
    const r = await fetch(`/api/stage/${sceneId}/revisions/${pv.rev}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_revision: revRef.current }),
    });
    if (r.status === 409) { markSave("conflict"); return; }
    if (!r.ok) { const d = await r.json().catch(() => ({})); setToast(userError(r.status, d.error ?? "restore failed").message); return; }
    const d = await r.json();
    const next = stageSceneSchema.parse(d.scene);
    undoRef.current = [];
    redoRef.current = [];
    setUndoLen(0);
    previewBaseRef.current = null;
    revRef.current = d.revision;
    setSel(null); setSelKey(null);
    setPreviewRev(null);
    setScene(next);
    markSave("saved");
    setToast(`Restored revision ${pv.rev} as head`);
    // the drawer gained a row - refetch while it's open instead of
    // leaving "Loading…" up until a reopen
    if (revOpen) {
      fetch(`/api/stage/${sceneId}/revisions`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d2) => { if (d2?.revisions) setRevList(d2.revisions); })
        .catch(() => {});
    } else {
      setRevList(null);
    }
  }, [sceneId, revOpen, setPreviewRev]);

  /* ---------- still/GLB export ---------- */
  const openExport = useCallback(() => {
    if (!scene) return;
    setExpW(String(scene.meta.renderSize.w));
    setExpH(String(scene.meta.renderSize.h));
    setExpOpen((o) => !o);
  }, [scene]);

  const downloadStill = useCallback(async () => {
    if (!scene || !vpApi.current) return;
    setExpBusy("still-dl");
    try {
      const { w, h } = expDims(expW, expH);
      const blob = await vpApi.current.renderStill(w, h);
      if (!blob) { setToast("Still render failed"); return; }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${scene.meta.title.replace(/[^\w-]+/g, "_")}-still.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    } finally {
      setExpBusy(null);
    }
  }, [scene, expW, expH]);

  const saveExport = useCallback(async (kind: "still" | "glb") => {
    if (!scene || !vpApi.current) return;
    await flushSave(); // the export POST snapshots server state - sync first
    setExpBusy(kind);
    try {
      const fd = new FormData();
      fd.set("kind", kind);
      if (kind === "still") {
        const { w, h } = expDims(expW, expH);
        const blob = await vpApi.current.renderStill(w, h);
        if (!blob) { setToast("Still render failed"); return; }
        fd.set("w", String(w));
        fd.set("h", String(h));
        fd.set("file", blob, "still.png");
      } else {
        const blob = await vpApi.current.exportGlb();
        if (!blob) { setToast("GLB export failed"); return; }
        fd.set("file", blob, "scene.glb");
      }
      const r = await fetch(`/api/stage/${sceneId}/exports`, { method: "POST", body: fd });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setToast(userError(r.status, d.error ?? "export failed").message); return; }
      const d = await r.json();
      setToast(`Saved to library - ${d.url}`);
      if (kind === "glb") setGlbRefs([]); // Add → Model must refetch so the new GLB shows
    } finally {
      setExpBusy(null);
    }
  }, [scene, sceneId, expW, expH, flushSave]);

  /* ---------- render video (stage-render job) ---------- */
  const hasMannequin = scene?.nodes.some((n) => n.kind === "mannequin") ?? false;
  const openRender = useCallback(() => {
    if (!scene) return;
    setRndStart("0");
    setRndDur(String(Math.min(STAGE_MAX_DURATION_S, scene.meta.duration)));
    setRndControl("depth");
    setRndPrompt(scene.meta.title);
    setRndSeed("0");
    setRndOpen(true);
  }, [scene]);

  /** live plan preview - the same math the recipe applies server-side, so the
   *  dialog shows exactly what a submit would run */
  const rndPlan = useMemo(() => {
    if (!scene) return null;
    const start = Number(rndStart);
    const dur = Number(rndDur);
    const size = stageRenderSize(scene.meta.aspect);
    const frames = stageFrameCount(dur);
    const windows = stageWindows(frames);
    const inRange = Number.isFinite(start) && Number.isFinite(dur)
      && start >= 0 && dur > 0 && start + dur <= scene.meta.duration;
    const prompt = inRange
      ? composeRenderPrompt(scene, rndPrompt, start, frames, size.w, size.h).text
      : "";
    const error = !inRange
      ? `start + duration must stay inside the scene (≤ ${scene.meta.duration} s)`
      : !windows.length
        ? `${frames} frames needs more than the local 2-window ceiling - not in this build`
        : null;
    return { size, frames, windows: windows.length, prompt, error };
  }, [scene, rndStart, rndDur, rndPrompt]);

  const submitRender = useCallback(async () => {
    if (!scene || !rndPlan || rndPlan.error) return;
    setRndBusy(true);
    try {
      await flushSave(); // pin the revision the server is about to read
      if (saveRef.current === "error") { setToast("Save failed - fix the save before rendering"); return; }
      const r = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint_id: "motionfield/stage/render",
          params: {
            scene_id: sceneId,
            revision: revRef.current,
            start_s: Number(rndStart) || 0,
            duration_s: Number(rndDur),
            control: rndControl,
            prompt: rndPrompt,
            seed: Number(rndSeed) || 0,
          },
        }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setToast(userError(r.status, d.error ?? "render failed").message); return; }
      const d = await r.json();
      setToast(`Render job submitted - rev ${revRef.current} pinned. Follow it in History.`);
      setRndOpen(false);
      void d;
    } finally {
      setRndBusy(false);
    }
  }, [scene, rndPlan, flushSave, sceneId, rndStart, rndDur, rndControl, rndPrompt, rndSeed]);

  /* ---------- owned .glb uploads for Add → Model ---------- */
  useEffect(() => {
    if (!addOpen || glbRefs.length) return;
    fetch("/api/uploads").then((r) => r.ok ? r.json() : { uploads: [] })
      .then((d) => setGlbRefs((d.uploads ?? []).filter((u: { url: string }) => /\.glb$/i.test(u.url)).map((u: { url: string }) => u.url)))
      .catch(() => {});
  }, [addOpen, glbRefs.length]);

  /* ---------- keyboard - the ONE keydown listener. A selected timeline
   *  diamond turns Delete into "remove keys at that t"; without it (or when
   *  the diamond's keys are already gone) Delete removes the selected node. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return;
      const k = e.key.toLowerCase(); // Shift+Ctrl+Z reports "Z" on Win/Linux
      if (previewRevRef.current) {
        // revision preview is read-only - Escape leaves it, playhead still runs
        if (e.key === "Escape") { e.preventDefault(); exitPreview(); }
        else if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.metaKey || e.ctrlKey) && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
      if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); }
      if (e.key === "Delete" || e.key === "Backspace") {
        const node = selKey && sceneRef.current?.nodes.find((n) => n.id === selKey.node);
        const hasKeys = selKey != null && node?.keys?.some((kk) => Math.abs(kk.t - selKey.t) < 1e-6);
        e.preventDefault();
        if (selKey && selKey.node === sel && hasKeys) removeKeysAt(selKey.node, selKey.t);
        else if (sel) removeNode(sel);
      }
      if (e.key === "g" || e.key === "w") setXform("translate");
      if (e.key === "r") setXform("rotate");
      if (e.key === "s") setXform("scale");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, sel, selKey, removeNode, removeKeysAt, exitPreview]);

  /* ---------- test/dev hook ---------- */
  useEffect(() => {
    (window as unknown as { __ofStage?: unknown }).__ofStage = {
      get scene() { return sceneRef.current; },
      get t() { return timeRef.current; },
      get sel() { return selRef.current; },
      setT: seek,
      sample: (tt: number) => (sceneRef.current ? sampleScene(sceneRef.current, tt) : null),
      cameraAt: (tt: number) => (sceneRef.current ? cameraAt(sceneRef.current, tt) : null),
      exportPath: () => (sceneRef.current ? exportCameraPath(sceneRef.current) : null),
      add: (kind: string) => addNode(kind as (typeof NODE_KINDS)[number]),
      select: (id: string | null) => select(id),
      undo, redo,
      setView,
      handlePos: (i: number) => vpApi.current?.handleScreenPos(i) ?? null,
      screenPos: (id: string) => vpApi.current?.objectScreenPos(id) ?? null,
      drawn: (id: string) => vpApi.current?.drawn(id) ?? false,
      screenPosAt: (pos: [number, number, number]) => vpApi.current?.screenPosAt(pos) ?? null,
      get previewRev() { return previewRevRef.current?.rev ?? null; },
      get previewScene() { return previewRevRef.current?.scene ?? null; },
      get undoDepth() { return undoRef.current.length; },
      preview: (rev: number) => openPreview(rev),
      flushSaves: () => flushSave(),
      renderStill: (w: number, h: number) => vpApi.current?.renderStill(w, h) ?? null,
      exportGlb: () => vpApi.current?.exportGlb() ?? null,
    };
    return () => { delete (window as unknown as { __ofStage?: unknown }).__ofStage; };
  }, [seek, addNode, undo, redo, select, openPreview, flushSave]);

  /* ---------- render ---------- */
  const refs = row?.refs ?? [];
  const unreadRefs = refs.length > 0 && row?.refs_read === false;
  const selNode = scene && sel ? (nodeById(scene, sel) ?? null) : null;

  if (status === "loading") {
    return <div className="mx-auto max-w-[1400px] p-8"><div className="panel h-[70vh] animate-pulse" /></div>;
  }
  if (status === "unauth") {
    return <div className="mx-auto max-w-[640px] p-8 panel text-sm">Log in to edit scenes. <Link className="text-[var(--color-accent)] underline" href="/login?next=/scene-3d">Log in</Link></div>;
  }
  if (status === "missing" || !scene) {
    return <div className="mx-auto max-w-[640px] p-8 panel text-sm">Scene not found. <Link className="text-[var(--color-accent)] underline" href="/scene-3d">Back to 3D Scene</Link></div>;
  }

  const viewScene = previewRev?.scene ?? scene; // preview mode draws the revision, not the doc

  return (
    <div className="flex h-[calc(100dvh-52px)] flex-col">
      {/* ---- top bar ---- */}
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
        <Link href="/scene-3d" className="btn btn-ghost btn-sm">← 3D Scene</Link>
        <input
          aria-label="Scene title"
          className="input max-w-56"
          defaultValue={scene.meta.title}
          key={scene.meta.title}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== scene.meta.title) mutate((sc) => { sc.meta.title = v; });
          }}
        />
        <span className="text-xs text-[var(--color-faint)]" data-testid="save-state">
          {save === "saved" ? "Saved" : save === "saving" ? "Saving…" : save === "dirty" ? "Unsaved…" : save === "conflict" ? "Changed on the server - reload" : "Save error"}
        </span>

        {/* scene meta - aspect swaps re-derive renderSize */}
        <div className="ml-3 flex items-center gap-1.5 text-xs">
          <select aria-label="Aspect" className="input w-20 px-1.5 py-1" value={scene.meta.aspect}
            onChange={(e) => mutate((sc) => {
              const a = e.target.value as Aspect;
              sc.meta.aspect = a;
              sc.meta.renderSize = { ...ASPECT_SIZE[a] };
            })}>
            {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select aria-label="FPS" className="input w-14 px-1.5 py-1" value={scene.meta.fps}
            onChange={(e) => mutate((sc) => { sc.meta.fps = Number(e.target.value) as 24 | 30; })}>
            <option value={24}>24</option>
            <option value={30}>30</option>
          </select>
          <label className="flex shrink-0 items-center gap-1 text-[var(--color-faint)]">
            <input aria-label="Duration" type="number" min={1} max={60} step={1}
              className="input w-16 min-w-16 px-1.5 py-1" value={scene.meta.duration}
              onChange={(e) => { const v = Number(e.target.value); if (v >= 1 && v <= 60) mutate((sc) => { sc.meta.duration = v; }); }} />
            s
          </label>
          {scene.meta.duration > STAGE_MAX_DURATION_S && (
            <span className="shrink-0 whitespace-nowrap text-[10px] text-[var(--color-warn,#f0b45a)]"
              data-testid="duration-over-cap" title="Authoring longer scenes is fine - the local VACE renderer just can't reach past the cap">
              <TriangleAlert size={13} className="mr-1 inline-block" /> renders first {STAGE_MAX_DURATION_S.toFixed(1)}s
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <div role="group" aria-label="View mode" className="flex overflow-hidden rounded-lg border border-[var(--color-border)]">
            {(["persp", "top", "cam"] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} aria-pressed={view === v}
                className={`px-3 py-1.5 text-xs ${view === v ? "bg-[var(--color-accent)] text-black" : "bg-[var(--color-panel2)]"}`}>
                {v === "persp" ? "Persp" : v === "top" ? "Top" : "Camera"}
              </button>
            ))}
          </div>
          <div role="group" aria-label="Gizmo mode" className="flex overflow-hidden rounded-lg border border-[var(--color-border)]">
            {(["translate", "rotate", "scale"] as const).map((m) => (
              <button key={m} onClick={() => setXform(m)} aria-pressed={xform === m}
                className={`px-2 py-1.5 text-xs ${xform === m ? "bg-[var(--color-panel2)] text-[var(--color-accent)]" : "bg-[var(--color-panel)]"}`}>
                {m === "translate" ? "Move" : m === "rotate" ? "Rot" : "Scale"}
              </button>
            ))}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={undo} aria-label="Undo" disabled={!!previewRev || undoLen === 0}>Undo</button>
          <button className="btn btn-ghost btn-sm" onClick={redo} aria-label="Redo" disabled={!!previewRev}>Redo</button>
          <button className="btn btn-ghost btn-sm" onClick={openRevisions} aria-haspopup="dialog">Revisions</button>
          <button className="btn btn-ghost btn-sm" onClick={openRender} aria-haspopup="dialog"
            disabled={!!previewRev || !!RENDER_GATE} title={RENDER_GATE}>
            {RENDER_GATE ? "Render video - coming soon" : "Render video"}
          </button>
          <div className="relative">
            <button className="btn btn-ghost btn-sm" onClick={openExport} aria-haspopup="menu">Export</button>
            {expOpen && (
              <div className="panel absolute right-0 z-20 mt-1 w-60 p-2" data-testid="export-panel">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-faint)]">Still (PNG)</div>
                <div className="mt-1 grid grid-cols-2 gap-1">
                  <label className="text-[10px] text-[var(--color-faint)]">W
                    <input aria-label="Export width" inputMode="numeric" className="input mt-0.5 w-full px-1.5 py-1 text-xs"
                      value={expW} onChange={(e) => setExpW(e.target.value)} />
                  </label>
                  <label className="text-[10px] text-[var(--color-faint)]">H
                    <input aria-label="Export height" inputMode="numeric" className="input mt-0.5 w-full px-1.5 py-1 text-xs"
                      value={expH} onChange={(e) => setExpH(e.target.value)} />
                  </label>
                </div>
                <div className="mt-1.5 flex gap-1">
                  <button className="btn btn-ghost btn-sm flex-1 text-[10px]" onClick={downloadStill}
                    disabled={expBusy !== null || !expValid(expW, expH)}>
                    Download PNG
                  </button>
                  <button className="btn btn-ghost btn-sm flex-1 text-[10px]" onClick={() => saveExport("still")}
                    disabled={expBusy !== null || !expValid(expW, expH)}>
                    Save to library
                  </button>
                </div>
                <div className="mt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-faint)]">Model (GLB)</div>
                <button className="btn btn-ghost btn-sm mt-1 w-full text-[10px]" onClick={() => saveExport("glb")}
                  disabled={expBusy !== null}>
                  Save GLB to library
                </button>
                <div className="mt-2 border-t border-[var(--color-border)] pt-1.5">
                  <button className="btn btn-ghost btn-sm w-full text-[10px]" onClick={exportPath}>Export path JSON</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---- left rail: outliner + inspector ---- */}
        <aside className="flex w-72 min-w-72 flex-col border-r border-[var(--color-border)]">
          {/* revision preview is read-only end to end - the disabled fieldset
           * keeps the affordances visibly inert, not just no-op */}
          <fieldset className="contents" disabled={!!previewRev}>
          <div className="border-b border-[var(--color-border)] p-2">
            <div className="relative">
              <button className="btn btn-ghost btn-sm w-full" onClick={() => setAddOpen((o) => !o)} aria-haspopup="menu">
                + Add node
              </button>
              {addOpen && (
                <div className="panel absolute z-10 mt-1 w-full p-1" role="menu">
                  {PRIMITIVE_SHAPES.map((sh) => (
                    <button key={sh} role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-[var(--color-panel2)]"
                      onClick={() => { addNode("primitive", { shape: sh, size: [1, 1, 1], color: "#8b93a3" }); setAddOpen(false); }}>
                      Primitive · {sh}
                    </button>
                  ))}
                  <button role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-[var(--color-panel2)]"
                    onClick={() => { addNode("mannequin"); setAddOpen(false); }}>Mannequin</button>
                  {LIGHT_KINDS.map((lk) => (
                    <button key={lk} role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-[var(--color-panel2)]"
                      onClick={() => { addNode("light", { light: lk, color: "#ffffff", intensity: lk === "sun" ? 2.5 : 8, angle: 30, range: 0 }); setAddOpen(false); }}>
                      Light · {lk}
                    </button>
                  ))}
                  <button role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-[var(--color-panel2)]"
                    onClick={() => { addNode("camera"); setAddOpen(false); }}>Camera</button>
                  {glbRefs.map((u) => (
                    <button key={u} role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-[var(--color-panel2)]"
                      onClick={() => { addNode("model", { src: u }); setAddOpen(false); }}>
                      Model · {u.split("/").pop()}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <Outliner scene={viewScene} sel={previewRev ? null : sel} onSelect={select} onRemove={removeNode} mutate={mutate} />
          <Inspector scene={viewScene} node={previewRev ? null : selNode} t={t} mutate={mutate}
            field={{ previewMut: preview, commitMut: commitGesture, revert: discardPreview }} />
          </fieldset>
        </aside>

        {/* ---- viewport ---- */}
        <main className="relative min-w-0 flex-1">
          <Viewport
            scene={viewScene} timeRef={timeRef} playing={playing} onTick={onTick}
            view={view} xform={xform} selection={previewRev ? null : sel}
            onSelect={previewRev ? () => {} : select}
            onCommit={previewRev ? () => {} : commitGesture}
            onPreview={previewRev ? () => {} : preview}
            register={(api) => { vpApi.current = api; }}
          />
          {previewRev && (
            <div data-testid="revision-banner"
              className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-[var(--color-accent)]/40 bg-black/80 px-3 py-1.5 text-xs text-[var(--color-text)]">
              Previewing revision {previewRev.rev} -
              <button className="font-semibold text-[var(--color-accent)] underline" onClick={restoreRevision}>Restore as head</button>
              <span className="text-[var(--color-faint)]">·</span>
              <button className="underline" onClick={exitPreview}>Back</button>
            </div>
          )}
          {framingProblems.length > 0 && (
            <div data-testid="framing-banner"
              className="absolute left-3 top-3 z-20 max-w-72 rounded-lg border border-[var(--color-warn,#f0b45a)]/40 bg-black/80 px-3 py-2 text-[10px] leading-snug text-[var(--color-warn,#f0b45a)]">
              <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider">framing</div>
              {framingProblems.slice(0, 3).map((p, i) => <div key={i}>{p.message}</div>)}
              {framingProblems.length > 3 && <div className="mt-0.5">…and {framingProblems.length - 3} more</div>}
            </div>
          )}
          {revOpen && (
            <div className="absolute right-0 top-0 z-10 flex h-full w-64 flex-col border-l border-[var(--color-border)] bg-[var(--color-panel)]"
              data-testid="revisions-drawer">
              <div className="flex items-center justify-between border-b border-[var(--color-border)] p-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-faint)]">Revisions</span>
                <button className="text-[var(--color-dim)]" aria-label="Close revisions" onClick={() => setRevOpen(false)}>×</button>
              </div>
              <ul className="min-h-0 flex-1 overflow-y-auto p-1">
                {(revList ?? []).map((r) => (
                  <li key={r.revision}>
                    <button data-testid={`rev-${r.revision}`}
                      className={`w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--color-panel2)] ${previewRev?.rev === r.revision ? "text-[var(--color-accent)]" : ""}`}
                      onClick={() => openPreview(r.revision)}>
                      <span className="tabular-nums">r{r.revision}</span>
                      <span className="mx-1.5 text-[var(--color-faint)]">{r.source}</span>
                      <span className="text-[10px] text-[var(--color-faint)]">{new Date(r.created_at).toLocaleTimeString()}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-[var(--color-dim)]">
                        {r.title ?? "untitled"} · {r.node_count} nodes
                      </span>
                    </button>
                  </li>
                ))}
                {revList !== null && revList.length === 0 && (
                  <li className="p-2 text-xs text-[var(--color-faint)]">No revisions yet.</li>
                )}
                {revList === null && (
                  <li className="p-2 text-xs text-[var(--color-faint)]">Loading…</li>
                )}
              </ul>
            </div>
          )}
          {unreadRefs && (
            <p className="absolute left-3 top-3 rounded bg-black/60 px-2 py-1 text-xs text-[var(--color-dim)]">
              References saved - no vision model is configured, so they weren't read.
            </p>
          )}
          {rndOpen && rndPlan && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60"
              role="dialog" aria-label="Render video" data-testid="render-dialog">
              <div className="panel w-[480px] max-w-[92%] p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">Render video</span>
                  <button className="text-[var(--color-dim)]" aria-label="Close render dialog" onClick={() => setRndOpen(false)}>×</button>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <label className="text-[10px] text-[var(--color-faint)]">Range start (s)
                    <input aria-label="Render start" type="number" min={0} max={scene.meta.duration} step={0.0625}
                      className="input mt-0.5 w-full px-1.5 py-1 text-xs"
                      value={rndStart} onChange={(e) => setRndStart(e.target.value)} />
                  </label>
                  <label className="text-[10px] text-[var(--color-faint)]">Duration (s)
                    <input aria-label="Render duration" type="number" min={0.0625} max={STAGE_MAX_DURATION_S} step={0.0625}
                      className="input mt-0.5 w-full px-1.5 py-1 text-xs"
                      value={rndDur} onChange={(e) => setRndDur(e.target.value)} />
                  </label>
                  <label className="text-[10px] text-[var(--color-faint)]">Control pass
                    <select aria-label="Render control" className="input mt-0.5 w-full px-1.5 py-1 text-xs"
                      value={rndControl} onChange={(e) => setRndControl(e.target.value as "depth" | "pose")}>
                      <option value="depth">Depth</option>
                      <option value="pose" disabled={!hasMannequin}>
                        Pose{hasMannequin ? "" : " - needs a mannequin"}
                      </option>
                    </select>
                  </label>
                </div>
                <label className="mt-2 block text-[10px] text-[var(--color-faint)]">Prompt
                  <textarea aria-label="Render prompt" rows={3} maxLength={800}
                    className="input mt-0.5 w-full px-1.5 py-1 text-xs"
                    value={rndPrompt} onChange={(e) => setRndPrompt(e.target.value)} />
                </label>
                <label className="mt-1 block w-24 text-[10px] text-[var(--color-faint)]">Seed
                  <input aria-label="Render seed" type="number" min={0} max={2147483647} step={1}
                    className="input mt-0.5 w-full px-1.5 py-1 text-xs"
                    value={rndSeed} onChange={(e) => setRndSeed(e.target.value)} />
                </label>
                <div className="mt-3 rounded border border-[var(--color-border)] bg-[var(--color-panel2)] p-2 text-[11px] leading-5">
                  <div data-testid="render-plan">
                    {rndPlan.size.w}×{rndPlan.size.h} @ {STAGE_RENDER_FPS} fps ·{" "}
                    {rndPlan.frames} frames (4n+1) ·{" "}
                    {rndPlan.windows} window{rndPlan.windows === 1 ? "" : "s"}
                    {rndPlan.windows > 1 ? ` (${STAGE_OVERLAP}-frame continuation)` : ""}
                  </div>
                  <div className="mt-1 text-[10px] text-[var(--color-faint)]">Composed prompt</div>
                  <div className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words" data-testid="render-composed-prompt">
                    {rndPlan.prompt || "-"}
                  </div>
                  {rndPlan.error && (
                    <div className="mt-1 text-[10px] text-[var(--color-warn,#f0a35e)]" data-testid="render-error">
                      {rndPlan.error}
                    </div>
                  )}
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="text-[10px] text-[var(--color-faint)]">
                    Pins revision {revRef.current} · Wan VACE 1.3B (Apache-2.0, local weights)
                  </span>
                  <button className="btn btn-primary btn-sm" onClick={submitRender}
                    disabled={rndBusy || !!rndPlan.error || !rndPlan.prompt.trim()}>
                    {rndBusy ? "Submitting…" : "Render"}
                  </button>
                </div>
              </div>
            </div>
          )}
          {toast && (
            <p className="absolute bottom-3 left-3 max-w-md rounded bg-black/70 px-3 py-1.5 text-xs text-[var(--color-text)]" role="status">
              {toast}
            </p>
          )}
        </main>
      </div>

      {/* ---- bottom: prompt + move + timeline ---- */}
      <footer className="border-t border-[var(--color-border)]">
        <div className="flex items-center gap-2 px-3 py-2">
          <button className="btn btn-ghost btn-sm" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <span className="w-16 text-center text-xs tabular-nums text-[var(--color-dim)]" data-testid="playhead">{t.toFixed(2)}s</span>
          <Timeline scene={viewScene} t={t} sel={previewRev ? null : sel} onSeek={seek} onSelect={select}
            selKey={previewRev ? null : selKey} onSelectKey={setSelKey}
            onPreview={preview} onCommit={commitGesture} />

          <input
            aria-label="Edit prompt"
            className="input text-xs"
            style={{ width: "16rem" }} // .input{ width:100% } beats w-64 - pin it so flex-1 keeps room for the timeline
            placeholder='Edit with a prompt - "add a spotlight over the box"'
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runPrompt(); }}
          />
          <button className="btn btn-ghost btn-sm" onClick={runPrompt} disabled={promptBusy || !promptText.trim()}>
            {promptBusy ? "…" : "Prompt"}
          </button>
          <select className="input text-xs" style={{ width: "10rem" }} value={moveId} onChange={(e) => setMoveId(e.target.value)} aria-label="Camera move">
            {MOVE_IDS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button className="btn btn-ghost btn-sm" onClick={applyMove}>Apply move</button>
          <button className="btn btn-ghost btn-sm" onClick={layoutCam} title="create/refresh the bird's-eye layout camera (never the render camera)">Layout cam</button>
        </div>
      </footer>

      {save === "conflict" && (
        <div className="border-t border-[var(--color-danger)] bg-[#2a1214] px-3 py-2 text-xs">
          This scene changed on the server - <button className="text-[var(--color-accent)] underline" onClick={() => location.reload()}>Reload</button> to keep editing.
        </div>
      )}
    </div>
  );
}

/* ================= outliner ================= */

function Outliner({ scene, sel, onSelect, onRemove, mutate }: {
  scene: StageScene; sel: string | null;
  onSelect(id: string | null): void;
  onRemove(id: string): void;
  mutate(fn: (sc: StageScene) => void): void;
}) {
  const byParent = useMemo(() => {
    const m = new Map<string | undefined, StageNode[]>();
    for (const n of scene.nodes) {
      const k = n.parent;
      m.set(k, [...(m.get(k) ?? []), n]);
    }
    return m;
  }, [scene.nodes]);

  const descendants = (id: string): Set<string> => {
    const out = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of scene.nodes) if (n.parent && out.has(n.parent) && !out.has(n.id)) { out.add(n.id); grew = true; }
    }
    return out;
  };

  const rows: { n: StageNode; depth: number }[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const n of byParent.get(parent) ?? []) {
      rows.push({ n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(undefined, 0);
  for (const n of scene.nodes) if (n.parent && !scene.nodes.some((p) => p.id === n.parent)) rows.push({ n, depth: 0 });

  const KIND_ICON: Record<string, React.ReactNode> = {
    primitive: <Box size={12} />, mannequin: <PersonStanding size={12} />, light: <Sun size={12} />,
    camera: <Camera size={12} />, model: <Shapes size={12} />,
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Outliner">
      <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-faint)]">Outliner</div>
      <ul className="mt-1 space-y-0.5">
        {rows.map(({ n, depth }) => (
          <li key={n.id} style={{ paddingLeft: depth * 14 }}>
            <div data-testid={`outliner-${n.id}`}
              className={`group flex items-center gap-1 rounded px-1.5 py-1 text-xs ${sel === n.id ? "bg-[var(--color-panel2)] text-[var(--color-text)]" : "hover:bg-[var(--color-panel2)]/60"}`}>
              <button className="min-w-0 flex-1 truncate text-left" onClick={() => onSelect(n.id)}>
                <span className="mr-1.5 inline-flex translate-y-px opacity-70">{KIND_ICON[n.kind]}</span>
                {n.name}
                {n.kind === "camera" && n.props.isRender && <span className="ml-1.5 text-[10px] text-[var(--color-accent)]">REC</span>}
              </button>
              <select
                aria-label={`Parent of ${n.name}`}
                className="hidden max-w-16 bg-transparent text-[10px] text-[var(--color-faint)] group-hover:block"
                value={n.parent ?? ""}
                onChange={(e) => {
                  const pid = e.target.value || null;
                  mutate((sc) => {
                    const nn = sc.nodes.find((x) => x.id === n.id)!;
                    if (pid === null) delete nn.parent; else nn.parent = pid;
                  });
                }}
              >
                <option value="">root</option>
                {scene.nodes
                  .filter((p) => p.id !== n.id && !descendants(n.id).has(p.id))
                  .map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button className="hidden text-[var(--color-danger)] group-hover:block" aria-label={`Delete ${n.name}`}
                onClick={() => onRemove(n.id)}>×</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ================= inspector ================= */

function NumField({ label, value, onPreview, onCommit, onRevert, step = 0.1, min, max, readOnly }: {
  label: string; value: number;
  /** live, non-undoable preview - fires per keystroke on a valid in-range parse */
  onPreview?(v: number): void;
  /** the single undoable commit - fires on blur/Enter when the clamped value
   *  differs from the focus-time value, and on ArrowUp/Down step */
  onCommit?(v: number): void;
  /** restore the focus-time value - Escape, or a blur that committed nothing
   *  (also flushes any live previews back to the gesture base) */
  onRevert?(): void;
  step?: number; min?: number; max?: number; readOnly?: boolean;
}) {
  /* draft-while-focused editing: type=text because a controlled type=number
   * can't carry a "-" keystroke (its .value sanitizes to "" mid-edit and the
   * controlled write then erases the raw text). Previews ride onChange;
   * clamping + the single commit wait for blur/Enter so intermediate parses
   * ("-2.5" → "-" → "-2" → "-2.5") never reach the scene. */
  const [draft, setDraft] = useState<string | null>(null);
  const focusBase = useRef(0);
  const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
  const shown = draft ?? fmt(Number.isFinite(value) ? value : 0);
  const inRange = (v: number) => (min === undefined || v >= min) && (max === undefined || v <= max);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  return (
    <label className="block text-[10px] text-[var(--color-faint)]">
      {label}
      <input type="text" inputMode="decimal" data-step={step} readOnly={readOnly}
        className="input mt-0.5 w-full px-1.5 py-1 text-xs"
        value={shown}
        onFocus={() => { focusBase.current = Number.isFinite(value) ? value : 0; setDraft(shown); }}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const v = Number(raw);
          if (raw.trim() !== "" && Number.isFinite(v) && inRange(v)) onPreview?.(v);
        }}
        onBlur={() => {
          if (draft !== null) {
            const v = Number(draft);
            if (draft.trim() !== "" && Number.isFinite(v)) {
              const c = clamp(v);
              if (c !== focusBase.current) onCommit?.(c);
              else onRevert?.(); // focus-and-go / typed-back-to-same: no commit, flush previews
            } else {
              onRevert?.(); // unparsable - the field reverts, previews unwind
            }
          }
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.value = fmt(focusBase.current); // restore raw text now, not next render
            onRevert?.();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const dir = e.key === "ArrowUp" ? 1 : -1;
            const mul = e.shiftKey ? 10 : 1;
            const base = draft !== null && Number.isFinite(Number(draft)) ? Number(draft) : (Number.isFinite(value) ? value : 0);
            const next = clamp(Math.round((base + dir * step * mul) * 1e4) / 1e4);
            focusBase.current = next; // the later blur must not double-commit
            setDraft(fmt(next));
            onCommit?.(next);
          }
        }} />
    </label>
  );
}

function Vec3Fields({ value, onPreview, onCommit, onRevert, labels }: {
  value: Vec3;
  onPreview?(v: Vec3): void;
  onCommit?(v: Vec3): void;
  onRevert?(): void;
  labels?: string[];
}) {
  const ls = labels ?? ["X", "Y", "Z"];
  const axis = (i: number, x: number) => { const n = [...value] as Vec3; n[i] = x; return n; };
  return (
    <div className="grid grid-cols-3 gap-1">
      {ls.map((l, i) => (
        <NumField key={l} label={l} value={value[i]}
          onPreview={(x) => onPreview?.(axis(i, x))}
          onCommit={(x) => onCommit?.(axis(i, x))}
          onRevert={onRevert} />
      ))}
    </div>
  );
}

/** field editors need the scene-level gesture plumbing - previews ride
 *  onChange while typing; the single undoable commit lands at gesture end */
interface FieldEdit {
  previewMut(fn: (sc: StageScene) => void): void;
  commitMut(fn: (sc: StageScene) => void): void;
  revert(): void;
}

type NodeEdit = (n: StageNode, sc: StageScene) => void;

function Inspector({ scene, node, t, mutate, field }: {
  scene: StageScene; node: StageNode | null; t: number;
  mutate(fn: (sc: StageScene) => void): void;
  field: FieldEdit;
}) {
  if (!node) {
    return <ScenePanel scene={scene} mutate={mutate} field={field} />;
  }
  const find = (sc: StageScene) => sc.nodes.find((x) => x.id === node.id);
  const edit = (fn: NodeEdit) => mutate((sc) => { const n = find(sc); if (n) fn(n, sc); });
  const previewNode = (fn: NodeEdit) => field.previewMut((sc) => { const n = find(sc); if (n) fn(n, sc); });
  const commitNode = (fn: NodeEdit) => field.commitMut((sc) => { const n = find(sc); if (n) fn(n, sc); });
  /* auto-key: once a path has a track the inspector's base value is invisible
   * at runtime - the commit writes a key at the playhead instead */
  const writeKeyed = (n: StageNode, path: string, value: number | Vec3 | string, base: () => void) => {
    if (n.keys?.some((k) => k.path === path)) {
      const ks = n.keys.filter((k) => !(k.path === path && Math.abs(k.t - t) < 1e-6));
      ks.push({ t, path, value: (Array.isArray(value) ? ([...value] as Vec3) : value) });
      n.keys = ks;
    } else base();
  };
  const setTransform = (field: "pos" | "rot" | "scale", v: Vec3) => (n: StageNode) =>
    writeKeyed(n, `transform.${field}`, v, () => { n.transform[field] = v; });
  const isCam = node.kind === "camera";
  const rotLabels = isCam ? ["Pitch", "Yaw", "Roll"] : ["RX", "RY", "RZ"];

  return (
    <div className="max-h-[46%] min-h-40 overflow-y-auto border-t border-[var(--color-border)] p-2" aria-label="Inspector">
      <div className="flex items-center gap-1 text-xs font-semibold">
        <input aria-label="Node name" className="input flex-1 px-1.5 py-1 text-xs" value={node.name}
          onChange={(e) => edit((n) => { n.name = e.target.value; })} />
        <span className="text-[10px] text-[var(--color-faint)]">{node.kind}</span>
      </div>

      <div className="mt-2 space-y-2">
        <div>
          <div className="text-[10px] uppercase text-[var(--color-faint)]">Position (m)</div>
          <Vec3Fields value={node.transform.pos}
            onPreview={(v) => previewNode(setTransform("pos", v))}
            onCommit={(v) => commitNode(setTransform("pos", v))}
            onRevert={field.revert} />
        </div>
        <div>
          <div className="text-[10px] uppercase text-[var(--color-faint)]">Rotation (°)</div>
          <Vec3Fields value={node.transform.rot} labels={rotLabels}
            onPreview={(v) => previewNode(setTransform("rot", v))}
            onCommit={(v) => commitNode(setTransform("rot", v))}
            onRevert={field.revert} />
        </div>
        <div>
          <div className="text-[10px] uppercase text-[var(--color-faint)]">Scale</div>
          <Vec3Fields value={node.transform.scale}
            onPreview={(v) => previewNode(setTransform("scale", v))}
            onCommit={(v) => commitNode(setTransform("scale", v))}
            onRevert={field.revert} />
        </div>

        {node.kind === "primitive" && (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[10px] text-[var(--color-faint)]">Shape
              <select className="input mt-0.5 w-full px-1.5 py-1 text-xs" value={node.props.shape}
                onChange={(e) => edit((n) => {
                  if (n.kind === "primitive") n.props.shape = e.target.value as PrimitiveShape;
                })}>
                {PRIMITIVE_SHAPES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="text-[10px] text-[var(--color-faint)]">Color
              <input type="color" className="mt-0.5 block h-7 w-full cursor-pointer rounded border border-[var(--color-border)] bg-transparent"
                value={node.props.color}
                onChange={(e) => edit((n) => { if (n.kind === "primitive") n.props.color = e.target.value; })} />
            </label>
            <div className="col-span-2">
              <div className="text-[10px] text-[var(--color-faint)]">Size (m)</div>
              <Vec3Fields value={node.props.size}
                onPreview={(v) => previewNode((n) => writeKeyed(n, "props.size", v, () => { if (n.kind === "primitive") n.props.size = v; }))}
                onCommit={(v) => commitNode((n) => writeKeyed(n, "props.size", v, () => { if (n.kind === "primitive") n.props.size = v; }))}
                onRevert={field.revert} />
            </div>
          </div>
        )}

        {node.kind === "mannequin" && (
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2">
              <div className="text-[10px] text-[var(--color-faint)]">Pose - {node.props.pose}</div>
              <PosePicker value={node.props.pose}
                onPick={(p) => edit((n) => { if (n.kind === "mannequin") n.props.pose = p; })} />
            </div>
            <NumField label="Height (m)" min={0.5} max={2.5} step={0.05} value={node.props.height}
              onPreview={(v) => previewNode((n) => writeKeyed(n, "props.height", v, () => {
                if (n.kind === "mannequin") n.props.height = Math.min(2.5, Math.max(0.5, v));
              }))}
              onCommit={(v) => commitNode((n) => writeKeyed(n, "props.height", v, () => {
                if (n.kind === "mannequin") n.props.height = Math.min(2.5, Math.max(0.5, v));
              }))}
              onRevert={field.revert} />
          </div>
        )}

        {node.kind === "light" && (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[10px] text-[var(--color-faint)]">Type
              <select className="input mt-0.5 w-full px-1.5 py-1 text-xs" value={node.props.light}
                onChange={(e) => edit((n) => {
                  if (n.kind === "light") n.props.light = e.target.value as LightKind;
                })}>
                {LIGHT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <label className="text-[10px] text-[var(--color-faint)]">Color
              <input type="color" className="mt-0.5 block h-7 w-full cursor-pointer rounded border border-[var(--color-border)] bg-transparent"
                value={node.props.color}
                onChange={(e) => edit((n) => { if (n.kind === "light") n.props.color = e.target.value; })} />
            </label>
            {(["intensity", "angle", "range"] as const).map((prop) => (
              <NumField key={prop}
                label={prop === "intensity" ? "Intensity" : prop === "angle" ? "Angle °" : "Range (m)"}
                min={prop === "intensity" ? 0 : prop === "angle" ? 1 : 0}
                max={prop === "intensity" ? 50 : prop === "angle" ? 89 : 200}
                step={prop === "intensity" ? 0.5 : 0.1}
                value={node.props[prop]}
                onPreview={(v) => previewNode((n) => writeKeyed(n, `props.${prop}`, v, () => {
                  if (n.kind === "light") n.props[prop] = prop === "intensity" ? Math.min(50, Math.max(0, v)) : prop === "angle" ? Math.min(89, Math.max(1, v)) : Math.min(200, Math.max(0, v));
                }))}
                onCommit={(v) => commitNode((n) => writeKeyed(n, `props.${prop}`, v, () => {
                  if (n.kind === "light") n.props[prop] = prop === "intensity" ? Math.min(50, Math.max(0, v)) : prop === "angle" ? Math.min(89, Math.max(1, v)) : Math.min(200, Math.max(0, v));
                }))}
                onRevert={field.revert} />
            ))}
          </div>
        )}

        {node.kind === "camera" && (
          <CameraInspector scene={scene} node={node} t={t} edit={edit}
            previewNode={previewNode} commitNode={commitNode} field={field} />
        )}

        {node.kind === "model" && (
          <div className="text-[10px] text-[var(--color-faint)]">
            src <code className="text-[var(--color-text)]">{node.props.src}</code>
          </div>
        )}

        <label className="block text-[10px] text-[var(--color-faint)]">Per-object prompt (used at render time)
          <textarea className="input mt-0.5 w-full px-1.5 py-1 text-xs" rows={2} value={node.prompt ?? ""}
            onChange={(e) => edit((n) => { n.prompt = e.target.value || undefined; })} />
        </label>

        {/* key helpers */}
        <button className="btn btn-ghost btn-sm w-full text-[10px]"
          onClick={() => edit((n) => {
            const ks = (n.keys ?? []).filter((k) => k.t !== t);
            // stamp the SAMPLED pose - keyed tracks already own the property,
            // so keying the base transform would bake a stale pose
            const sampled = sampleNodeLocal(n, t);
            for (const p of ["transform.pos", "transform.rot", "transform.scale"] as const) {
              const field = p.split(".")[1] as "pos" | "rot" | "scale";
              ks.push({ t, path: p, value: [...sampled[field]] as Vec3 });
            }
            n.keys = ks;
          })}>
          ◆ Key transform at {t.toFixed(2)}s
        </button>
      </div>
    </div>
  );
}

/** the pose picker - thumbnails rendered lazily by the project's own
 *  mannequin builder (pose-thumbs.ts), names always shown so a headless
 *  environment still gets a usable picker */
function PosePicker({ value, onPick }: { value: MannequinPose; onPick(p: MannequinPose): void }) {
  const [open, setOpen] = useState(false);
  usePopoverGroup(open, () => setOpen(false));
  return (
    <div className="mt-0.5">
      <button type="button" className="input flex w-full items-center justify-between px-1.5 py-1 text-xs"
        onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="pose-picker-toggle">
        <span>{value}</span>
        <span className="text-[10px] text-[var(--color-faint)]">{open ? "▲" : "▼"} {MANNEQUIN_POSES.length} poses</span>
      </button>
      {open && (
        <div className="mt-1 grid max-h-56 grid-cols-3 gap-1 overflow-y-auto rounded border border-[var(--color-border)] p-1"
          data-testid="pose-picker">
          {MANNEQUIN_POSES.map((p) => (
            <PoseCell key={p} pose={p} active={p === value}
              onPick={() => { onPick(p); setOpen(false); }} />
          ))}
        </div>
      )}
    </div>
  );
}

function PoseCell({ pose, active, onPick }: { pose: MannequinPose; active: boolean; onPick(): void }) {
  // thumbs render on first mount of each cell - one shared GL context in
  // pose-thumbs, cached per pose afterwards
  const [src] = useState<string | null>(() => poseThumb(pose));
  return (
    <button type="button" onClick={onPick} title={pose} data-testid={`pose-${pose}`}
      className={`flex flex-col items-center gap-0.5 rounded border p-0.5 text-[9px] leading-tight ${
        active ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10" : "border-[var(--color-border)] hover:border-[var(--color-accent)]"}`}>
      {src
        // eslint-disable-next-line @next/next/no-img-element -- data-URL thumbnail from our own renderer
        ? <img src={src} alt={pose} width={48} height={64} className="rounded-sm" />
        : <span className="flex h-16 w-12 items-center justify-center rounded-sm bg-[var(--color-panel)] text-[8px]">{pose}</span>}
      <span className="max-w-full truncate">{pose}</span>
    </button>
  );
}

/* ================= scene panel (nothing selected) ================= */

function ScenePanel({ scene, mutate, field }: {
  scene: StageScene;
  mutate(fn: (sc: StageScene) => void): void;
  field: FieldEdit;
}) {
  const env = scene.env;
  const rs = scene.meta.renderSize;
  /* W→H aspect lock: the render size always keeps meta.aspect - changing W
   * re-derives H; the H field stays as the read-only readout */
  const aspectBase = ASPECT_SIZE[scene.meta.aspect];
  const setW = (v: number) => (sc: StageScene) => {
    const w = Math.min(4096, Math.max(64, Math.round(v)));
    sc.meta.renderSize = {
      w,
      h: Math.min(4096, Math.max(64, Math.round((w * aspectBase.h) / aspectBase.w))),
    };
  };
  return (
    <div className="max-h-[46%] min-h-40 overflow-y-auto border-t border-[var(--color-border)] p-2" aria-label="Scene panel">
      <div className="text-xs font-semibold">Scene</div>
      <p className="mt-0.5 text-[10px] text-[var(--color-faint)]">Select a node in the outliner to edit it.</p>
      <div className="mt-2 space-y-2">
        <label className="block text-[10px] text-[var(--color-faint)]">Background
          <input aria-label="Background" type="color"
            className="mt-0.5 block h-7 w-full cursor-pointer rounded border border-[var(--color-border)] bg-transparent"
            value={env.background}
            onChange={(e) => mutate((sc) => { sc.env.background = e.target.value; })} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <NumField label="Ambient" min={0} max={2} step={0.1} value={env.ambient}
            onPreview={(v) => field.previewMut((sc) => { sc.env.ambient = Math.min(2, Math.max(0, v)); })}
            onCommit={(v) => field.commitMut((sc) => { sc.env.ambient = Math.min(2, Math.max(0, v)); })}
            onRevert={field.revert} />
          <NumField label="Sun intensity" min={0} max={5} step={0.1} value={env.sun.intensity}
            onPreview={(v) => field.previewMut((sc) => { sc.env.sun.intensity = Math.min(5, Math.max(0, v)); })}
            onCommit={(v) => field.commitMut((sc) => { sc.env.sun.intensity = Math.min(5, Math.max(0, v)); })}
            onRevert={field.revert} />
        </div>
        <div>
          <div className="text-[10px] uppercase text-[var(--color-faint)]">Sun direction</div>
          <Vec3Fields value={env.sun.direction}
            onPreview={(v) => field.previewMut((sc) => { sc.env.sun.direction = v; })}
            onCommit={(v) => field.commitMut((sc) => { sc.env.sun.direction = v; })}
            onRevert={field.revert} />
        </div>
        <div>
          <div className="text-[10px] uppercase text-[var(--color-faint)]">Render size (px) - locked to {scene.meta.aspect}</div>
          <div className="grid grid-cols-2 gap-1">
            <NumField label="W" min={64} max={4096} step={1} value={rs.w}
              onPreview={(v) => field.previewMut(setW(v))}
              onCommit={(v) => field.commitMut(setW(v))}
              onRevert={field.revert} />
            <NumField label="H" value={rs.h} readOnly />
          </div>
        </div>
      </div>
    </div>
  );
}

/** subject-bound framing presets - pick a subject and a shot type; the
 *  camera teleports into the preset's offset in the subject's own frame,
 *  aims at it, and (with "follow") parents to the subject so the framing
 *  tracks its motion */
function FramingPresets({ scene, node, edit }: {
  scene: StageScene;
  node: Extract<StageNode, { kind: "camera" }>;
  edit(fn: (n: StageNode, sc: StageScene) => void): void;
}) {
  const subjects = presetSubjects(scene).filter((s) => s.id !== node.id);
  const [subjectId, setSubjectId] = useState(node.props.lookAt ?? subjects[0]?.id ?? "");
  const [presetId, setPresetId] = useState(CAMERA_PRESETS[1].id); // medium - the everyday default
  const [follow, setFollow] = useState(false);
  if (!subjects.length) return null;
  const apply = () => edit((n, sc) => {
    applyCameraPreset(sc, node.id, subjectId || subjects[0].id, presetId, { follow });
  });
  return (
    <div className="rounded border border-[var(--color-border)] p-1.5" data-testid="framing-presets">
      <div className="text-[10px] font-semibold text-[var(--color-faint)]">Framing preset</div>
      <div className="mt-1 grid grid-cols-2 gap-1">
        <select className="input px-1.5 py-1 text-xs" value={presetId}
          onChange={(e) => setPresetId(e.target.value)} aria-label="Framing preset" data-testid="preset-select">
          {CAMERA_PRESETS.map((pr) => <option key={pr.id} value={pr.id}>{pr.label}</option>)}
        </select>
        <select className="input px-1.5 py-1 text-xs" value={subjectId}
          onChange={(e) => setSubjectId(e.target.value)} aria-label="Preset subject" data-testid="preset-subject">
          {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <label className="flex items-center gap-1 text-[10px] text-[var(--color-faint)]" title="parent the camera to the subject - offset and aim track its motion">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} data-testid="preset-follow" />
          follow subject
        </label>
        <button className="btn btn-ghost btn-sm text-[10px]" onClick={apply} data-testid="preset-apply">Stamp framing</button>
      </div>
      <div className="mt-0.5 text-[9px] text-[var(--color-dim)]">
        {CAMERA_PRESETS.find((pr) => pr.id === presetId)?.note}
      </div>
    </div>
  );
}

function CameraInspector({ scene, node, t, edit, previewNode, commitNode, field }: {
  scene: StageScene;
  node: Extract<StageNode, { kind: "camera" }>;
  t: number;
  edit(fn: (n: StageNode, sc: StageScene) => void): void;
  previewNode(fn: (n: StageNode, sc: StageScene) => void): void;
  commitNode(fn: (n: StageNode, sc: StageScene) => void): void;
  field: FieldEdit;
}) {
  const pose = cameraAt(scene, t, node.id);
  const p = node.props;
  /* focal is keyable - once a track exists the field writes keys at the
   * playhead (auto-key), same rule as the transform fields */
  const setFocal = (mm: number) => (n: StageNode) => {
    const c = n as Extract<StageNode, { kind: "camera" }>;
    if (c.keys?.some((k) => k.path === "props.focalMm")) {
      const ks = c.keys.filter((k) => !(k.path === "props.focalMm" && Math.abs(k.t - t) < 1e-6));
      ks.push({ t, path: "props.focalMm", value: mm });
      c.keys = ks;
    } else {
      c.props.focalMm = Math.min(300, Math.max(8, mm));
    }
  };
  const fovToFocal = (fovDeg: number) => Math.min(300, Math.max(8, focalForHFov(fovDeg, p.sensor as SensorName)));
  const clampPt = (axis: number, v: number) => axis === 1 ? Math.max(0, v) : v;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <NumField label="Focal (mm)" min={8} max={300} step={1} value={p.focalMm}
            onPreview={(v) => previewNode(setFocal(Math.min(300, Math.max(8, v))))}
            onCommit={(v) => commitNode(setFocal(Math.min(300, Math.max(8, v))))}
            onRevert={field.revert} />
          <input aria-label="Focal slider" type="range" min={8} max={300} step={1}
            className="mt-1 w-full accent-[var(--color-accent)]" value={p.focalMm}
            onChange={(e) => edit((n) => {
              const c = n as Extract<StageNode, { kind: "camera" }>;
              c.props.focalMm = Math.min(300, Math.max(8, Number(e.target.value)));
            })} />
        </div>
        <div>
          <NumField label="FOV °" min={1} max={179} step={0.1}
            value={hFov(p.focalMm, p.sensor as SensorName)}
            onPreview={(v) => { if (v > 0 && v < 180) previewNode(setFocal(fovToFocal(v))); }}
            onCommit={(v) => { if (v > 0 && v < 180) commitNode(setFocal(fovToFocal(v))); }}
            onRevert={field.revert} />
        </div>
        <label className="text-[10px] text-[var(--color-faint)]">Sensor
          <select className="input mt-0.5 w-full px-1.5 py-1 text-xs" value={p.sensor}
            onChange={(e) => edit((n) => {
              const c = n as Extract<StageNode, { kind: "camera" }>;
              c.props.sensor = e.target.value as SensorName;
            })}>
            {SENSORS_LIST.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <p className="col-span-2 text-[10px] tabular-nums text-[var(--color-dim)]" data-testid="cam-fov">
          hFOV {pose ? pose.fov.toFixed(1) : "-"}° - focal/sensor drive the frustum and the through-camera view
        </p>
      </div>

      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-[10px] text-[var(--color-faint)]">
          <input type="checkbox" checked={p.isRender}
            onChange={(e) => edit((n, sc) => {
              const c = n as Extract<StageNode, { kind: "camera" }>;
              if (e.target.checked) {
                // the clone owns this edit - touching the prop scene would
                // corrupt live state AND the undo snapshot
                for (const o of sc.nodes) if (o.kind === "camera") o.props.isRender = false;
                c.props.isRender = true;
              }
            })} />
          Render camera
        </label>
        <label className="flex-1 text-[10px] text-[var(--color-faint)]">Look at
          <select className="input mt-0.5 w-full px-1.5 py-1 text-xs" value={p.lookAt ?? ""}
            onChange={(e) => edit((n) => {
              const c = n as Extract<StageNode, { kind: "camera" }>;
              if (e.target.value) c.props.lookAt = e.target.value; else delete c.props.lookAt;
            })}>
            <option value="">-</option>
            {scene.nodes.filter((x) => x.id !== node.id && x.kind !== "camera").map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
        </label>
      </div>

      {/* subject-bound framing presets */}
      <FramingPresets scene={scene} node={node} edit={edit} />

      {/* camera path editor */}
      <div className="rounded border border-[var(--color-border)] p-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold text-[var(--color-faint)]">Camera path</span>
          {p.path
            ? <button className="text-[10px] text-[var(--color-danger)]" onClick={() => edit((n) => { delete (n as Extract<StageNode, { kind: "camera" }>).props.path; })}>Clear</button>
            : <button className="text-[10px] text-[var(--color-accent)]" onClick={() => edit((n) => {
                const c = n as Extract<StageNode, { kind: "camera" }>;
                const a = c.transform.pos;
                c.props.path = {
                  points: [[...a] as Vec3, [a[0] * 0.6, Math.max(0.5, a[1] * 0.8), a[2] * 0.6] as Vec3],
                  times: [0, scene.meta.duration],
                };
              })}>New path</button>}
        </div>
        {p.path && (
          <div className="mt-1 space-y-1">
            {p.path.points.map((pt, i) => (
              <div key={i} className="flex items-center gap-1" data-testid={`path-point-${i}`}>
                <span className="w-4 text-[10px] text-[var(--color-faint)]">{i}</span>
                {([0, 1, 2] as const).map((axis) => (
                  <NumField key={axis} label={["X", "Y", "Z"][axis]} value={pt[axis]}
                    onPreview={(v) => previewNode((n) => {
                      const c = n as Extract<StageNode, { kind: "camera" }>;
                      if (c.props.path) c.props.path.points[i][axis] = clampPt(axis, v);
                    })}
                    onCommit={(v) => commitNode((n) => {
                      const c = n as Extract<StageNode, { kind: "camera" }>;
                      if (c.props.path) c.props.path.points[i][axis] = clampPt(axis, v);
                    })}
                    onRevert={field.revert} />
                ))}
                <NumField label="t" min={0} max={scene.meta.duration} value={p.path!.times[i]}
                  onPreview={(v) => previewNode((n) => {
                    const c = n as Extract<StageNode, { kind: "camera" }>;
                    if (c.props.path) c.props.path.times[i] = Math.min(scene.meta.duration, Math.max(0, v));
                  })}
                  onCommit={(v) => commitNode((n) => {
                    const c = n as Extract<StageNode, { kind: "camera" }>;
                    if (c.props.path) c.props.path.times[i] = Math.min(scene.meta.duration, Math.max(0, v));
                  })}
                  onRevert={field.revert} />
                {p.path!.points.length > 2 && (
                  <button className="text-[var(--color-danger)]" aria-label={`Remove point ${i}`}
                    onClick={() => edit((n) => {
                      const c = n as Extract<StageNode, { kind: "camera" }>;
                      c.props.path!.points.splice(i, 1);
                      c.props.path!.times.splice(i, 1);
                    })}>×</button>
                )}
              </div>
            ))}
            <button className="btn btn-ghost btn-sm w-full text-[10px]" onClick={() => edit((n) => {
              const c = n as Extract<StageNode, { kind: "camera" }>;
              const path = c.props.path!;
              // a fresh path ends at duration - a tail push can't stay
              // increasing; a midpoint insert between the last two knots can
              const m = path.points.length - 1;
              const tMid = (path.times[m - 1] + path.times[m]) / 2;
              const pMid = [0, 1, 2].map((i) => (path.points[m - 1][i] + path.points[m][i]) / 2) as Vec3;
              path.points.splice(m, 0, pMid);
              path.times.splice(m, 0, tMid);
            })}>+ Point</button>
            <p className="text-[10px] text-[var(--color-faint)]">Drag points in Top view · {p.path.points.length} control points</p>
          </div>
        )}
        {pose && (
          <p className="mt-1 text-[10px] tabular-nums text-[var(--color-faint)]">
            pose @ {t.toFixed(1)}s - yaw {pose.yaw.toFixed(1)}° pitch {pose.pitch.toFixed(1)}° fov {pose.fov.toFixed(1)}°
          </p>
        )}
      </div>
    </div>
  );
}

/* ================= timeline ================= */

function Timeline({ scene, t, sel, onSeek, onSelect, selKey, onSelectKey, onPreview, onCommit }: {
  scene: StageScene; t: number; sel: string | null;
  onSeek(t: number): void; onSelect(id: string): void;
  /** the selected diamond (owned by the editor - see its keydown handler) */
  selKey: { node: string; t: number } | null;
  onSelectKey(k: { node: string; t: number } | null): void;
  onPreview(mut: (sc: StageScene) => void): void;
  onCommit(mut: (sc: StageScene) => void): void;
}) {
  const dur = scene.meta.duration;
  const keyRows = scene.nodes.filter((n) => (n.keys?.length ?? 0) > 0);
  const pct = (v: number) => `${(v / dur) * 100}%`;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

  /** move every key the node has at fromT to toT; same-path keys already
   *  sitting at toT are replaced by the moved ones (drop-on merge) */
  const moveKeysAt = (sc: StageScene, nodeId: string, fromT: number, toT: number) => {
    const n = sc.nodes.find((x) => x.id === nodeId);
    if (!n?.keys) return;
    const landed = Math.min(dur, Math.max(0, toT));
    const moving = n.keys.filter((k) => near(k.t, fromT));
    if (!moving.length) return;
    const paths = new Set(moving.map((k) => k.path));
    n.keys = [
      ...n.keys.filter((k) => !near(k.t, fromT) && !(near(k.t, landed) && paths.has(k.path))),
      ...moving.map((k) => ({ ...k, t: landed })),
    ];
  };

  const removeKeysAt = (nodeId: string, kt: number) => {
    onCommit((sc) => {
      const n = sc.nodes.find((x) => x.id === nodeId);
      if (n?.keys) n.keys = n.keys.filter((k) => !near(k.t, kt));
    });
    onSelectKey(null);
  };

  /* Delete/Backspace is handled by the editor's single keydown listener -
   * a second listener here raced it and could eat the wrong edit. */

  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      onSeek(((ev.clientX - r.left) / r.width) * dur);
    };
    move(e.nativeEvent);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** click seeks+selects; a horizontal drag previews the move and commits
   *  once on pointer-up so undo stays per-gesture */
  const diamondDown = (e: React.PointerEvent, nodeId: string, kt: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    onSelectKey({ node: nodeId, t: kt });
    onSelect(nodeId);
    onSeek(kt);
    const startX = e.clientX;
    const row = (e.currentTarget as HTMLElement).closest("[data-keyrow]") as HTMLElement | null;
    const w = row?.getBoundingClientRect().width || 1;
    /* the gesture base: every preview AND the commit rebuild from this keys
     * snapshot - a cumulative preview that swept a diamond across another
     * same-path key deleted that key for good. Base-restart moves kt→nt
     * each move, so crossing merges visually but never erases mid-drag. */
    const baseKeys = structuredClone(scene.nodes.find((n) => n.id === nodeId)?.keys ?? []);
    let last = kt;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const nt = Math.min(dur, Math.max(0, kt + ((ev.clientX - startX) / w) * dur));
      if (Math.abs(nt - last) < 1e-9) return;
      onPreview((sc) => {
        const n = sc.nodes.find((x) => x.id === nodeId);
        if (n?.keys) n.keys = structuredClone(baseKeys);
        moveKeysAt(sc, nodeId, kt, nt);
      });
      last = nt;
      moved = true;
      onSeek(nt);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) {
        const fin = last;
        onCommit((sc) => {
          const n = sc.nodes.find((x) => x.id === nodeId);
          if (n?.keys) n.keys = structuredClone(baseKeys);
          moveKeysAt(sc, nodeId, kt, fin);
        });
        onSelectKey({ node: nodeId, t: fin });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="relative min-w-0 flex-1 select-none" data-testid="stage-timeline">
      {/* ruler */}
      <div className="relative h-4 cursor-ew-resize rounded bg-[var(--color-panel2)]" onPointerDown={scrub}>
        {Array.from({ length: Math.floor(dur) + 1 }, (_, i) => (
          <span key={i} className="absolute top-0 text-[9px] text-[var(--color-faint)]" style={{ left: `calc(${pct(i)} + 2px)` }}>{i}s</span>
        ))}
        <div className="absolute top-0 h-full w-px bg-[var(--color-accent)]" style={{ left: pct(t) }} />
      </div>
      {/* key rows - a diamond per keyed t across every path the node carries */}
      {keyRows.map((n) => {
        const times = [...new Set((n.keys ?? []).map((k) => Math.round(k.t * 1e6) / 1e6))].sort((a, b) => a - b);
        return (
          <div key={n.id} data-keyrow className="relative mt-1 h-4 rounded bg-[var(--color-panel2)]/50">
            <button className={`absolute left-0 top-0 z-10 h-full px-1 text-[9px] ${sel === n.id ? "text-[var(--color-accent)]" : "text-[var(--color-faint)]"}`}
              onClick={() => onSelect(n.id)}>{n.name}</button>
            {times.map((kt) => {
              const isSelK = selKey !== null && selKey.node === n.id && near(selKey.t, kt);
              return (
                <span key={kt}>
                  <button aria-label={`key at ${+kt.toFixed(3)}s`}
                    className={`absolute top-1/2 z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-ew-resize ${isSelK ? "bg-white" : "bg-[var(--color-accent)]"}`}
                    style={{ left: pct(kt) }}
                    onPointerDown={(e) => diamondDown(e, n.id, kt)} />
                  {isSelK && (
                    <button aria-label={`Delete key at ${+kt.toFixed(3)}s`}
                      className="absolute top-0 z-10 -translate-y-1/2 text-[10px] leading-none text-[var(--color-danger)]"
                      style={{ left: `calc(${pct(kt)} + 7px)` }}
                      onClick={() => removeKeysAt(n.id, kt)}>×</button>
                  )}
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
