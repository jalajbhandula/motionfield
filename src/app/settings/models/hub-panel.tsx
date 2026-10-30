"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { userError } from "@/lib/user-error";

/** Settings → Models & LLMs - the "Hugging Face" section. Check a public
 *  repo's card licence, then download ComfyUI weights or pull a GGUF into
 *  Ollama. Every refusal comes back with its reason; the action button is
 *  disabled while the server says no. Hidden entirely in hosted mode (the
 *  caller mounts it only when providers.hosted is false). */

const HubFileV = z.object({
  path: z.string(),
  size: z.number(),
  sha256: z.string().nullable(),
  quant: z.string().nullable(),
});
const InspectV = z.object({
  revision: z.string().nullable(),
  licenseIds: z.array(z.string()),
  class: z.enum(["open", "permissive-terms", "restricted", "refused"]),
  reason: z.string(),
  allowed: z.boolean(),
  optInRequired: z.boolean(),
  files: z.array(HubFileV),
});
const HubRowV = z.object({
  id: z.string(), kind: z.string(), repo: z.string(), revision: z.string(), file: z.string(),
  subfolder: z.string().nullable(), status: z.string(), error: z.string().nullable(),
  bytes: z.number(), bytesDone: z.number(), bytesTotal: z.number(),
  licenceId: z.string(), licenceClass: z.string(),
});
const DownloadsListV = z.object({ downloads: z.array(HubRowV), disk: z.object({ free_gb: z.number().nullable() }).optional() });
const PullLineV = z.looseObject({
  status: z.string().optional(),
  percent: z.number().optional(),
  error: z.string().optional(),
});
const DownloadRespV = z.looseObject({ alreadyInstalled: z.boolean().optional() });
const ErrV = z.looseObject({ error: z.string().optional() });

type InspectPayload = z.infer<typeof InspectV>;
type HubRow = z.infer<typeof HubRowV>;

const SUBFOLDERS = [
  "checkpoints", "diffusion_models", "unet", "loras", "vae",
  "text_encoders", "clip", "clip_vision", "controlnet", "upscale_models", "embeddings",
];

const input =
  "w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-panel2)] px-2.5 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]";

const badge = (cls: string) =>
  `rounded-full border px-2 py-0.5 text-[11px] font-medium ${
    cls === "open" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
    : cls === "permissive-terms" ? "border-teal-500/40 bg-teal-500/10 text-teal-300"
    : cls === "restricted" ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
    : "border-red-500/40 bg-red-500/10 text-red-400"}`;

