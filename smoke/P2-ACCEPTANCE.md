# P2 candidate acceptance — 2026-09-11

Scope: local verification of the uncommitted P0/P1/P2 candidate. This is not a
release announcement, an online model experiment, or a new formal benchmark.

## Passed: installed artifact and public plugin wiring

`npm run build` followed by `npm run pack-test` passed on Linux / Node 26.8.1.
The pack test installs the tarball into a temporary consumer, then imports its
public ESM entry. It retains the store, CLI binary, and bundle-manifest probes.
The new `packed-consumer-p2.mjs` driver additionally mounts the exported `apply`
on a minimal context and calls the actual registered plugin listeners.

The driver executes real local Node processes and verifies:

1. A command with an observed, declared dependency fails and records v1.
2. The same command is denied before another process is run.
3. Writing the dependency and delivering v2 allows retry before the 10-minute
   TTL; the real process succeeds and the fact resolves.
4. An unmatched command records no dependency evidence and retains its TTL
   restriction even when the configured file changes.
5. Final counters show two hit facts, three dispatch denials, no duplicate
   executions, and no warnings. The plugin disposal effect releases SQLite.

No external model is invoked. The context and `fs/observed` events are supplied
by the driver: the check proves artifact and listener wiring, not the behavior
of the complete DSH host. CI already runs `pack-test` on its platform matrix;
those remote jobs have not been run by this local verification.

## Passed: regression collection and tests

The benchmark collector now prefers the ledger message's structured summary
(`repeat` / `evidence changed` with a known fact kind). Text matching is retained
only for legacy messages without a summary. In-progress notices and messages
from another plugin do not count as repeat warnings. This fixes a P1 wording
regression that would otherwise undercount warnings and releases.

`npm run typecheck` passed. The standard `npm test` passed all 11 test files.
An additional in-process test-runner invocation,
`node --test --test-isolation=none 'tests/**/*.test.ts'`, exposed individual
results and passed 173 tests across 33 suites, with no failures or skips.

## Checked: declared DSH tool interface

The published `@deepseek-ai/dsh-tools@0.1.1-rc.2` package was downloaded and read
without installing a second harness runtime into this project. Tarball SHA-256:

`9a4a10114b3cfb747317dd3910645cf0347c069c06606ad01594877e0f508c6c`

In the package's `lib/types/index.js`, `prepareExecution` passes the prepared
execution into the `tools/pre-execute` waterfall; `finalizeScheduledExecution`
and `postExecute` pass the prepared execution into `tools/post-execute`.
The post-execute decision carries `additionalContexts`. This matches the plugin's
structural interface and its pre/post invocation correlation assumptions.
This source check does not replace runtime verification of filesystem events.

## Passed: real installed DSH host (keyless)

The running DSH installation was found under the local npm npx cache. No full
checkout is needed: `smoke/real-dsh-p2.ts` imports the installed real Cordis,
agent registry/loop, session log, LLM runtime, tool runtime, filesystem tools and
local filesystem/bash/subprocess providers. Only the LLM adapter is scripted.
The plugin is imported through its public source entry, `src/index.ts`; packed
artifact verification remains the separate check above.

Reproduce by passing an existing DSH installation's `node_modules` directory:

```sh
npm run smoke:real-dsh -- /home/akslcw/.npm/_npx/1e7f6d9597241db0/node_modules
```

This command passed with exit status **0**, **32 assertions**, Node **26.8.1**,
`@deepseek-ai/dsh` **0.1.5-rc.1**, Cordis **4.0.2**, and the base, agent,
agent-loop, tools, fs, fs-local, tool-fs, tool-bash, bash-local and subprocess-local
packages all **0.1.5-rc.2**. The driver prints detected versions and assertion
count, and fails if the installation is unavailable; it installs nothing.

The two isolated hosts prove:

1. Two real reads of a missing file produce a model-visible advisory on the
   next request. Real write creates the file; the final real read succeeds,
   the withdrawal reaches the model, and the single fact resolves. Counters:
   `factsHit=1`, `duplicateFailuresObserved=1`, `warningsEmitted=1`, `callsDenied=0`.
2. A real read emits the absolute dependency's present observation. The first
   real bash probe exits **1**, and its fact records exactly that filesystem
   version as precondition evidence. The repeated command returns the ledger's
   pre-dispatch denial: its process marker still contains **1** execution.
   A real write emits a different version; the identical command then exits
   **0** before the **600,000 ms** cooldown, with exactly **2** total executions.
   The single fact resolves and its withdrawal reaches the model. Counters:
   `factsHit=1`, `duplicateFailuresObserved=0`, `warningsEmitted=0`, `callsDenied=1`.

All observations and tool settlements come from the real host pipeline; the
script does not emit synthetic filesystem events or invoke ledger listeners
directly. Temporary workspaces/SQLite stores are removed and Cordis is disposed.
No paid model API, browser/session attachment, credential read, user config
change, or interaction with the already running DSH web service is involved.
The test assembles the required local providers, not the entire web/base profile:
web transport, shipped sandbox/approval providers, remote models and unrelated
plugins are outside this verification. The npx cache path is machine-specific
and must be replaced if that installation is moved or removed.

Historical numbers in `benchmark/FORMAL-RESULTS.md` continue to describe their
original version. No token-saving or model-completion improvement is claimed.

## Reproducible CI host fixture

The separate `real-dsh-smoke` Linux CI job uses Node **22.19.0**, a 10-minute
job timeout and a 120-second smoke timeout. It does not expand the existing
seven-job platform/Node matrix. Reproduce the fixture installation and check:

```sh
npm ci --ignore-scripts
npm ci --prefix smoke/host-fixture --ignore-scripts --no-audit --no-fund
timeout 120s npm run smoke:real-dsh -- smoke/host-fixture/node_modules
```

`host-fixture/package.json` pins the 41 DeepSeek runtime dependencies and their
recursive dependency/peer closure: DSH packages **0.1.5-rc.2**, Cordis **4.0.2**,
Cordis include **1.0.7**, loader **1.0.3**, Cosmokit **1.8.3**, Schemastery
**3.18.2**. Its lockfile also fixes third-party transitive versions and integrity
hashes. A clean install added 51 packages and passed all **32 assertions** locally
on Node **26.8.1**. GitHub execution remains a separate verification.

The fixture installs only the runtime closure this driver needs; the CLI and
base profile are unnecessary, so the driver now reports the loaded runtime
versions without requiring those packages. Installation uses the npm registry
(or npm's integrity-checked cache), with lifecycle scripts disabled. Runtime
execution stays keyless and isolated in temporary workspaces. Version upgrades
require an explicit fixture/lockfile update and a fresh smoke run; this job
checks the pinned host, not compatibility with every future DSH release.
