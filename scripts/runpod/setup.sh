#!/bin/bash
# MotionField RunPod setup — downloads the weight manifest and installs the
# pinned software stack. Bash 3.2-safe (no mapfile / assoc arrays).
#
#   setup.sh [--dry-run] [--download-only] [--tier A,B,C,3d]  (default A)
#            [--with-restricted] [--with-optional] [--manifest <file>]
#
# --dry-run       print the plan + what would run; fetch nothing, install nothing
# --download-only skip the software install, weights only (ComfyUI itself is
#                 still cloned/checked out first — the weights land inside it)
# --tier          comma-separated tiers to include (default A)
# --with-restricted  also fetch class:restricted weights — they print
#                    "opt-in required in Settings -> Licenses" and stay gated
#                    server-side until the user accepts there
# --with-optional    include optional:true entries (camera extras, tier C)
# --workflows     comma-separated workflow filenames; only their literal model inputs
#                 are downloaded (custom-node auto-downloads need separate setup)
# --manifest      alternate manifest path
#
# Repo overrides (for mirrors/tests): COMFYUI_REPO, VHS_REPO, FLASHVSR_REPO,
# LONGCAT_REPO (+ the matching *_REF). HF_TOKEN is read from the environment
# only and is never printed.
#
# Every entry must verify: class is open|permissive-terms|restricted, the
# class equals the licence's class (or is stricter for a named pack), the
# licence is not NC/banned/unknown/other, and the sha256 matches after
# download. Any entry failing the gate aborts the run BEFORE anything downloads.
# Exit codes: 2 usage/manifest, 3 licence gate, 4 sha256 mismatch, 5 a needed
# tool is missing.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
MANIFEST="$HERE/models.cloud.json"
TIERS="A"
WORKFLOWS=""
DRY_RUN=0
DOWNLOAD_ONLY=0
WITH_RESTRICTED=0
WITH_OPTIONAL=0

COMFY_HOME="${COMFY_HOME:-/workspace/ComfyUI}"
MODELS_DIR="${MODELS_DIR:-$COMFY_HOME/models}"
CURL="${CURL:-curl}"
SETUP_LOCK="${SETUP_LOCK:-/tmp/of-setup.lock}"
COMFYUI_REPO="${COMFYUI_REPO:-https://github.com/comfyanonymous/ComfyUI.git}"
COMFYUI_REF="${COMFYUI_REF:-ce1e922d8623bb507180e32a0c01a7d0e29edef7}"   # ComfyUI 0.41.0
VHS_REPO="${VHS_REPO:-https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git}"
VHS_REF="${VHS_REF:-4d907bee61e92c2e65af3bd6383a4e4d356126d1}"           # ComfyUI-VideoHelperSuite pin
FLASHVSR_REPO="${FLASHVSR_REPO:-https://github.com/smthemex/ComfyUI_FlashVSR.git}"
FLASHVSR_REF="${FLASHVSR_REF:-153cf03343a116c85aee40d291125921cc33935a}" # ComfyUI_FlashVSR (smthemex, Apache-2.0) — see CLOUD.md
LONGCAT_REPO="${LONGCAT_REPO:-https://github.com/rookiestar28/ComfyUI-LongCat-Avatar.git}"
LONGCAT_REF="${LONGCAT_REF:-08b4daedfaed69abaf467097f8665615b2137331}" # ComfyUI-LongCat-Avatar (rookiestar28, MIT) — see CLOUD.md
LTXVIDEO_REPO="${LTXVIDEO_REPO:-https://github.com/Lightricks/ComfyUI-LTXVideo.git}"
LTXVIDEO_REF="${LTXVIDEO_REF:-220e1d45aa0469f518e982102fca4dca92a61862}" # ComfyUI-LTXVideo pin — IC-LoRA + draw-track nodes
KOKORO_REPO="${KOKORO_REPO:-https://github.com/stavsap/comfyui-kokoro.git}"
KOKORO_REF="${KOKORO_REF:-cfb59b5605b351e196182c836f0b48c1a784e52f}"      # comfyui-kokoro pin (stavsap, Apache-2.0) — same ref as setup-studio.sh
MUSETALK_REPO="${MUSETALK_REPO:-https://github.com/chaojie/ComfyUI-MuseTalk.git}"
MUSETALK_REF="${MUSETALK_REF:-84f4b6dcbb0d87e87687f324092056646582457d}" # ComfyUI-MuseTalk pin — same ref as setup-musetalk.sh
MUSETALK_PATCH="$REPO_ROOT/scripts/patches/comfyui-musetalk-mps.patch"
WHISPER_CPP_REPO="${WHISPER_CPP_REPO:-https://github.com/ggml-org/whisper.cpp.git}"
WHISPER_CPP_REF="${WHISPER_CPP_REF:-v1.8.2}"            # whisper.cpp pin — pod-side whisper-cli for ASR
CHATTERBOX_REPO="${CHATTERBOX_REPO:-https://github.com/wildminder/ComfyUI-Chatterbox.git}"
CHATTERBOX_REF="${CHATTERBOX_REF:-4597af8f59d4460d441e13533eae24b092e40952}" # wildminder/ComfyUI-Chatterbox pin (MIT) — ChatterboxTTS/ChatterboxVC

