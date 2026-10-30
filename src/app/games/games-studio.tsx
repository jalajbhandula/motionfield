"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BEHAVIORS, CONTROLS, ENEMY_LOOKS, GENRE_GOALS, GENRES, PICKUP_LOOKS, PLAYER_LOOKS, THEMES,
  type GameDraft, type GameSpec, type Genre,
} from "@/lib/games/spec";
import { ErrNote } from "@/components/ErrNote";
import { userError, type UserError } from "@/lib/user-error";
import { EXAMPLE_GAME, EXAMPLE_GAME_ID } from "@/lib/games/example";

/**
 * /games - describe a game, play it right here, tweak it live, share a link.
 * The game itself runs from /api/games/<id>/play in an iframe sandboxed to
 * allow-scripts only; edits preview instantly over postMessage and persist on
 * Save.
 */

interface GameRow {
  id: string; title: string; prompt?: string; spec: GameSpec | null; via: "llm" | "template";
  public: boolean; mine: boolean; created_at: string; updated_at: string;
}

const GENRE_LABEL: Record<Genre, string> = {
  platformer: "Platformer", runner: "Endless runner", shooter: "Shooter", adventure: "Adventure", puzzle: "Match-3 puzzle", racer: "Racer",
};
const GOAL_LABEL = { reach_end: "Reach the end", score: "Reach a score", survive: "Survive (seconds)", collect: "Collect items" } as const;

const EXAMPLES = [
  "A tiny frog hopping across lily pads to rescue its family from a grumpy heron",
  "Endless runner: a bike courier dashing through a neon city at night",
  "Space shooter where a lone pilot defends a moon base from crystal bugs",
  "A knight exploring a haunted crypt collecting lost souls, top-down",
  "Match-3 with tropical fruits on a sunny beach",
  "Arcade racer weaving through snowy mountain traffic",
];

