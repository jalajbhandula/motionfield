import Link from "next/link";
import { MCP_HTTP_SNIPPETS, MCP_SNIPPETS } from "./snippets";

export const metadata = { title: "MCP - add MotionField to your agent" };

const mono = "font-mono text-[0.85em] text-[var(--color-accent)]";
const dim = "text-sm leading-6 text-[var(--color-dim)]";

/** Add MotionField to your agent - the real install + key + config flow for
 *  the motionfield-mcp stdio server. */
export default function Mcp() {
  return (
    <div className="mx-auto max-w-3xl space-y-10 px-4 py-12">
      <header className="space-y-3">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--color-dim)]">MCP</div>
        <h1 className="font-display text-3xl font-bold">Add MotionField to your agent</h1>
        <p className={dim}>
          <code className={mono}>motionfield-mcp</code> is a stdio MCP server that exposes the MotionField{" "}
          <Link href="/docs/api" className="text-[var(--color-accent)] hover:underline">v1 API</Link> to
          MCP clients - the same wire contract the CLI and SDKs use. Full reference:{" "}
          <code className={mono}>docs/MCP.md</code>.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">1 - Install</h2>
        <p className={dim}>
          From a clone of this repo - links <code className={mono}>motionfield</code> (the{" "}
          <Link href="/docs/cli" className="text-[var(--color-accent)] hover:underline">CLI</Link>) and{" "}
          <code className={mono}>motionfield-mcp</code> into your npm prefix. Requires Node ≥ 22.18.
        </p>
        <pre className="panel overflow-x-auto p-4 text-xs" data-testid="mcp-install">{`./scripts/install-cli.sh
command -v motionfield-mcp   # on your PATH after install - running it without
                           # MOTIONFIELD_API_KEY prints the env error and exits 2`}</pre>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">2 - API key</h2>
        <p className={dim}>
          Mint a key under{" "}
          <Link href="/settings/keys" className="text-[var(--color-accent)] hover:underline">Settings → API keys</Link>.
          The full <code className={mono}>of_…</code> token shows once - put it in the snippet&apos;s{" "}
          <code className={mono}>MOTIONFIELD_API_KEY</code>.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">3 - Point your client at it</h2>
        <p className={dim}>
          One stdio command - <code className={mono}>motionfield-mcp</code> - and the env it reads.
          Replace <code className={mono}>of_…</code> with your key.{" "}
          <code className={mono}>MOTIONFIELD_URL</code> defaults to{" "}
          <code className={mono}>http://localhost:3000</code> - set it when your server listens elsewhere.
        </p>
        <div className="space-y-4">
          {MCP_SNIPPETS.map((s) => (
            <div key={s.id} className="panel overflow-hidden p-0">
              <div className="flex items-baseline justify-between border-b border-[var(--color-border)] px-4 py-2">
                <span className="text-sm font-semibold">{s.label}</span>
                <span className="text-xs text-[var(--color-faint)]">{s.file}</span>
              </div>
              <pre className="overflow-x-auto p-4 text-xs" data-testid={`mcp-snippet-${s.id}`}>{s.text}</pre>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Remote - Streamable HTTP</h2>
        <p className={dim}>
          <code className={mono}>motionfield-mcp-http</code> serves the same tools over the MCP
          Streamable HTTP transport at <code className={mono}>POST /mcp</code> - stateless, one
          request per JSON-RPC message. There is no server-side key: every request carries its own{" "}
          <code className={mono}>Authorization: Bearer of_…</code>, verified against{" "}
          <code className={mono}>GET /api/v1/me</code> (≤60 s cache). Loopback-only by default;
          exposing it beyond your machine means a TLS reverse proxy in front plus a tight{" "}
          <code className={mono}>MOTIONFIELD_MCP_ALLOWED_HOSTS</code>. Local paths are stdio-only over
          HTTP - <code className={mono}>upload</code> takes http(s) URLs and{" "}
          <code className={mono}>job_download</code> returns a result URL for you to fetch.
        </p>
        <pre className="panel overflow-x-auto p-4 text-xs" data-testid="mcp-http-install">{`MOTIONFIELD_URL=http://localhost:3000 motionfield-mcp-http
# listens on http://127.0.0.1:8790/mcp`}</pre>
        <div className="panel overflow-x-auto p-0">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-[var(--color-faint)]">
                <th className="px-4 py-2 font-medium">variable</th>
                <th className="px-4 py-2 font-medium">default</th>
                <th className="px-4 py-2 font-medium">what it does</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["MOTIONFIELD_MCP_HTTP_HOST", "127.0.0.1", "bind address"],
                ["MOTIONFIELD_MCP_HTTP_PORT", "8790", "bind port"],
                ["MOTIONFIELD_MCP_ALLOWED_HOSTS", "localhost:<port>,127.0.0.1:<port>", "Host/Origin allowlist - anything else gets 403"],
              ].map(([k, d, w]) => (
                <tr key={k} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="px-4 py-2"><code className={mono}>{k}</code></td>
                  <td className="px-4 py-2 text-[var(--color-dim)]">{d}</td>
                  <td className="px-4 py-2 text-[var(--color-dim)]">{w}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-4">
          {MCP_HTTP_SNIPPETS.map((s) => (
            <div key={s.id} className="panel overflow-hidden p-0">
              <div className="flex items-baseline justify-between border-b border-[var(--color-border)] px-4 py-2">
                <span className="text-sm font-semibold">{s.label}</span>
                <span className="text-xs text-[var(--color-faint)]">{s.file}</span>
              </div>
              <pre className="overflow-x-auto p-4 text-xs" data-testid={`mcp-http-snippet-${s.id}`}>{s.text}</pre>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Environment</h2>
        <div className="panel overflow-x-auto p-0">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-[var(--color-faint)]">
                <th className="px-4 py-2 font-medium">variable</th>
                <th className="px-4 py-2 font-medium">default</th>
                <th className="px-4 py-2 font-medium">what it does</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["MOTIONFIELD_API_KEY", "- (required)", "your of_… key; missing → exit 2"],
                ["MOTIONFIELD_URL", "http://localhost:3000", "the MotionField base URL"],
                ["MOTIONFIELD_TOOLSETS", "core,3d", "comma list; all enables every toolset"],
                ["MOTIONFIELD_MCP_OUT_DIR", "./motionfield-out", "where job_download writes outputs"],
              ].map(([k, d, w]) => (
                <tr key={k} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="px-4 py-2"><code className={mono}>{k}</code></td>
                  <td className="px-4 py-2 text-[var(--color-dim)]">{d}</td>
                  <td className="px-4 py-2 text-[var(--color-dim)]">{w}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Toolsets</h2>
        <div className="panel overflow-x-auto p-0">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-[var(--color-faint)]">
                <th className="px-4 py-2 font-medium">toolset</th>
                <th className="px-4 py-2 font-medium">status</th>
                <th className="px-4 py-2 font-medium">tools</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-[var(--color-border)]">
                <td className="px-4 py-2"><code className={mono}>core</code></td>
                <td className="px-4 py-2 text-[var(--color-dim)]">on by default</td>
                <td className="px-4 py-2 text-[var(--color-dim)]">20 - catalog, presets, skills, estimate, upload, generate, jobs, assets, system, runs</td>
              </tr>
              <tr className="border-b border-[var(--color-border)]">
                <td className="px-4 py-2"><code className={mono}>studio</code></td>
                <td className="px-4 py-2 text-[var(--color-dim)]">opt-in</td>
                <td className="px-4 py-2 text-[var(--color-dim)]">
                  enable with <code className={mono}>MOTIONFIELD_TOOLSETS=studio</code> (or{" "}
                  <code className={mono}>all</code>) - refs, person_swap, director_shot, voices,
                  motion_graphics, audio list when their capability or endpoint is reported; the rest
                  answer not_available
                </td>
              </tr>
              <tr className="border-b border-[var(--color-border)]">
                <td className="px-4 py-2"><code className={mono}>3d</code></td>
                <td className="px-4 py-2 text-[var(--color-dim)]">on by default</td>
                <td className="px-4 py-2 text-[var(--color-dim)]">
                  <code className={mono}>stage</code> - the /api/stage 3D-scene surface while the{" "}
                  <code className={mono}>stage</code> capability is reported; <code className={mono}>anim_clips</code>{" "}
                  stays pending until clip search lands. Renders and GLB exports happen on the{" "}
                  <Link href="/scene-3d" className="text-[var(--color-accent)] hover:underline">3D Scene page</Link>{" "}
                  (the browser renders them) - the stage tool has no render/export action
                </td>
              </tr>
              <tr className="border-b border-[var(--color-border)] last:border-0">
                <td className="px-4 py-2"><code className={mono}>sites · blender</code></td>
                <td className="px-4 py-2 text-[var(--color-dim)]">registered</td>
                <td className="px-4 py-2 text-[var(--color-dim)]">no tools yet - MOTIONFIELD_TOOLSETS=all enables them as they land</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className={dim}>
          At startup the server reads <code className={mono}>GET /api/v1/capabilities</code> and{" "}
          <code className={mono}>GET /api/v1/models</code> once and advertises{" "}
          <em>enabled toolsets ∩ reported capabilities ∩ the model catalog</em>. A tool outside the
          advertised set still answers calls with a <code className={mono}>not_available</code> tool
          error - never a crash.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">The v1 API underneath</h2>
        <pre className="panel overflow-x-auto p-4 text-xs">{`GET  /api/v1/models        → endpoint catalog (inputs JSON Schema per endpoint)
GET  /api/v1/capabilities  → reported feature strings
POST /api/v1/jobs          → { endpoint, params } → { id, status }
GET  /api/v1/jobs/{id}     → status | params | outputs
POST /api/v1/jobs/{id}/cancel
POST /api/v1/estimate      → { credits, usd, unlimited }
POST /api/v1/uploads       → multipart → { url: "/files/…" }
GET  /api/v1/jobs/{id}/result?i=N  → output bytes`}</pre>
        <p className={dim}>
          Bearer <code className={mono}>Authorization: Bearer of_…</code> on every call. Details:{" "}
          <Link href="/docs/api" className="text-[var(--color-accent)] hover:underline">API reference</Link>{" "}
          · machine contract at <code className={mono}>/api/v1/openapi.json</code>.
        </p>
      </section>
    </div>
  );
}
