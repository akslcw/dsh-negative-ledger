/**
 * JsonlLedgerStore: the v0 behavior adapter behind LedgerStore v3. It wraps
 * the append-only JSONL engine unchanged, so every v0 semantic (messages,
 * ledger bytes) stays byte-identical. Known differences, documented in
 * DESIGN-SQLITE.md 附录 B:
 *
 * - `OperationMeta` idempotency fields are ignored (v0 has no events).
 * - `commitAttemptDecision` degrades to a non-atomic record-then-write path
 *   (v0 is single-process by design); `verify-retry` is unavailable.
 * - `transitionFacts` / `settleLease` / `importJsonl` are unsupported until
 *   the plugin wiring moves to them in M3.
 * - `StoreFact.revision` is a constant 1 (no optimistic concurrency in v0).
 *
 * Scope handling: v0 fingerprints embed the cwd; the store interface keeps
 * `scope` as a first-class dimension, so this adapter splits/joins it around
 * the engine.
 *
 * @module dsh-negative-ledger/store-jsonl
 */

import { NegativeLedger } from './engine.ts'
import { normalizeFingerprint } from './pure.ts'
import type { Fingerprint, NegativeFact, NegativeFactInput, SavingsSummary } from './types.ts'
import type {
  AttemptDecisionRequest,
  AttemptDecisionResult,
  FactInput,
  FactTransitionItem,
  ImportReport,
  LeaseSettlement,
  LedgerStore,
  OperationMeta,
  SettleResult,
  StoreFact,
} from './store.ts'

export interface JsonlLedgerStoreOptions {
  /** Directory holding `ledger.jsonl`; created on demand (0700). */
  dir?: string
}

/** Inject the scope back into a fingerprint parsed from the store form. */
function fingerprintWithScope(kind: FactInput['kind'], scope: string, fingerprintJson: string): Fingerprint {
  const parsed = JSON.parse(fingerprintJson) as Record<string, unknown>
  if (kind === 'command_failed' || kind === 'file_missing') {
    return { ...parsed, cwd: scope } as Fingerprint
  }
  return parsed as Fingerprint
}

/** Split a v0 fingerprint into the store's scope + scope-free canonical JSON. */
function splitScope(fingerprint: Fingerprint): { scope: string; fingerprintJson: string } {
  if (fingerprint.kind === 'command_failed' || fingerprint.kind === 'file_missing') {
    const { cwd, ...rest } = fingerprint as Fingerprint & { cwd: string }
    return { scope: cwd, fingerprintJson: JSON.stringify(rest) }
  }
  return { scope: '', fingerprintJson: JSON.stringify(fingerprint) }
}

export class JsonlLedgerStore implements LedgerStore {
  readonly #engine: NegativeLedger
  /** In-memory leaseId → factId (the v0 engine has no leases; single-process). */
  readonly #leaseFacts = new Map<string, string>()

  constructor(options: JsonlLedgerStoreOptions = {}) {
    this.#engine = new NegativeLedger(options.dir === undefined ? {} : { dir: options.dir })
  }

