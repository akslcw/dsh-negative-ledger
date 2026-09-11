# Retry task trials — local, scripted-operator

Scope: local verification of the **committed** P0/P1/P2 retry candidate
(`d75a8b8` accounting fix, `1a274b6` dependency-evidence gate, `c339bb9` packed
consumer + real-DSH verification, `46264dd` CI smoke job) through the **real DSH
host** (agent-loop, tools, fs-local, bash-local) with a **scripted operator**
standing in for the model.

The P0/P1/P2 candidate is committed (`d75a8b8`, `1a274b6`, `c339bb9`, `46264dd`).
On top of it this round carries a fix set **by content**: `src/plugin.ts` (A1, A2 and
the recovery-message change), regressions in `tests/plugin.test.ts`,
`tests/plugin-sqlite.test.ts`, `tests/command-dependencies.test.ts` and
`tests/retry-contract.test.ts`, plus the trials themselves (`smoke/task-trials.ts`,
this file, one `package.json` script line). This document describes the change set,
not its commit state: if your checkout contains the commit that introduced this file,
the set is committed; if not, it is working-tree only. See
[Fixed in this round](#fixed-in-this-round) for before/after evidence.
This is not an online model experiment, not a formal benchmark, and not a release
announcement. No remote model, no network, no credentials.

Run: `npm run smoke:task-trials` (optionally pass a DSH `node_modules` path).

## What is real, and what is scripted

**Scripted:** the decisions. `ScriptedAdapter` replays a fixed list of tool calls,
so the trials measure *policy behavior under a known operator*, never agent
capability. Every trial is one scripted trajectory, not a distribution.

**Real:** the DSH plugin/composition wiring, the filesystem, `write`/`read` tool
execution, `bash -c` subprocesses, the SQLite ledger, and the timing.
The `fs/observed` events that drive evidence are the harness's own, not fixtures.

## Fixture

`build.mjs` reads `build.json` (`{"enabled":bool}`) and `source.txt`, appends one
line to `runs.log` per execution, and writes `dist.txt` uppercased. Either input
can be the real cause, which is what lets the declared/undeclared distinction be
exercised on one fixture. The declared `commandDependencies` rule lists
`build.json` only, matching the exact command line and cwd.
`commandRetryAfterMs` is 600000 for every scenario, so nothing here waits out the
TTL: a release inside a scenario is always an evidence release.

## Scenarios

| id | intent | denied attempts (expected) | terminal fact |
|---|---|---|---|
| `declared-repair` | unchanged repeat and unrelated edit stay blocked; a relevant `build.json` change releases the exact retry before TTL | correct, correct | `resolved` |
| `missing-evidence` | no pre-dispatch snapshot was frozen, so the fact carries no witness and a `build.json` change cannot release it | correct, conservative:missing-evidence | `active` |
| `expired-evidence` | the repair is observed, then ages past `commandEvidenceMaxAgeMs` (2000ms), so a retry that would now succeed stays blocked until the file is observed again | correct, conservative:expired-evidence | `resolved` |
| `hidden-dependency` | the real cause is `source.txt`, which the rule never declared; the repair makes the command succeed counterfactually while the declared dependency is unchanged | correct, conservative:undeclared-dependency | `active` |

`missing-evidence` and `hidden-dependency` end with an **alternate-command
control**: a semantically identical build behind a different command line. It is
not the rule's command line, so it is allowed, and it proves the fixture itself is
genuinely repaired while the exact retry is still denied.

## Ground truth is per attempt, never per scenario

Two independent oracles per denied attempt, both taken **at the moment the
decision was made**:

1. **Counterfactual probe.** The same command is run against a private copy of the
   workspace as it stood at dispatch. Its exit code is what the command *would*
   have done. The copy is why the probe cannot pollute the real workspace — the
   `runs.log` assertion (`lines == executed builds`) fails if it ever does.
2. **Freshness oracle.** The harness records every `fs/observed` event with its own
   timestamp, and compares the declared file's current version against the version
   the fact recorded. This reconstructs the plugin's release predicate without
   asking the plugin.

**A denial is never scored wrong because a later, repaired attempt succeeded.**
That is the whole point of probing at decision time: in `expired-evidence` and
`hidden-dependency`, the final command succeeds, yet the earlier denial is
classified as conservative, not wrong.

| classification | meaning |
|---|---|
| `correct-block` | the command would have failed anyway (probe non-zero) |
| `WRONG-BLOCK` — a **contract-violating denial** | the plugin had a fresh, positively changed observation of a declared dependency and denied anyway |
| `conservative-block:expired-evidence` | a relevant change existed and the fact had a witness, but the observation was past its freshness window |
| `conservative-block:missing-evidence` | a relevant change existed but the fact carried no witness to compare against |
| `conservative-block:undeclared-dependency` | the declared dependency never changed (the cause is outside the declared set) |

**A zero contract-violation count is not a zero false-block count.** The oracle
above answers "did the policy break its own contract at decision time?", which is a
narrower question than "was this denial bad for the task?". Every conservative
block is a call that *would have worked* and that the operator could not get. Those
are counted separately and kept explicit below.

## Measured results (2026-09-11, Node 26.8.1, Linux, 53 assertions, all passing)

| scenario | bash attempts | builds run | denied | contract-violating | conservative | task-level false blocks | correct | exact retry resolved before TTL | ms |
|---|---|---|---|---|---|---|---|---|---|
| `declared-repair` | 4 | 2 | 2 | 0 | 0 | 0 | 2 | yes | 587 |
| `missing-evidence` | 4 | 2 | 2 | 0 | 1 | 1 | 1 | no | 499 |
| `expired-evidence` | 4 | 2 | 2 | 0 | 1 | 1 | 1 | yes | 3004 |
| `hidden-dependency` | 4 | 2 | 2 | 0 | 1 | 1 | 1 | no | 511 |

`ms` is wall-clock and varies with machine load (observed 490–770ms for the three
fast scenarios; `expired-evidence` is ~3.0s because the scenario delays 2500ms so
its observation ages past the 2000ms `commandEvidenceMaxAgeMs` window). Every
other figure in the table was identical across repeated runs.

"Task-level false blocks" = denied calls whose counterfactual probe exited 0 at the
moment of the denial (the `denialsThatWouldHaveSucceeded` metric). **Three of the
eight denied calls across the suite are calls that would have succeeded.** They are
unavoidable under the documented contract, and they are the honest headline: each
one cost the operator a denied attempt, and then the recovery call the trace shows
it spending instead — a re-observation, or a semantically equivalent build behind a
different command line. The suite makes no claim about calls *not* taken; there is
no no-ledger baseline here, so nothing in this table is an efficiency measurement.

Every denial records the world state it was made against — including whether the
declared file had already changed at that moment, sampled at decision time so a
later repair cannot retroactively relabel an earlier denial.

Per scenario, the ledger counters are `{factsHit: 1, duplicateFailuresObserved: 0,
warningsEmitted: 0, callsDenied: 2}` and were asserted equal to the
harness-derived denial count. `factsHit` counts **facts that intercepted at least
once**, not interceptions (`src/store-sqlite.ts:741`, `src/types.ts:174-179`): two
denials of one fact is `factsHit: 1`, `callsDenied: 2`. Reading it as a per-call
count is the one interpretation error this suite was handed with.

Each denied attempt also carries `resultError` — what the host actually delivered
at `tools/post-execute`. For all eight denials it is `isError: true` with the
plugin's own `blocked by negative-ledger (command_failed)` message, which is why
`duplicateFailuresObserved` stays 0: the plugin recognises its own denial before the
observe-warn branch (see A3 below — measured, not assumed).

## Findings

**F1 — the release path needs a *fresh* observation, so a repair has to be
re-observed, not merely retried.** In `expired-evidence` the repair was observed
2507ms before the retry against a 2000ms `commandEvidenceMaxAgeMs`, so the deny read
*"Current precondition evidence is incomplete; no change has been confirmed"* —
while the ledger's own store had already marked the same fact `stale`. The change
existed and the store knew it; the release predicate still could not use it.
Re-observing the file (`read`) released it immediately. Structurally: a change
observed more than `commandEvidenceMaxAgeMs` before the retry is invisible to the
release predicate, and the default window is much shorter than the default TTL, so
"wait for the TTL, then retry the identical command" and "repair, then retry" are
different operator strategies with different outcomes. How often an operator picks
the wrong one is **not measured here** (one trajectory per scenario). No production
default was changed. Contract-documented (`RETRY-CONTRACT.md:68-70`) and pinned by
`tests/command-dependencies.test.ts:163-181` — so this is a **cost to weigh, not a
defect to patch**, and it is the largest policy risk found.

**F2 — a fact with no witness cannot release early *for that failure revision*.**
`missing-evidence` never observed `build.json` before the first failure, so the fact
recorded outcome+TTL only (`RETRY-CONTRACT.md:55-56`). The declared file *was* then
observed, changed and fresh at retry time, and the release predicate still could not
fire: there was no recorded version to compare against. The repair was visible and
unused. The limit is not permanent — the witness belongs to the failure revision, so
a *new* failure recorded after an observation does carry one
(`tests/command-dependencies.test.ts` re-records and releases on the next attempt).
What is lost is early release for the failure that never had a snapshot.

**F3 — an undeclared dependency is structurally unreachable, by design.**
`hidden-dependency` is correct behavior under "declared, never inferred"
(`src/plugin.ts:22-30`), and the deny reason "Observed preconditions still match"
is literally true. Worth stating plainly because in the real product the operator
must enumerate dependencies per command line, and a single unlisted input reduces
the feature to the TTL for that command.

**F4 — a trivially different command line bypasses the ledger entirely.** Both
controls are `command + ' # repaired-control'`. Exact-verbatim fingerprinting
(`src/pure.ts:38-40`, trim only) is deliberate, and collapsing whitespace would
merge semantically different programs — but the same property means an operator
that varies its command text at all (a trailing comment, a reordered flag) gets an
unrelated fact and no interception. Any headline "repeat failures reduced by X%"
must therefore state that it is measured under *verbatim* command repetition.

**F5 — the benchmark's wrong-block oracle could not tell a contract violation from a
task-level false block.** *(Fixed in the same change set — see below the analysis.)*
Oracle ② (benchmark protocol, 「发布门槛」) counted "a denied
fingerprint that later succeeds in the same run" as a wrong block.
`expired-evidence` is a measured instance, and it is neither a contract violation
nor "not wrong": the fact was already `stale` when the denial was made, the plugin
had no fresh witness it was permitted to use, so nothing in the contract was broken
— **and the denied call would have succeeded, so it is a task-level false block**
(one of the three counted above). Oracle ② would score that call as a wrong block
for a reason that has nothing to do with the contract. A denial followed by a later
success is exactly what a conservative block looks like under a TTL-based release:
the operator waits, or the world changes, and the retry then legitimately succeeds.
This holds regardless of the freshness-window-to-TTL ratio; a short overlay TTL
does not make the oracle sound, it only changes which denials it mislabels.
**Oracle ② should be replaced by a decision-time oracle** (the counterfactual probe
+ freshness oracle used here) before any run whose results are read as false-block
rates, and its output should be reported as two numbers — contract violations and
task-level false blocks — never one.

**Fixed in the same change set.** `benchmark/summarize.ts` now splits the old metric
three ways instead of one: `contractViolatingDenials` (scenario-declared
`mustNeverDeny` keys, decision-time truth, **gates**), `counterfactuallySuccessfulDenials`
(**`null` = 未评估 / `UNASSESSED`** unless a collector actually recorded
`decisionTimeTruth.assessed: true` — it is never rendered as `0`), and
`deniedThenLaterSucceeded` (the old oracle, kept as an observation and explicitly
excluded from the gate). `benchmark/run.ts` records per-run `denialBases` — the
decision-time *reason* the plugin gave (`evidence-unchanged`, `evidence-incomplete`,
`no-evidence-recorded`, `lease-in-progress`, `store-unavailable`, `unclassified`) —
which is decision-time evidence about what the plugin could verify, not a verdict that
a denial was wrong. G2 is now `UNASSESSED` for any batch collected without a probe
(including every historical batch), and PROTOCOL/BENCHMARK/FORMAL-RESULTS say so
instead of quoting `wrongBlocks 0` as zero false blocks. Raw result files were not
rewritten and no counterfactual was invented; the summarizer re-derives the basis
tally from the recorded error text when a run predates the field. Tests:
`tests/benchmark-summarize.test.ts` plus new cases in
`tests/benchmark-session-log.test.ts`.

**F6 — the deny message conflated "never observed" with "observed but expired".**
*(Fixed in the same change set.)* `missing-evidence` and `expired-evidence` are
genuinely different states, and the second is the recoverable one, but they read as
"no evidence" and "incomplete evidence" with no age — that is the wording the trial
table above was measured against. The message now separates the three cases, and only
ever offers re-reading for `file-state` witnesses — the ones re-reading can actually
answer:

- a recorded **file** witness whose cached observation has aged past the freshness
  window: *"…the recorded observation of `<file>` is no longer fresh"*;
- a **file** witness never observed in this retry context: *"no observation of `<file>`
  was recorded in this context"*;
- and both end with *"Re-reading those files may confirm a change and enable an early
  retry; unchanged files leave the retry restriction in place."* — "cooldown" only when
  the fact's condition is `after` (`never`/`manual`/`anyOf` are released by clearance or
  a confirmed change, not by elapsed time).

