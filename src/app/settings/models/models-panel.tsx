"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { HubPanel } from "./hub-panel";
import { LOCAL_MODEL_PRESETS } from "@/lib/llm/providers";
import { userError } from "@/lib/user-error";

/** Settings → Models & LLMs - real controls over /api/llm/*. Every button
 *  hits a live endpoint; nothing here is a stub. */

type Caps = { tools: boolean; vision: boolean; jsonSchema: boolean };
type ProviderView = {
  id: string; label: string; doc: string; group: "local" | "endpoint";
  status: string; hasKey?: boolean; baseUrl?: string | null; wire?: string | null;
  models?: string[]; defaultModel?: string; capabilities: Caps; local: boolean;
};
type ProvidersPayload = {
  hosted: boolean;
  suggested: { providerId: string; model: string };
  groups: { id: string; label: string; providers: ProviderView[] }[];
};
type RouteMap = Record<string, { providerId: string; model: string; wire: string | null } | null>;
type Prefs = { offline: boolean; locked: boolean; searxngUrl?: string | null };
type TestState = Record<string, string>;

const TASKS = ["planner", "writer", "vision", "coder", "enhancer", "judge"] as const;
const WIRES = ["openai-chat", "ollama"] as const;

const badge = (ok: boolean | null) =>
  `rounded-full border px-2 py-0.5 text-[11px] font-medium ${
    ok === true ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
    : ok === false ? "border-[var(--color-line)] text-[var(--color-dim)]"
    : "border-amber-500/40 bg-amber-500/10 text-amber-400"}`;

const input =
  "w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-panel2)] px-2.5 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]";

/** Why a provider can't serve a task - mirrors the server-side taskGuard. */
function taskGuard(task: string, caps: Caps): string | null {
  if (task === "planner" && !caps.tools) return "planner needs tool use";
  if (task === "vision" && !caps.vision) return "vision needs image input";
  return null;
}