usage() { sed -n '2,27p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --download-only) DOWNLOAD_ONLY=1 ;;
    --tier) TIERS="${2:?--tier needs a value}"; shift ;;
    --tier=*) TIERS="${1#*=}" ;;
    --with-restricted) WITH_RESTRICTED=1 ;;
    --with-optional) WITH_OPTIONAL=1 ;;
    --workflows) WORKFLOWS="${2:?--workflows needs a value}"; shift ;;
    --workflows=*) WORKFLOWS="${1#*=}" ;;
    --manifest) MANIFEST="${2:?--manifest needs a path}"; shift ;;
    --manifest=*) MANIFEST="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "setup.sh: unknown flag $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[ -f "$MANIFEST" ] || { echo "setup.sh: manifest not found: $MANIFEST" >&2; exit 2; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

tier_selected() {
  case ",$TIERS," in *,"$1",*) return 0 ;; esac
  return 1
}

# Gated repos (Lightricks/LTX-*) ship with sha256 "pending" — resolve them via
# the authenticated paths-info API before the gate sees the manifest. Without
# HF_TOKEN the gate's sha256 refusal names every unresolved file.
if [ -n "${HF_TOKEN:-}" ] && grep -q '"sha256": *"pending"' "$MANIFEST"; then
  python3 "$HERE/fill-hashes.py" "$MANIFEST" || true
fi

# Flatten + gate the manifest in one pass. The gate mirrors
# licenseClassForSpdx() in src/lib/catalog/licenses.ts — every entry must be
# fully specified, the class must equal the licence's class (or be STRICTER
# for a named pack — e.g. trellis2's MIT DiT running restricted beside its
# bundled DINOv3 clip), no repo/name/path may hit a banned-weight pattern,
# sha256 must be 64-hex, bytes > 0, name/target must be safe relative paths
# and every URL must resolve on huggingface.co — unless the entry carries an
# explicit "url" on a narrow allowlist of official vendor hosts (GitHub
# release assets, OpenAI's whisper CDN). Every offender is named on stderr
# and the run exits 3 BEFORE the plan or a single download.
ENTRIES="$(
  python3 - "$MANIFEST" "$WORKFLOWS" "$REPO_ROOT" <<'PY'
import json, re, sys
from pathlib import Path
from urllib.parse import urlparse

try:
    m = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"setup.sh: failed to parse manifest: {e}", file=sys.stderr)
    sys.exit(2)

base = m.get("base_url", "https://huggingface.co/{repo}/resolve/main/{path}")
if urlparse(base.replace("{repo}", "x/y").replace("{path}", "z")).hostname != "huggingface.co":
    print(f"setup.sh: REFUSED — base_url host is not huggingface.co: {base}", file=sys.stderr)
    sys.exit(3)

# same allowlist as licenseClassForSpdx (src/lib/catalog/licenses.ts)
OPEN_IDS = {"mit", "apache-2.0", "bsd-2-clause", "bsd-3-clause", "bsd", "isc",
            "ofl-1.1", "cc0", "cc0-1.0", "unlicense", "zlib", "mpl-2.0"}
def spdx_class(lic):
    s = (lic or "").strip().lower()
    if s == "" or re.search(r"(^|[^a-z])nc([^a-z]|$)|noncommercial|non-commercial|^other$|^unknown$|^unlisted$|^gated$", s):
        return "refused"
    if s in OPEN_IDS:
        return "open"
    if re.search(r"hunyuan|tencent", s):        # before the community rule
        return "refused"
    if (re.search(r"community", s) or re.match(r"open-?rail", s) or re.match(r"llama", s)
            or re.match(r"gemma", s) or re.match(r"dinov3", s) or re.match(r"ltx", s)
            or re.match(r"sam-license$", s)):
        return "restricted"
    if re.match(r"cc-by(-sa)?-\d", s) or re.search(r"permissive-terms", s):
        return "permissive-terms"
    return "refused"

