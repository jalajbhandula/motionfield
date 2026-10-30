"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { buildScene, type RenderHandle } from "@/lib/render/runtime";
import type { SceneSpec } from "@/lib/render/spec";

/**
 * Live SceneSpec preview - letterboxed canvas + transport bar.
 * Rebuilds on spec change; param writes repaint the current frame even while
 * paused. A paint that lands mid-render is not dropped: the latest (t) is
 * remembered and runs when the current frame finishes, so the last slider
 * value always ends up on screen.
 *
 * spec.post (mono/flash/glow) is an exporter-side ffmpeg feature - the
 * preview approximates it with a CSS filter on the canvas and labels the
 * approximation so nobody mistakes it for the real composite.
 */
export default function SceneCanvas({
  spec,
  params,
  onReady,
}: {
  spec: SceneSpec;
  params?: Record<string, number>;
  onReady?: (handle: RenderHandle) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<RenderHandle | null>(null);
  const tRef = useRef(0);
  const busyRef = useRef(false);
  const pendingRef = useRef<number | null>(null);
  const paramsRef = useRef<Record<string, number> | undefined>(params);
  paramsRef.current = params;
  const [playing, setPlaying] = useState(true);
  const [clock, setClock] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const hasPost = Boolean(spec.post?.mono?.length || spec.post?.flash?.length || spec.post?.glow?.length);

  // CSS approximation of the ffmpeg post chain - honest label only, the
  // exporter does the real composite (mono→grayscale, flash→brightness,
  // glow→brightness+blur-ish)
  const postCssAt = useCallback((t: number): string => {
    const p = spec.post;
    if (!p) return "";
    if (p.flash?.some((f) => t >= f.t && t < f.t + f.frames / spec.fps)) return "brightness(3)";
    if (p.mono?.some((w) => t >= w.t0 && t < w.t1)) return "grayscale(1)";
    const g = p.glow?.find((w) => t >= w.t0 && t < w.t1);
    if (g) return `brightness(${1 + 0.45 * g.strength}) saturate(${1 + 0.4 * g.strength})`;
    return "";
  }, [spec.post, spec.fps]);

  const paint = useCallback((t: number) => {
    tRef.current = t;
    if (busyRef.current) {
      pendingRef.current = t; // keep only the freshest request
      return;
    }
    busyRef.current = true;
    const run = (tt: number) => {
      if (paramsRef.current) handleRef.current?.setParams(paramsRef.current);
      const c = canvasRef.current;
      if (c && hasPost) c.style.filter = postCssAt(tt);
      handleRef.current?.renderAt(tt).catch(() => {}).finally(() => {
        busyRef.current = false;
        const p = pendingRef.current;
        if (p !== null) {
          pendingRef.current = null;
          busyRef.current = true;
          run(p);
        }
      });
    };
    run(t);
  }, [hasPost, postCssAt]);

  // (re)build whenever the spec object changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const h = buildScene(spec, THREE, canvas);
    handleRef.current = h;
    busyRef.current = false;
    pendingRef.current = null;
    tRef.current = 0;
    setClock(0);
    setError(null);
    h.ready.then(() => {
      onReady?.(h);
      return h.renderAt(0);
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      handleRef.current = null;
      h.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);

  // param writes - always push to the handle; repaint immediately when paused
  useEffect(() => {
    if (!params) return;
    handleRef.current?.setParams(params);
    if (!playing) paint(tRef.current);
  }, [params, playing, paint]);

  // playback loop - mid-render frames coalesce into one pending repaint
  useEffect(() => {
    if (!playing) return;
    const t0 = performance.now() - tRef.current * 1000; // resume from scrub pos
    let raf = 0;
    const tick = (now: number) => {
      const t = ((now - t0) / 1000) % spec.duration;
      setClock(t);
      paint(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, spec.duration, paint]);

  const scrub = (v: number) => {
    setPlaying(false);
    setClock(v);
    paint(v);
  };

  return (
    <div>
      {/* letterbox: fixed to the spec's aspect, canvas stretched inside */}
      <div
        className="relative w-full overflow-hidden rounded-lg bg-black"
        style={{ aspectRatio: `${spec.width} / ${spec.height}` }}
      >
        <canvas
          ref={canvasRef}
          width={spec.width}
          height={spec.height}
          className="absolute inset-0 h-full w-full object-contain"
        />
        {hasPost && (
          <div className="absolute right-2 top-2 rounded bg-black/70 px-2 py-0.5 font-mono text-[10px] text-[var(--color-dim)]">
            post fx · preview approximation
          </div>
        )}
        {error && (
          <div className="absolute inset-0 grid place-items-center bg-black/80 p-4 text-sm text-[var(--color-danger)]">
            {error}
          </div>
        )}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          className="btn btn-ghost btn-sm w-14"
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={spec.duration}
          step={0.01}
          value={clock}
          onChange={(e) => scrub(Number(e.target.value))}
          className="min-w-0 flex-1 accent-[var(--color-accent)]"
          aria-label="Seek"
        />
        <span className="w-24 text-right font-mono text-xs text-[var(--color-dim)]">
          {clock.toFixed(2)} / {spec.duration.toFixed(1)}s
        </span>
      </div>
    </div>
  );
}