A failure with **no** recorded witness says the opposite honestly — re-reading cannot
release the retry early and the restriction stands — because nothing can ever mismatch.
A witness that is not file state at all (`env-state`, `repo-state`) keeps the previous
generic answer (*"Current precondition evidence is incomplete; no change has been
confirmed."*): this plugin can neither re-observe it by reading a file nor tell "aged
out" from "never seen here" for it, so it makes no freshness claim. No branch promises
an automatic release or a success, and no verdict or default changed.

**What the fix does not include:** the text still prints neither the observation's age
nor the configured `commandEvidenceMaxAgeMs` window, which the original note proposed.
Naming the file and the state is what makes the denial actionable (the operator can
re-read it); the ages would lengthen the message for a model that can simply re-read
the file. Pinned by `tests/command-dependencies.test.ts` (expired vs never-observed,
both backends), `tests/retry-contract.test.ts` (no witness ⇒ restriction stands, and no
re-read invitation) and `tests/plugin.test.ts` (non-file witness stays generic; a
`manual` fact asks for a retry restriction, not a cooldown).

## Fixed in this round

Three defects were found while preparing the review above, in
`commandDependencies`/evidence code the trials touch but do not exercise. **A1 and
A2 are fixed** in `src/plugin.ts` with regression tests; **A3 is deliberately left
latent** — and the two measurement/message findings above (**F5** oracle, **F6**
deny wording) are fixed in the same set. Each entry keeps the original observation,
then states what changed and what now pins it, so the observed defects and the
candidate fix stay distinguishable.

### A1 — FIXED (was: allow-bias, one session's file became another's evidence)

**Original observation.** `displayByModel` was declared as "model-supplied path →
backend displayPath, from the actor correlation" — keyed by the model path alone,
with no session or cwd scope. It was written last-writer-wins and read unscoped,
where the value was added to the fact's witness paths. Repro, two sessions sharing
one store, both reading the relative path `data.txt` with different cwds
(`/tmp/x/a`, `/tmp/x/b`): dispatch A's read, observe `/tmp/x/a/data.txt` absent,
dispatch B's read, observe `/tmp/x/b/data.txt` absent, settle B's read as
`FS_NOT_FOUND`, then settle A's. A's fact was recorded with witnesses
`["/tmp/x/a\0data.txt", "/tmp/x/b/data.txt"]` — B's absolute path, and no entry for
A's own. Writing `/tmp/x/b/data.txt` and observing it then released A's fact, and a
retry of A's read was **allowed while `/tmp/x/a/data.txt` still did not exist** —
the allow-bias direction, and the more dangerous one. The config doc ("only that
exact displayPath is ever used as evidence — never a relative path alias from
another project") describes the intent the map's scoping did not implement.

**Fix.** The map is now keyed by `scopedModelKey(cwd, modelPath)` — the *same*
session key the read path already uses for its primary witness — on both the write
and the read side. Consequences: two cwds no longer share an entry; a session with
an unknown cwd still degrades to the bare model path exactly as before; and the two
witnesses a fact records can no longer disagree about which session's observation
they describe. No new state, no API change, no config change.

**Regression.** `keeps one session's repair from releasing another session's missing
file` — two sessions interleaved, asserting both the recorded witness list and that
B's repair leaves A denied while A's own repair releases it — added to
`tests/plugin.test.ts` (JSONL) and `tests/plugin-sqlite.test.ts` (SQLite).

**Before / after (both files fail without the fix, pass with it).** Pre-fix, the
witness list came back as
`['/ws/a\0config.json', '/ws/b/config.json']` where `['/ws/a\0config.json',
'/ws/a/config.json']` was required — the foreign file, caught by a committed
assertion rather than by a hand-run probe.

### A2 — FIXED (was: withdrawal note skipped on the repair-driven retry)

**Original observation.** `guardAttempt` read the fact into `entry`, and on a
`stale-allow` verdict committed the staleness to the store — without re-reading
`entry`. The lease was then recorded with `staleAtGrant: entry.fact.status ===
'stale'`, sampling the *pre-*transition status, which on an `active` fact is
`false`; settling as `applied` therefore skipped `staleNote`. The read-through
always wins its own comparison, so the note was dropped on exactly the first
repair-driven retry, when it is most useful. Only the explanation was lost; the
decision was unaffected. Observed originally as: retry allowed and status `stale`
either way, but the note present only when the queued invalidation pass had
committed before dispatch.

**Fix.** `staleAtGrant: verdict === 'stale-allow' || entry.fact.status === 'stale'`.
A stale-allow verdict *is* "recorded preconditions changed", so the lease records
it directly instead of asking a pre-transition snapshot; the second arm preserves
the note for a lease granted on a fact that was already stale without a witness
mismatch. Lease semantics, the verdict path, and return-to-original-state behavior
are untouched — a change-and-change-back still stays denied with no witness
mismatch.

**Regression.** Two tests in `tests/command-dependencies.test.ts`, run over **both
backends** by that file's existing loop: one holds the observation's invalidation
pass at its first store read (with a 250ms backstop) so the pre-dispatch
read-through is deterministically the path that marks the fact stale, and one
observes the already-stale order. Both assert the note text and the resolved fact.

**Before / after.** Pre-fix on both backends the read-through test failed at the
`contexts.length` assertion (`0 !== 1` — no note); post-fix both orders pass on both
backends.

### A3 — LATENT, not fixed (by decision)

Own-denial recognition is an unguarded string prefix: `:897-900` decides "this
result is my own denial" by
`result.error.message.startsWith('blocked by negative-ledger')`, coupling a
pre-execute decision to a post-execute message format. Measured against the real
host, the coupling holds today: a denied `read` and a denied `bash` both arrive at
`tools/post-execute` with `isError: true` and the plugin's message verbatim (see the
`resultError` field in the trial JSON), so the branch fires and
`duplicateFailuresObserved` stays 0. Demonstrated consequence if a harness ever
wraps that message (e.g. `Tool denied: blocked by negative-ledger …`): the denial is
then counted as an observed duplicate and can attach an advisory — measured as
`duplicateFailuresObserved` 0 → 1 with one advisory, versus 0 → 0 with none for the
verbatim message. The fix implied by the shape is a marker the plugin owns (a
symbol or an id it can recognise) rather than prose it hopes survives. Left alone
here because it needs no behavior change today and the marker shape is a design
decision.

## Next gate (prioritized)

1. **Decide the intended recovery strategy for F1/F2.** A repair that must be
   *re-observed* within `commandEvidenceMaxAgeMs` is a different operator contract
   from one that releases on retry, and both are configurable and independently
   defaulted (60s vs 300s). Cheapest gate: run `declared-repair` and
   `expired-evidence` with the *retry gap* as the variable (retry at 5s, 30s, 90s
   after the repair) and record the release rate, so the choice is made against a
   measured curve rather than argued. Two shapes are worth weighing against each
   other, and neither is safe on its own: **re-observe first** (have the release
   predicate ask for a fresh observation when the recorded one is too old, which
   keeps the predicate honest and costs the operator a call), or a durable
   "changed since failure" record. A durable marker alone is unsafe — if the input
   is changed and then changed back, a marker that only records "it changed" would
   release a retry that fails identically. If such a marker is pursued it must
   record the observed *state*, not just a mutation event, and it should not be a
   reason to assume the window has to equal the TTL: the two knobs govern different
   things (how long an observation is evidence, how long a failure is protected) and
   their correct relationship is a policy decision, not an arithmetic one.
2. ~~**Replace or constrain benchmark oracle ②** (F5)~~ — **done in this change set**:
   the oracle is now an explicit non-gating observation, contract violations and
   task-level false blocks are separate numbers, an unprobed batch reads
   `UNASSESSED` rather than `0`, and `denialBases` records the decision-time reason
   per run. What is *not* done: nothing yet collects decision-time truth, so every
   benchmark batch (including future ones run by the current `run.ts`) will keep
   reporting the task-level half as unassessed until a collector probes a private
   workspace copy.
3. **A1 and A2 — done in this change set**, each with a regression test
   over both store backends (A1 with two sessions sharing a relative path, A2 for
   both invalidation orders). Review should confirm the same-cwd evidence is
   byte-identical: the existing cwd-scoped/displayPath witness test and the
   `real-dsh` smoke both pin it. **A3 remains open** and is a marker-shape decision,
   not a bug fix.
4. **Add a P2 gate to the protocol.** Today `s4` attributes its release to the TTL
   and `s3` exercises the `read` path, so the declared-dependency feature has no
   benchmark coverage. `smoke/real-dsh-p2.ts` already validates dependency recovery
   end to end (real read/write observations, changed version, denied command not
   re-executed, retry allowed before the 600s TTL, fact `resolved` at
   `smoke/real-dsh-p2.ts:226-250`), so what is missing is benchmark *coverage*, not
   evidence that the feature works.
5. ~~**F6 message fix**~~ — **done in this change set** (expired vs never-observed vs
   no-witness, file names included, no release promised). Not done: printing the
   observation age and the window, deliberately — see F6.

No production default, no policy behavior, and no architecture was changed by this
work. F1/F2/F3 are contract-documented behavior and are reported as costs to weigh;
A3 remains a latent coupling left alone by decision. A1 and A2 are fixed in this
[change set](#fixed-in-this-round) — both are implementation defects with
narrow scope (an evidence-scoping bug and a dropped advisory), neither changes a
verdict or a default, and each is pinned by a regression test. A1 does change which
witnesses a fact records, so review of that diff should confirm the same-cwd
behavior is unchanged — the existing
`records missing-file facts with cwd-scoped and displayPath witnesses` test and the
`real-dsh` smoke (a real host invalidating a real fact from a write-driven
observation) both still pass.

## What these trials do not claim

- The **trial decisions** are scripted: no model produced the tool calls, so token
  cost, latency, completion rate, and agent adaptation are **unmeasured** here — a
  scripted operator cannot loop, re-read, or give up the way a model does. This is
  a statement about the trial operator, not about how the code under test was
  developed.
- No baseline. Nothing here supports an efficiency claim ("saves N calls"), because
  the same tasks were never run without the ledger.
- One trajectory per scenario, one platform (Linux), one Node version.
- `dist.txt`, `runs.log`, and the ledger counters are cross-checked against each
  other, but nothing here is a substitute for the `formal` phase in
  `benchmark/PROTOCOL.md`.
