# motionfield CLI

A zero-dependency command-line client for the MotionField v1 API. Every command
calls the real API through the TypeScript SDK - the CLI invents nothing, and
every write is tagged `X-MotionField-Source: cli` so jobs/uploads carry that
provenance.

## Install

```bash
./scripts/install-cli.sh          # npm link into your global prefix
PREFIX=/tmp/of ./scripts/install-cli.sh   # into $PREFIX/bin (test installs)

motionfield --version               # → motionfield 0.1.0
motionfield --help                  # command index
motionfield help <command>          # per-command usage
```

The installer also links **`motionfield-mcp`** and **`motionfield-mcp-http`** -
the MCP servers for agent clients (see [MCP.md](./MCP.md)).

Requires Node ≥22.18 (type stripping on by default - Node 22.6-22.17 would
need `--experimental-strip-types`, which the launcher does not pass). The
launcher is `bin/motionfield.mjs` → `src/main.mts`, so no build step is ever
needed. Install is from this repo only - nothing is published to a package
registry and there is no Homebrew tap.

## Configuration

```bash
motionfield login --key of_…                              # http://localhost:3000
motionfield login --url http://localhost:3110 --key of_…  # another server
```

The key is verified against `GET /api/v1/me` first - a rejected key writes
nothing. `--url` falls back to `MOTIONFIELD_URL`, then `http://localhost:3000`.
`login` refuses to send a key over plaintext `http://` to a non-loopback host
unless you pass `--insecure`.

A successful login writes `<config-dir>/config.json` with mode `0600` (dir
`0700`). The config dir is `MOTIONFIELD_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/motionfield`, else `~/.config/motionfield`. `MOTIONFIELD_URL` /
`MOTIONFIELD_API_KEY` always override the file - and `MOTIONFIELD_API_KEY` alone
is enough, since the URL defaults to `http://localhost:3000`. Guard rails: a
hand-edited config that isn't `{url,key}` strings exits `2` rather than being
trusted, and pointing `MOTIONFIELD_URL` at a different server than the stored
login without also setting `MOTIONFIELD_API_KEY` exits `2` - the stored key is
never sent to a host it wasn't issued for.

```bash
motionfield whoami          # user, plan, credits, key label (never the key)
motionfield logout          # removes the stored config
```

## Commands

| Command                                    | What it calls                          |
| ------------------------------------------ | -------------------------------------- |
| `models [--kind K]`                        | `GET /api/v1/models`                   |
| `models get <endpoint>`                    | `GET /api/v1/models` (one entry)       |
| `estimate <endpoint> [-p k=v]…`            | `POST /api/v1/estimate`                |
| `generate <endpoint> [flags]`              | `POST /api/v1/jobs` (+ uploads)        |
| `status [<id>]`                            | `GET /api/v1/system` or `…/jobs/{id}`  |
| `wait <id>`                                | `GET /api/v1/jobs/{id}` (polled)       |
| `cancel <id>`                              | `POST /api/v1/jobs/{id}/cancel`        |
| `list [--status S] [--kind K] [--source S] [--limit N] [--before]` | `GET /api/v1/jobs` |
| `download <id> [-i N] -o <file\|dir>`      | `GET /api/v1/jobs/{id}/result` - N is 0-based |
| `upload <file>`                            | `POST /api/v1/uploads`                 |
| `skills list` / `skills get <slug>`        | `GET /api/v1/skills[/{slug}]`          |
| `skills import <folder>`                   | gated on the `skills.import` capability |
| `runs create <…>`                          | `POST /api/v1/runs`                    |
| `runs get <id>`                            | `GET /api/v1/runs/{id}`                |
| `runs approve <id>`                        | `POST /api/v1/runs/{id}/approve`       |
| `runs control <id> <action>`               | `POST /api/v1/runs/{id}/control`       |
| `runs edit <id> <step> --rev N`            | `PATCH /api/v1/runs/{id}/steps/{step}` |
| `stage list`                               | `GET /api/stage`                       |
| `stage create (--empty\|--prompt <text>)`  | `POST /api/stage`                      |
| `stage get <id>`                           | `GET /api/stage/{id}`                  |
| `stage inspect <id> [--t <view>] [--rev N]`| `GET /api/stage/{id}/inspect`          |
| `stage apply <id> --base-revision <rev> --ops <ops.json\|->` | `POST /api/stage/{id}/ops` (+ `Idempotency-Key`) |
| `stage revisions <id>`                     | `GET /api/stage/{id}/revisions`        |
| `stage restore <id> <rev> --base-revision <rev>` | `POST /api/stage/{id}/revisions/{rev}/restore` |
| `ads` / `sites`                            | gated on their capabilities            |

### One example per command

