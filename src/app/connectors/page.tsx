import Link from "next/link";
import { V1_CAPABILITIES } from "@/lib/api/capabilities";

export const metadata = { title: "Connectors" };

const mono = "font-mono text-[0.85em] text-[var(--color-accent)]";
const dim = "text-sm leading-6 text-[var(--color-dim)]";

const NOT_INCLUDED = [
  "Slack", "WhatsApp Business", "Discord",
  "TikTok", "Instagram", "YouTube", "X / Twitter",
  "Google Drive", "Dropbox", "Notion", "GitHub", "Figma", "Airtable",
];

/** Connectors - only surfaces that exist are listed as working. Everything
 *  else is named under "not included" - never with a connect button. */
export default function Connectors() {
  const telegram = (V1_CAPABILITIES as readonly string[]).includes("telegram");
  return (
    <div className="mx-auto max-w-3xl space-y-10 px-4 py-12">
      <header className="space-y-3">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--color-dim)]">Connectors</div>
        <h1 className="font-display text-3xl font-bold">Connectors</h1>
        <p className={dim}>
          Ways in and out of MotionField that this build actually provides - signed webhooks,
          the MCP stdio server and API keys.
        </p>
      </header>

      <section className="space-y-5">
        <h2 className="text-lg font-semibold">Available in this build</h2>

        <article className="panel space-y-2 p-5" data-testid="connector-webhooks">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-base font-semibold">Webhooks</h3>
            <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-accent)]">built-in</span>
          </div>
          <p className={dim}>
            Signed per-job HTTP POSTs on all four terminal events -{" "}
            <code className={mono}>job.completed</code>, <code className={mono}>job.failed</code>,{" "}
            <code className={mono}>job.nsfw</code> and <code className={mono}>job.canceled</code> - to
            any URL you submit with <code className={mono}>webhook_url</code> on{" "}
            <code className={mono}>POST /api/v1/jobs</code>. Bodies are signed{" "}
            <code className={mono}>HMAC-SHA256</code> with the key&apos;s webhook secret; 408/429/5xx
            retried up to 6 attempts within 2 h (30 s, 2 m, 10 m, 30 m, 1 h).
          </p>
          <p className="text-sm">
            <Link href="/docs/api#webhooks" className="text-[var(--color-accent)] hover:underline">
              Webhook signing + event shapes → API reference
            </Link>
          </p>
        </article>

        <article className="panel space-y-2 p-5" data-testid="connector-mcp">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-base font-semibold">Custom MCP</h3>
            <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-accent)]">built-in</span>
          </div>
          <p className={dim}>
            <code className={mono}>motionfield-mcp</code> exposes the v1 API over MCP stdio - add it to
            any client that launches a stdio command. Install steps and per-client config live on
            the MCP page.
          </p>
          <p className="text-sm">
            <Link href="/mcp" className="text-[var(--color-accent)] hover:underline">
              Add MotionField to your agent → /mcp
            </Link>
          </p>
        </article>

        <article className="panel space-y-2 p-5" data-testid="connector-apikeys">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-base font-semibold">API keys</h3>
            <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-accent)]">built-in</span>
          </div>
          <p className={dim}>
            <code className={mono}>of_…</code> bearer keys for the v1 API, the CLI and the MCP
            server - mint, label and revoke them yourself.
          </p>
          <p className="text-sm">
            <Link href="/settings/keys" className="text-[var(--color-accent)] hover:underline">
              Manage keys → Settings → API keys
            </Link>
          </p>
        </article>

        <article className="panel space-y-2 p-5" data-testid="connector-telegram">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-base font-semibold">Telegram</h3>
            <span
              data-testid="telegram-status"
              className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-warn)]"
            >
              {telegram ? "available" : "planned"}
            </span>
          </div>
          <p className={dim}>
            {telegram
              ? "The server reports a telegram capability - send it your key per its own docs."
              : "A Telegram surface is planned but not built - this server reports no telegram capability, so there is nothing to connect."}
          </p>
        </article>
      </section>

      <section className="space-y-3" data-testid="not-included">
        <h2 className="text-lg font-semibold">Not included in this build</h2>
        <p className={dim}>
          There are no integrations for these services - no credentials flow exists, so
          nothing here can be connected:
        </p>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-[var(--color-dim)] sm:grid-cols-3">
          {NOT_INCLUDED.map((n) => <li key={n}>{n}</li>)}
        </ul>
      </section>
    </div>
  );
}
