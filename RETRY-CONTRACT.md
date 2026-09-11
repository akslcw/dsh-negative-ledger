# Retry decision contract — P0/P1/P2

This change separates the reason for a decision from the decision itself.
P2 adds explicitly configured command/file evidence; it does not infer shell dependencies or change the verdict table.

## Current behavior

| Historical fact / current observation | Verdict before mode is applied | Meaning |
|---|---|---|
| No current unresolved fact | allow | No ledger restriction |
| At least one recorded precondition positively differs | stale-allow | Old evidence no longer restricts this verification; success is not guaranteed |
| No confirmed change, `after` deadline not reached | block | Recorded cooldown is active, including commands with no dependency evidence |
| No confirmed change, `after` deadline reached | allow | Verification may proceed; no proof of environmental repair is implied |
| No confirmed change, no retry condition | warn | Prior failure remains advisory in the engine |
| No confirmed change, `manual` / `never` | block | Explicit retry restriction remains applicable |
| No confirmed change, `anyOf` | allow if any alternative allows; otherwise block | Existing retry-condition semantics |

`off` bypasses recording and decisions. `warn` never denies dispatch; it may
attach an advisory after execution. `block` denies both `warn` and `block`
verdicts. Allowed retries compete for the existing verification lease in
SQLite; the JSONL backend retains its single-process degraded behavior.

Missing current evidence is **unknown**, not proof that conditions match.
P0/P1 retains the conservative existing decision in this case and labels the
incomplete evidence honestly. An outcome (exit code / error text) proves only
that a failure happened; it is not a precondition.

Without configured dependencies (or a complete fresh pre-dispatch snapshot),
automatically captured command facts contain only an outcome and a cooldown
(default 5 minutes). Every newly recorded failure renews that cooldown. The
characterization test in `tests/retry-contract.test.ts` retains this fallback
behavior: a repaired command remains denied until TTL expiry without evidence.
Only successful execution resolves a fact.

## Explicit command dependencies (P2)

Configure `commandDependencies` as a list of rules with `tool`, `commandLine`,
`cwd`, and `files`. The first three fields match the actual tool name, exact
command text, and effective cwd. Matching performs no shell parsing, whitespace
rewriting, globbing, or semantic inference. Duplicate rule keys are rejected.
Each nonempty `files` list names absolute DSH `displayPath` values. Supply paths
as reported by the filesystem service; aliases and symlinks are not resolved.
Configuration is trusted input and is copied during policy initialization.
POSIX, Windows drive, and UNC absolute paths are supported.

The policy consumes existing `fs/observed` events; it performs no extra disk
reads or hashing. A declaration alone is not evidence: the filesystem service
must have observed every declared file before dispatch. `commandEvidenceMaxAgeMs`
(default 60000, positive integer) bounds the age of those locally received
observations. This is a freshness bound, not an atomic snapshot of the filesystem
and command execution. Changes not observed by the harness remain unknown.

At pre-execution the policy freezes a complete, fresh set of dependency states.
On failure it records that snapshot alongside the outcome and TTL. A missing,
expired, or absent pre-execution snapshot falls back to outcome + TTL; it never
fills evidence from observations received only after command execution began.
An observed `absent` state is valid evidence, distinct from no observation.
Execution identity is required to correlate the pre/post callbacks. Anonymous
calls use their execution object identity; a replacement object safely loses
the dependency snapshot rather than borrowing another invocation's evidence.
Supplied tool call IDs must remain globally unique as required by the existing
SQLite operation-idempotency contract. Session-scoped snapshot storage provides
additional isolation, but does not redefine the store's operation identity.
Each session snapshot bucket is bounded to 256 pending entries; overflow drops
old snapshots and safely falls back to TTL for those calls.

A fresh observation differing from a recorded dependency permits verification
before TTL expiry. Unrelated changes do not. Expired current evidence is treated
as unknown and leaves the TTL in force. Returning to the original state can
make the prior restriction applicable again: the verdict uses current evidence,
not only the stored active/stale label. File-read behavior is unchanged.

SQLite verification still competes for a lease across policy instances. Success
resolves the fact, failure records a new attempt's evidence and cooldown, and
cancellation releases the lease without claiming success. Evidence caches are
local to each policy instance; after restart or in another process, fresh
observations must arrive again to support early retry. The ledger is shared;
the in-memory observation cache is not.

## Notification policy

- Messages distinguish absent preconditions, incomplete current evidence,
  positively matching preconditions, and the recorded retry condition.
- Incomplete evidence names which recorded `file-state` witness is stale
  (observed here but aged out) versus never observed in this context, and only
  for those does it suggest re-reading the file as a way to confirm a change;
  non-file witnesses keep the generic wording. The release path is described as
  a cooldown only for an `after` condition — otherwise it is a retry
  restriction that clearance or a confirmed change ends.
- Cumulative totals remain in `stats`; they are no longer appended to warnings.
- `warningRepeatAfterMs` defaults to 60000. Set it to `0` to disable suppression
  and evaluate text changes independently.
- Repeated advisories are limited per policy instance, session object, and fact.
  A changed failure evidence payload or elapsed notification interval permits
  another warning. Revisions and sliding command TTLs do not reset the interval.
- Successful execution and allowed verification reset the current session's
  suppression entry. Other sessions receive their own warnings. Callers without
  a session/agent object share a policy-local bucket.
- Each bucket keeps at most 256 entries. Eviction, plugin reload, or replacing
  session object identities can cause an extra advisory. Suppression is neither
  persisted nor shared across processes. Denial reasons are never suppressed.
- `duplicateFailuresObserved` still counts observed repeats when the warning is
  suppressed. `warningsEmitted` counts attached repeat advisories; `callsDenied`
  continues to count actual dispatch denials. `factsHit` includes silently
  observed duplicates. SQLite receipts/events retain transactional counting;
  JSONL retains its existing lack of operation idempotency.

## Validation and next gate

Run `npm run typecheck`, `npm test`, `npm run demo`, and `npm run build`.
The new contract cases run against both stores, use controlled time, and cover
unknown/matching/changed evidence, unrelated changes, notification intervals,
changed errors, session separation, successful retries, and result integrity.
Storage tests cover suppressed counts, persistence, reconciliation and import.

No new online A/B run is claimed here. Historical formal results describe the
old version and must not be reused as results for this candidate. For P3,
compare baseline, old policy, text-only (`warningRepeatAfterMs: 0`), and text +
suppression under fixed tasks/model/environment and randomized order. Report
completion, legal retries, wrong blocks, tokens, latency, and loops after denial
separately; fewer warnings alone do not establish lower total task cost.

P3 should first assess whether explicit dependencies improve legal retry behavior
without introducing wrong blocks. Resource metrics are diagnostic; token savings
are not a product release requirement.
