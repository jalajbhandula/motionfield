"use client";
import { useState } from "react";
import { Lightbox, type LightboxItem } from "@/components/Lightbox";
import { ErrNote } from "@/components/ErrNote";
import { LoginGate } from "@/components/LoginGate";
import { PageExamples } from "@/components/ExampleCard";
import { uploadFile, userError, userErrorFrom, type UserError } from "@/lib/user-error";

/** Ad Lab - product photo/URL + brief → ad creative batch. */
export default function AdLab() {
  const [productUrl, setProductUrl] = useState("");
  const [productImg, setProductImg] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState<{ url: string }[]>([]);
  const [err, setErr] = useState<UserError | string | null>(null);
  const [viewer, setViewer] = useState<LightboxItem | null>(null);

  async function onPick(f: File) {
    setErr(null); setUploading(true);
    try {
      const d = await uploadFile(f);
      setProductImg(d.url);
    } catch (e) {
      setErr(userErrorFrom(e));
    } finally {
      setUploading(false);
    }
  }

  async function run() {
    setBusy(true); setErr(null); setResults([]);
    const prompt = `Professional product advertisement: ${brief || "clean studio product shot with dramatic lighting"}. ${productUrl ? `Product: ${productUrl}` : ""}`;
    try {
      const r = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint_id: "motionfield/product-placement", params: { prompt, product_image_url: productImg || undefined, aspect_ratio: "4:5", batch_size: 4 } }) });
      const d = await r.json();
      if (!r.ok) { setErr(userError(r.status, d.error)); return; }
      let job = d.job;
      while (["queued", "in_progress"].includes(job.status)) {
        await new Promise((x) => setTimeout(x, 1500));
        const jr = await fetch(`/api/jobs/${job.id}`);
        job = (await jr.json().catch(() => ({}))).job;
        if (!jr.ok || !job) { setErr(userError(jr.status, undefined)); return; }
      }
      if (job.status === "completed") setResults(job.outputs ?? []);
      else setErr(userError(undefined, job.error ?? job.status));
    } catch (e) {
      setErr(userErrorFrom(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-10">
      <h1 className="font-display text-3xl font-bold">Product Ads</h1>
      <p className="mt-1 text-[var(--color-dim)]">Product in, campaign-ready creatives out.</p>
      <PageExamples />
      <div className="panel mt-6 space-y-4 p-5">
        <LoginGate />
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase text-[var(--color-dim)]">Product image</label>
          <label className="grid h-28 cursor-pointer place-items-center rounded-xl border border-dashed border-[var(--color-border)] hover:border-[var(--color-accent)]">
            {productImg
              ? <img src={productImg} alt="product shot" className="h-full object-contain" />
              : <span className="text-sm text-[var(--color-dim)]">{uploading ? "Uploading…" : "+ Upload product shot"}</span>}
            <input type="file" accept="image/*" className="hidden" disabled={uploading}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void onPick(f); }} />
          </label>
        </div>
        <input className="input" placeholder="Product URL (optional - for brand context)" value={productUrl} onChange={(e) => setProductUrl(e.target.value)} />
        <textarea className="input min-h-20" placeholder="Brief - vibe, audience, must-haves…" value={brief} onChange={(e) => setBrief(e.target.value)} />
        <ErrNote err={err} />
        <button className="btn btn-primary" onClick={run} disabled={busy || uploading}>{busy ? "Generating…" : "Generate ad batch"}</button>
      </div>
      {results.length > 0 && (
        <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {results.map((r, i) => <div key={i} className="media-tile aspect-[4/5] cursor-pointer" onClick={() => setViewer({ url: r.url, type: "image" })}><img src={r.url} alt={`ad creative ${i + 1}`} /></div>)}
        </div>
      )}
      <Lightbox item={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}
