/**
 * LedgerStore v3: the storage seam every adapter implements (DESIGN-SQLITE.md §1).
 * The engine never depends on a concrete storage backend; the JSONL adapter
 * wraps the v0 engine, the SQLite adapter implements the transactional
 * protocol (M2–M4).
 * @module dsh-negative-ledger/store
 */

import type {
  Evidence,
  FactKind,
  FactTransition,
  NegativeFact,
  RetryCondition,
  SavingsSummary,
} from './types.ts'

/** Identity of one logical operation; the caller mints it and replays it verbatim. */
export interface OperationMeta {
  operationId: string
  toolCallId?: string
  actor?: string
}

/** A negative fact as recorded through the store: scope is a first-class dimension, the fingerprint excludes it. */
export interface FactInput {
  kind: FactKind
  scope: string
  /** Canonical fingerprint JSON WITHOUT the scope (see DESIGN-SQLITE.md §1). */
  fingerprint: string
  claim: string
  evidence: Evidence[]
  retryCondition?: RetryCondition
}

/** One current fact as read from a store. */
export interface StoreFact {
  fact: NegativeFact
  /** Optimistic-concurrency revision; the JSONL adapter reports a constant 1 (no concurrency protocol). */
  revision: number
  /** Active verification lease summary; the JSONL adapter reports undefined (leases unsupported). */
  lease?: { leaseId: string; owner: string; expiresAt: string }
}

export interface AttemptDecisionRequest {
  factId: string
  expectedRevision: number
  /**
   * The three verdicts: deny (condition forbids), observe-warn (evidence
   * unchanged), verify-retry (allow/stale-allow — both compete for a lease).
   */
  decision: 'deny' | 'observe-warn' | 'verify-retry'
  meta: OperationMeta
  leaseRequest?: { leaseId: string; owner: string; ttlMs: number }
}

export type AttemptDecisionResult =
  | { kind: 'applied'; fact?: StoreFact; lease?: { leaseId: string; expiresAt: string } }
  | { kind: 'conflict' }
  | { kind: 'in-progress'; owner: string; expiresAt: string }
  | { kind: 'replay'; result: AttemptDecisionResult }
  | { kind: 'unavailable'; reason: string }

export type LeaseSettlement =
  | { kind: 'succeeded'; leaseId: string; owner: string; meta: OperationMeta }
  | { kind: 'failed'; leaseId: string; owner: string; fact: FactInput; meta: OperationMeta }
  | { kind: 'released'; leaseId: string; owner: string; meta: OperationMeta }

export type SettleResult = 'applied' | 'not-active' | 'revision-conflict'

/** One batched state transition (a single FS observation can invalidate many facts). */
export interface FactTransitionItem {
  id: string
  expectedRevision: number
  transition: FactTransition
}

export interface ImportReport {
  lines: number
  facts: number
  foldedVersions: number
  currentSwitches: number
  hits: number
  skipped: number
  failures: string[]
}

export interface LedgerStore {
  getFact(scope: string, kind: FactKind, fingerprint: string): Promise<StoreFact | undefined>
  queryFacts(filter?: { scope?: string }): Promise<StoreFact[]>
  commitAttemptDecision(request: AttemptDecisionRequest): Promise<AttemptDecisionResult>
  recordFact(input: FactInput, meta: OperationMeta): Promise<StoreFact>
  transitionFacts(batch: FactTransitionItem[], meta: OperationMeta): Promise<StoreFact[]>
  settleLease(request: LeaseSettlement): Promise<SettleResult>
  summarize(scope?: string): Promise<SavingsSummary>
  open(): Promise<void>
  close(): Promise<void>
  reconcile(): Promise<void>
  importJsonl(path: string): Promise<ImportReport>
}
