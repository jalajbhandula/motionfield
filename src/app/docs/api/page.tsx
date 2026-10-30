import Link from "next/link";
import { openEndpoints } from "@/lib/api/openapi";

export const metadata = { title: "API reference" };

const mono = "font-mono text-[0.85em] text-[var(--color-accent)]";

/** Human-readable API reference - the endpoint table is generated from the
 *  same catalog builder that produces /api/v1/openapi.json. */
export default function ApiDocsPage() {
  const endpoints = openEndpoints();
  return (
    <div className="mx-auto max-w-3xl space-y-10 px-4 py-10">
      <header className="space-y-3">
        <h1 className="font-display text-3xl font-bold">MotionField API <span className="text-[var(--color-dim)]">v1</span></h1>
        <p className="text-sm leading-6 text-[var(--color-dim)]">
          Programmatic access to every MotionField generation endpoint. Bearer-token authenticated,
          idempotent job submission, signed webhooks. The machine-readable contract lives at{" "}
          <Link href="/api/v1/openapi.json" className="text-[var(--color-accent)] hover:underline">
            <code className={mono}>/api/v1/openapi.json</code> (OpenAPI 3.1)
          </Link>.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Authentication</h2>
        <p className="text-sm leading-6 text-[var(--color-dim)]">
          Create a key under <Link href="/settings/keys" className="text-[var(--color-accent)] hover:underline">Settings → API keys</Link>{" "}
          (or <code className={mono}>POST /api/keys</code> from a signed-in session). The full{" "}
          <code className={mono}>of_&lt;keyId&gt;_&lt;secret&gt;</code> token is shown exactly once - only its hash is
          stored. Send it on every call:
        </p>
        <pre className="panel overflow-x-auto p-4 text-xs">Authorization: Bearer of_…</pre>
        <p className="text-sm leading-6 text-[var(--color-dim)]">
          Revoked or malformed keys get <code className={mono}>401</code> everywhere. Keys see only their
          owner&apos;s jobs - any other id is a <code className={mono}>404</code>.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Idempotency</h2>
        <p className="text-sm leading-6 text-[var(--color-dim)]">
          Send an <code className={mono}>Idempotency-Key</code> header (1-255 printable ASCII) with{" "}
          <code className={mono}>POST /api/v1/jobs</code>. We store it with a sha256 of the canonical{" "}
          <code className={mono}>{"{ endpoint, params }"}</code> payload:
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-[var(--color-dim)]">
          <li>Same key + same payload → <code className={mono}>200</code> with the original job. Nothing is re-charged or re-submitted.</li>
          <li>Same key + different payload → <code className={mono}>422 idempotency_mismatch</code>.</li>
          <li>Keys are scoped per user and never expire.</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Concurrency</h2>
        <p className="text-sm leading-6 text-[var(--color-dim)]">
          Each key has <code className={mono}>max_concurrency</code> (default 2, set at creation, 1-64). When
          the key&apos;s live jobs (<code className={mono}>queued</code> + <code className={mono}>in_progress</code>) hit the
          cap, job creation answers <code className={mono}>429 concurrency_limit</code> with{" "}
          <code className={mono}>Retry-After: 5</code>. Finished or canceled jobs free their slots immediately.
          Your plan-level limit applies on top.
        </p>
      </section>

      <section className="space-y-3" id="webhooks">
        <h2 className="text-lg font-semibold">Webhooks</h2>
        <p className="text-sm leading-6 text-[var(--color-dim)]">
          Pass <code className={mono}>webhook_url</code> on job creation and we POST once when the job reaches a
          terminal state - <code className={mono}>job.completed</code>, <code className={mono}>job.failed</code>,{" "}
          <code className={mono}>job.nsfw</code>, <code className={mono}>job.canceled</code>. The body is frozen when
          the event is enqueued and resent verbatim on retries:
        </p>
        <pre className="panel overflow-x-auto p-4 text-xs">{`{
  "id": "<delivery uuid>",
  "type": "job.completed",
  "created": 1730000000,
  "data": { /* exact GET /api/v1/jobs/{id} object */ }
}`}</pre>
        <p className="text-sm leading-6 text-[var(--color-dim)]">
          Every delivery carries <code className={mono}>X-MotionField-Event-Id</code> (the delivery id) and{" "}
          <code className={mono}>X-MotionField-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code> where{" "}
          <code className={mono}>v1</code> is HMAC-SHA256 over <code className={mono}>{"`${t}.${body}`"}</code> keyed
          with your key&apos;s <code className={mono}>ofwh_…</code> secret - shown once at key creation or via{" "}
          <code className={mono}>POST /api/keys/:id/webhook-secret</code>. Verify it in Node:
        </p>
        <pre className="panel overflow-x-auto p-4 text-xs">{`import crypto from "node:crypto";

const [t, v1] = header.replace("t=", "").split(",v1=");
const expected = crypto
  .createHmac("sha256", secret)
  .update(\`\${t}.\${rawBody}\`)
  .digest("hex");
const fresh = Math.abs(Date.now() / 1000 - Number(t)) <= 300;
const ok = fresh && crypto.timingSafeEqual(
  Buffer.from(v1, "hex"), Buffer.from(expected, "hex"));`}</pre>
        <p className="text-sm leading-6 text-[var(--color-dim)]">
          Reject stale timestamps (±5 minutes) and always verify against the raw request body.
          Deliveries retry at +30s, +2m, +10m, +30m and +60m after each failed attempt - six
          attempts at most - then are marked exhausted. Any 2xx acknowledges; other statuses
          (including redirects, which we never follow) end the delivery as failed unless they
          are 408/429/5xx. On hosted deployments, webhook targets may not resolve to private
          networks; link-local and multicast addresses are always refused.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Endpoints</h2>
        <p className="text-sm leading-6 text-[var(--color-dim)]">
          {endpoints.length} callable endpoints - generated from the same catalog the server enforces.
        </p>
        <div className="panel overflow-x-auto p-0">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-[var(--color-faint)]">
                <th className="px-4 py-2 font-medium">endpoint</th>
                <th className="px-4 py-2 font-medium">kind</th>
                <th className="px-4 py-2 font-medium">label</th>
                <th className="px-4 py-2 font-medium">required params</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map(({ model, workflow }) => (
                <tr key={workflow.endpointId} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="px-4 py-2"><code className={mono}>{workflow.endpointId}</code></td>
                  <td className="px-4 py-2">{workflow.kind}</td>
                  <td className="px-4 py-2 text-[var(--color-dim)]">{model.label} · {workflow.label}</td>
                  <td className="px-4 py-2 text-[var(--color-dim)]">
                    {workflow.params.filter((p) => p.required).map((p) => p.name).join(", ") || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