export function ModelsPanel() {
  const [providers, setProviders] = useState<ProvidersPayload | null>(null);
  const [routes, setRoutes] = useState<RouteMap>({});
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<TestState>({});
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [urlDrafts, setUrlDrafts] = useState<Record<string, string>>({});
  const [searxngDraft, setSearxngDraft] = useState("");
  const [wireDrafts, setWireDrafts] = useState<Record<string, string>>({});
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  const [routeProvider, setRouteProvider] = useState<Record<string, string>>({});
  const [routeModel, setRouteModel] = useState<Record<string, string>>({});
  const [pullName, setPullName] = useState("");
  const [pullLog, setPullLog] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, r, f] = await Promise.all([
      fetch("/api/llm/providers").then((x) => (x.ok ? x.json() : null)),
      fetch("/api/llm/routes").then((x) => (x.ok ? x.json() : null)),
      fetch("/api/llm/prefs").then((x) => (x.ok ? x.json() : null)),
    ]);
    if (!p) { setError("couldn't load provider settings - signed in?"); return; }
    setProviders(p);
    setRoutes(r?.routes ?? {});
    setPrefs(f);
    setSearxngDraft((d) => (d ? d : f?.searxngUrl ?? ""));
    const m: Record<string, string> = {};
    for (const t of TASKS) if (r?.routes?.[t]) m[t] = r.routes[t]!.model;
    setRouteModel(m);
    const rp: Record<string, string> = {};
    for (const t of TASKS) if (r?.routes?.[t]) rp[t] = r.routes[t]!.providerId;
    setRouteProvider(rp);
  }, []);
  useEffect(() => { load(); }, [load]);

  const allProviders = useMemo(
    () => (providers?.groups ?? []).flatMap((g) => g.providers),
    [providers],
  );
  const providerOf = (id: string) => allProviders.find((p) => p.id === id);

  async function api(path: string, method: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
    const r = await fetch(path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: r.ok, status: r.status, data };
  }

  async function saveProvider(id: string, patch: Record<string, unknown>) {
    setBusy(id);
    const { ok, status, data } = await api(`/api/llm/providers/${id}`, "PUT", patch);
    setBusy(null);
    if (!ok) { setError(userError(status, data.error ?? "save failed").message); return false; }
    setError(null);
    setKeyDrafts((d) => ({ ...d, [id]: "" }));
    await load();
    return true;
  }

  async function runTest(target: { providerId?: string; task?: string; model?: string }, key: string) {
    setTests((t) => ({ ...t, [key]: "…" }));
    const { data } = await api("/api/llm/test", "POST", target);
    setTests((t) => ({
      ...t,
      [key]: data.ok ? `ok - ${data.latencyMs} ms${data.model ? ` · ${data.model}` : ""}` : `failed - ${data.error ?? "unreachable"}`,
    }));
  }

  async function saveRoute(task: string) {
    const providerId = routeProvider[task];
    if (!providerId) return;
    setBusy(`route-${task}`);
    const { ok, status, data } = await api(`/api/llm/routes/${task}`, "PUT", {
      providerId, model: routeModel[task] ?? "",
    });
    setBusy(null);
    if (!ok) setError(userError(status, data.error ?? "couldn't save the route").message);
    else { setError(null); await load(); }
  }

  /** "Use suggested" writes the real route (ollama:qwen3.5:9b), not just a
   *  draft - one click and the task is routed. */
  async function applySuggested(task: string) {
    const s = providers?.suggested;
    if (!s) return;
    setBusy(`route-${task}`);
    const { ok, status, data } = await api(`/api/llm/routes/${task}`, "PUT", {
      providerId: s.providerId, model: s.model,
    });
    setBusy(null);
    if (!ok) setError(userError(status, data.error ?? "couldn't save the route").message);
    else { setError(null); await load(); }
  }

  async function clearRoute(task: string) {
    setBusy(`route-${task}`);
    await api(`/api/llm/routes/${task}`, "DELETE");
    setBusy(null);
    await load();
  }

  async function pullModel() {
    const name = pullName.trim();
    if (!name) return;
    setPullLog(["pulling…"]);
    const r = await fetch("/api/llm/local/pull", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
    }).catch(() => null);
    if (!r || !r.body) { setPullLog(["couldn't reach the server"]); return; }
    if (r.status === 403 || r.status === 400 || r.status === 401) {
      const d = await r.json().catch(() => ({}));
      setPullLog([`⚠ ${userError(r.status, d.error).message}`]);
      return;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const lines: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line) as { status?: string; percent?: number; error?: string; done?: boolean };
          lines.push(j.error ? `⚠ ${j.error}` : `${j.status ?? "…"}${j.percent !== undefined ? ` ${j.percent}%` : ""}`);
        } catch { /* ignore partial lines */ }
      }
      setPullLog([...lines.slice(-6)]);
    }
    await load();
  }

  const taskRow = (task: string) => {
    const route = routes[task];
    const suggested = providers?.suggested;
    return (
      <div key={task} data-testid={`task-row-${task}`} className="flex flex-wrap items-center gap-2 px-4 py-3">
        <div className="w-20 shrink-0">
          <div className="text-sm font-semibold capitalize">{task}</div>
          <div className="text-[10px] text-[var(--color-dim)]">
            {task === "planner" ? "tool-calling" : task === "vision" ? "image input" : "text only"}
          </div>
        </div>
        <select
          data-testid={`task-provider-${task}`}
          className={`${input} max-w-44`}
          value={routeProvider[task] ?? ""}
          onChange={(e) => setRouteProvider((d) => ({ ...d, [task]: e.target.value }))}
        >
          <option value="">- pick a provider -</option>
          {allProviders.map((p) => {
            const why = taskGuard(task, p.capabilities);
            const usable = p.group === "local" || !!p.baseUrl;
            const label = !usable ? `${p.label} (needs a base URL first)`
              : why ? `${p.label} - ${why}` : p.label;
            return (
              <option key={p.id} value={p.id} disabled={!!why || !usable}>
                {label}
              </option>
            );
          })}
        </select>
        <input
          data-testid={`task-model-${task}`}
          className={`${input} max-w-44`}
          placeholder="model name"
          value={routeModel[task] ?? ""}
          onChange={(e) => setRouteModel((d) => ({ ...d, [task]: e.target.value }))}
          list={routeProvider[task] && providerOf(routeProvider[task])?.models?.length ? `models-${routeProvider[task]}` : undefined}
        />
        {routeProvider[task] && providerOf(routeProvider[task])?.models?.length ? (
          <datalist id={`models-${routeProvider[task]}`}>
            {providerOf(routeProvider[task])!.models!.map((m) => <option key={m} value={m} />)}
          </datalist>
        ) : null}
        <button className="btn" data-testid={`task-save-${task}`} disabled={!routeProvider[task] || busy === `route-${task}`} onClick={() => saveRoute(task)}>
          Save
        </button>
        {route && (
          <button className="btn" data-testid={`task-clear-${task}`} disabled={busy === `route-${task}`} onClick={() => clearRoute(task)}>
            Clear
          </button>
        )}
        {suggested && !route && (() => {
          // offer the suggestion on any unrouted task the suggested provider's
          // capabilities can serve (ollama is text+tools+vision → every task)
          const sp = providerOf(suggested.providerId);
          return sp && !taskGuard(task, sp.capabilities) ? (
            <button className="btn" data-testid={`suggested-${task}`} disabled={busy === `route-${task}`} onClick={() => applySuggested(task)}>
              Use suggested ({sp.label} · {suggested.model})
            </button>
          ) : null;
        })()}
        {route && <span className="text-[11px] text-[var(--color-dim)]">→ {route.providerId}:{route.model || "default"}</span>}
      </div>
    );
  };

  return (
    <div className="max-w-2xl space-y-5" data-testid="models-panel">
      <div>
        <h2 className="font-semibold">Models &amp; LLMs</h2>
        <p className="text-sm text-[var(--color-dim)]">
          Run open-weights models on your own machine (or your own server) - then pick which one serves each job.
          No hosted closed-model APIs. An endpoint key, if you set one, is stored encrypted and never shown again.
        </p>
      </div>

      {error && <p className="text-sm text-[var(--color-danger)]" role="alert">{error}</p>}
      {!providers && !error && <p className="text-sm text-[var(--color-dim)]">Loading…</p>}

      {/* Offline mode - persisted per user; locked when env forces it */}
      {prefs && (
        <label className="panel flex items-center justify-between gap-4 p-4">
          <span>
            <span className="block text-sm font-semibold">Offline mode</span>
            <span className="mt-0.5 block text-xs text-[var(--color-dim)]">
              {prefs.locked
                ? "Forced on by MOTIONFIELD_OFFLINE=1 - every remote LLM route is refused."
                : prefs.offline
                  ? "On - every LLM call uses local loopback routes only. New AI Assistant sessions start in Offline."
                  : "Off - LLM calls may use remote providers."}
            </span>
          </span>
          <button
            type="button" role="switch" aria-checked={prefs.offline} disabled={prefs.locked}
            data-testid="offline-toggle"
            onClick={async () => {
              const { ok, status, data } = await api("/api/llm/prefs", "PUT", { offline: !prefs.offline });
              if (ok) setPrefs((p) => (p ? { ...p, offline: !p.offline } : p));
              else setError(userError(status, data.error ?? "couldn't save").message);
            }}
            className={`relative h-6 w-11 shrink-0 rounded-full transition ${prefs.offline ? "bg-emerald-500" : "bg-[var(--color-line)]"} ${prefs.locked ? "cursor-not-allowed opacity-60" : ""}`}>
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${prefs.offline ? "left-[1.375rem]" : "left-0.5"}`} />
          </button>
        </label>
      )}

      {/* Web search - off by default; the user supplies their own SearXNG
          instance (an external AGPL service, never bundled). */}
      {prefs && (
        <div className="panel p-4" data-testid="web-search-panel">
          <div className="text-sm font-semibold">Web search (SearXNG)</div>
          <p className="mt-0.5 text-xs text-[var(--color-dim)]">
            Off by default - set the base URL of a SearXNG instance you run and the
            agent's web_search tool switches on. SearXNG is an external AGPL-licensed
            service; MotionField never bundles it and sends it nothing until you ask
            for a search. Offline mode only accepts a loopback URL.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <input
              className={input}
              data-testid="searxng-url"
              placeholder="http://127.0.0.1:8888"
              value={searxngDraft}
              onChange={(e) => setSearxngDraft(e.target.value)}
            />
            <button
              className="btn"
              data-testid="searxng-save"
              disabled={busy === "searxng"}
              onClick={async () => {
                setBusy("searxng");
                const { ok, status, data } = await api("/api/llm/prefs", "PUT", {
                  searxngUrl: searxngDraft.trim() || null,
                });
                setBusy(null);
                if (!ok) { setError(userError(status, data.error ?? "couldn't save").message); return; }
                setError(null);
                setPrefs((p) => (p ? { ...p, searxngUrl: typeof data.searxngUrl === "string" ? data.searxngUrl : null } : p));
              }}
            >
              {searxngDraft.trim() ? "Save" : "Disable"}
            </button>
            {prefs.searxngUrl && (
              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                web_search on
              </span>
            )}
          </div>
        </div>
      )}

      {/* Per-task routing */}
      {providers && (
        <section className="panel divide-y divide-[var(--color-line)]" data-testid="task-routes">
          <div className="px-4 py-3">
            <h3 className="text-sm font-semibold">Task models</h3>
            <p className="mt-0.5 text-xs text-[var(--color-dim)]">
              Which provider+model serves each task. Unset tasks fall back to env config, then the built-in planner.
            </p>
          </div>
          {TASKS.map(taskRow)}
        </section>
      )}

      {/* Provider groups */}
      {(providers?.groups ?? []).map((group) => (
        <section key={group.id} className="panel divide-y divide-[var(--color-line)]" data-testid={`group-${group.id}`}>
          <div className="px-4 py-3">
            <h3 className="text-sm font-semibold">{group.label}</h3>
            {group.id === "endpoint" && (
              <p className="mt-0.5 text-xs text-[var(--color-dim)]">
                Your own server speaking the OpenAI-compatible or Ollama protocol - a vLLM or llama.cpp box on your network, for example. Serve open-weights models only.
              </p>
            )}
          </div>
          {group.providers.map((p) => (
            <ProviderRow
              key={p.id}
              p={p}
              keyDraft={keyDrafts[p.id] ?? ""}
              urlDraft={urlDrafts[p.id] ?? p.baseUrl ?? ""}
              wireDraft={wireDrafts[p.id] ?? p.wire ?? "openai-chat"}
              onKey={(v) => setKeyDrafts((d) => ({ ...d, [p.id]: v }))}
              onUrl={(v) => setUrlDrafts((d) => ({ ...d, [p.id]: v }))}
              onWire={(v) => setWireDrafts((d) => ({ ...d, [p.id]: v }))}
              onSave={saveProvider}
              onRemove={async () => {
                setBusy(p.id);
                const { ok } = await api(`/api/llm/providers/${p.id}`, "DELETE");
                setBusy(null);
                if (!ok) setError("couldn't remove - it may not exist");
                await load();
              }}
              onTest={() => runTest({ providerId: p.id, model: modelDrafts[p.id] }, `provider-${p.id}`)}
              busy={busy === p.id}
              testResult={tests[`provider-${p.id}`]}
              modelDraft={modelDrafts[p.id] ?? ""}
              onModel={(v) => setModelDrafts((d) => ({ ...d, [p.id]: v }))}
            />
          ))}
          {group.id === "local" && (
            <div className="px-4 py-3" data-testid="pull-row">
              <div className="text-xs font-semibold">Get a local model</div>
              <p className="mt-0.5 text-xs text-[var(--color-dim)]">
                Pull a model into Ollama - a tag like <code>qwen3.5:9b</code> or <code>hf.co/&lt;org&gt;/&lt;repo&gt;[:quant]</code>.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5" data-testid="model-presets">
                {LOCAL_MODEL_PRESETS.map((m) => (
                  <button key={m.tag} type="button" title={m.note}
                    className={`chip ${pullName === m.tag ? "chip-on" : ""}`}
                    onClick={() => setPullName(m.tag)}>{m.label}</button>
                ))}
              </div>
              {pullName === "qwen3.8:27b" && (
                <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300" data-testid="ram-warning">
                  Qwen3.8 27B (4-bit) needs ~17 GB free RAM - pick it on machines with ≥48 GB RAM or a 24 GB GPU. On 32 GB it will swap.
                </p>
              )}
              <div className="mt-2 flex items-center gap-2">
                <input className={input} placeholder="qwen3.5:9b" value={pullName} data-testid="pull-input"
                  onChange={(e) => setPullName(e.target.value)} />
                <button className="btn" data-testid="pull-button" onClick={pullModel}>Pull</button>
              </div>
              <p className="mt-2 text-[11px] text-[var(--color-dim)]">
                You're responsible for a pulled model's licence; MotionField's defaults stay open-weights.
              </p>
              {pullLog.length > 0 && (
                <div className="mt-2 space-y-0.5 font-mono text-[11px] text-[var(--color-dim)]" data-testid="pull-progress">
                  {pullLog.map((l, i) => <div key={i}>{l}</div>)}
                </div>
              )}
            </div>
          )}
        </section>
      ))}

      {/* Hugging Face hub - check licences, download weights, pull GGUFs */}
      {providers?.hosted === false && <HubPanel offline={!!prefs?.offline} />}
    </div>
  );
}

function ProviderRow({
  p, keyDraft, urlDraft, wireDraft, modelDraft,
  onKey, onUrl, onWire, onModel, onSave, onRemove, onTest, busy, testResult,
}: {
  p: ProviderView;
  keyDraft: string; urlDraft: string; wireDraft: string; modelDraft: string;
  onKey: (v: string) => void; onUrl: (v: string) => void; onWire: (v: string) => void; onModel: (v: string) => void;
  onSave: (id: string, patch: Record<string, unknown>) => Promise<boolean>;
  onRemove: () => Promise<void>;
  onTest: () => void;
  busy: boolean;
  testResult?: string;
}) {
  const detected = p.group === "local" && p.status === "detected";
  const configured = p.group === "endpoint" && !!p.baseUrl;
  return (
    <div className="px-4 py-3" data-testid={`provider-${p.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{p.label}</span>
          {p.group === "local" && <span className={badge(detected ? true : null)}>{detected ? "detected" : "not detected"}</span>}
          {p.group === "endpoint" && <span className={badge(configured ? true : false)} data-testid={`key-status-${p.id}`}>{configured ? (p.hasKey ? "configured · key saved" : "configured") : "not set"}</span>}
          {testResult && <span className="text-[11px] text-[var(--color-dim)]" data-testid={`test-result-${p.id}`}>{testResult}</span>}
        </div>
        {/^https?:\/\//.test(p.doc) && (
          <a href={p.doc} target="_blank" rel="noreferrer" className="text-[11px] text-[var(--color-accent)] hover:underline">docs</a>
        )}
      </div>
      {p.models && p.models.length > 0 && (
        <p className="mt-1 text-[11px] text-[var(--color-dim)]">models: {p.models.slice(0, 8).join(", ")}{p.models.length > 8 ? ` +${p.models.length - 8}` : ""}</p>
      )}

      {p.group === "local" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input className={`${input} max-w-72`} placeholder={p.id === "ollama" ? "http://127.0.0.1:11434" : "base URL"} value={urlDraft} onChange={(e) => onUrl(e.target.value)} data-testid={`url-${p.id}`} />
          <button className="btn" disabled={busy} onClick={() => onSave(p.id, { baseUrl: urlDraft || undefined })}>Save URL</button>
          {p.baseUrl && (
            <button className="btn" disabled={busy} onClick={() => onSave(p.id, { baseUrl: "" })} data-testid={`clear-url-${p.id}`}>Clear URL</button>
          )}
          {p.baseUrl && (
            <button className="btn" disabled={busy} onClick={onRemove} data-testid={`remove-${p.id}`}>Remove</button>
          )}
          <input
            className={`${input} max-w-44`} placeholder={p.defaultModel ?? "model to test"}
            value={modelDraft} onChange={(e) => onModel(e.target.value)}
            list={p.models?.length ? `prov-models-${p.id}` : undefined} data-testid={`model-${p.id}`}
          />
          {p.models?.length ? (
            <datalist id={`prov-models-${p.id}`}>
              {p.models.map((m) => <option key={m} value={m} />)}
            </datalist>
          ) : null}
          <button className="btn" disabled={!detected} onClick={onTest} data-testid={`test-${p.id}`}>Test</button>
        </div>
      )}

      {p.group === "endpoint" && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={`${input} max-w-64`} type="password" autoComplete="off"
              placeholder={p.hasKey ? "•••••••• saved - enter a new key to replace" : "endpoint key (optional)"}
              value={keyDraft} onChange={(e) => onKey(e.target.value)} data-testid={`key-${p.id}`}
            />
            <select className={`${input} max-w-44`} value={wireDraft} onChange={(e) => onWire(e.target.value)} data-testid={`wire-${p.id}`}>
              {WIRES.map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
            <input
              className={`${input} max-w-64`} placeholder="http://your-server:8000/v1"
              value={urlDraft} onChange={(e) => onUrl(e.target.value)} data-testid={`url-${p.id}`}
            />
            <input
              className={`${input} max-w-44`} placeholder={p.defaultModel ?? "model to test"}
              value={modelDraft} onChange={(e) => onModel(e.target.value)}
              list={p.models?.length ? `prov-models-${p.id}` : undefined} data-testid={`model-${p.id}`}
            />
            {p.models?.length ? (
              <datalist id={`prov-models-${p.id}`}>
                {p.models.map((m) => <option key={m} value={m} />)}
              </datalist>
            ) : null}
            <button className="btn" disabled={busy} onClick={() => onSave(p.id, {
              ...(keyDraft ? { apiKey: keyDraft } : {}),
              ...(urlDraft !== (p.baseUrl ?? "") ? { baseUrl: urlDraft } : {}),
              ...(wireDraft !== (p.wire ?? "openai-chat") ? { wire: wireDraft } : {}),
            })} data-testid={`save-${p.id}`}>Save</button>
            {(p.hasKey || p.baseUrl || p.wire) && (
              <button className="btn" disabled={busy} onClick={onRemove} data-testid={`remove-${p.id}`}>Remove</button>
            )}
            <button className="btn" disabled={!p.baseUrl} onClick={onTest} data-testid={`test-${p.id}`}>Test</button>
          </div>
          <p className="text-[11px] text-[var(--color-dim)]">Base URL + wire protocol; the model name is picked per task above.</p>
        </div>
      )}

    </div>
  );
}
