# @motionfield/sdk

Zero-dependency TypeScript client for the MotionField public API (`/api/v1`).
MIT licensed. Node ≥18.20 (or any modern fetch runtime). Request signing and
idempotency ids use WebCrypto (`globalThis.crypto`); `verifyWebhook` needs a
synchronous HMAC (WebCrypto is async-only) so it loads `node:crypto` lazily
via `process.getBuiltinModule` on first call - importing the SDK never
eagerly requires Node builtins.

```ts
import { MotionField, verifyWebhook } from "@motionfield/sdk";

const of = new MotionField({
  baseUrl: "http://localhost:3000",
  apiKey: "of_…", // Settings → API keys
});

const models = await of.models();                    // catalog + license info
const est = await of.estimate("motionfield/z-image-turbo/text-to-image", { prompt: "neon" });

const job = await of.submit("motionfield/z-image-turbo/text-to-image",
  { prompt: "neon" },
  // { idempotencyKey: "my-key",   // defaults to a fresh UUID
  //   webhookUrl: "https://me/hook" },
);

const done = await of.wait(job.id, { intervalMs: 1500 });
const { bytes, contentType } = await of.download(done.id);  // output[0], e.g. image/png

// in your webhook receiver:
const ok = verifyWebhook(
  process.env.OF_WEBHOOK_SECRET!,                    // the ofwh_… shown at key creation
  req.headers["x-motionfield-signature"],
  rawBody,                                           // exact request bytes
);
```

Every request sends `Authorization: Bearer <key>` and a per-attempt
`AbortSignal.timeout`. `submit`, `get`, `cancel`, `models` and `estimate`
retry transient `429`/`5xx` up to twice, honoring `Retry-After`. `upload` and
`download` are single-attempt (upload bodies can't replay).

Errors throw `MotionFieldError` carrying `status`, `code`, `message`, and -
when present - `retryAfter`, `license`, `enableAt` (the `403
restricted_license` fields). A `wait` that exhausts its budget throws
`code === "wait_timeout"`.

`outputs[].type` values are MIME types - e.g. `image/png`, `video/mp4`,
`model/gltf-binary`.
