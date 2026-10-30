"use client";
import { useState } from "react";
import { useDismiss, useDropUp } from "@/lib/use-dismiss";

/**
 * The composer mode menu - the three run modes in plain words. `modeLocked`
 * (MOTIONFIELD_OFFLINE=1) keeps Offline pinned and the menu closed.
 */

export const MODE_OPTIONS = [
  { id: "Auto", hint: "Plans your request the best way it can" },
  { id: "Offline", hint: "Uses only models on this computer, nothing goes online" },
  { id: "Custom", hint: "Asks you to choose the model for every step" },
] as const;
export type ModeId = (typeof MODE_OPTIONS)[number]["id"];
const MODE_API = { Auto: "auto", Offline: "offline", Custom: "custom" } as const;
const API_MODE = { auto: "Auto", offline: "Offline", custom: "Custom" } as const;
export const modeToApi = (m: ModeId): "auto" | "offline" | "custom" => MODE_API[m];
export const apiToMode = (m: string): ModeId | null =>
  m === "auto" || m === "offline" || m === "custom" ? API_MODE[m] : null;

export function ModeMenu({
  mode, locked, onPick, chev,
}: {
  mode: ModeId;
  locked: boolean;
  onPick: (m: ModeId) => void;
  chev: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useDismiss<HTMLDivElement>(open, setOpen);
  const up = useDropUp(wrap, open);
  return (
    <div className="relative" ref={wrap}>
      <button
        type="button"
        title={locked ? "Offline is locked on by MOTIONFIELD_OFFLINE=1" : "Mode"}
        data-testid="mode-menu-button"
        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-[var(--color-dim)] hover:bg-[var(--color-line)] disabled:cursor-not-allowed disabled:opacity-60"
        disabled={locked}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-[var(--color-faint)]">Mode:</span> {mode}{locked ? " (locked)" : ""} {chev}
      </button>
      {open && !locked && (
        <div data-testid="mode-menu" className={`absolute left-0 z-30 w-64 ${up ? "bottom-full mb-1" : "top-full mt-1"} rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-1 shadow-xl`}>
          {MODE_OPTIONS.map((o) => (
            <button type="button" key={o.id} data-testid={`mode-option-${o.id.toLowerCase()}`}
              className={`w-full rounded-lg px-2.5 py-2 text-left hover:bg-[var(--color-panel2)] ${o.id === mode ? "text-[var(--color-accent)]" : ""}`}
              onClick={() => { onPick(o.id); setOpen(false); }}>
              <div className="text-xs font-semibold">{o.id}</div>
              <div className="text-[10px] text-[var(--color-dim)]">{o.hint}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