BANNED = re.compile(r"kijai|briaai|rmbg|hunyuan|tencent|nvdiffrast|diso|u2net", re.I)
NAME_OK = re.compile(r"^[A-Za-z0-9._/-]+$")
SHA_OK = re.compile(r"^[0-9a-f]{64}$")
GH_RELEASE = re.compile(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/")
WHISPER_CDN = re.compile(r"^https://openaipublic\.azureedge\.net/main/whisper/models/")
RANK = {"open": 0, "permissive-terms": 1, "restricted": 2}
REQUIRED = ("tier", "name", "repo", "path", "target", "bytes", "sha256",
            "license", "license_url", "class")

bad = 0
def refuse(name, why):
    global bad
    bad += 1
    print(f"setup.sh: REFUSED — {name} — {why}", file=sys.stderr)

# Scope against graph inputs, not _meta prose or speculative used_by labels.
selected_names = None
if sys.argv[2]:
    selected_names = set()
    for name in sys.argv[2].split(","):
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*\.json", name):
            print("setup.sh: unsafe workflow filename", file=sys.stderr)
            sys.exit(2)
        file = Path(sys.argv[3]) / "workflows" / name
        try:
            graph = json.loads(file.read_text())
        except (OSError, ValueError):
            print(f"setup.sh: workflow not found or invalid: {name}", file=sys.stderr)
            sys.exit(2)
        def collect(value):
            if isinstance(value, str):
                selected_names.add(value)
            elif isinstance(value, list):
                for child in value: collect(child)
            elif isinstance(value, dict):
                for child in value.values(): collect(child)
        for node_id, node in graph.items():
            if node_id != "_meta" and isinstance(node, dict):
                collect(node.get("inputs", {}))

rows = []
for i, e in enumerate(m.get("models", [])):
    name = str(e.get("name", f"<entry {i}>"))
    missing = [k for k in REQUIRED if e.get(k) in (None, "")]
    if missing:
        refuse(name, f"missing field(s): {', '.join(missing)}")
        continue
    # banned repo / file names can never ride an open-looking licence in
    if BANNED.search(" ".join([e["repo"], e["name"], e["path"]])):
        refuse(name, "repo/name/path matches a banned weight pattern (kijai, briaai, rmbg, hunyuan, tencent, nvdiffrast, diso, u2net)")
    for field in ("name", "target"):
        v = e[field]
        if not NAME_OK.match(v) or ".." in v or v.startswith("/"):
            refuse(name, f"{field} '{v}' is not a safe relative path")
    sha = str(e["sha256"])
    if sha == "pending":
        # gated upstream — fill-hashes.py + HF_TOKEN resolves it; the download
        # loop skips entries that reach it still pending
        print(f"setup.sh: PENDING sha256 — {name} ({e['repo']}) — run fill-hashes.py with HF_TOKEN", file=sys.stderr)
    elif not SHA_OK.match(sha):
        refuse(name, f"sha256 '{e['sha256']}' is not 64 lowercase hex")
    if not isinstance(e["bytes"], int) or e["bytes"] <= 0:
        refuse(name, f"bytes '{e['bytes']}' is not a positive integer")
    url = str(e.get("url") or "")
    if url:
        # non-HF sources are a narrow allowlist of official vendor hosts:
        # GitHub release assets and the OpenAI whisper CDN — still sha256-verified
        if not (GH_RELEASE.match(url) or WHISPER_CDN.match(url)):
            refuse(name, f"url '{url}' — only github.com release assets and openaipublic.azureedge.net whisper models may bypass huggingface.co")
    else:
        url = base.replace("{repo}", e["repo"]).replace("{path}", e["path"])
        if urlparse(url).hostname != "huggingface.co":
            refuse(name, f"resolved URL host is not huggingface.co: {url}")
    cls = str(e["class"])
    if cls not in RANK:
        refuse(name, f"class '{cls}' — only open|permissive-terms|restricted may ship")
        continue
    want = spdx_class(e["license"])
    if want == "refused":
        refuse(name, f"licence '{e['license']}' is non-commercial/banned/unverifiable")
    elif RANK[cls] < RANK[want]:
        refuse(name, f"class '{cls}' is weaker than licence class '{want}'")
    elif RANK[cls] > RANK[want] and not e.get("pack"):
        refuse(name, f"class '{cls}' is stricter than licence class '{want}' — only a named pack may do that")
    rows.append([e["tier"], e["name"], str(e["bytes"]), e["sha256"], e["license"],
                 cls, e["target"], url, "1" if e.get("optional") else "0"])

if bad:
    sys.exit(3)
for row in rows:
    if selected_names is not None and row[1] not in selected_names:
        continue
    print("\t".join(row))
PY
)" && gate_rc=0 || gate_rc=$?
if [ "$gate_rc" != "0" ]; then
  [ "$gate_rc" = "3" ] && echo "setup.sh: refusing to continue — fix or drop the entries above" >&2
  exit "$gate_rc"
