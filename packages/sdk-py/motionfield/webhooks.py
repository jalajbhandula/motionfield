"""`x-motionfield-signature` verification - stdlib only (hmac/hashlib)."""

from __future__ import annotations

import hashlib
import hmac
import time

_HEX64 = frozenset("0123456789abcdef")


def verify_webhook(
    secret: str,
    header: str | None,
    body: bytes | str,
    tolerance: int = 300,
    now: float | None = None,
) -> bool:
    """Verify a `t=<unix>,v1=<hex hmac-sha256>` signature header against the raw
    request body with the key's `ofwh_…` secret. Fails closed on every anomaly -
    malformed headers, stale timestamps beyond `tolerance` seconds, wrong body,
    wrong secret.
    """
    if not secret or not header:
        return False
    fields: dict[str, str] = {}
    for part in header.split(","):
        k, _, v = part.partition("=")
        fields[k.strip()] = v.strip()
    t_raw, v1 = fields.get("t"), fields.get("v1")
    if not t_raw or not v1:
        return False
    try:
        t = int(t_raw)
    except ValueError:
        return False
    if len(v1) != 64 or any(c not in _HEX64 for c in v1.lower()):
        return False
    if abs((time.time() if now is None else float(now)) - t) > tolerance:
        return False

    if isinstance(body, str):
        body = body.encode("utf-8")
    payload = f"{t}.".encode("utf-8") + bytes(body)
    expected = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(v1.lower(), expected)
