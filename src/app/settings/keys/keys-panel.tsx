"use client";
import { useCallback, useEffect, useState } from "react";
import { userError } from "@/lib/user-error";

interface KeyRow {
  id: string;
  key_id: string;
  label: string;
  max_concurrency: number;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface ShowOnce {
  title: string;
  key?: string;
  secret?: string;
}

function fmt(v: string | null) {
  return v ? new Date(v).toLocaleString() : "-";
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("done");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 1500);
      }}
    >
      {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}

export function KeysPanel() {
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [label, setLabel] = useState("");
  const [maxConcurrency, setMaxConcurrency] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showOnce, setShowOnce] = useState<ShowOnce | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/keys", { credentials: "include" });
    if (res.ok) setKeys((await res.json()).keys);
    else setError(userError(res.status, (await res.json().catch(() => null))?.error).message);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = await fetch("/api/keys", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: label.trim() || "default", max_concurrency: maxConcurrency }),
    });
    setBusy(false);
    const body = await res.json().catch(() => null);
    if (!res.ok) { setError(userError(res.status, body?.error).message); return; }
    setShowOnce({ title: "Key created - you won’t see these values again", key: body.key, secret: body.webhook_secret });
    setLabel(""); setMaxConcurrency(2);
    refresh();
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this key? Calls with it fail immediately.")) return;
    setError(null);
    const res = await fetch(`/api/keys/${id}`, { method: "DELETE", credentials: "include" });
    if (!res.ok) setError(userError(res.status, (await res.json().catch(() => null))?.error).message);
    refresh();
  }

  async function rotate(id: string) {
    if (!confirm("Rotate the webhook signing secret? Save the new value - it’s shown only once.")) return;
    setError(null);
    const res = await fetch(`/api/keys/${id}/webhook-secret`, { method: "POST", credentials: "include" });
    const body = await res.json().catch(() => null);
    if (!res.ok) { setError(userError(res.status, body?.error).message); return; }
    setShowOnce({ title: "Webhook secret rotated - save it now", secret: body.webhook_secret });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="panel space-y-4 p-5">
        <div>
          <h2 className="font-semibold">API keys</h2>
          <p className="text-sm text-[var(--color-dim)]">
            Keys authenticate the <code className="font-mono text-[0.85em]">/api/v1</code> surface -{" "}
            <a href="/docs/api" className="text-[var(--color-accent)] hover:underline">API docs</a>.
            The full token and webhook secret are shown once at creation.
          </p>
        </div>

        <form onSubmit={createKey} className="flex flex-wrap items-end gap-2">
          <label className="flex-1 min-w-40">
            <span className="mb-1 block text-xs text-[var(--color-faint)]">Label</span>
            <input className="input w-full" placeholder="ci, laptop, bot…" value={label}
              onChange={(e) => setLabel(e.target.value)} maxLength={80} data-testid="key-label" />
          </label>
          <label>
            <span className="mb-1 block text-xs text-[var(--color-faint)]">Max concurrency</span>
            <input className="input w-24" type="number" min={1} max={64} value={maxConcurrency}
              onChange={(e) => setMaxConcurrency(Math.max(1, Math.min(64, Number(e.target.value) || 1)))}
              data-testid="key-max-concurrency" />
          </label>
          <button className="btn btn-primary" disabled={busy} data-testid="create-key">
            {busy ? "Creating…" : "Create key"}
          </button>
        </form>
        {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
      </div>

      {showOnce && (
        <div className="panel space-y-3 border-[var(--color-accent)] p-5" data-testid="show-once">
          <h3 className="font-semibold">{showOnce.title}</h3>
          {showOnce.key && (
            <div className="space-y-1">
              <p className="text-xs text-[var(--color-faint)]">API key</p>
              <div className="flex items-center gap-2">
                <code className="break-all rounded bg-[var(--color-panel2)] px-2 py-1 font-mono text-xs" data-testid="key-value">
                  {showOnce.key}
                </code>
                <CopyButton value={showOnce.key} label="Copy key" />
              </div>
            </div>
          )}
          {showOnce.secret && (
            <div className="space-y-1">
              <p className="text-xs text-[var(--color-faint)]">Webhook signing secret</p>
              <div className="flex items-center gap-2">
                <code className="break-all rounded bg-[var(--color-panel2)] px-2 py-1 font-mono text-xs" data-testid="secret-value">
                  {showOnce.secret}
                </code>
                <CopyButton value={showOnce.secret} label="Copy secret" />
              </div>
            </div>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => setShowOnce(null)}>Done - I saved them</button>
        </div>
      )}

      <div className="panel p-5">
        <h3 className="mb-3 font-semibold">Your keys</h3>
        {keys == null ? (
          <p className="text-sm text-[var(--color-dim)]">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-[var(--color-dim)]">No keys yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]" data-testid="key-list">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3" data-testid={`key-row-${k.key_id}`}>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{k.label}{" "}
                    <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                      k.revoked_at ? "bg-[var(--color-danger)]/20 text-[var(--color-danger)]" : "bg-[var(--color-panel2)] text-[var(--color-dim)]"
                    }`}>{k.revoked_at ? "revoked" : "active"}</span>
                  </p>
                  <p className="font-mono text-xs text-[var(--color-dim)]">of_{k.key_id}_…</p>
                  <p className="text-xs text-[var(--color-faint)]">
                    created {fmt(k.created_at)} · last used {fmt(k.last_used_at)} · max {k.max_concurrency} live
                  </p>
                </div>
                {!k.revoked_at && (
                  <div className="flex gap-2">
                    <button className="btn btn-ghost btn-sm" onClick={() => rotate(k.id)}>Rotate secret</button>
                    <button className="btn btn-ghost btn-sm text-[var(--color-danger)]" onClick={() => revoke(k.id)}>Revoke</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
