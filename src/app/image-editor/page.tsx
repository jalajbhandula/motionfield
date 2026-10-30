"use client";
import { useState } from "react";
import { Lightbox, type LightboxItem } from "@/components/Lightbox";
import { ErrNote } from "@/components/ErrNote";
import { LoginGate } from "@/components/LoginGate";
import { PageExamples } from "@/components/ExampleCard";
import { uploadFile, userError, userErrorFrom, type UserError } from "@/lib/user-error";

/** Layers - prompt-driven AI image editor on Qwen Image Edit + Real-ESRGAN. */
const EDIT = "motionfield/qwen-image-edit/edit";
const TOOLS: { id: string; label: string; needsPrompt: boolean; endpoint: string; preset?: string; apply?: Record<string, unknown> }[] = [
  { id: "edit", label: "Prompt edit", needsPrompt: true, endpoint: EDIT },
  { id: "relight", label: "Relight", needsPrompt: true, endpoint: EDIT },
  { id: "angles", label: "Change angle", needsPrompt: true, endpoint: EDIT, apply: { edit_mode: "angles" } },
  { id: "expand", label: "Expand / crop", needsPrompt: true, endpoint: EDIT },
  { id: "upscale", label: "Upscale 2×", needsPrompt: false, endpoint: "motionfield/upscale/image" },
  { id: "skin", label: "Skin retouch", needsPrompt: false, endpoint: EDIT, preset: "enhance skin texture, professional beauty retouch, keep identity" },
  { id: "color", label: "Color grade", needsPrompt: true, endpoint: EDIT },
];

export default function Layers() {
  const [image, setImage] = useState<string | null>(null);
  const [tool, setTool] = useState(TOOLS[0]);
  const [prompt, setPrompt] = useState("");
  const [out, setOut] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<UserError | string | null>(null);
  const [viewer, setViewer] = useState<LightboxItem | null>(null);

  async function onPick(f: File) {
    setErr(null); setUploading(true);
    try {
      const d = await uploadFile(f);
      setImage(d.url);
    } catch (e) {
      setErr(userErrorFrom(e));
    } finally {
      setUploading(false);
    }
  }

  async function run() {
    if (!image) return;
    setStatus("running"); setErr(null); setOut(null);
    const p = prompt || tool.preset || tool.label;
    try {
      const r = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint_id: tool.endpoint, params: { prompt: p, image_url: image, ...(tool.apply ?? {}) } }) });
      const d = await r.json();
      if (!r.ok) { setErr(userError(r.status, d.error)); setStatus(""); return; }
      let job = d.job;
      while (["queued", "in_progress"].includes(job.status)) {
        await new Promise((x) => setTimeout(x, 1200));
        const jr = await fetch(`/api/jobs/${job.id}`);
        job = (await jr.json().catch(() => ({}))).job;
        if (!jr.ok || !job) { setErr(userError(jr.status, undefined)); setStatus(""); return; }
      }
      setStatus(job.status);
      if (job.status === "completed") setOut(job.outputs?.[0]?.url);
      else setErr(userError(undefined, job.error ?? job.status));
    } catch (e) {
      setErr(userErrorFrom(e)); setStatus("");
    }
  }

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8">
      <h1 className="font-display text-3xl font-bold">Image Editor</h1>
      <p className="text-[var(--color-dim)]">AI image editing - upload, pick a tool, describe the change.</p>
      <PageExamples />
      <div className="mt-4 max-w-md"><LoginGate /></div>
      <div className="mt-6 grid gap-6 lg:grid-cols-[240px_1fr_1fr]">
        <div className="panel h-fit space-y-1 p-3">
          {TOOLS.map((t) => (
            <button key={t.id} onClick={() => setTool(t)}
              className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${tool.id === t.id ? "bg-[var(--color-panel2)] text-white" : "text-[var(--color-dim)] hover:text-white"}`}>{t.label}</button>
          ))}
        </div>
        <div>
          <label className="grid aspect-square cursor-pointer place-items-center rounded-2xl border border-dashed border-[var(--color-border)] hover:border-[var(--color-accent)]">
            {image ? <img src={image} alt="edit source" className="h-full w-full rounded-2xl object-cover" /> : <span className="text-[var(--color-dim)]">{uploading ? "Uploading…" : "+ Upload image"}</span>}
            <input type="file" accept="image/*" className="hidden" disabled={uploading}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void onPick(f); }} />
          </label>
          {tool.needsPrompt && <textarea className="input mt-3 min-h-20" placeholder={`${tool.label} instruction…`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />}
          <ErrNote err={err} className="mt-2" />
          <button className="btn btn-primary mt-3 w-full" onClick={run} disabled={!image || uploading || status === "running"}>
            {status === "running" ? "Editing…" : `Apply ${tool.label}`}
          </button>
        </div>
        <div className="media-tile grid aspect-square place-items-center">
          {out ? <img src={out} alt="edit result" className="h-full w-full cursor-zoom-in object-cover" onClick={() => setViewer({ url: out, type: "image" })} /> : <span className="text-sm text-[var(--color-faint)]">Result</span>}
        </div>
      </div>
      <Lightbox item={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}
