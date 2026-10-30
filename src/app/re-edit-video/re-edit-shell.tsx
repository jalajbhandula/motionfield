"use client";
import { useState } from "react";
import Link from "next/link";
import ReCutClient, { type RestyleTile } from "./re-edit-client";
import BeatCut from "./beat-cut";
import { COMING_SOON } from "@/lib/catalog/coming-soon";

type Mode = "remake" | "music";
const MODES: [Mode, string, string][] = [
  ["remake", "Remake an edit", "Upload a reference edit - it's split into shots, each regenerated with your subjects, and returned as one file: same order, timing, aspect, fps and soundtrack."],
  ["music", "Cut to music", "Drop in a few clips and a track - the tempo and bars are found, the clips are cut on the beat (faster where the music is louder) with transitions on the bar starts."],
];

/** /re-edit-video - two ways to edit: remake a reference edit shot by shot, or cut clips to a track's beat. */
export default function ReCutShell({ restyleTiles, initialMode, authed }: { restyleTiles: RestyleTile[]; initialMode: Mode; authed: boolean }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const pick = (m: Mode) => {
    setMode(m);
    const u = new URL(window.location.href);
    if (m === "music") u.searchParams.set("mode", "music"); else u.searchParams.delete("mode");
    window.history.replaceState(null, "", u);
  };
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-2xl font-bold tracking-tight">Re-edit Video</h1>
        <div className="flex gap-1 rounded-lg border border-[var(--color-border)] p-1 text-sm" role="tablist" data-testid="re-edit-modes">
          {MODES.map(([m, label]) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => pick(m)}
              className={`rounded-md px-3 py-1 ${mode === m ? "bg-[var(--color-panel2)] text-[var(--color-text)]" : "text-[var(--color-dim)] hover:text-[var(--color-text)]"}`}>{label}</button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-sm text-[var(--color-dim)]">{MODES.find(([m]) => m === mode)![2]}</p>
      <p className="mt-3 max-w-[68ch] text-sm text-[var(--color-faint)]">{COMING_SOON["motionfield/re-edit/v1.0"]} This page is not one of the finished flows.</p>
      {!authed && <p className="panel mt-6 p-4 text-sm"><Link href="/login?next=/re-edit-video" className="underline">Sign in</Link> to edit.</p>}
      <div className="mt-6">{mode === "music" ? <BeatCut authed={authed} /> : <ReCutClient restyleTiles={restyleTiles} />}</div>
    </div>
  );
}
