"use client";
import { useState } from "react";
import { Music, X } from "lucide-react";
import type { ParamField } from "@/lib/catalog/types";
import { uploadFile, userErrorFrom, type UserError } from "@/lib/user-error";
import { ErrNote } from "./ErrNote";

export function UploadInput({ value, onChange, accept, multiple, maxItems, disabled, ariaLabel, tileAlt }: {
  value: string | string[] | null; onChange: (v: string | string[]) => void;
  accept: string; multiple?: boolean; maxItems?: number; disabled?: boolean;
  /** names the hidden file input for label lookups - the visible "+" tile
   *  carries no text of its own */
  ariaLabel?: string;
  /** alt text for the selected-file image tiles (decorative "" by default) */
  tileAlt?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<UserError | null>(null);
  const items = Array.isArray(value) ? value : value ? [value] : [];
  const fileName = (u: string) => decodeURIComponent(u.split("/").pop() ?? u);
  return (
    <div className="w-full">
      <div className="flex flex-wrap gap-2">
        {items.map((u, i) => (
          <div key={i} className="w-16">
            <div className="relative media-tile h-16 w-16">
              {accept.startsWith("image") ? <img src={u} alt={tileAlt ?? ""} /> : accept.startsWith("video") ? <video src={u} muted /> : <div className="grid h-full place-items-center"><Music size={16} className="text-[var(--color-dim)]" /></div>}
              <button onClick={() => onChange(multiple ? items.filter((_, j) => j !== i) : "")}
                className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/70 text-white"><X size={10} /></button>
            </div>
            <p className="mt-0.5 truncate text-[9px] text-[var(--color-faint)]" title={fileName(u)}>{fileName(u)}</p>
          </div>
        ))}
        {(!maxItems || items.length < maxItems) && (
          <label title={disabled ? "Tick the consent box first" : undefined} className={`grid h-16 w-16 place-items-center rounded-xl border border-dashed border-[var(--color-border)] text-xl ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer text-[var(--color-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"}`}>
            {busy ? "…" : "+"}
            <input type="file" accept={accept} multiple={multiple} className="hidden" disabled={busy || disabled}
              aria-label={ariaLabel}
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? []);
                if (!files.length) return;
                setBusy(true); setErr(null);
                try {
                  const urls = (await Promise.all(files.map((f) => uploadFile(f)))).map((d) => d.url);
                  onChange(multiple ? [...items, ...urls].slice(0, maxItems ?? 99) : urls[0]);
                } catch (x) { setErr(userErrorFrom(x)); }
                finally { setBusy(false); e.target.value = ""; }
              }} />
          </label>
        )}
      </div>
      <ErrNote err={err} className="mt-2" />
    </div>
  );
}

export function ParamFieldView({ field, value, onChange, options, disabled }: {
  field: ParamField;
  value: unknown;
  onChange: (v: unknown) => void;
  options?: Record<string, { value: string; label: string }[]>;
  disabled?: boolean;
}) {
  const v = value ?? field.default;

  switch (field.type) {
    case "prompt":
    case "textarea":
      return (
        <textarea className="input min-h-24 resize-y" placeholder={field.placeholder}
          value={String(v ?? "")} onChange={(e) => onChange(e.target.value)} />
      );
    case "text":
      return <input className="input" placeholder={field.placeholder} value={String(v ?? "")} onChange={(e) => onChange(e.target.value)} />;
    case "number":
    case "integer":
      return <input type="number" className="input" min={field.min} max={field.max}
        value={v === undefined || v === null ? "" : Number(v)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />;
    case "slider":
      return (
        <div className="flex items-center gap-3">
          <input type="range" className="flex-1 accent-[var(--color-accent)]" min={field.min ?? 0} max={field.max ?? 1} step={field.step ?? 0.1}
            value={Number(v ?? 0)} onChange={(e) => onChange(Number(e.target.value))} />
          <span className="w-10 text-right text-xs text-[var(--color-dim)]">{Number(v ?? 0)}</span>
        </div>
      );
    case "boolean":
      // likeness consent is a real checkbox - the label is the assertion
      if (field.name === "likeness_consent") {
        return (
          <label className="flex cursor-pointer items-start gap-2 text-sm text-[var(--color-dim)]">
            <input type="checkbox" checked={!!v} onChange={(e) => onChange(e.target.checked)}
              className="mt-0.5 accent-[var(--color-accent)]" />
            <span>{field.label}</span>
          </label>
        );
      }
      return (
        <button onClick={() => onChange(!v)}
          className={`h-6 w-11 rounded-full transition-colors relative ${v ? "bg-[var(--color-accent)]" : "bg-[var(--color-panel2)] border border-[var(--color-border)]"}`}>
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${v ? "left-[22px]" : "left-0.5"}`} />
        </button>
      );
    case "select": {
      const opts = options?.[field.name] ?? (field.enum ?? []).map((x) => ({ value: String(x), label: String(x) }));
      return (
        <div className="flex flex-wrap gap-1.5" data-field={field.name}>
          {opts.map((o) => (
            <button key={o.value} onClick={() => onChange(o.value)}
              className={`chip ${String(v) === o.value ? "chip-on" : "hover:border-[#3a3a42]"}`}>{o.label}</button>
          ))}
        </div>
      );
    }
    case "image":
    case "video":
    case "audio":
      return <UploadInput value={(v as string) ?? null} onChange={(x) => onChange(x)}
        accept={field.type === "image" ? "image/*" : field.type === "video" ? "video/*" : "audio/*"} disabled={disabled} />;
    case "images":
      return <UploadInput value={(v as string[]) ?? []} onChange={(x) => onChange(x)} accept="image/*" multiple maxItems={field.maxItems} disabled={disabled} />;
    case "media":
      return <UploadInput value={(v as string[]) ?? []} onChange={(x) => onChange(x)} accept="image/*,video/*,audio/*" multiple maxItems={field.maxItems} disabled={disabled} />;
    case "multishots": {
      const shots = Array.isArray(v) ? (v as { prompt: string; duration: number }[]) : [];
      return (
        <div className="space-y-2">
          {shots.map((s, i) => (
            <div key={i} className="panel p-2 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[var(--color-dim)]">Shot {i + 1}</span>
                <button className="text-xs text-[var(--color-danger)]" onClick={() => onChange(shots.filter((_, j) => j !== i))}>Remove</button>
              </div>
              <input className="input" placeholder="Shot prompt" value={s.prompt}
                onChange={(e) => onChange(shots.map((x, j) => j === i ? { ...x, prompt: e.target.value } : x))} />
              <input type="number" className="input" min={1} max={15} value={s.duration}
                onChange={(e) => onChange(shots.map((x, j) => j === i ? { ...x, duration: Number(e.target.value) } : x))} />
            </div>
          ))}
          {shots.length < (field.maxItems ?? 6) && (
            <button className="btn btn-ghost btn-sm w-full" onClick={() => onChange([...shots, { prompt: "", duration: 5 }])}>+ Add shot</button>
          )}
        </div>
      );
    }
    default:
      return null;
  }
}
