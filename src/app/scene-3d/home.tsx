"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ASPECTS, type Aspect } from "@/lib/stage/scene";
import { ErrNote } from "@/components/ErrNote";
import { GlbViewer } from "@/components/GlbViewer";

const EXAMPLE_PROMPT = "a lighthouse keeper on a rocky pier at dusk, a lantern on a crate beside him, a small rowboat moored to the left, slow dolly-in from the sea";
import { userError, type UserError } from "@/lib/user-error";

/**
 * /scene-3d - "My Scenes" newest-first, with the New-scene prompt form.
 * The generate call is a real POST /api/stage: 503 NEEDS_LLM surfaces the
 * Empty-scene fallback instead of failing blind.
 */

interface SceneRow { id: string; title: string; revision: number; created_at: string; updated_at: string }
interface UploadRow { id: string; url: string; mime: string; name: string | null; created_at: string }

async function jfetch(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export default function StageHome() {
  const router = useRouter();
  const [scenes, setScenes] = useState<SceneRow[] | null>(null);
  const [authed, setAuthed] = useState(true);
  const [error, setError] = useState<UserError | string | null>(null);
  const [needsLlm, setNeedsLlm] = useState(false);
  const [busy, setBusy] = useState(false);

  // new-scene form
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState(15);
  const [aspect, setAspect] = useState<Aspect>("16:9");
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [refs, setRefs] = useState<Set<string>>(new Set());

  const load = async () => {
    const r = await jfetch("/api/stage");
    if (r.status === 401) { setAuthed(false); setScenes([]); return; }
    setAuthed(true);
    setScenes(r.data.scenes ?? []);
    const up = await jfetch("/api/uploads");
    if (up.ok) setUploads(up.data.uploads ?? []);
  };
  useEffect(() => { load().catch(() => setScenes([])); }, []);

  const create = async (mode: "prompt" | "empty") => {
    setBusy(true); setError(null);
    const body = mode === "empty"
      ? { empty: true, duration, aspect }
      : { prompt: prompt.trim(), refs: [...refs], duration, aspect };
    const r = await jfetch("/api/stage", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    setBusy(false);
    if (r.status === 503) { setNeedsLlm(true); setError(userError(503, String(r.data.error ?? "no LLM configured"))); return; }
    if (!r.ok) { setError(userError(r.status, r.data.error)); return; }
    router.push(`/scene-3d/${r.data.id}`);
  };

  const rename = async (row: SceneRow) => {
    const title = window.prompt("Rename scene", row.title)?.trim();
    if (!title || title === row.title) return;
    const r = await jfetch(`/api/stage/${row.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_revision: row.revision, title }),
    });
    if (!r.ok) { setError(userError(r.status, r.data.error)); return; }
    load();
  };

  const del = async (row: SceneRow) => {
    if (!window.confirm(`Delete "${row.title}"? This can't be undone.`)) return;
    const r = await jfetch(`/api/stage/${row.id}`, { method: "DELETE" });
    if (!r.ok) { setError(userError(r.status, r.data.error)); return; }
    setScenes((s) => (s ?? []).filter((x) => x.id !== row.id));
  };

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-8">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">3D Scene</h1>
          <p className="text-sm text-[var(--color-dim)] mt-1">
            Prompt a grey-box scene, block it in 3D, compose the camera.
          </p>
        </div>
      </div>

      {/* new scene */}
      <section className="panel mt-6 p-4" aria-label="New scene">
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-faint)]">New scene</div>
        <textarea
          aria-label="Scene prompt"
          className="input mt-3 min-h-20 w-full resize-y"
          placeholder='e.g. "a mannequin on a pedestal between two boxes, a warm spot from the left, slow dolly-in"'
          value={prompt}
          onChange={(e) => { setPrompt(e.target.value); setNeedsLlm(false); }}
        />
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-xs text-[var(--color-dim)]">
            Duration (s)
            <input aria-label="Duration" className="input mt-1 block w-24" type="number" min={1} max={60}
              value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
          </label>
          <label className="text-xs text-[var(--color-dim)]">
            Aspect
            <select aria-label="Aspect" className="input mt-1 block w-28" value={aspect}
              onChange={(e) => setAspect(e.target.value as Aspect)}>
              {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <button className="btn btn-primary btn-sm" disabled={busy || !prompt.trim()} onClick={() => create("prompt")}>
              {busy ? "Writing…" : "Generate scene"}
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => create("empty")}>
              Empty scene
            </button>
          </div>
        </div>

        {uploads.length > 0 && (
          <fieldset className="mt-3">
            <legend className="text-xs text-[var(--color-dim)]">References (your uploads - images get vision-read when a vision route is configured)</legend>
            <div className="mt-2 flex max-h-28 flex-wrap gap-2 overflow-y-auto">
              {uploads.map((u) => (
                <label key={u.id} className={`chip cursor-pointer ${refs.has(u.url) ? "chip-on" : ""}`}>
                  <input type="checkbox" className="sr-only" checked={refs.has(u.url)}
                    onChange={() => setRefs((s) => { const n = new Set(s); if (n.has(u.url)) n.delete(u.url); else n.add(u.url); return n; })} />
                  {u.name ?? u.url.split("/").pop()}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {needsLlm && (
          <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">
            {typeof error === "string" ? error : error?.message} - or start from an <button className="underline" onClick={() => create("empty")}>Empty scene</button>.
          </p>
        )}
        {!needsLlm && <ErrNote err={error} className="mt-3" />}
      </section>

      {/* example - a real LLM-blocked scene, exported from the editor */}
      <section className="panel mt-6 p-4" aria-label="Example scene" data-testid="scene-example">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-faint)]">Example: Lighthouse Keeper at Dusk</div>
          <button className="btn btn-ghost btn-sm" onClick={() => { setPrompt(EXAMPLE_PROMPT); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
            Try this example
          </button>
        </div>
        <p className="mt-1 text-xs text-[var(--color-dim)]">&ldquo;{EXAMPLE_PROMPT}&rdquo; - laid out by the local model, then exported as GLB and a camera still.</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <GlbViewer url="/examples/feature/scene-3d-lighthouse.glb" className="aspect-video w-full rounded-xl" />
            <div className="mt-1 text-[11px] text-[var(--color-faint)]">GLB - drag to orbit</div>
          </div>
          <div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/examples/feature/scene-3d-lighthouse.jpg" alt="Camera still of the lighthouse keeper scene" className="aspect-video w-full rounded-xl object-cover" />
            <div className="mt-1 text-[11px] text-[var(--color-faint)]">Still from the scene camera</div>
          </div>
        </div>
        <div className="mt-4 grid items-center gap-3 md:grid-cols-2">
          <video src="/examples/feature/stage-render.mp4" muted loop playsInline autoPlay className="aspect-video w-full rounded-xl bg-black object-cover" />
          <p className="text-xs text-[var(--color-dim)]">
            <span className="font-medium text-[var(--color-text)]">Render video</span> - a different blocked scene (ground, camera, sun) rendered as a real
            shot: &ldquo;a woman in a yellow raincoat walking across a sunlit plaza toward a fountain&rdquo;. The block&apos;s depth guides
            Wan 2.1 VACE 1.3B (Apache-2.0) on the GPU.
          </p>
        </div>
      </section>

      {/* my scenes */}
      <section className="mt-8">
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-faint)]">My Scenes</div>
        {!authed && (
          <p className="mt-4 text-sm text-[var(--color-dim)]">
            <Link className="text-[var(--color-accent)] underline" href="/login?next=/scene-3d">Log in</Link> to keep scenes.
          </p>
        )}
        {authed && scenes === null && <div className="panel mt-4 h-24 animate-pulse" />}
        {authed && scenes?.length === 0 && (
          <p className="mt-4 text-sm text-[var(--color-faint)]">No scenes yet - write a prompt above, or open an Empty scene.</p>
        )}
        <ul className="mt-4 space-y-2">
          {(scenes ?? []).map((s) => (
            <li key={s.id} className="panel flex items-center gap-3 px-4 py-3">
              <Link href={`/scene-3d/${s.id}`} className="min-w-0 flex-1 truncate font-medium hover:text-[var(--color-accent)]">
                {s.title}
              </Link>
              <span className="text-xs text-[var(--color-faint)]">rev {s.revision} · {new Date(s.updated_at).toLocaleString()}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => router.push(`/scene-3d/${s.id}`)}>Open</button>
              <button className="btn btn-ghost btn-sm" onClick={() => rename(s)}>Rename</button>
              <button className="btn btn-ghost btn-sm text-[var(--color-danger)]" onClick={() => del(s)}>Delete</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
