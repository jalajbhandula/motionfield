# motionfield-sdk

Stdlib-only Python client for the MotionField public API (`/api/v1`). MIT
licensed. Requires Python ≥3.10 - HTTP via `urllib`, signing verification via
`hmac`/`hashlib`, no third-party dependencies.

```python
from motionfield import Client, AsyncClient, MotionFieldError, verify_webhook

client = Client("http://localhost:3000", "of_…")       # Settings → API keys

models = client.models()                              # catalog + license info
est = client.estimate("motionfield/z-image-turbo/text-to-image", {"prompt": "neon"})

job = client.submit("motionfield/z-image-turbo/text-to-image",
                    params={"prompt": "neon"},
                    # idempotency_key="my-key",      # defaults to a fresh UUID
                    # webhook_url="https://me/hook",
                    )

done = client.wait(job["id"], interval=1.0)
png = client.download(done["id"])                     # bytes of output[0]

# async facade (runs the stdlib client on worker threads):
async_client = AsyncClient("http://localhost:3000", "of_…")
done = await async_client.wait(job["id"])

# in your webhook receiver:
ok = verify_webhook(os.environ["OF_WEBHOOK_SECRET"],   # the ofwh_… from key creation
                    request.headers.get("x-motionfield-signature"),
                    request.body)                      # exact request bytes
```

`submit` always sends an `Idempotency-Key` and (like `get`, `cancel`,
`models`, `estimate`) retries transient `429`/`5xx` up to twice, honoring
`Retry-After`. `upload` accepts `bytes` or a filesystem path; `download`
returns raw bytes (or writes them to `path`).

Errors raise `MotionFieldError` carrying `status`, `code`, `message`, and -
when present - `retry_after`, `license`, `enable_at` (the `403
restricted_license` fields). A `wait` that exhausts its budget raises
`code="wait_timeout"`. `Authorization` is never forwarded across a redirect
to a different host.

`outputs[].type` values are MIME types - e.g. `image/png`, `video/mp4`,
`model/gltf-binary`.

## Tests

```sh
python3 -I -B -m unittest discover -s tests
```
