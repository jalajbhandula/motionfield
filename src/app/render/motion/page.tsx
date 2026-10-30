"use client";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { parseSceneSpec, type SceneSpec } from "@/lib/render/spec";
import { buildScene, type RenderHandle } from "@/lib/render/runtime";

/**
 * Chrome-less deterministic render page.
 *
 * Spec sources (first match wins):
 *   window.__OF_SPEC__ - injected by the headless exporter (addInitScript)
 *   ?spec=<base64url> - inline JSON
 *   ?id=<specId> - GET /api/render/specs/:id (signed-in session)
 *
 * Exposes window.__of = { ready, renderAt(t), setParams(values), spec } -
 * renderAt is a pure function of (spec, params, t), safe to drive frame-by-frame
 * from Playwright.
 *
 * ?preview=1 adds a real-time rAF loop + sliders generated from spec.params.
 */

export interface OfHandle {
  ready: Promise<void>;
  renderAt(t: number): Promise<void>;
  setParams(values: Record<string, number>): void;
  spec: SceneSpec;
}

declare global {
  interface Window {
    __of?: OfHandle;
    __OF_SPEC__?: unknown;
    /** set when the spec fails to load/validate - headless exporter reads this */
    __ofError?: string;
  }
}

function b64urlDecode(s: string): string {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0)));
}

async function loadSpec(): Promise<SceneSpec> {
  if (window.__OF_SPEC__ !== undefined) return parseSceneSpec(window.__OF_SPEC__);
  const q = new URLSearchParams(window.location.search);
  const b64 = q.get("spec");
  if (b64) return parseSceneSpec(JSON.parse(b64urlDecode(b64)));
  const id = q.get("id");
  if (id) {
    const res = await fetch(`/api/render/specs/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`spec fetch failed (${res.status})`);
    const data = await res.json();
    return parseSceneSpec(data.spec);
  }
  throw new Error("no spec - pass ?spec=<base64url JSON>, ?id=<specId>, or inject window.__OF_SPEC__");
}

const mono: React.CSSProperties = { fontFamily: "ui-monospace, Menlo, monospace" };

export default function RenderMotionPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<RenderHandle | null>(null);
  const [spec, setSpec] = useState<SceneSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [clock, setClock] = useState(0);
  const [vals, setVals] = useState<Record<string, number>>({});
  const clockRef = useRef(0);
  const busyRef = useRef(false);

  // spec load (once)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setPreview(q.get("preview") === "1" || q.get("preview") === "true");
    let dead = false;
    loadSpec()
      .then((s) => { if (!dead) setSpec(s); })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        window.__ofError = msg;
        if (!dead) setError(msg);
      });
    return () => { dead = true; };
  }, []);

  // scene build + __of exposure
  useEffect(() => {
    if (!spec || !canvasRef.current) return;
    const handle = buildScene(spec, THREE, canvasRef.current);
    handleRef.current = handle;
    const defaults: Record<string, number> = {};
    for (const p of spec.params ?? []) defaults[p.id] = p.default;
    setVals(defaults);
    window.__of = {
      ready: handle.ready,
      renderAt: (t) => handle.renderAt(t),
      setParams: (v) => handle.setParams(v),
      spec,
    };
    handle.renderAt(0).catch(() => {});
    return () => {
      handle.dispose();
      handleRef.current = null;
      delete window.__of;
    };
  }, [spec]);

  // preview: real-time playback loop - skip a frame while a render runs
  useEffect(() => {
    if (!preview || !spec || !playing) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = ((now - t0) / 1000) % spec.duration;
      clockRef.current = t;
      setClock(t);
      if (!busyRef.current) {
        busyRef.current = true;
        handleRef.current?.renderAt(t).catch(() => {}).finally(() => { busyRef.current = false; });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [preview, spec, playing]);

  const setParam = (id: string, v: number) => {
    setVals((s) => ({ ...s, [id]: v }));
    handleRef.current?.setParams({ [id]: v });
    // paused: repaint the current time so the slider's effect shows immediately
    if (!playing && !busyRef.current) {
      busyRef.current = true;
      handleRef.current?.renderAt(clockRef.current).catch(() => {}).finally(() => { busyRef.current = false; });
    }
  };

  return (
    <div
      data-testid="render-stage"
      style={{
        position: "fixed", inset: 0, zIndex: 9999, background: "#000",
        display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
      }}
    >
      <canvas
        ref={canvasRef}
        data-testid="render-canvas"
        style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
      />
      {!spec && !error && (
        <div style={{ position: "absolute", color: "#777", ...mono, fontSize: 13 }}>loading spec…</div>
      )}
      {error && (
        <div style={{ position: "absolute", color: "#ff5c5c", ...mono, fontSize: 13, maxWidth: "80%", whiteSpace: "pre-wrap" }}>
          render error: {error}
        </div>
      )}
      {preview && spec && (
        <div
          data-testid="preview-panel"
          style={{
            position: "absolute", left: 16, bottom: 16, display: "flex", flexDirection: "column", gap: 10,
            background: "rgba(12,12,14,.88)", border: "1px solid #2a2a30", borderRadius: 12,
            padding: "14px 16px", minWidth: 280, backdropFilter: "blur(6px)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#ddd", ...mono, fontSize: 12 }}>
            <button
              data-testid="preview-play"
              onClick={() => setPlaying((p) => !p)}
              style={{ background: "#22242b", color: "#eee", border: "1px solid #34363e", borderRadius: 6, padding: "3px 10px", cursor: "pointer", ...mono }}
            >
              {playing ? "pause" : "play"}
            </button>
            <span>{clock.toFixed(2)}s / {spec.duration.toFixed(2)}s</span>
          </div>
          {(spec.params ?? []).map((p) => (
            <label key={p.id} style={{ display: "flex", flexDirection: "column", gap: 4, color: "#bbb", ...mono, fontSize: 11 }}>
              <span style={{ display: "flex", justifyContent: "space-between" }}>
                <span>{p.label}</span>
                <span style={{ color: "#888" }}>{(vals[p.id] ?? p.default).toFixed(2)}</span>
              </span>
              <input
                type="range"
                data-testid={`param-${p.id}`}
                min={p.min}
                max={p.max}
                step={p.step}
                value={vals[p.id] ?? p.default}
                onChange={(e) => setParam(p.id, Number(e.target.value))}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