const fmtSize = (n: number) =>
  n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(2)} GB`
    : n >= 2 ** 20 ? `${(n / 2 ** 20).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 2 ** 10))} KB`;

const basename = (p: string) => p.split("/").pop() ?? p;

async function api(path: string, method: string, body?: unknown) {
  const r = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data: unknown = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export function HubPanel({ offline }: { offline: boolean }) {
  const [repo, setRepo] = useState("");
  const [kind, setKind] = useState<"weights" | "gguf">("weights");
  const [insp, setInsp] = useState<InspectPayload | null>(null);
  const [file, setFile] = useState("");
  const [subfolder, setSubfolder] = useState("loras");
  const [quant, setQuant] = useState("");
  const [rows, setRows] = useState<HubRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pullLog, setPullLog] = useState<string[]>([]);
  const [freeGb, setFreeGb] = useState<number | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const { ok, data } = await api("/api/models/hub/downloads", "GET");
    if (ok) {
      const parsed = DownloadsListV.safeParse(data);
      if (parsed.success) { setRows(parsed.data.downloads); setFreeGb(parsed.data.disk?.free_gb ?? null); }
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!rows.some((r) => r.status === "running")) {
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
      return;
    }
    if (!pollTimer.current) pollTimer.current = setInterval(refresh, 1000);
    return () => {
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
    };
  }, [rows, refresh]);

  async function check() {
    const name = repo.trim();
    if (!name) return;
    setBusy(true); setError(null); setNote(null); setInsp(null);
    const { ok, status, data } = await api("/api/models/hub/inspect", "POST", { repo: name, kind });
    setBusy(false);
    if (!ok) { setError(userError(status, ErrV.parse(data).error ?? "check failed").message); return; }
    const payload = InspectV.safeParse(data);
    if (!payload.success) { setError("the check answered something unreadable"); return; }
    setInsp(payload.data);
    const first = payload.data.files[0]?.path ?? "";
    setFile(first);
    const q = payload.data.files.find((f) => f.quant)?.quant ?? "";
    setQuant(q);
  }

  async function download() {
    if (!insp?.revision || !file) return;
    setBusy(true); setError(null); setNote(null);
    const { ok, status, data } = await api("/api/models/hub/downloads", "POST", {
      repo: repo.trim(), revision: insp.revision, file, subfolder,
    });
    setBusy(false);
    if (!ok) { setError(userError(status, ErrV.parse(data).error ?? "download refused").message); return; }
    if (DownloadRespV.parse(data).alreadyInstalled) setNote("already installed");
    await refresh();
  }

  async function resume(row: HubRow) {
    if (!row.subfolder) return;
    setBusy(true); setError(null); setNote(null);
    const { ok, status, data } = await api("/api/models/hub/downloads", "POST", {
      repo: row.repo, revision: row.revision, file: row.file, subfolder: row.subfolder,
    });
    setBusy(false);
    if (!ok) { setError(userError(status, ErrV.parse(data).error ?? "download refused").message); return; }
    if (DownloadRespV.parse(data).alreadyInstalled) setNote("already installed");
    await refresh();
  }

  async function pull() {
    if (!insp?.revision || !quant) return;
    setBusy(true); setError(null); setNote(null); setPullLog(["pulling…"]);
    const r = await fetch("/api/models/hub/pull", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: repo.trim(), quant }),
    }).catch(() => null);
    setBusy(false);
    if (!r) { setPullLog(["couldn't reach the server"]); return; }
    if (!r.ok || !r.body) {
      const d = ErrV.parse(await r.json().catch(() => ({})));
      setPullLog([`⚠ ${userError(r.status, d.error).message}`]);
      return;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let firstLine = true;
    const lines: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        if (firstLine) {
          firstLine = false;
          // the pull row exists from the first streamed event - refresh so
          // the running row (progress bar + Cancel) shows immediately
          void refresh();
        }
        let jraw: unknown;
        try { jraw = JSON.parse(line); } catch { continue; } // partial line
        const j = PullLineV.safeParse(jraw);
        if (j.success) {
          lines.push(j.data.error ? `⚠ ${j.data.error}` : `${j.data.status ?? "…"}${j.data.percent !== undefined ? ` ${j.data.percent}%` : ""}`);
        }
      }
      setPullLog([...lines.slice(-6)]);
    }
    await refresh();
  }

  async function cancel(id: string) {
    await api(`/api/models/hub/downloads/${id}`, "DELETE");
    await refresh();
  }

  const quants = [...new Set(insp?.files.map((f) => f.quant).filter((q): q is string => !!q) ?? [])];
  const canAct = !!insp && insp.allowed && !busy && !offline
    && (kind === "gguf" ? !!quant : !!file && !!subfolder);

  return (
    <section className="panel divide-y divide-[var(--color-line)]" data-testid="hub-panel">
      <div className="px-4 py-3">
        <h3 className="text-sm font-semibold">Hugging Face</h3>
        <p className="mt-0.5 text-xs text-[var(--color-dim)]">
          Check a public repo&apos;s licence, then download weights into ComfyUI or pull a GGUF into Ollama.
        </p>
        <p className="mt-1 text-[11px] text-[var(--color-dim)]" data-testid="hub-scope-note">
          Custom weights are available to ComfyUI; MotionField presets use only the weights in Settings → Licenses.
        </p>
        {freeGb !== null && (
          <p className="mt-1 text-[11px] text-[var(--color-dim)]" data-testid="hub-free-space">
            {freeGb} GB free on the models volume - a canceled download keeps its .part and resumes on re-pull.
          </p>
        )}
      </div>

      <div className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={`${input} max-w-64`} placeholder="owner/name" value={repo}
            data-testid="hub-repo" onChange={(e) => setRepo(e.target.value)}
          />
          <select
            className={`${input} max-w-44`} value={kind} data-testid="hub-kind"
            onChange={(e) => { setKind(e.target.value === "gguf" ? "gguf" : "weights"); setInsp(null); }}
          >
            <option value="weights">ComfyUI weights</option>
            <option value="gguf">Brain (GGUF → Ollama)</option>
          </select>
          <button className="btn" data-testid="hub-check" disabled={busy || offline || !repo.trim()} onClick={check}>
            Check
          </button>
        </div>
        {offline && (
          <p className="mt-2 text-[11px] text-amber-400" data-testid="hub-offline-note">
            Offline mode is on - downloads need the network.
          </p>
        )}
        {error && <p className="mt-2 text-[11px] text-[var(--color-danger)]" role="alert" data-testid="hub-error">{error}</p>}
        {note && <p className="mt-2 text-[11px] text-[var(--color-dim)]" data-testid="hub-note">{note}</p>}

        {insp && (
          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2" data-testid="hub-licence">
              <span className={badge(insp.class)} data-testid="hub-licence-badge">{insp.class}</span>
              <span className="text-[11px] text-[var(--color-dim)]" data-testid="hub-licence-reason">
                {insp.licenseIds.length ? insp.licenseIds.join(", ") : "no licence declared"} - {insp.reason}
              </span>
              {insp.class === "permissive-terms" && (
                <span className="text-[11px] text-teal-300">attribution required</span>
              )}
              {insp.optInRequired && (
                <span className="text-[11px] text-amber-400">opt in at Settings → Licenses first</span>
              )}
            </div>

            {insp.files.length > 0 ? (
              kind === "gguf" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <select className={`${input} max-w-40`} value={quant} data-testid="hub-quant"
                    onChange={(e) => setQuant(e.target.value)}>
                    {quants.map((q) => <option key={q} value={q}>{q}</option>)}
                  </select>
                  <span className="text-[11px] text-[var(--color-dim)]">
                    {insp.files.find((f) => f.quant === quant)?.path ?? `${insp.files.length} gguf file(s)`}
                  </span>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <select className={`${input} max-w-72`} value={file} data-testid="hub-file"
                    onChange={(e) => setFile(e.target.value)}>
                    {insp.files.map((f) => (
                      <option key={f.path} value={f.path}>{f.path} ({fmtSize(f.size)})</option>
                    ))}
                  </select>
                  <select className={`${input} max-w-44`} value={subfolder} data-testid="hub-subfolder"
                    onChange={(e) => setSubfolder(e.target.value)}>
                    {SUBFOLDERS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              )
            ) : (
              <p className="text-[11px] text-[var(--color-dim)]">no {kind === "gguf" ? ".gguf" : "weight"} files in this repo</p>
            )}

            <div className="flex items-center gap-2">
              <button
                className="btn"
                data-testid={kind === "gguf" ? "hub-pull" : "hub-download"}
                disabled={!canAct}
                title={insp.allowed ? "" : insp.reason}
                onClick={kind === "gguf" ? pull : download}
              >
                {kind === "gguf" ? "Pull" : "Download"}
              </button>
              {!insp.allowed && (
                <span className="text-[11px] text-[var(--color-dim)]" data-testid="hub-refused-reason">
                  {insp.reason}
                </span>
              )}
            </div>
            {pullLog.length > 0 && (
              <div className="space-y-0.5 font-mono text-[11px] text-[var(--color-dim)]" data-testid="hub-pull-log">
                {pullLog.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="px-4 py-3" data-testid="hub-installed">
        <div className="text-xs font-semibold">Installed</div>
        {rows.length === 0 && (
          <p className="mt-1 text-[11px] text-[var(--color-dim)]">nothing yet - check a repo above.</p>
        )}
        <div className="mt-2 space-y-1.5">
          {rows.map((r) => {
            const pct = r.bytesTotal > 0 ? Math.min(100, Math.round((r.bytesDone / r.bytesTotal) * 100)) : 0;
            return (
              <div key={r.id} data-testid={`hub-row-${r.id}`}
                className="rounded-lg bg-[var(--color-panel2)] px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{basename(r.file)}</span>
                  <span className={badge(r.licenceClass)}>{r.licenceClass}</span>
                  {r.licenceId && <span className="text-[10px] text-[var(--color-faint)]">{r.licenceId}</span>}
                  <span className="text-[10px] text-[var(--color-dim)]">
                    {r.kind === "gguf" ? `ollama · hf.co/${r.repo}` : `${r.repo} → models/${r.subfolder}`}
                  </span>
                  <span className="ml-auto text-[10px] text-[var(--color-dim)]" data-testid={`hub-status-${r.id}`}>
                    {r.status}{r.error && r.status !== "done" ? ` - ${r.error}` : ""}
                  </span>
                  {r.status === "running" && (
                    <button className="text-[var(--color-dim)] hover:text-red-300" data-testid={`hub-cancel-${r.id}`}
                      onClick={() => cancel(r.id)}>Cancel</button>
                  )}
                  {(r.status === "failed" || r.status === "canceled" || r.status === "interrupted") && r.kind === "weights" && (
                    <button className="text-[var(--color-accent)] hover:underline" data-testid={`hub-resume-${r.id}`}
                      onClick={() => resume(r)}>Resume</button>
                  )}
                </div>
                {r.status === "running" && (
                  <div className="mt-1.5 h-1 overflow-hidden rounded bg-[var(--color-line)]" data-testid="hub-progressbar">
                    <div className="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