  #expose(fact: NegativeFact): StoreFact {
    return { fact, revision: 1 }
  }

  async getFact(scope: string, kind: FactInput['kind'], fingerprint: string): Promise<StoreFact | undefined> {
    const fact = this.#engine.findByFingerprint(fingerprintWithScope(kind, scope, fingerprint))
    return fact === undefined ? undefined : this.#expose(fact)
  }

  async queryFacts(filter?: { scope?: string }): Promise<StoreFact[]> {
    let facts = this.#engine.facts()
    if (filter?.scope !== undefined) {
      facts = facts.filter(fact => splitScope(fact.fingerprint).scope === filter.scope)
    }
    return facts.map(fact => this.#expose(fact))
  }

  async commitAttemptDecision(request: AttemptDecisionRequest): Promise<AttemptDecisionResult> {
    // Degraded, non-atomic path (v0 is single-process); OperationMeta is
    // ignored — a documented known difference of this adapter.
    if (request.decision === 'deny') {
      this.#engine.recordHit(request.factId, 'block')
      return { kind: 'applied' }
    }
    if (request.decision === 'observe-warn') {
      this.#engine.recordHit(request.factId, 'warn')
      return { kind: 'applied' }
    }
    // verify-retry: unconditional local lease — a single process has no
    // competing retriers to serialize.
    if (request.leaseRequest === undefined) throw new Error('verify-retry requires a leaseRequest')
    this.#leaseFacts.set(request.leaseRequest.leaseId, request.factId)
    const expiresAt = new Date(Date.now() + request.leaseRequest.ttlMs).toISOString()
    return { kind: 'applied', lease: { leaseId: request.leaseRequest.leaseId, expiresAt } }
  }

  async recordFact(input: FactInput, _meta: OperationMeta): Promise<StoreFact> {
    const fingerprint = normalizeFingerprint(fingerprintWithScope(input.kind, input.scope, input.fingerprint))
    const engineInput: NegativeFactInput = {
      kind: input.kind,
      fingerprint,
      claim: input.claim,
      evidence: input.evidence,
      ...(input.retryCondition !== undefined ? { retryCondition: input.retryCondition } : {}),
    }
    return this.#expose(this.#engine.recordNegativeFact(engineInput))
  }

  async transitionFacts(batch: FactTransitionItem[], _meta: OperationMeta): Promise<StoreFact[]> {
    const updated: StoreFact[] = []
    for (const item of batch) {
      const fact = this.#engine.transitionById(item.id, item.transition)
      if (fact === undefined) throw new Error(`fact ${item.id} not found`)
      updated.push({ fact, revision: 1 })
    }
    return updated
  }

  async settleLease(request: LeaseSettlement): Promise<SettleResult> {
    const factId = this.#leaseFacts.get(request.leaseId)
    if (factId === undefined) return 'not-active'
    this.#leaseFacts.delete(request.leaseId)
    if (request.kind === 'released') return 'applied'
    const fact = this.#engine.facts().find(candidate => candidate.id === factId)
    if (fact === undefined) return 'not-active'
    if (request.kind === 'succeeded') {
      this.#engine.markResolved(fact.fingerprint, request.meta.toolCallId)
      return 'applied'
    }
    const v0Input: NegativeFactInput = {
      kind: request.fact.kind,
      fingerprint: normalizeFingerprint(fingerprintWithScope(request.fact.kind, request.fact.scope, request.fact.fingerprint)),
      claim: request.fact.claim,
      evidence: request.fact.evidence,
      ...(request.fact.retryCondition !== undefined ? { retryCondition: request.fact.retryCondition } : {}),
    }
    this.#engine.recordNegativeFact(v0Input)
    return 'applied'
  }

  async summarize(scope?: string): Promise<SavingsSummary> {
    if (scope === undefined) return this.#engine.summarizeSavings()
    const facts = (await this.queryFacts({ scope })).map(entry => entry.fact)
    const summary: SavingsSummary = {
      factsHit: 0,
      duplicateFailuresObserved: 0,
      warningsEmitted: 0,
      callsDenied: 0,
    }
    for (const fact of facts) {
      summary.duplicateFailuresObserved += fact.savings.duplicateFailuresObserved
      summary.warningsEmitted += fact.savings.warningsEmitted
      summary.callsDenied += fact.savings.callsDenied
      if (fact.savings.warningsEmitted + fact.savings.callsDenied > 0) summary.factsHit += 1
    }
    return summary
  }

  async open(): Promise<void> {
    // The JSONL engine loads on construction; nothing further to do.
  }

  async close(): Promise<void> {
    // Append-only sync writes; nothing to flush.
  }

  async reconcile(): Promise<void> {
    // v0 counters are derived in memory from hit lines on every load;
    // nothing to repair.
  }

  async importJsonl(_path: string): Promise<ImportReport> {
    throw new Error('importJsonl is unsupported in the JSONL store (it IS the JSONL format)')
  }
}
