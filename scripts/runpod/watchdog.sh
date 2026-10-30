#!/bin/bash
# MotionField RunPod watchdog — polls the ComfyUI queue every minute; after
# EMPTY_LIMIT_SECS of an empty queue the pod stops itself via runpodctl.
# Continuous unreachability longer than UNREACHABLE_LIMIT_SECS counts as
# idle (a crashed ComfyUI still bills) — except while SETUP_LOCK is held by
# a live pid, which setup.sh writes for its whole download+install run. A
# lock whose pid is gone (SIGKILLed setup) is stale and ignored.
#
#   watchdog.sh [--dry-run]
#
# --dry-run prints the current decision and exits — no loop, no stop.
# Knobs (env): QUEUE_URL (default http://127.0.0.1:8188/queue),
# POLL_SECS (60), EMPTY_LIMIT_SECS (1200 — 20 min),
# UNREACHABLE_LIMIT_SECS (1800 — 30 min), SETUP_LOCK (/tmp/of-setup.lock).
set -euo pipefail

QUEUE_URL="${QUEUE_URL:-http://127.0.0.1:8188/queue}"
POLL_SECS="${POLL_SECS:-60}"
EMPTY_LIMIT_SECS="${EMPTY_LIMIT_SECS:-1200}"
UNREACHABLE_LIMIT_SECS="${UNREACHABLE_LIMIT_SECS:-1800}"
SETUP_LOCK="${SETUP_LOCK:-/tmp/of-setup.lock}"
MAX_RUNTIME_SECS="${MAX_RUNTIME_SECS:-0}"
RUNPODCTL_BIN="${RUNPODCTL_BIN:-runpodctl}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
[ "${1:-}" = "" ] || [ "$DRY_RUN" = "1" ] || { echo "usage: watchdog.sh [--dry-run]" >&2; exit 2; }

pending() { # -> number of queued+running jobs, or -1 on unreachable
  "$CURL_BIN" -s -m 10 "$QUEUE_URL" 2>/dev/null | python3 -c "
import json, sys
try:
    q = json.load(sys.stdin)
    print(len(q.get('queue_running', [])) + len(q.get('queue_pending', [])))
except Exception:
    print(-1)
"
}
CURL_BIN="${CURL:-curl}"

# setup.sh writes its pid into SETUP_LOCK; only a lock whose pid is still
# alive means "setup in progress" — a stale lock must not hold the watchdog
# off a dead pod.
setup_in_progress() {
  local pid=""
  [ -f "$SETUP_LOCK" ] || return 1
  pid="$(cat "$SETUP_LOCK" 2>/dev/null || true)"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null
}

if [ "$DRY_RUN" = "1" ]; then
  n="$(pending || true)"
  if [ "$n" = "-1" ]; then
    if setup_in_progress; then
      echo "dry-run: queue unreachable at $QUEUE_URL but setup lock $SETUP_LOCK is held by a live pid — setup in progress, no stop"
    else
      if [ -f "$SETUP_LOCK" ]; then
        echo "dry-run: setup lock $SETUP_LOCK is stale (its pid is gone) — ignoring it"
      fi
      # unreachable counts as idle once it has lasted UNREACHABLE_LIMIT_SECS,
      # and the outage is then backdated as idle — so the stop fires at
      # max(UNREACHABLE_LIMIT_SECS, EMPTY_LIMIT_SECS) from the outage start.
      echo "dry-run: queue unreachable at $QUEUE_URL — counts as idle after ${UNREACHABLE_LIMIT_SECS}s of continuous unreachability, backdated, so the stop fires at max(${UNREACHABLE_LIMIT_SECS}s, ${EMPTY_LIMIT_SECS}s) total (a live setup lock at $SETUP_LOCK would pause it)"
    fi
  elif [ "$n" = "0" ]; then
    echo "dry-run: queue empty — stop would fire after ${EMPTY_LIMIT_SECS}s of this (runpodctl pod stop ${RUNPOD_POD_ID:-<unset>})"
  else
    echo "dry-run: $n job(s) in flight — no stop"
  fi
  exit 0
fi

[ -n "${RUNPOD_POD_ID:-}" ] || { echo "watchdog.sh: RUNPOD_POD_ID is unset — not on a pod?" >&2; exit 2; }

command -v "$RUNPODCTL_BIN" >/dev/null 2>&1 || { echo "watchdog.sh: RunPod CLI missing — no spending guard is active" >&2; exit 2; }
case "$MAX_RUNTIME_SECS" in ''|*[!0-9]*) echo "watchdog.sh: invalid MAX_RUNTIME_SECS" >&2; exit 2 ;; esac
started=$(date +%s)
empty_since=0
unreach_since=0
while true; do
  n="$(pending || true)"
  now=$(date +%s)
  if [ "$MAX_RUNTIME_SECS" -gt 0 ] && [ "$((now - started))" -ge "$MAX_RUNTIME_SECS" ]; then
    echo "watchdog: runtime limit ${MAX_RUNTIME_SECS}s reached — stopping pod $RUNPOD_POD_ID even if a job is stuck"
    "$RUNPODCTL_BIN" pod stop "$RUNPOD_POD_ID"
    exit 0
  fi
  if [ "$n" = "-1" ]; then
    if setup_in_progress; then
      unreach_since=0; empty_since=0
      echo "watchdog: queue unreachable but setup lock held by a live pid — setup in progress, waiting"
    else
      if [ -f "$SETUP_LOCK" ]; then
        echo "watchdog: ignoring stale setup lock $SETUP_LOCK (its pid is gone)"
      fi
      [ "$unreach_since" = "0" ] && unreach_since=$now
      unreach=$(( now - unreach_since ))
      if [ "$unreach" -ge "$UNREACHABLE_LIMIT_SECS" ]; then
        # dead ComfyUI for over the limit — count the outage as idle time
        [ "$empty_since" = "0" ] && empty_since=$unreach_since
        echo "watchdog: unreachable ${unreach}s (>= ${UNREACHABLE_LIMIT_SECS}s) — counting as idle"
      else
        echo "watchdog: queue unreachable ${unreach}s/${UNREACHABLE_LIMIT_SECS}s — waiting"
      fi
    fi
  elif [ "$n" = "0" ]; then
    unreach_since=0
    [ "$empty_since" = "0" ] && empty_since=$now
  else
    unreach_since=0; empty_since=0
    echo "watchdog: $n job(s) in flight"
  fi
  if [ "$empty_since" != "0" ]; then
    idle=$(( now - empty_since ))
    if [ "$idle" -ge "$EMPTY_LIMIT_SECS" ]; then
      # re-poll right before the stop — never stop mid-job
      n="$(pending || true)"
      if [ "$n" != "-1" ] && [ "$n" != "0" ]; then
        echo "watchdog: $n job(s) appeared — not stopping"
        unreach_since=0; empty_since=0
        sleep "$POLL_SECS"
        continue
      fi
      echo "watchdog: queue empty/unreachable for ${idle}s — stopping pod $RUNPOD_POD_ID"
      "$RUNPODCTL_BIN" pod stop "$RUNPOD_POD_ID"
      exit 0
    fi
    echo "watchdog: idle ${idle}s/${EMPTY_LIMIT_SECS}s"
  fi
  sleep "$POLL_SECS"
done
