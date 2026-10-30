import Link from "next/link";

export const metadata = { title: "Plugins" };

const mono = "font-mono text-[0.85em] text-[var(--color-accent)]";
const dim = "text-sm leading-6 text-[var(--color-dim)]";

function Steps({ items }: { items: (string | React.ReactNode)[] }) {
  return (
    <ol className="list-decimal space-y-1 pl-5 text-sm leading-6 text-[var(--color-dim)]">
      {items.map((s, i) => <li key={i}>{s}</li>)}
    </ol>
  );
}

/** Plugins - every row names an artifact that exists in this repository:
 *  the Chrome extension, the Blender add-on, the MCP server, the CLI and the
 *  SDKs. Anything else is named under "not included" - never with a button. */
export default function Plugins() {
  return (
    <div className="mx-auto max-w-3xl space-y-10 px-4 py-12">
      <header className="space-y-3">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--color-dim)]">Plugins</div>
        <h1 className="font-display text-3xl font-bold">Plugins</h1>
        <p className={dim}>
          Host-app surfaces that exist in this repository. Every install step below is a
          manual load - nothing here ships through a store.
        </p>
      </header>

      <section className="space-y-5">
        <h2 className="text-lg font-semibold">In this build</h2>

        <article className="panel space-y-3 p-5" data-testid="plugin-chrome">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-base font-semibold">Chrome extension</h3>
            <code className={mono}>plugins/chrome/</code>
          </div>
          <p className={dim}>
            A <strong>Send to MotionField</strong> context menu on images and videos on the web -
            picking a menu item uploads the media to your server and submits a generation job
            on the endpoint you chose. Plain JavaScript + Manifest V3 - no build step.
          </p>
          <Steps items={[
            <>Open <code className={mono}>chrome://extensions</code> and enable <em>Developer mode</em>.</>,
            <>Choose <em>Load unpacked</em> and pick <code className={mono}>plugins/chrome/</code> in your clone.</>,
            <>Right-click the toolbar icon → <em>Options</em>.</>,
            <>Set your MotionField URL, paste an API key (<Link href="/settings/keys" className="text-[var(--color-accent)] hover:underline">Settings → API keys</Link>), then press <em>Check</em>.</>,
            <>Right-click an image or video on any page → <em>Send to MotionField</em> → pick an endpoint.</>,
          ]} />
          <p className="text-xs text-[var(--color-faint)]">
            Tested on headless Chromium only (Playwright, unpacked). Not tested in desktop Chrome.
          </p>
        </article>

        <article className="panel space-y-3 p-5" data-testid="plugin-blender">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-base font-semibold">Blender add-on</h3>
            <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-warn)]">beta</span>
            <code className={mono}>plugins/blender/motionfield_blender/</code>
            <span className="text-xs text-[var(--color-faint)]">GPL-2.0-or-later</span>
          </div>
          <p className={dim}>
            Talks to your MotionField server from the 3D Viewport sidebar - generate a texture
            for the active object, or render the scene camera and submit it as a video job.
            Blender is external and never bundled; the extension only speaks HTTP to the v1
            API. The zip builds from <code className={mono}>plugins/blender/build.py</code>.
          </p>
          <Steps items={[
            <>Build the zip: <code className={mono}>python3 plugins/blender/build.py</code> → <code className={mono}>plugins/blender/dist/motionfield_blender-&lt;ver&gt;.zip</code>.</>,
            <>Blender → <em>Edit → Preferences → Get Extensions → ⌄ menu → Install from Disk…</em> → pick the zip → enable <em>MotionField</em>.</>,
            <>Extension preferences: set the server URL and an API key (<Link href="/settings/keys" className="text-[var(--color-accent)] hover:underline">Settings → API keys</Link>) → <em>Check</em>.</>,
            <>Sidebar tab: <em>3D Viewport → N sidebar → MotionField tab</em>.</>,
          ]} />
          <p className="text-xs text-[var(--color-faint)]">
            Headless smoke passed on Blender 5.2.3 - the GUI panel itself has not been
            hand-tested yet.
          </p>
        </article>

        <article className="panel space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-base font-semibold">MCP server</h3>
            <code className={mono}>motionfield-mcp</code>
          </div>
          <p className={dim}>
            The v1 API as an MCP stdio server - the same flow an agent client uses.
            Install steps and per-client config live on the{" "}
            <Link href="/mcp" className="text-[var(--color-accent)] hover:underline">MCP page</Link>.
          </p>
        </article>

        <article className="panel space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-base font-semibold">CLI</h3>
            <code className={mono}>motionfield</code>
          </div>
          <p className={dim}>
            The v1 API as a terminal program - key in a file, no browser needed after install.
            Commands and install steps: <Link href="/docs/cli" className="text-[var(--color-accent)] hover:underline">CLI reference</Link>.
          </p>
        </article>

        <article className="panel space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-base font-semibold">SDKs</h3>
            <code className={mono}>packages/sdk-ts · packages/sdk-py</code>
          </div>
          <p className={dim}>
            TypeScript and Python wrappers over the v1 API - jobs, uploads, refs, runs.
            Wire contract and examples: <Link href="/docs/api" className="text-[var(--color-accent)] hover:underline">API reference</Link>.
          </p>
        </article>
      </section>

      <section className="space-y-3" data-testid="not-included">
        <h2 className="text-lg font-semibold">Not included in this build</h2>
        <p className={dim}>
          Plugins for other host apps do not exist in this repository - there is nothing to
          download and no install button for them: Figma, Photoshop, Premiere, DaVinci
          Resolve, After Effects.
        </p>
      </section>
    </div>
  );
}