fi

[ -n "$ENTRIES" ] || { echo "setup.sh: manifest has no entries" >&2; exit 2; }

while IFS=$'\t' read -r tier name bytes sha license class target url optional; do
  tier_selected "$tier" || continue
  if [ "$class" = "restricted" ] && [ "$WITH_RESTRICTED" = "0" ]; then
    echo "setup.sh: $name is restricted — needs --with-restricted (opt-in required in Settings -> Licenses)" >&2
  fi
done <<EOF
$ENTRIES
EOF

# Unresolvable sha256 on a selected entry is fatal — never a silent skip.
# fill-hashes.py (above) resolves gated repos via the authenticated HF API;
# an entry still pending here means the token is missing or lacks access to
# that repo (licence not accepted on huggingface.co).
pending_selected=""
while IFS=$'\t' read -r tier name bytes sha license class target url optional; do
  tier_selected "$tier" || continue
  [ "$optional" = "1" ] && [ "$WITH_OPTIONAL" = "0" ] && continue
  [ "$class" = "restricted" ] && [ "$WITH_RESTRICTED" = "0" ] && continue
  [ "$sha" = "pending" ] && pending_selected="$pending_selected$name "
done <<EOF
$ENTRIES
EOF
# ---- plan ----------------------------------------------------------------
echo "plan (tier $TIERS$([ "$WITH_RESTRICTED" = 1 ] && echo " +restricted")$([ "$WITH_OPTIONAL" = 1 ] && echo " +optional")):"
plan_total=0
planned_names=""
while IFS=$'\t' read -r tier name bytes sha license class target url optional; do
  tier_selected "$tier" || continue
  [ "$optional" = "1" ] && [ "$WITH_OPTIONAL" = "0" ] && continue
  [ "$class" = "restricted" ] && [ "$WITH_RESTRICTED" = "0" ] && continue
  printf '  %s  %-52s %12s  %s  %-14s %-10s %s\n' "$tier" "$name" "$bytes" "$sha" "$license" "$class" "$target"
  plan_total=$((plan_total + bytes))
  planned_names="$planned_names/$name/"
done <<EOF
$ENTRIES
EOF
echo "total: $plan_total bytes ($((plan_total / 1024 / 1024 / 1024)) GiB) across the plan"

if [ "$DRY_RUN" = "1" ]; then
  [ -n "$pending_selected" ] && echo "dry-run: PENDING sha256 (gated — resolves via fill-hashes.py with HF_TOKEN): ${pending_selected% }"
  echo "dry-run: no downloads, no installs"
  exit 0
fi

# gated entries the manifest still can't verify fail the real run — silently
# skipping them would ship a pod missing the LTX/SAM weights the batch needs.
if [ -n "$pending_selected" ]; then
  echo "setup.sh: cannot fetch gated weights — sha256 unresolved for:" >&2
  for n in $pending_selected; do echo "  - $n" >&2; done
  if [ -z "${HF_TOKEN:-}" ]; then
    echo "setup.sh: HF_TOKEN is not set. Export a Hugging Face token that has" >&2
    echo "          accepted each gated repo's licence, then re-run." >&2
  else
    echo "setup.sh: HF_TOKEN is set but could not resolve these files — the" >&2
    echo "          account has not accepted the licence (or lacks access) on" >&2
    echo "          huggingface.co for the listed repos. Accept the licences and" >&2
    echo "          re-run, or drop --with-restricted to install without them." >&2
  fi
  exit 3
fi

