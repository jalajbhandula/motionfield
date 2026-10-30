"use client";
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles } from "lucide-react";
import { BeforeAfter } from "./BeforeAfter";
import { uploadFile } from "@/lib/user-error";
import { examplesForPath, exampleHref, type FeatureExample } from "@/lib/examples";

/** Re-upload an example's bundled inputs as the user's own /files/ media and
 *  return the params to prefill (consent is never pre-ticked). */
export async function loadExampleParams(e: FeatureExample): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...e.params };
  for (const [k, v] of Object.entries(e.inputs ?? {})) {
    const srcs = Array.isArray(v) ? v : [v];
    const urls: string[] = [];
    for (const src of srcs) {
      const blob = await (await fetch(src)).blob();
      urls.push((await uploadFile(blob, src.split("/").pop())).url);
    }
    out[k] = Array.isArray(v) ? urls : urls[0];
  }
  return out;
}

export function ExampleMedia({ e, className = "" }: { e: FeatureExample; className?: string }) {
  if (e.kind === "video") return <video src={e.media} className={className} muted loop playsInline autoPlay preload="metadata" />;
  if (e.kind === "audio") return <audio src={e.media} controls className="w-full" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={e.media} alt={String(e.params.prompt ?? "example output")} className={className} />;
}

function TryButton({ e, onTry, href, wide }: { e: FeatureExample; onTry?: (p: Record<string, unknown>) => void; href?: string; wide?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cls = `btn btn-primary ${wide ? "w-full justify-center" : ""}`;
  return (
    <div className={wide ? "w-full" : ""}>
      {onTry ? (
        <button className={cls} disabled={busy} data-testid="try-example" onClick={async () => {
          setBusy(true); setErr(null);
          try { onTry(await loadExampleParams(e)); } catch (x) { setErr(x instanceof Error ? x.message : "couldn't load the example"); }
          setBusy(false);
        }}><Sparkles size={14} className="mr-1.5 inline-block" />{busy ? "Loading example…" : "Try this example"}</button>
      ) : href && e.tryHref ? (
        /* full navigation: the tool page reads ?example on mount */
        <a href={href} className={cls} data-testid="try-example"><Sparkles size={14} className="mr-1.5 inline-block" />Try this example</a>
      ) : href ? (
        <Link href={href} className={cls} data-testid="try-example"><Sparkles size={14} className="mr-1.5 inline-block" />Try this example</Link>
      ) : null}
      {err && <p className="mt-2 text-xs text-[var(--color-danger)]">{err}</p>}
    </div>
  );
}

function Caption({ e }: { e: FeatureExample }) {
  const [open, setOpen] = useState(false);
  const prompt = typeof e.params.prompt === "string" ? e.params.prompt
    : typeof e.params.look === "string" ? `Look: ${e.params.look.replace(/-/g, " ")}` : "";
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-faint)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />Example · made on our GPU
      </div>
      {prompt && (
        <button type="button" onClick={() => setOpen((o) => !o)} title={open ? "Collapse" : prompt}
          className={`block w-full text-left text-sm leading-relaxed text-[var(--color-text)] ${open ? "" : "line-clamp-2"}`}>
          {typeof e.params.prompt === "string" ? `“${prompt}”` : prompt}
        </button>
      )}
      <p className="truncate text-xs text-[var(--color-dim)]" title={e.credit}>{e.credit}</p>
    </div>
  );
}

/** A real generation + "Try this example". Pass onTry inside the studio
 *  (prefills in place) or href on a standalone page (deep link).
 *  layout "stack" = media over caption (narrow columns); "row" = media left,
 *  caption + button right (page-width panels; stacks again on small screens). */
export function ExampleCard({ e, onTry, href, layout = "stack" }: { e: FeatureExample; onTry?: (p: Record<string, unknown>) => void; href?: string; layout?: "stack" | "row" }) {
  const media = e.kind === "audio"
    ? <div className="p-4"><ExampleMedia e={e} /></div>
    : e.before && (e.kind === "image" || e.kind === "video")
    ? <div className="flex items-center justify-center bg-black"><BeforeAfter before={e.before} after={e.media} kind={e.kind} withAudio={e.studio === "audio"} maxH={layout === "row" ? 420 : 460} alt={String(e.params.prompt ?? "")} /></div>
    : <div className="flex items-center justify-center bg-black"><ExampleMedia e={e} className={`object-contain ${layout === "row" ? "max-h-[420px] w-auto max-w-full" : "max-h-[460px] w-full"}`} /></div>;
  if (layout === "row") return (
    <div className="panel grid overflow-hidden border border-[var(--color-border)] md:grid-cols-[minmax(0,auto)_minmax(280px,1fr)]" data-example={e.endpoint}>
      {media}
      <div className="flex flex-col justify-between gap-5 p-5">
        <Caption e={e} />
        <TryButton e={e} onTry={onTry} href={href} />
      </div>
    </div>
  );
  return (
    <div className="panel overflow-hidden border border-[var(--color-border)]" data-example={e.endpoint}>
      {media}
      <div className="space-y-4 p-4">
        <Caption e={e} />
        <TryButton e={e} onTry={onTry} href={href} wide />
      </div>
    </div>
  );
}

/** Real example(s) for a standalone tool page - place it under the page
 *  title/subtitle, inside the page's content column. */
export function PageExamples({ pathname }: { pathname?: string }) {
  const here = usePathname();
  const list = examplesForPath(pathname ?? here ?? "");
  if (!list.length) return null;
  return (
    <section className="mt-6 space-y-3" aria-label="Example">
      {list.map((e) => <ExampleCard key={e.endpoint} e={e} href={exampleHref(e)} layout="row" />)}
    </section>
  );
}
