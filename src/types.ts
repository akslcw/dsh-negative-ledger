/**
 * Core data model of the negative-knowledge ledger.
 * Zero runtime dependencies; type-only module for the MVP engine.
 * @module dsh-negative-ledger/types
 */

/** The four negative-path families the MVP tracks. */
export type FactKind =
  | 'command_failed'
  | 'file_missing'
  | 'approach_rejected'
  | 'api_unavailable'

/**
 * Deterministic query key: two attempts that share a fingerprint are "the
 * same action" for ledger purposes. Only these fields drive hits; the
 * natural-language claim never does.
 *
 * Command fingerprints preserve the RAW command text (trimmed only, no
 * whitespace collapsing — collapsing would merge semantically different
 * shell programs such as `printf "a  b"` and `printf "a b"`), the tool that
 * ran it (`bash` vs `pwsh` have different grammars), and the effective cwd.
 * File fingerprints scope the model-supplied path to the session cwd so
 * identical relative paths in different projects never collide.
 */
export type Fingerprint =
  | { kind: 'command_failed'; tool: string; commandLine: string; cwd: string; envHash?: string }
  | { kind: 'file_missing'; path: string; cwd: string }
  | { kind: 'approach_rejected'; taskHash: string }
  | { kind: 'api_unavailable'; endpoint: string }

/**
 * Witness roles:
 *
 * - `outcome`: proves the failure happened (exit code, stderr signature,
 *   routed error code). Historical facts; never invalidate a fact by
 *   themselves.
 * - `precondition`: state that, if changed, may make the failure obsolete.
 *   A fact stays intercepting only while every precondition witness still
 *   matches the current world; any mismatch lifts the interception.
 *
 * `file-state` witnesses map one-to-one onto the DSH filesystem seam's
 * `fs/observed` observations (`present` with an opaque version, or confirmed
 * `absent`), so the plugin records and invalidates them without hashing file
 * contents itself. The `path` is an opaque key: the plugin composes it from
 * the model path and the session cwd to keep projects isolated.
 */
export type Evidence =
  | { role: 'outcome'; kind: 'command-exit'; exitCode: number; stderrSignature: string }
  | { role: 'outcome'; kind: 'error-code'; code: string }
  | { role: 'precondition'; kind: 'directory-listing'; path: string; listingHash: string }
  | { role: 'precondition'; kind: 'file-content'; path: string; contentHash: string }
  | { role: 'precondition'; kind: 'env-state'; key: string; valueHash: string }
  | { role: 'precondition'; kind: 'repo-state'; root: string; treeHash: string }
  | { role: 'precondition'; kind: 'file-state'; path: string; observed: 'present'; version: string }
  | { role: 'precondition'; kind: 'file-state'; path: string; observed: 'absent' }

/** Precondition witnesses only. */
export type PreconditionEvidence = Extract<Evidence, { role: 'precondition' }>

/**
 * When a retry is legitimate. Absent means `evidenceChanged`: the fact stops
 * intercepting once a precondition witness no longer matches.
 *
 * Automatically recorded command facts always carry a short `after` TTL so a
 * fail-closed deployment cannot lock a command forever: the strongest
 * verdicts (`never`, `manual`) are reserved for facts an explicit, trusted
 * author recorded.
 */
export type RetryCondition =
  | { type: 'never' }
  | { type: 'manual' }
  | { type: 'after'; at: string }
  | { type: 'anyOf'; conditions: RetryCondition[] }

/**
 * `active`/`stale` record history; interception is derived per query from
 * the CURRENT evidence (a stale fact whose original evidence returns
 * intercepts again, and an active fact whose evidence changed stops
 * intercepting). `superseded` marks facts replaced by a newer record of the
 * same fingerprint after the older one was resolved.
 */
export type FactStatus = 'active' | 'stale' | 'resolved' | 'superseded'

/**
 * Honest interception counters, each independently meaningful:
 *
 * - `duplicateFailuresObserved`: a later attempt executed and failed the
 *   same way again (observed, not prevented).
 * - `warningsEmitted`: advisory contexts attached to executed results.
 * - `callsDenied`: pre-execution denies — the only counter that proves an
 *   execution was avoided.
 *
 * Token savings are NOT derived here; trajectory replay/A-B diffing (#4)
 * owns that estimate.
 */
export interface Savings {
  duplicateFailuresObserved: number
  warningsEmitted: number
  callsDenied: number
}

/** The last state-changing transition, persisted for audit. */
export interface FactTransition {
  kind: 'stale' | 'resolved'
  at: string
  /** Precondition witness kinds whose current value differed. */
  staleWitnesses?: string[]
  /** Tool call that drove the transition, when known. */
  via?: string
}

export interface NegativeFact {
  id: string
  kind: FactKind
  fingerprint: Fingerprint
  /**
   * Human-readable negative conclusion. Auto-generated only; never contains
   * raw command text or untrusted input, and is rendered as quoted data, not
   * instructions.
   */
  claim: string
  /** At least one outcome witness required; precondition witnesses optional. */
  evidence: Evidence[]
  retryCondition?: RetryCondition
  status: FactStatus
  createdAt: string
  updatedAt: string
  savings: Savings
  lastTransition?: FactTransition
}

/** Input for {@link recordNegativeFact}; the engine assigns the rest. */
export type NegativeFactInput = Omit<NegativeFact, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'savings' | 'lastTransition'>

/** A pending attempt the engine queries against the ledger. */
export interface AttemptContext {
  kind: FactKind
  fingerprint: Fingerprint
  /**
   * Current values of the precondition witnesses, collected by the caller
   * (in DSH: `fs/observed` versions, shell results). Compared against each
   * fact's precondition evidence to decide applicability.
   */
  preconditionNow: PreconditionEvidence[]
}

/**
 * What the engine tells the caller about a pending attempt, derived from the
 * CURRENT evidence on every query:
 *
 * - `block`: the retry condition forbids the attempt (`never`, `manual`,
 *   unmet `after`).
 * - `warn`: evidence matches and no condition is satisfied — the repeat is
 *   expected to fail; advisory interception.
 * - `allow`: the retry condition is satisfied — proceed without warning.
 * - `stale-allow`: a precondition witness changed — the conclusion does not
 *   currently apply; proceed and consider it withdrawn.
 */
export type QueryVerdict = 'block' | 'warn' | 'allow' | 'stale-allow'

export interface FactMatch {
  fact: NegativeFact
  verdict: QueryVerdict
}

/** One active→stale transition caused by a changed witness. */
export interface InvalidatedFact {
  id: string
  /** Kinds of the precondition witnesses that no longer match. */
  staleWitnesses: Array<PreconditionEvidence['kind']>
}

export interface SavingsSummary {
  factsHit: number
  duplicateFailuresObserved: number
  warningsEmitted: number
  callsDenied: number
}
