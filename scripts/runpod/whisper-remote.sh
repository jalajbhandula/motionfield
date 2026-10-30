#!/usr/bin/env bash
# whisper-remote.sh — a drop-in whisper-cli that executes on the RunPod pod.
# The Mac never runs ASR locally: src/lib/captions/asr.ts spawns whatever
# WHISPER_CLI names, so the session sets
#   WHISPER_CLI=<repo>/scripts/runpod/whisper-remote.sh
# and every whisper invocation crosses SSH instead.
#
# argv contract (what asr.ts emits):
#   whisper-cli -m <model> -ml 1 -sow -ojf -np -l <lang> -of <outBase> <wav>
#
# The model is pod-side: pass -m remote:<name> (e.g. remote:ggml-base.en.bin)
# or any path — the basename maps onto $POD_WHISPER_DIR on the pod. The wav
# is scp'd up, whisper-cli runs there, and <outBase>.json is scp'd back to
# the exact local path asr.ts reads. Any failure exits non-zero.
#
#   POD_HOST / POD_PORT   required — the runpod ssh endpoint (sync-to-pod.sh's)
#   SSH_KEY               default $HOME/.ssh/runpod_motionfield (sync-to-pod.sh's)
#   POD_WHISPER_CLI       default whisper-cli (setup.sh installs it on PATH)
#   POD_WHISPER_DIR       default ~/.motionfield/models/whisper on the pod
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
whisper-remote — pod-side whisper-cli drop-in
  -m <model>   model name (remote:<name> or a path — basename maps to the pod)
  -of <base>   local output base — <base>.json is copied back here
  -l <lang>    language (forwarded)
  other whisper flags (-ml, -sow, -ojf, -np, …) are forwarded verbatim
env: POD_HOST POD_PORT [SSH_KEY] [POD_WHISPER_CLI] [POD_WHISPER_DIR]
EOF
}

# -h is how asr.ts probes "does this binary exist" — answer before env checks.
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ $# -eq 0 ]; then usage; exit 0; fi

POD_HOST="${POD_HOST:?POD_HOST env required (runpod ssh host)}"
POD_PORT="${POD_PORT:?POD_PORT env required (runpod ssh port)}"
KEY="${SSH_KEY:-$HOME/.ssh/runpod_motionfield}"
POD_WHISPER_CLI="${POD_WHISPER_CLI:-whisper-cli}"
POD_WHISPER_DIR="${POD_WHISPER_DIR:-/root/.motionfield/models/whisper}"

SSH=(ssh -i "$KEY" -p "$POD_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
SCP=(scp -i "$KEY" -P "$POD_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

model="" of="" lang="auto" wav=""
fwd=()
while [ $# -gt 0 ]; do
  case "$1" in
    -m)   model="${2:?-m needs a value}"; shift 2 ;;
    -of)  of="${2:?-of needs a value}"; shift 2 ;;
    -l)   lang="${2:?-l needs a value}"; fwd+=(-l "$lang"); shift 2 ;;
    -ml|-t|-bo|-bs|-ac|-at|-nth|-p)
          fwd+=("$1" "${2:?$1 needs a value}"); shift 2 ;;
    -sow|-ojf|-np|-nts|-pp|-ps|-pc|-owt|-ocs|-dtw)
          fwd+=("$1"); shift ;;
    -*)   echo "whisper-remote: unhandled flag '$1' — extend the allowlist" >&2; exit 2 ;;
    *)    [ -n "$wav" ] && { echo "whisper-remote: extra positional '$1' — one input file only" >&2; exit 2; }
          wav="$1"; shift ;;
  esac
done
[ -n "$wav" ] || { echo "whisper-remote: no input file" >&2; exit 2; }
[ -n "$of" ]  || { echo "whisper-remote: no -of <out base>" >&2; exit 2; }
[ -f "$wav" ] && [ -r "$wav" ] || { echo "whisper-remote: input not readable: $wav" >&2; exit 1; }
# the remote command is a single string — only pod-side paths may enter it,
# so the model name must be a plain basename (no spaces, no quotes to smuggle)
name="${model#remote:}"; name="${name##*/}"
case "$name" in
  ""|*[!A-Za-z0-9._-]*) echo "whisper-remote: bad model name '$name'" >&2; exit 2 ;;
esac
# POD_WHISPER_CLI/POD_WHISPER_DIR land inside the remote single-quoted string
# — reject anything that could smuggle a quote out of it
case "$POD_WHISPER_CLI" in
  ""|*[!A-Za-z0-9._/-]*) echo "whisper-remote: bad POD_WHISPER_CLI" >&2; exit 2 ;;
esac
case "$POD_WHISPER_DIR" in
  ""|*[!A-Za-z0-9._/-]*) echo "whisper-remote: bad POD_WHISPER_DIR" >&2; exit 2 ;;
esac
case "$lang" in
  ""|*[!a-zA-Z]*) echo "whisper-remote: bad language '$lang'" >&2; exit 2 ;;
esac
pod_model="$POD_WHISPER_DIR/$name"

work="$("${SSH[@]}" "root@$POD_HOST" 'mktemp -d /tmp/of-asr.XXXXXXXX')" || {
  echo "whisper-remote: ssh failed — is the pod up? (POD_HOST=$POD_HOST POD_PORT=$POD_PORT)" >&2; exit 1; }
case "$work" in
  /tmp/of-asr.[A-Za-z0-9]*) ;;
  *) echo "whisper-remote: unexpected remote workdir '$work'" >&2; exit 1 ;;
esac
cleanup() { "${SSH[@]}" "root@$POD_HOST" "rm -rf -- '$work'" >/dev/null 2>&1 || true; }
trap cleanup EXIT

"${SCP[@]}" "$wav" "root@$POD_HOST:$work/in.wav" || {
  echo "whisper-remote: scp up failed" >&2; exit 1; }

# the flags we forward are already validated above; join them for the remote
# single-string command (%q-escaped so remote bash re-parses to the same argv)
remote_flags=""
[ ${#fwd[@]} -gt 0 ] && remote_flags="$(printf ' %q' "${fwd[@]}")"
"${SSH[@]}" "root@$POD_HOST" \
  "'$POD_WHISPER_CLI' -m '$pod_model'$remote_flags -of '$work/out' '$work/in.wav'" || {
  echo "whisper-remote: pod whisper-cli failed" >&2; exit 1; }

"${SCP[@]}" "root@$POD_HOST:$work/out.json" "$of.json" || {
  echo "whisper-remote: scp back failed" >&2; exit 1; }
[ -s "$of.json" ] || { echo "whisper-remote: pod produced no JSON output" >&2; exit 1; }
