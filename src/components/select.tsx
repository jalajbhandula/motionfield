"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Chevron } from "@/components/nav-icons";
import { usePopoverGroup } from "@/lib/use-dismiss";

export type SelectOption = { value: string; label: string; note?: string; badge?: string; disabled?: boolean };

/** Styled single-select (button + listbox) - the app's replacement for a
 *  native <select> where options deserve a note/badge. Keyboard: arrows,
 *  Home/End, Enter/Space to pick, Escape to close; type to filter when the
 *  list is long. */
export function Select({ value, options, onChange, label, testId, searchFrom = 9 }: {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  label: string;
  testId?: string;
  searchFrom?: number;
}) {
  const [open, setOpen] = useState(false);
  usePopoverGroup(open, () => setOpen(false));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => `${o.label} ${o.note ?? ""} ${o.badge ?? ""}`.toLowerCase().includes(q)) : options;
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (!open) { setQuery(""); return; }
    setActive(Math.max(0, shown.findIndex((o) => o.value === value)));
    if (options.length >= searchFrom) requestAnimationFrame(() => search.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) wrap.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (o: SelectOption | undefined) => {
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
    button.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); }
      return;
    }
    // typing while the list is open always lands in the search box
    if (options.length >= searchFrom && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.target !== search.current) {
      e.preventDefault(); setQuery((q) => q + e.key); setActive(0); search.current?.focus(); return;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); button.current?.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(shown.length - 1); }
    else if (e.key === "Enter" || (e.key === " " && e.target === button.current)) { e.preventDefault(); pick(shown[active]); }
    else if (e.key === "Tab") setOpen(false);
  };

  return (
    <div ref={wrap} className="relative" onKeyDown={onKey}>
      <button ref={button} type="button" data-testid={testId} data-value={value}
        role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className={`input flex items-center gap-2 text-left transition-colors hover:border-[#3a3a42] ${open ? "border-[var(--color-accent)]" : ""}`}>
        <span className="min-w-0 flex-1 truncate">{current?.label ?? "Choose…"}</span>
        {current?.badge && <span className="max-w-[45%] shrink-0 truncate rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-dim)]" title={current.badge}>{current.badge}</span>}
        <Chevron open={open} className="h-3.5 w-3.5 shrink-0 text-[var(--color-dim)]" />
      </button>
      {open && (
        <div className="menu-in absolute left-0 right-0 top-full z-40 mt-1.5 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-[0_18px_48px_rgba(0,0,0,.55)]">
          {options.length >= searchFrom && (
            <div className="border-b border-[var(--color-border)] p-2">
              <input ref={search} value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }}
                placeholder="Search…" aria-label={`Search ${label}`}
                className="w-full rounded-lg bg-[var(--color-panel2)] px-3 py-2 text-[13px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]" />
            </div>
          )}
          <ul id={listId} role="listbox" aria-label={label} className="max-h-80 overflow-y-auto p-1.5">
            {shown.length === 0 && <li className="px-3 py-2 text-[13px] text-[var(--color-faint)]">No match</li>}
            {shown.map((o, i) => {
              const selected = o.value === value;
              return (
                <li key={o.value} data-idx={i} role="option" aria-selected={selected} aria-disabled={o.disabled || undefined}
                  onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg px-3 py-2 ${i === active ? "bg-[var(--color-panel2)]" : ""} ${o.disabled ? "cursor-not-allowed opacity-50" : ""}`}>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[13px] font-medium ${selected ? "text-[var(--color-accent)]" : "text-[var(--color-text)]"}`}>{o.label}</span>
                    {o.note && <span className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-[var(--color-faint)]">{o.note}</span>}
                  </span>
                  {o.badge && <span className="mt-0.5 max-w-[38%] shrink-0 truncate rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-dim)]" title={o.badge}>{o.badge}</span>}
                  {selected && (
                    <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12l5 5 9-10" />
                    </svg>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
