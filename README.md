# dsh-negative-ledger

A negative-knowledge ledger for coding agents. It records only **disproven paths** — failed commands, missing files, rejected approaches, unavailable APIs — together with the evidence behind each conclusion and the conditions under which a retry becomes legitimate. When the evidence changes, the conclusion is invalidated automatically.

[中文](README.zh.md)

## What it is not

- **Not memory**: no positive knowledge, no semantic recall.
- **Not a cache**: it stores conclusions, not tool results.
- **Not a bug regression tracker**: it covers any tool call and file read, not just fix attempts.

## The core loop

1. A tool call fails (non-zero exit, `FS_NOT_FOUND`, …) → a **negative fact** is recorded with outcome witnesses (exit code, error code) and precondition witnesses (file state from DSH's `fs/observed`).
2. The next identical attempt matches the fact's **fingerprint** (normalized command + cwd, or file path).
3. While every precondition witness is unchanged, the attempt is **warned** (`warn` mode) or **denied** (`block` mode).
4. Any precondition change marks the fact **stale** — the reminder is withdrawn and the retry is allowed. A successful retry marks it **resolved**.

The differentiation: a DSH-native, evidence-bound persistent negative-memory gate — failure conclusions activate and revoke themselves with the environmental evidence, and stay transactionally consistent across concurrent agents.

## Quick start — one-command install

```sh
dsh plugin --profile <name> add @akslcw/dsh-negative-ledger
```

Installs the package and activates its bundle layer: the shipped `cordis.patch.yml` (declared by the `dsh.bundle` manifest) mounts the ledger policy with production defaults — sqlite backend, `warn` mode, `.ledger` directory, default TTLs. Verify without booting, then boot:

```sh
dsh --profile <name> --dump-config   # the "@akslcw/dsh-negative-ledger" layer and its negative-ledger row
dsh --profile <name>                 # boot
```

Remove: `dsh plugin --profile <name> remove @akslcw/dsh-negative-ledger`. A clean-environment end-to-end smoke (add → layer → headless warn + sqlite ledger → remove → profile still boots) is `powershell -File smoke/plugin-add-smoke.ps1`.

> **pnpm 11 note**: pnpm ≥11 turns "ignored build scripts" into a hard error and fails the `add` with `ERR_PNPM_IGNORED_BUILDS: better-sqlite3`. better-sqlite3 ships official prebuilds, so the ignored script is harmless — no compilation happens. In the profile directory run `pnpm config set --location project strict-dep-builds false`, then re-run the `add`. (Allowing the build instead would compile better-sqlite3 from source and require a C++ toolchain.)

In-checkout hacking (engine and CLI only, no DSH composition):

```sh
node src/cli.ts --dir .ledger stats
node demos/run-demos.ts      # S1 command dedup, S2 missing-file dedup, S3 evidence-change invalidation
node smoke/real-mount.ts     # real-mount smoke inside a deepseek-harness checkout
```

Requires Node `^22.19.0 || >=24.0.0` (aligned with the official DSH engines range).

## CLI

```
node src/cli.ts [--dir <path>] [--backend sqlite|jsonl] <list | show <id> | stale | stats>
```

The backend flag wins; otherwise the directory is auto-detected (`ledger.db` → sqlite, `ledger.jsonl` → jsonl); with neither present the primary sqlite backend is used.

| Command | Output |
|---|---|
| `list` | Every fact: status, kind, id, claim |
| `show <id>` | One fact as pretty JSON |
| `stale` | Facts invalidated by evidence change |
| `stats` | Honest interception counters (duplicate failures observed, warnings emitted, calls denied) |

## Engine API

Two store backends sit behind one `LedgerStore` seam: the default transactional SQLite store (`SqliteLedgerStore`: WAL, revision-based optimistic concurrency, operation receipts, retry leases, JSONL import) and the legacy single-process JSONL store (`JsonlLedgerStore`).

- `getFact(scope, kind, fingerprint)` / `queryFacts(filter)` — current facts with revision and active-lease summaries.
- `commitAttemptDecision(request)` — the only decision entry: `deny` / `observe-warn` / `verify-retry` (allow and stale-allow both compete for a lease); revision conflicts re-read and re-decide.
- `recordFact(input, meta)` — records a disproven path; repeats append versions on the same id; idempotent by operation receipt and `(fact, toolCallId, operation_kind)`.
- `transitionFacts(batch, meta)` — batched, all-or-nothing state transitions (one FS observation can invalidate many facts).
- `settleLease(settlement)` — the lease holder's retry outcome: succeeded → resolved, failed → new evidence version, released → fact untouched.
- `summarize(scope?)` — three honest counters: `duplicateFailuresObserved`, `warningsEmitted`, `callsDenied`. No token estimates — trajectory replay/A-B diffing owns that number.

## DSH integration

Compatibility: tested with `@deepseek-ai/dsh-tools` `0.1.1-rc.2`. The package declares `>=0.1.1-rc.2 <0.2.0` as an optional peer range, so it documents the supported DSH event surface without installing a second DSH runtime.

The bundle layer shipped in the package is exactly:

```yaml
- id: negative-ledger
  name: '@akslcw/dsh-negative-ledger'
```

Override the row by `id` in a later layer (your profile's `cordis.patch.yml`) — a patch replaces the whole `config`, so restate every key you change:

```yaml
- id: negative-ledger
  name: '@akslcw/dsh-negative-ledger'
  config:
    backend: sqlite       # sqlite (default, transactional) | jsonl (legacy single-process)
    mode: block           # off | warn | block (default warn)
    dir: .ledger          # ledger directory (default .ledger)
    commandRetryAfterMs: 300000   # TTL on auto-recorded command facts
    commandTools: [bash, pwsh]   # recorded as command_failed
    readTools: [read]            # recorded as file_missing
```

- The store connection and the background invalidation queue are owned by the plugin fiber: disposal drains the queue and closes the store (HMR-safe).

- `warn` (default): attaches `additionalContexts` on `tools/post-execute`; never blocks, never rewrites tool results.
- `block`: denies at `tools/pre-execute` before dispatch. Denied calls still flow through post-execute and are recognized by the plugin's own denial prefix, so one attempt is never double-counted.
- Auto-recorded command facts carry a short `after` TTL (`commandRetryAfterMs`, default 5 minutes): `block` mode releases them automatically instead of locking a command forever on transient failures. `never`/`manual` are reserved for facts an explicit, trusted author recorded.
- `off`: disables recording and interception entirely.
- `fs/observed` events (`present` with version, or `absent`) map one-to-one onto `file-state` precondition witnesses; the emitting execution is correlated so a model-supplied path (scoped by the session cwd) and the backend's resolved `displayPath` witness the same fact; every observation change drives invalidation, so file hashing is never needed.
- Successful tool results resolve the fact through settlement or a lease-free transition — the reminder is withdrawn after a working retry.
- The ledger is shared across agents (subagents do not repeat the parent's failures); counters are transactional columns (sqlite) or append-only hit lines (jsonl).

Security posture:

- Claims never embed raw command text; model-facing previews are control-character-sanitized and length-capped. Raw commands stay in the ledger FILE (they are the fingerprint) — the file is written 0600 inside a 0700 directory.
- The ledger renders facts as quoted data, never as instructions.
- Single-writer JSONL applies to the legacy backend only; the sqlite backend is multi-process (WAL).

Boundary with `repeat-tool-reminder`: that guard nudges on byte-identical consecutive repeats within one session; the ledger is persistent, evidence-bound, and auto-invalidating across sessions.

## Known limitations and deferred work

- **Single-writer JSONL (legacy)**: `backend: jsonl` keeps the v0 single-process store for migrations and debugging; concurrent multi-process writers are unsupported there. The default `backend: sqlite` is the transactional WAL store with unique indexes, idempotent operation receipts, and crash recovery.
- Command fingerprints use the calling agent's session cwd; a sandbox-policy workspace-root override is not visible to the plugin. Raw command text is preserved (no whitespace collapsing) so semantically different shell programs never collide, but equivalent re-spellings do.
- A non-zero exit does not always disprove a path (e.g. `grep` exits 1 for "no match"); the short TTL and the warn-default posture bound the damage, but per-tool recording policy is deferred.
- v0 matches exact fingerprints only; no semantic similarity.
- `approach_rejected` and `api_unavailable` kinds exist in the model but are not wired to tools yet.
- Token savings are deliberately not estimated here; the trajectory lab (#4) owns A/B and replay diffs.
- Future seams: failed_attempts in subagent contract results (#1), active/stale projection into task checkpoints (#3), repeat-failure rates in trajectory regression (#4), fail-closed promotion of high-risk paths (#2).
