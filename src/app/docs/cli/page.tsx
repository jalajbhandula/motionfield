import Link from "next/link";

export const metadata = { title: "CLI - motionfield" };

const mono = "font-mono text-[0.85em] text-[var(--color-accent)]";
const dim = "text-sm leading-6 text-[var(--color-dim)]";

/** CLI reference - the commands docs/CLI.md actually documents. Install →
 *  login → generate → download; runs is the plan-first surface. */
export default function DocsCli() {
  return (
    <div className="mx-auto max-w-3xl space-y-10 px-4 py-12">
      <header className="space-y-3">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--color-dim)]">Docs</div>
        <h1 className="font-display text-3xl font-bold">motionfield - the CLI</h1>
        <p className={dim}>
          The MotionField v1 API as a terminal program - the same key, the same endpoints.
          Source of truth: <code className={mono}>docs/CLI.md</code> in this repo.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Install</h2>
        <pre className="panel overflow-x-auto p-4 text-xs">{`./scripts/install-cli.sh   # links motionfield + motionfield-mcp + motionfield-mcp-http into your npm prefix`}</pre>
        <p className={dim}>
          The installer links all three bins - <code className={mono}>motionfield</code> (the CLI),{" "}
          <code className={mono}>motionfield-mcp</code> and <code className={mono}>motionfield-mcp-http</code>{" "}
          (see <Link href="/mcp" className="text-[var(--color-accent)] hover:underline">MCP</Link>).
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Config</h2>
        <p className={dim}>
          <code className={mono}>motionfield login --key of_…</code> writes{" "}
          <code className={mono}>~/.config/motionfield/config.json</code> mode{" "}
          <code className={mono}>0600</code>. <code className={mono}>MOTIONFIELD_API_KEY</code> and{" "}
          <code className={mono}>MOTIONFIELD_URL</code> always override the file.
          Mint keys at <Link href="/settings/keys" className="text-[var(--color-accent)] hover:underline">Settings → API keys</Link>.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Commands</h2>
        <div className="panel overflow-x-auto p-0">
          <table className="w-full text-left text-xs">
            <tbody>
              {[
                ["motionfield login --key of_… · logout · whoami", "store/remove a key; print user, plan, credits, key label"],
                ["motionfield models [--kind K] · models get <endpoint>", "endpoint catalog - get prints one entry's inputs JSON Schema"],
                ["motionfield estimate <endpoint> [-p k=v]…", "cost before you spend it"],
                ["motionfield generate <endpoint> [-p k=v]… [-f name=path]… [--wait] [-o dir]", "submit a job; -f uploads first; --wait polls to terminal and writes outputs"],
                ["motionfield status [<id>]", "system view, or one job"],
                ["motionfield wait <id>", "poll until terminal"],
                ["motionfield cancel <id>", "cancel a live job"],
                ["motionfield list [--status S] [--kind K] [--source S] [--limit N] [--before]", "your jobs, newest first"],
                ["motionfield download <id> [-i N] -o <file|dir>", "fetch outputs - N is the 0-based output index"],
                ["motionfield upload <file>", "upload media → the /files/… url params take"],
                ["motionfield skills list · skills get <slug> · skills import <folder>", "prompt-recipe skills (import is capability-gated)"],
                ["motionfield runs create --plan|--text|--skill … · runs get · runs approve · runs control pause|resume|stop · runs edit <id> <step> --rev N", "plan-first runs from a brief"],
                ["motionfield stage list · create --empty|--prompt · get · inspect · apply --ops · revisions · restore", "the /api/stage 3D-scene surface - optimistic concurrency + idempotency keys on writes"],
                ["motionfield ads · sites", "capability-gated groups - they answer with the capability's name until it lands"],
              ].map(([cmd, d]) => (
                <tr key={cmd} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="px-4 py-2"><code className={mono}>{cmd}</code></td>
                  <td className="px-4 py-2 text-[var(--color-dim)]">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={dim}>
          <code className={mono}>--json</code> prints only the JSON object on stdout (chatter goes to
          stderr). API errors exit <code className={mono}>1</code>; usage problems and
          capability-gated groups exit <code className={mono}>2</code>.
        </p>
      </section>
    </div>
  );
}