# ---- tool preflight ----------------------------------------------------------
# named before any clone/download: container images often lack rsync, and uv
# installs to ~/.local/bin which root shells usually keep off PATH — failing
# here beats failing after hours of downloads.
need() {
  case "$1" in */*) [ -x "$1" ] && return 0 ;; *) command -v "$1" >/dev/null 2>&1 && return 0 ;; esac
  echo "setup.sh: missing required tool: $1" >&2
  exit 5
}
need git; need python3; need "$CURL"
if [ "$DOWNLOAD_ONLY" = "0" ]; then
  need rsync; need uv
  # stock pod images ship python3 without the venv/ensurepip addon — the venv
  # at $VENV would fail hours in, after the downloads. Check it now.
  python3 -c "import venv, ensurepip" >/dev/null 2>&1 \
    || { echo "setup.sh: python3-venv is missing (apt-get install -y python3-venv) — the venv would fail" >&2; exit 5; }
fi

# watchdog pause: while the lock file holds a live pid the pod is mid-setup —
# ComfyUI isn't up yet, so "queue unreachable" must not count toward a stop
# decision. A SIGKILLed setup leaves a stale lock the watchdog ignores.
echo $$ > "$SETUP_LOCK"
trap 'rm -f "$SETUP_LOCK"' EXIT

# ---- ComfyUI checkout --------------------------------------------------------
# BEFORE the download loop: the weights land under $COMFY_HOME/models, and
# `git clone` refuses a non-empty target — so the checkout must exist first.
# A dir already holding weights but no .git (e.g. an older --download-only
# pre-fill) is adopted in place: init + fetch + checkout -f FETCH_HEAD keeps
# untracked files like models/ untouched.
checkout() { # repo-dir ref — git only fetches full object ids
  local dir="$1" ref="$2"
  git -C "$dir" cat-file -e "$ref^{commit}" 2>/dev/null || git -C "$dir" fetch origin "$ref"
  git -C "$dir" checkout -q "$ref"
}
if [ -d "$COMFY_HOME/.git" ]; then
  checkout "$COMFY_HOME" "$COMFYUI_REF"
elif [ -d "$COMFY_HOME" ] && [ -n "$(ls -A "$COMFY_HOME" 2>/dev/null)" ]; then
  git -C "$COMFY_HOME" init -q
  git -C "$COMFY_HOME" remote add origin "$COMFYUI_REPO" 2>/dev/null || true
  git -C "$COMFY_HOME" fetch -q "$COMFYUI_REPO" "$COMFYUI_REF"
  git -C "$COMFY_HOME" checkout -q -f FETCH_HEAD
else
  git clone "$COMFYUI_REPO" "$COMFY_HOME"
  checkout "$COMFY_HOME" "$COMFYUI_REF"
fi
echo "ComfyUI @ $COMFYUI_REF checked out at $COMFY_HOME"

# ---- downloads -------------------------------------------------------------
size_of() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1"; }

fetch() { # url dest sha256 bytes
  local url="$1" dest="$2" want="$3" want_bytes="${4:-0}"
  mkdir -p "$(dirname "$dest")"
  # size + .ok marker: a re-run skips the re-hash on files already verified
  if [ -f "$dest.ok" ] && [ -f "$dest" ] && [ "$(size_of "$dest")" = "$want_bytes" ]; then
    echo "ok (cached)  $dest"
    return 0
  fi
  # correct size but no marker (e.g. weights landed before this script ran):
  # verify the bytes once — good files get the marker and stay, bad ones
  # (truncated stubs, html error pages) are re-downloaded
  if [ -f "$dest" ] && [ "$(size_of "$dest")" = "$want_bytes" ]; then
    if [ "$(sha256_of "$dest")" = "$want" ]; then
      : > "$dest.ok"
      echo "ok (verified) $dest"
      return 0
    fi
    echo "setup.sh: $dest matches on size but not sha256 — re-downloading" >&2
  fi
  rm -f "$dest.ok"
  if [ -n "${HF_TOKEN:-}" ]; then
    # token travels on stdin (curl -K -), never on argv / in a process listing
    printf 'header = "Authorization: Bearer %s"\n' "$HF_TOKEN" | "$CURL" -fL -C - -K - -o "$dest" "$url"
  else
    "$CURL" -fL -C - -o "$dest" "$url"
  fi
  got="$(sha256_of "$dest")"
  if [ "$got" != "$want" ]; then
    mv -f "$dest" "$dest.bad"
    echo "setup.sh: sha256 mismatch for $dest (got $got, want $want — moved to $dest.bad)" >&2
    exit 4
  fi
  : > "$dest.ok"
  echo "ok           $dest"
}

# broken-weight sweeper: stub files (git-lfs pointers, html error pages saved
# over a model name, truncated downloads) get parked as .stub so no loader
# can pick them up — e.g. the known 512-byte flux-2-klein-4b-bf16.safetensors
# on the pod. Scope: <4 KiB weight files whose basename the manifest plans
# to install. Names the manifest doesn't know are left alone — pre-seeded
# or user weights under models/ survive untouched.
stubbed=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$planned_names" in
    */"$(basename "$f")"/*) mv "$f" "$f.stub" && stubbed="$stubbed$f " || true ;;
  esac
done <<EOF
$(find "$MODELS_DIR" -type f \( -name "*.safetensors" -o -name "*.pt" -o -name "*.pth" -o -name "*.onnx" -o -name "*.bin" \) -size -4096c 2>/dev/null)
EOF
[ -n "$stubbed" ] && echo "setup.sh: parked stub weight files: ${stubbed% }" >&2

while IFS=$'\t' read -r tier name bytes sha license class target url optional; do
  tier_selected "$tier" || continue
  [ "$optional" = "1" ] && [ "$WITH_OPTIONAL" = "0" ] && continue
  [ "$class" = "restricted" ] && [ "$WITH_RESTRICTED" = "0" ] && continue
  [ "$class" = "restricted" ] && echo "note: $name — opt-in required in Settings -> Licenses"
  fetch "$url" "$MODELS_DIR/$target/$name" "$sha" "$bytes"
done <<EOF
$ENTRIES
EOF

[ "$DOWNLOAD_ONLY" = "1" ] && { echo "download-only: ComfyUI checked out + weights fetched — skipping the rest of the software install"; exit 0; }

# ---- software pins -----------------------------------------------------------
echo "installing pinned stack (VHS ${VHS_REF}, FlashVSR ${FLASHVSR_REF}, LongCat ${LONGCAT_REF}, proxy 0.1.6)"
mkdir -p "$COMFY_HOME/custom_nodes"
if [ ! -d "$COMFY_HOME/custom_nodes/ComfyUI-VideoHelperSuite/.git" ]; then
  git clone "$VHS_REPO" \
    "$COMFY_HOME/custom_nodes/ComfyUI-VideoHelperSuite"
fi
# checkout() aborts once the streamless-audio patch dirties utils.py.
# This pack's only local change is that patch, so reset to the pin and
# re-apply. A clip with no audio stream otherwise kills VHS_LoadVideo
# (LazyAudioMap raises inside ComfyUI's ram_release walk).
VHS_DIR="$COMFY_HOME/custom_nodes/ComfyUI-VideoHelperSuite"
git -C "$VHS_DIR" cat-file -e "$VHS_REF^{commit}" 2>/dev/null || git -C "$VHS_DIR" fetch origin "$VHS_REF"
git -C "$VHS_DIR" checkout -q -f "$VHS_REF"
VHS_AUDIO_PATCH="$REPO_ROOT/scripts/patches/vhs-streamless-audio.patch"
if git -C "$VHS_DIR" apply --check "$VHS_AUDIO_PATCH"; then
  git -C "$VHS_DIR" apply "$VHS_AUDIO_PATCH"
  echo "vhs streamless-audio patch applied"
else
  echo "setup.sh: vhs streamless-audio patch does not apply cleanly on $VHS_REF" >&2
  exit 1
fi
# our node pack — rsynced from this checkout, never fetched from a remote
rsync -a --delete "$REPO_ROOT/comfy-nodes/motionfield_nodes/" "$COMFY_HOME/custom_nodes/motionfield_nodes/"
case "$planned_names" in *"/flashvsr_streaming_dmd.safetensors/"*)
if [ ! -d "$COMFY_HOME/custom_nodes/ComfyUI-FlashVSR/.git" ]; then
  git clone "$FLASHVSR_REPO" \
    "$COMFY_HOME/custom_nodes/ComfyUI-FlashVSR"
fi
checkout "$COMFY_HOME/custom_nodes/ComfyUI-FlashVSR" "$FLASHVSR_REF"
;; esac
case "$planned_names" in *"/longcat_avatar_15_int8_00001.safetensors/"*)
if [ ! -d "$COMFY_HOME/custom_nodes/ComfyUI-LongCat-Avatar/.git" ]; then
  git clone "$LONGCAT_REPO" \
    "$COMFY_HOME/custom_nodes/ComfyUI-LongCat-Avatar"
fi
checkout "$COMFY_HOME/custom_nodes/ComfyUI-LongCat-Avatar" "$LONGCAT_REF"
;; esac
case "$planned_names" in *"/ltx-"*)
if [ ! -d "$COMFY_HOME/custom_nodes/ComfyUI-LTXVideo/.git" ]; then
  git clone "$LTXVIDEO_REPO" \
    "$COMFY_HOME/custom_nodes/ComfyUI-LTXVideo"
fi
checkout "$COMFY_HOME/custom_nodes/ComfyUI-LTXVideo" "$LTXVIDEO_REF"
;; esac
case "$planned_names" in *"/kokoro_v1.onnx/"*)
if [ ! -d "$COMFY_HOME/custom_nodes/comfyui-kokoro/.git" ]; then
  git clone "$KOKORO_REPO" \
    "$COMFY_HOME/custom_nodes/comfyui-kokoro"
fi
checkout "$COMFY_HOME/custom_nodes/comfyui-kokoro" "$KOKORO_REF"
# the node loads the model from its own dir — link the verified manifest copy
for f in kokoro_v1.onnx; do
  [ -f "$COMFY_HOME/custom_nodes/comfyui-kokoro/$f" ] || \
    ln "$MODELS_DIR/motionfield/kokoro/$f" "$COMFY_HOME/custom_nodes/comfyui-kokoro/$f" 2>/dev/null || \
    cp "$MODELS_DIR/motionfield/kokoro/$f" "$COMFY_HOME/custom_nodes/comfyui-kokoro/$f"
done
;; esac
case "$planned_names" in *"/ggml-base.en.bin/"*|*"/ggml-large-v3-turbo.bin/"*)
# ASR runs ON THE POD — captions + output checks reach whisper-cli through
# scripts/runpod/whisper-remote.sh, which maps model names onto
# ~/.motionfield/models/whisper here. Hard-link the verified manifest copies
# there (pod-local; nothing crosses back to the Mac).
mkdir -p "$HOME/.motionfield/models/whisper"
for f in ggml-base.en.bin ggml-large-v3-turbo.bin; do
  [ -f "$MODELS_DIR/whisper/$f" ] || continue
  [ -f "$HOME/.motionfield/models/whisper/$f" ] || \
    ln "$MODELS_DIR/whisper/$f" "$HOME/.motionfield/models/whisper/$f" 2>/dev/null || \
    cp "$MODELS_DIR/whisper/$f" "$HOME/.motionfield/models/whisper/$f"
done
# build the pinned whisper.cpp — CUDA when the toolchain is on the image,
# CPU otherwise (~5–8 min; Order 0 budgets for it). whisper-cli lands on PATH.
if ! command -v whisper-cli >/dev/null 2>&1; then
  command -v cmake >/dev/null 2>&1 && command -v g++ >/dev/null 2>&1 || {
    apt-get update -qq && apt-get install -y --no-install-recommends cmake build-essential; }
  WHISPER_SRC=/tmp/whisper.cpp
  [ -d "$WHISPER_SRC/.git" ] || git clone "$WHISPER_CPP_REPO" "$WHISPER_SRC"
  checkout "$WHISPER_SRC" "$WHISPER_CPP_REF"
  CMAKE_ARGS=(-B "$WHISPER_SRC/build" -S "$WHISPER_SRC" -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON)
  if command -v nvcc >/dev/null 2>&1; then CMAKE_ARGS+=(-DGGML_CUDA=ON); fi
  cmake "${CMAKE_ARGS[@]}"
  cmake --build "$WHISPER_SRC/build" --config Release -j "$(nproc)" --target whisper-cli
  install -m 0755 "$WHISPER_SRC/build/bin/whisper-cli" /usr/local/bin/whisper-cli
  echo "whisper-cli ${WHISPER_CPP_REF} installed to /usr/local/bin/whisper-cli"
fi
;; esac
case "$planned_names" in *"/t3_cfg.safetensors/"*)
if [ ! -d "$COMFY_HOME/custom_nodes/ComfyUI-Chatterbox/.git" ]; then
  git clone "$CHATTERBOX_REPO" \
    "$COMFY_HOME/custom_nodes/ComfyUI-Chatterbox"
fi
checkout "$COMFY_HOME/custom_nodes/ComfyUI-Chatterbox" "$CHATTERBOX_REF"
;; esac
case "$planned_names" in *"/musetalk.json/"*)
if [ ! -d "$COMFY_HOME/custom_nodes/ComfyUI-MuseTalk/.git" ]; then
  git clone "$MUSETALK_REPO" \
    "$COMFY_HOME/custom_nodes/ComfyUI-MuseTalk"
fi
checkout "$COMFY_HOME/custom_nodes/ComfyUI-MuseTalk" "$MUSETALK_REF"
# the MotionField patch is portable (cuda>mps>cpu device pick, lazy load, AUDIO
# input, required mouth_masks input, vendored ONNX dwpose) — unpatched, the
# pack needs mmpose/s3fd/face-parsing weights we do not ship
if git -C "$COMFY_HOME/custom_nodes/ComfyUI-MuseTalk" apply --check --reverse "$MUSETALK_PATCH" 2>/dev/null; then
  echo "musetalk patch already applied"
elif git -C "$COMFY_HOME/custom_nodes/ComfyUI-MuseTalk" apply --check "$MUSETALK_PATCH" 2>/dev/null; then
  git -C "$COMFY_HOME/custom_nodes/ComfyUI-MuseTalk" apply "$MUSETALK_PATCH"
  echo "musetalk patch applied"
else
  echo "setup.sh: musetalk patch does not apply cleanly — is the pack dirty?" >&2
  exit 1
fi
rm -rf "$COMFY_HOME/custom_nodes/ComfyUI-MuseTalk/musetalk/utils/face_parsing"
# the patched pipeline reads the DWPose ONNX pair from the pack's dwpose dir —
# link the verified motionfield/dwpose staging copies (same as setup-musetalk.sh)
MUSE_DWPOSE="$MODELS_DIR/diffusers/TMElyralab/MuseTalk/dwpose"
mkdir -p "$MUSE_DWPOSE"
for f in yolox_l.onnx dw-ll_ucoco_384.onnx; do
  [ -f "$MODELS_DIR/motionfield/dwpose/$f" ] || continue
  [ -f "$MUSE_DWPOSE/$f" ] || \
    ln "$MODELS_DIR/motionfield/dwpose/$f" "$MUSE_DWPOSE/$f" 2>/dev/null || \
    cp "$MODELS_DIR/motionfield/dwpose/$f" "$MUSE_DWPOSE/$f"
done
;; esac

# the venv start.sh execs — system-site-packages keeps the pod image's torch
VENV="${VENV:-$COMFY_HOME/.venv}"
python3 -m venv --system-site-packages "$VENV"
"$VENV/bin/pip" install -r "$COMFY_HOME/requirements.txt"
# motionfield_nodes needs onnxruntime on every install (nodes_pose/nodes_mask run
# the DWPose ONNX pair) — GPU build on the pod; its CPUExecutionProvider still
# covers the vendored CPU paths. Install once here, never alongside the plain
# onnxruntime wheel (same import package — they clobber each other).
"$VENV/bin/pip" install onnxruntime-gpu
for req in "$COMFY_HOME"/custom_nodes/*/requirements.txt; do
  [ -f "$req" ] || continue
  case "$req" in
    # the patched pack never imports mmpose/tensorflow — install the curated
    # dep set below instead (same list setup-musetalk.sh uses)
    */ComfyUI-MuseTalk/*) continue ;;
  esac
  "$VENV/bin/pip" install -r "$req"
done
case "$planned_names" in *"/musetalk.json/"*)
  # onnxruntime comes from the onnxruntime-gpu install above — same dep set as
  # setup-musetalk.sh minus it
  "$VENV/bin/pip" install diffusers omegaconf ffmpeg-python pydub soundfile \
    imageio-ffmpeg regex scipy huggingface_hub opencv-python
;; esac
case "$planned_names" in *"/kokoro_v1.onnx/"*)
  # voices_v1.bin has no canonical URL — the pack generates it by np.savez'ing
  # the per-voice .pt files from hexgrad/Kokoro-82M (deterministic content, but
  # zip timestamps make the bytes unpinnable, so it can't ride the manifest)
  if [ ! -f "$COMFY_HOME/custom_nodes/comfyui-kokoro/voices_v1.bin" ]; then
    "$VENV/bin/python" - "$COMFY_HOME/custom_nodes/comfyui-kokoro" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from ComfyUIKokoro import download_voices
download_voices(sys.argv[1])
PY
  fi
;; esac
uv tool install comfy-api-proxy==0.1.6
# comfy-api-proxy 0.1.6 drops ComfyUI's "3d" outputs (SaveGLB / TRELLIS.2 /
# MoGe), so only the preview PNG reached the app. Map them to files - idempotent.
PROXY_APP=$(ls "$HOME"/.local/share/uv/tools/comfy-api-proxy/lib/python*/site-packages/comfy_api_proxy/app.py 2>/dev/null | head -1)
if [ -n "$PROXY_APP" ] && ! grep -q '"3d": "file"' "$PROXY_APP"; then
  sed -i 's/^    "latents": "latent",$/&\n    "3d": "file",  # ComfyUI SaveGLB \/ 3D nodes (motionfield patch)/' "$PROXY_APP"
  grep -q '"3d": "file"' "$PROXY_APP" || echo "setup.sh: WARNING could not patch comfy-api-proxy for 3D outputs" >&2
fi
echo "setup.sh: done — start with scripts/runpod/start.sh (binds 127.0.0.1 only)"