async function jfetch(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}
const jsonInit = (method: string, body: unknown): RequestInit => ({
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

function draftOf(s: GameSpec): GameDraft {
  const { version: _v, seed: _s, ...d } = s;
  return d;
}

export default function GamesStudio({ llmReady }: { llmReady: boolean }) {
  const [games, setGames] = useState<GameRow[] | null>(null);
  const [authed, setAuthed] = useState(true);
  const [current, setCurrent] = useState<GameRow | null>(null);
  const [draft, setDraft] = useState<GameDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [genre, setGenre] = useState<Genre | "auto">("auto");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<UserError | string | null>(null);
  const [refineText, setRefineText] = useState("");
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

  const load = useCallback(async () => {
    const r = await jfetch("/api/games");
    if (r.status === 401) { setAuthed(false); setGames([]); return; }
    setAuthed(true);
    setGames(r.data.games ?? []);
  }, []);
  useEffect(() => { load().catch(() => setGames([])); }, [load]);

  const open = (g: GameRow) => {
    setCurrent(g); setDraft(g.spec ? draftOf(g.spec) : null); setDirty(false); setLastEvent(null); setError(null);
  };

  // game → studio events (win/lose/score) from the sandboxed frame
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const d = e.data as { type?: string; event?: string; score?: number };
      if (d?.type !== "motionfield-game-event") return;
      if (d.event === "win") setLastEvent(`You won - ${d.score} points`);
      else if (d.event === "lose") setLastEvent(`Game over - ${d.score} points`);
      else if (d.event === "start") setLastEvent(null);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // live preview: push the edited draft into the running game
  const preview = useCallback((d: GameDraft) => {
    if (!current?.spec) return;
    frame.current?.contentWindow?.postMessage({ type: "motionfield-game-spec", spec: { ...d, version: 1, seed: current.spec.seed } }, "*");
  }, [current]);

  const edit = (fn: (d: GameDraft) => GameDraft) => {
    if (!draft) return;
    const next = fn(structuredClone(draft));
    setDraft(next); setDirty(true); preview(next);
  };

  const create = async () => {
    setBusy("create"); setError(null);
    const r = await jfetch("/api/games", jsonInit("POST", { prompt: prompt.trim(), ...(genre === "auto" ? {} : { genre }) }));
    setBusy(null);
    if (!r.ok) { setError(userError(r.status, r.data.error)); return; }
    const g = r.data.game as GameRow;
    setGames((list) => [g, ...(list ?? [])]);
    open(g);
  };

  const patch = async (body: Record<string, unknown>, what: string) => {
    if (!current) return;
    setBusy(what); setError(null);
    const r = await jfetch(`/api/games/${current.id}`, jsonInit("PATCH", body));
    setBusy(null);
    if (!r.ok) { setError(userError(r.status, r.data.error)); return; }
    const g = r.data.game as GameRow;
    setGames((list) => (list ?? []).map((x) => (x.id === g.id ? g : x)));
    open(g);
  };

  const refine = async () => {
    if (!current) return;
    setBusy("refine"); setError(null);
    const r = await jfetch(`/api/games/${current.id}/refine`, jsonInit("POST", { instruction: refineText.trim() }));
    setBusy(null);
    if (!r.ok) { setError(userError(r.status, r.data.error)); return; }
    const g = r.data.game as GameRow;
    setGames((list) => (list ?? []).map((x) => (x.id === g.id ? g : x)));
    setRefineText("");
    open(g);
  };

  const del = async () => {
    if (!current || !window.confirm(`Delete "${current.title}"? This can't be undone.`)) return;
    const r = await jfetch(`/api/games/${current.id}`, { method: "DELETE" });
    if (!r.ok) { setError(userError(r.status, r.data.error)); return; }
    setGames((list) => (list ?? []).filter((x) => x.id !== current.id));
    setCurrent(null); setDraft(null);
  };

  const shareUrl = current ? `${typeof window === "undefined" ? "" : window.location.origin}/games/play/${current.id}` : "";
  const copy = async () => {
    try { await navigator.clipboard.writeText(shareUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  const frameSrc = useMemo(() => (current ? `/api/games/${current.id}/play?v=${encodeURIComponent(current.updated_at)}` : ""), [current]);

  return (
    <div className="mx-auto max-w-[1320px] px-4 py-8">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Game Builder</h1>
        <p className="mt-1 text-sm text-[var(--color-dim)]">Describe a game. Play it in your browser, tune it, share the link.</p>
      </div>

      {!authed && (
        <p className="panel mt-6 p-4 text-sm">
          <Link href="/login" className="underline">Sign in</Link> to make games.
        </p>
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="space-y-5">
          <section className="panel p-4" aria-label="New game">
            <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-faint)]">New game</div>
            <textarea
              aria-label="Game idea" data-testid="game-prompt"
              className="input mt-3 min-h-28 w-full resize-y"
              placeholder="What's the game about? Who do you play, what's in the way, how do you win?"
              value={prompt} onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="mt-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Genre">
              {(["auto", ...GENRES] as const).map((g) => (
                <button key={g} role="radio" aria-checked={genre === g} data-testid={`genre-${g}`}
                  className={`chip ${genre === g ? "chip-on" : ""}`} onClick={() => setGenre(g)}>
                  {g === "auto" ? "Auto" : GENRE_LABEL[g]}
                </button>
              ))}
            </div>
            <button className="btn btn-primary mt-4 w-full" data-testid="game-create"
              disabled={!authed || busy === "create" || prompt.trim().length < 3} onClick={create}>
              {busy === "create" ? (llmReady ? "Designing your game…" : "Building…") : "Create game"}
            </button>
            {!llmReady && (
              <p className="mt-3 text-xs text-[var(--color-dim)]" data-testid="games-template-note">
                No local model set up, so games start from a genre template matched to your words.
                Add one in <Link className="underline" href="/settings/models">Settings → Models &amp; LLMs</Link> for fully custom designs.
              </p>
            )}
            <div className="mt-4 text-xs font-semibold uppercase tracking-wider text-[var(--color-faint)]">Try one</div>
            <div className="mt-2 space-y-1.5">
              {EXAMPLES.map((ex) => (
                <button key={ex} className="block w-full rounded-lg px-2 py-1.5 text-left text-xs text-[var(--color-dim)] hover:bg-[var(--color-panel2)] hover:text-[var(--color-text)]"
                  onClick={() => setPrompt(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </section>

          <section className="panel p-4" aria-label="My games">
            <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-faint)]">My games</div>
            {games === null && <div className="skeleton mt-3 h-16 rounded-lg" />}
            {games?.length === 0 && authed && <p className="mt-3 text-sm text-[var(--color-dim)]">No games yet.</p>}
            <ul className="mt-2 space-y-1" data-testid="games-list">
              {games?.map((g) => (
                <li key={g.id}>
                  <button onClick={() => open(g)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-[var(--color-panel2)] ${current?.id === g.id ? "bg-[var(--color-panel2)]" : ""}`}>
                    <span className="min-w-0 flex-1 truncate">{g.title}</span>
                    {g.spec && <span className="shrink-0 text-[11px] text-[var(--color-faint)]">{GENRE_LABEL[g.spec.genre]}</span>}
                    {g.public && <span className="shrink-0 rounded-full border border-[var(--color-border)] px-1.5 text-[10px] text-[var(--color-dim)]">shared</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </aside>

        <main className="min-w-0 space-y-5">
          <ErrNote err={error} />
          {!current && (
            <div className="space-y-2" data-testid="game-example">
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="font-display text-xl font-semibold">Example: {EXAMPLE_GAME.title}</h2>
                <span className="chip">Designed by the local model from one sentence</span>
              </div>
              <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-black">
                <iframe src={`/api/games/${EXAMPLE_GAME_ID}/play`} title={`${EXAMPLE_GAME.title} - example game`}
                  sandbox="allow-scripts" allow="fullscreen" data-testid="game-example-frame"
                  className="block aspect-video w-full" />
              </div>
              <p className="text-xs text-[var(--color-dim)]">
                Click the game, then ←/→ move · Space jump. Six genres - platformer, runner, shooter, adventure, puzzle and racer - all playable with keyboard or touch. Your own game appears here.
              </p>
            </div>
          )}

          {current && current.spec && draft && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display mr-1 text-xl font-semibold" data-testid="game-title">{current.title}</h2>
                <span className="chip">{GENRE_LABEL[current.spec.genre]}</span>
                <span className="chip" title={current.via === "llm" ? "Designed by your local model" : "Built from a genre template"} data-testid="game-via">
                  {current.via === "llm" ? "Designed by your model" : "Template"}
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <button className="btn btn-sm" onClick={() => frame.current?.requestFullscreen?.()}>Fullscreen</button>
                  <button className="btn btn-sm" disabled={!!busy} onClick={() => patch({ reseed: true }, "reseed")} data-testid="game-reseed">New layout</button>
                  <label className="btn btn-sm cursor-pointer">
                    <input type="checkbox" className="mr-1.5" checked={current.public} data-testid="game-share"
                      disabled={!!busy} onChange={(e) => patch({ public: e.target.checked }, "share")} />
                    Share link
                  </label>
                  {current.public && <button className="btn btn-sm" onClick={copy} data-testid="game-copy">{copied ? "Copied" : "Copy link"}</button>}
                  <button className="btn btn-ghost btn-sm" onClick={del}>Delete</button>
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-black">
                <iframe
                  key={frameSrc} ref={frame} src={frameSrc} title={`${current.title} - game`}
                  sandbox="allow-scripts" allow="fullscreen" data-testid="game-frame"
                  className="block aspect-video w-full"
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-dim)]">
                <span>{CONTROLS[draft.genre]} · R restarts · click the game first so it gets your keys</span>
                {lastEvent && <span className="font-medium text-[var(--color-text)]" data-testid="game-event">{lastEvent}</span>}
              </div>

              <section className="panel p-4" aria-label="Change it in words">
                <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-faint)]">Change it in words</div>
                <div className="mt-2 flex gap-2">
                  <input className="input flex-1" placeholder='e.g. "make it night time and add a boss that shoots"'
                    value={refineText} onChange={(e) => setRefineText(e.target.value)} disabled={!llmReady}
                    onKeyDown={(e) => { if (e.key === "Enter" && refineText.trim().length > 1) refine(); }} />
                  <button className="btn btn-primary" disabled={!llmReady || busy === "refine" || refineText.trim().length < 2} onClick={refine}>
                    {busy === "refine" ? "Applying…" : "Apply"}
                  </button>
                </div>
                {!llmReady && <p className="mt-2 text-xs text-[var(--color-faint)]">Needs a local model - use the controls below meanwhile.</p>}
              </section>

              <Tweaks draft={draft} edit={edit} />

              <div className="flex items-center justify-end gap-3">
                {dirty && <span className="text-xs text-[var(--color-dim)]">Unsaved changes - previewing live</span>}
                {dirty && <button className="btn btn-sm" onClick={() => open(current)}>Discard</button>}
                <button className="btn btn-primary" disabled={!dirty || busy === "save"} onClick={() => patch({ draft }, "save")} data-testid="game-save">
                  {busy === "save" ? "Saving…" : "Save changes"}
                </button>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block text-xs text-[var(--color-dim)] ${className}`}>
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function Slider({ label, value, min, max, onChange, testId }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; testId?: string }) {
  return (
    <Field label={`${label} · ${value}`}>
      <input type="range" min={min} max={max} value={value} data-testid={testId}
        onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" />
    </Field>
  );
}

function Tweaks({ draft, edit }: { draft: GameDraft; edit: (fn: (d: GameDraft) => GameDraft) => void }) {
  const goals = GENRE_GOALS[draft.genre];
  const paletteKeys = ["sky", "ground", "player", "enemy", "pickup", "accent"] as const;
  return (
    <section className="panel p-4" aria-label="Tune the game">
      <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-faint)]">Tune it</div>
      <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Field label="Genre">
          <select className="input w-full" value={draft.genre} data-testid="tweak-genre"
            onChange={(e) => edit((d) => {
              const g = e.target.value as Genre;
              const kind = GENRE_GOALS[g].includes(d.goal.kind) ? d.goal.kind : GENRE_GOALS[g][0];
              return { ...d, genre: g, goal: { ...d.goal, kind } };
            })}>
            {GENRES.map((g) => <option key={g} value={g}>{GENRE_LABEL[g]}</option>)}
          </select>
        </Field>
        <Field label="World">
          <select className="input w-full" value={draft.theme} onChange={(e) => edit((d) => ({ ...d, theme: e.target.value as GameDraft["theme"] }))}>
            {THEMES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Goal">
          <select className="input w-full" value={draft.goal.kind} onChange={(e) => edit((d) => ({ ...d, goal: { ...d.goal, kind: e.target.value as GameDraft["goal"]["kind"] } }))}>
            {goals.map((g) => <option key={g} value={g}>{GOAL_LABEL[g]}</option>)}
          </select>
        </Field>
        {draft.goal.kind !== "reach_end" && (
          <Field label="Goal target">
            <input className="input w-full" type="number" min={1} max={500} value={draft.goal.target}
              onChange={(e) => edit((d) => ({ ...d, goal: { ...d.goal, target: Math.max(1, Math.min(500, Number(e.target.value) || 1)) } }))} />
          </Field>
        )}
        <Slider label="Difficulty" value={draft.difficulty} min={1} max={5} testId="tweak-difficulty" onChange={(v) => edit((d) => ({ ...d, difficulty: v }))} />
        <Slider label="Length" value={draft.length} min={1} max={5} onChange={(v) => edit((d) => ({ ...d, length: v }))} />
        <Slider label="Speed" value={draft.player.speed} min={1} max={10} onChange={(v) => edit((d) => ({ ...d, player: { ...d.player, speed: v } }))} />
        <Slider label="Jump" value={draft.player.jump} min={1} max={10} onChange={(v) => edit((d) => ({ ...d, player: { ...d.player, jump: v } }))} />
        <Slider label="Lives" value={draft.player.lives} min={1} max={5} onChange={(v) => edit((d) => ({ ...d, player: { ...d.player, lives: v } }))} />
        <Field label="Hero" className="xl:col-span-2">
          <div className="flex gap-2">
            <input className="input min-w-0 flex-1" maxLength={24} value={draft.player.name} onChange={(e) => edit((d) => ({ ...d, player: { ...d.player, name: e.target.value.slice(0, 24) } }))} />
            <select className="input w-32 shrink-0" value={draft.player.look} onChange={(e) => edit((d) => ({ ...d, player: { ...d.player, look: e.target.value as GameDraft["player"]["look"] } }))}>
              {PLAYER_LOOKS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
        </Field>
        <Field label="Pickup" className="xl:col-span-2">
          <div className="flex gap-2">
            <input className="input min-w-0 flex-1" maxLength={24} value={draft.pickup.name} onChange={(e) => edit((d) => ({ ...d, pickup: { ...d.pickup, name: e.target.value.slice(0, 24) } }))} />
            <select className="input w-32 shrink-0" value={draft.pickup.look} onChange={(e) => edit((d) => ({ ...d, pickup: { ...d.pickup, look: e.target.value as GameDraft["pickup"]["look"] } }))}>
              {PICKUP_LOOKS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
        </Field>
      </div>

      <div className="mt-5 text-xs font-semibold uppercase tracking-wider text-[var(--color-faint)]">Enemies</div>
      <div className="mt-2 space-y-2">
        {draft.enemies.map((en, i) => (
          <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_120px_120px_1fr_auto]">
            <input className="input" aria-label={`Enemy ${i + 1} name`} maxLength={24} value={en.name}
              onChange={(e) => edit((d) => { d.enemies[i].name = e.target.value.slice(0, 24); return d; })} />
            <select className="input" aria-label={`Enemy ${i + 1} look`} value={en.look} onChange={(e) => edit((d) => { d.enemies[i].look = e.target.value as typeof en.look; return d; })}>
              {ENEMY_LOOKS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <select className="input" aria-label={`Enemy ${i + 1} behaviour`} value={en.behavior} onChange={(e) => edit((d) => { d.enemies[i].behavior = e.target.value as typeof en.behavior; return d; })}>
              {BEHAVIORS.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <Slider label="Speed" value={en.speed} min={1} max={10} onChange={(v) => edit((d) => { d.enemies[i].speed = v; return d; })} />
            <button className="btn btn-ghost btn-sm" disabled={draft.enemies.length <= 1} onClick={() => edit((d) => ({ ...d, enemies: d.enemies.filter((_, j) => j !== i) }))}>Remove</button>
          </div>
        ))}
        {draft.enemies.length < 3 && (
          <button className="btn btn-sm" onClick={() => edit((d) => ({ ...d, enemies: [...d.enemies, { name: "Newcomer", look: "drone", behavior: "zigzag", speed: 4 }] }))}>Add enemy</button>
        )}
      </div>

      <div className="mt-5 text-xs font-semibold uppercase tracking-wider text-[var(--color-faint)]">Colours</div>
      <div className="mt-2 flex flex-wrap gap-3">
        {paletteKeys.map((k) => (
          <label key={k} className="flex items-center gap-2 text-xs text-[var(--color-dim)]">
            <input type="color" className="h-8 w-10 cursor-pointer rounded border border-[var(--color-border)] bg-transparent"
              value={draft.palette[k]} onChange={(e) => edit((d) => ({ ...d, palette: { ...d.palette, [k]: e.target.value } }))} />
            {k}
          </label>
        ))}
      </div>

      <div className="mt-5 text-xs font-semibold uppercase tracking-wider text-[var(--color-faint)]">Words</div>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <Field label="Title"><input className="input w-full" maxLength={48} value={draft.title} onChange={(e) => edit((d) => ({ ...d, title: e.target.value.slice(0, 48) }))} /></Field>
        <Field label="Tagline"><input className="input w-full" maxLength={90} value={draft.tagline} onChange={(e) => edit((d) => ({ ...d, tagline: e.target.value.slice(0, 90) }))} /></Field>
        <Field label="Intro"><textarea className="input min-h-16 w-full" maxLength={240} value={draft.story.intro} onChange={(e) => edit((d) => ({ ...d, story: { ...d.story, intro: e.target.value.slice(0, 240) } }))} /></Field>
        <div className="grid gap-3">
          <Field label="Win message"><input className="input w-full" maxLength={120} value={draft.story.win} onChange={(e) => edit((d) => ({ ...d, story: { ...d.story, win: e.target.value.slice(0, 120) } }))} /></Field>
          <Field label="Lose message"><input className="input w-full" maxLength={120} value={draft.story.lose} onChange={(e) => edit((d) => ({ ...d, story: { ...d.story, lose: e.target.value.slice(0, 120) } }))} /></Field>
        </div>
      </div>
    </section>
  );
}
