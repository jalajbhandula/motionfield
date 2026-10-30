"use client";
import { useEffect, useState } from "react";
import { MemoriesV, type MemoryRow } from "@/app/projects/[id]/memory-map";

/** The assistant sidebar's Memory panel - list, save by name, forget.
 *  Reads the caller's own rows through /api/agent/memories; nothing renders
 *  for a logged-out view. */

export function MemoryPanel() {
  const [mems, setMems] = useState<MemoryRow[] | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [open, setOpen] = useState(false);

  const load = () => fetch("/api/agent/memories")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const p = MemoriesV.safeParse(d);
      setMems(p.success ? p.data.memories : []);
    })
    .catch(() => setMems([]));
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!name.trim() || !content.trim()) return;
    const r = await fetch("/api/agent/memories", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), content: content.trim() }),
    });
    if (r.ok) { setName(""); setContent(""); load(); }
  };
  const forget = async (id: string) => {
    const r = await fetch(`/api/agent/memories/${id}`, { method: "DELETE" });
    if (r.ok) load();
  };

  return (
    <div className="mt-3 border-t border-[var(--color-line)] pt-2" data-testid="memory-panel">
      <button type="button"
        className="flex w-full items-center justify-between px-5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-dim)]"
        onClick={() => setOpen((o) => !o)}>
        Memory <span className="text-[9px] normal-case">{mems?.length ?? "…"}</span>
      </button>
      {open && (
        <div className="px-3 pb-2 pt-1.5">
          <div className="mb-1.5 space-y-1">
            <input className="w-full rounded-md bg-[var(--color-panel2)] px-2 py-1 text-[11px] outline-none placeholder:text-[var(--color-dim)]"
              placeholder="name - e.g. brand-colors" value={name} onChange={(e) => setName(e.target.value)}
              data-testid="memory-name" />
            <textarea className="w-full resize-none rounded-md bg-[var(--color-panel2)] px-2 py-1 text-[11px] outline-none placeholder:text-[var(--color-dim)]"
              rows={2} placeholder="what to remember…" value={content} onChange={(e) => setContent(e.target.value)}
              data-testid="memory-content" />
            <button type="button" className="w-full rounded-md bg-[var(--color-line)] py-1 text-[10px] font-semibold hover:opacity-80 disabled:opacity-40"
              disabled={!name.trim() || !content.trim()} onClick={save} data-testid="memory-save">Save memory</button>
          </div>
          <div className="max-h-36 space-y-0.5 overflow-y-auto">
            {(mems ?? []).map((m) => (
              <div key={m.id} data-testid={`memory-${m.name}`}
                className="group flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-[var(--color-dim)] hover:bg-[var(--color-panel2)]">
                <span className="min-w-0 flex-1 truncate" title={m.content}>
                  <span className="font-semibold text-[var(--color-fg)]">{m.name}</span>
                  {m.project_id && <span className="ml-1 rounded bg-[var(--color-line)] px-1 text-[9px]">project</span>}
                  <span className="ml-1 opacity-60">{m.kind}</span>
                </span>
                <button type="button" title={`forget ${m.name}`} data-testid={`memory-forget-${m.name}`}
                  className="shrink-0 text-[var(--color-dim)] hover:text-red-300"
                  onClick={() => forget(m.id)}>×</button>
              </div>
            ))}
            {mems?.length === 0 && <div className="px-2 py-1 text-[10px] text-[var(--color-dim)]">Nothing remembered yet.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