```bash
motionfield login --key of_…
motionfield logout
motionfield whoami
motionfield models --kind image
motionfield models get motionfield/z-image-turbo/text-to-image
motionfield estimate motionfield/z-image-turbo/text-to-image -p prompt=cat
motionfield generate motionfield/z-image-turbo/text-to-image -p prompt=cat --wait --json
motionfield status                     # system view: queue, gpu, tier, disk
motionfield status <job id>            # one job
motionfield wait <job id> -o ./out
motionfield cancel <job id>
motionfield list --status completed --limit 10
motionfield list --kind image --source mcp   # only MCP-submitted image jobs
motionfield download <job id> -o ./out/      # all outputs; -i N picks one (0-based)
motionfield upload ./refs/shot.png
motionfield skills list
motionfield skills get narrated-explainer --file SKILL.md
motionfield skills import ./my-skill           # needs the skills.import capability
motionfield runs create --text "a 5s clip of rain on a window" --wait
motionfield runs get <run id> --json
motionfield runs approve <run id>
motionfield runs control <run id> pause        # also: resume, stop (alias: cancel)
motionfield runs edit <run id> s1 --rev 0 -p prompt="dunes at dusk"
motionfield stage list
motionfield stage create --empty                     # the default camera+ground scene, no LLM
motionfield stage create --prompt "a plaza at night" # the LLM scene writer (needs one configured)
motionfield stage get <scene id>
motionfield stage inspect <scene id> --t tree        # meta · tree · shots · physics · problems
motionfield stage apply <scene id> --base-revision 1 --ops ops.json   # --ops - reads stdin
motionfield stage apply <scene id> --base-revision 1 --ops ops.json --idempotency-key batch-1
motionfield stage revisions <scene id>
motionfield stage restore <scene id> 1 --base-revision 2
motionfield ads                                # capability-gated
motionfield sites                              # capability-gated
```

### stage

`motionfield stage` drives the `/api/stage` 3D-scene surface - gated on the
`stage` capability, exits `2` until the server reports it. `create --empty`
mints the default camera+ground scene with no LLM in the loop;
`create --prompt` goes through the scene writer. `apply` runs a JSON array
of typed ops from a file or stdin (`--ops -`) under optimistic concurrency -
`--base-revision` is the rev you last saw, and a stale one is the API's
`stale_revision` error with `head_rev` for refetch-and-retry. `--idempotency-key`
dedupes byte-identical retries server-side (a reused key with a different
body is `idempotency_mismatch`). `restore` copies a stored revision onto a
new head - history is append-only. Scenes are owned: a foreign or missing
id is `not_found`.

### runs

```bash
motionfield runs create --plan ./plan.json     # or --plan - to read the plan from stdin
motionfield runs create --text "…" --planner builtin   # or "<provider>:<model>"
motionfield runs create --skill narrated-explainer --brief "how rain forms" -a voice=warm
```

- `runs create` takes exactly one of `--plan <file|->`, `--text <brief>` or
  `--skill <slug>` (which needs `--brief`; `-a key=value` fills the skill's
  intake answers). `--input <path|/files/url>` supplies media the skill or
  planner fills in (local paths upload first; repeatable). `--mode
  auto|offline`, `--ask-first`, `--project <uuid>` and `--idempotency-key`
  ride along; `--wait` polls `runs get` to a terminal status - `done` exits
  `0`, `failed`/`stopped` exit `1`.
- `runs get` prints the run - steps show as `id:status`; with `--json` the
  full view (estimate, planner, per-step rev/outputs/error).
- `runs approve` releases an `awaiting_approval` run; idempotent.
- `runs control <id> pause|resume|stop` - `cancel` is accepted as an alias
  for `stop`.
- `runs edit <id> <step> --rev N` needs the step's current `rev` (see
  `runs get`); `--title` renames, `-p name=value` / `--params <json|@file>`
  merge params. A stale rev is the API's `409 stale_revision` (exit `1`).

### generate

```bash
motionfield generate motionfield/z-image-turbo/text-to-image \
  -p prompt="a neon lighthouse" -p batch_size=2 -p seed=42 \
  -f image=./refs/shot.png \
  --webhook https://me.example/hook \
  --idempotency-key my-key-123 \
  --wait --timeout 600 --interval 3 -o ./out --json
```

- `-p name=value` - repeatable; the value is coerced (`4`, `true`, `[1,2]`
  parse as JSON; anything else stays a string).
- `-f name=./path` - uploads the file first, then substitutes the returned
  URL into the named param.
- `--wait` polls until a terminal status. Completed → `0` (and every output
  written under `-o <dir>` as `<id>-<i>.<ext>`); `failed`/`nsfw`/`canceled`
  or a `--timeout` expiry → exit `1`.
- Without `--wait`, the `202`/`200` creation envelope is returned and the
  command exits `0`.

### Batch with jq

```bash
for p in "sunset" "dawn" "storm"; do
  motionfield generate motionfield/z-image-turbo/text-to-image \
    -p prompt="lighthouse, $p" -p batch_size=1 --json |
    jq -r .id
done > ids.txt

# poll them all
while read -r id; do motionfield status "$id" --json | jq -r '.status'; done < ids.txt

# download every completed job's first output
motionfield list --status completed --limit 100 --json |
  jq -r '.jobs[].id' |
  while read -r id; do motionfield download "$id" -i 0 -o ./out/; done
```

## Output and exit codes

- `--json` prints **only** the JSON object on stdout; all progress and
  chatter go to stderr so `| jq` always works.
- API errors print `error: <code>: <message>` to stderr, or the
  `{error: {…}}` envelope to stdout with `--json` - exit `1` either way.
- Usage problems and capability-gated groups exit `2`.
- The API key is never printed by any command.
