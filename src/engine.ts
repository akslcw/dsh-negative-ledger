/**
 * Append-only JSONL ledger engine.
 *
 * Storage: one line per mutation of two kinds — a fact version
 * (`{ "v": 1, "fact": { ... } }`) and an interception counter increment
 * (`{ "v": 1, "hit": { factId, mode, at } }`). Current state = fold of
 * lines: the last fact line per id wins; an older fact whose fingerprint
 * matches a newer record is derived `superseded`; savings counters sum the
 * hit lines per fact, so interception statistics survive reloads.
 *
 * Interception is derived per query from the CURRENT evidence: a fact whose
 * precondition witnesses match intercepts again (active or stale), and a
 * fact whose witnesses changed stops intercepting. `active`/`stale` are
 * history; applicability is per-query.
 *
 * @module dsh-negative-ledger/engine
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AttemptContext,
  FactMatch,
  FactStatus,
  FactTransition,
  Fingerprint,
  InvalidatedFact,
  NegativeFact,
  NegativeFactInput,
  PreconditionEvidence,
  Savings,
  SavingsSummary,
} from './types.ts'

/** Storage line version; bump only together with a loader migration. */
const STORE_VERSION = 1

interface StoredLine {
  v: typeof STORE_VERSION
  fact?: Omit<NegativeFact, 'savings'>
  hit?: { factId: string; mode: 'warn' | 'block'; at: string }
}

export interface LedgerOptions {
  /** Directory holding `ledger.jsonl`; created on demand (0700). Defaults to `.ledger` under the cwd. */
  dir?: string
}

const ZERO_SAVINGS: Savings = { duplicateFailuresObserved: 0, warningsEmitted: 0, callsDenied: 0 }

// Pure logic lives in pure.ts so every store adapter shares one verdict and
// evidence implementation; re-export the two helpers existing tests import
// from this module.
import {
  fingerprintKey,
  mismatchedWitnessKinds,
  normalizeFingerprint,
  retryVerdict,
} from './pure.ts'

export { fingerprintKey, normalizeCommandLine } from './pure.ts'

export class NegativeLedger {
  readonly dir: string
  readonly #file: string
  #facts = new Map<string, NegativeFact>()
  #byFingerprint = new Map<string, string>()
  #savings = new Map<string, Savings>()

  constructor(options: LedgerOptions = {}) {
    this.dir = options.dir ?? join(process.cwd(), '.ledger')
    this.#file = join(this.dir, 'ledger.jsonl')
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    this.#load()
  }

  #load(): void {
    if (!existsSync(this.#file)) return
    const lines = readFileSync(this.#file, 'utf8').split('\n')
    const pendingHits: Array<{ factId: string; mode: 'warn' | 'block' }> = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim() ?? ''
      if (line === '') continue
      let parsed: StoredLine
      try {
        parsed = JSON.parse(line) as StoredLine
      } catch {
        throw new Error(`ledger line ${index + 1} is not valid JSON: ${this.#file}`)
      }
      if (parsed.v !== STORE_VERSION) {
        throw new Error(`ledger line ${index + 1} uses version ${String(parsed.v)}, expected ${STORE_VERSION}`)
      }
      if (parsed.fact !== undefined) {
        const fact: NegativeFact = { ...parsed.fact, savings: structuredClone(ZERO_SAVINGS) }
        this.#facts.set(fact.id, fact)
        this.#byFingerprint.set(fingerprintKey(fact.fingerprint), fact.id)
      } else if (parsed.hit !== undefined) {
        pendingHits.push(parsed.hit)
      } else {
        throw new Error(`ledger line ${index + 1} carries neither a fact nor a hit: ${this.#file}`)
      }
    }
    this.#deriveSuperseded()
    // Hits fold only onto facts that exist after the complete fold; a hit
    // referencing an unknown fact id is corrupt data and stays uncounted.
    for (const hit of pendingHits) {
      if (this.#facts.has(hit.factId)) this.#applyHit(hit.factId, hit.mode)
    }
  }

  /** Older facts sharing a newer record's fingerprint are superseded. */
  #deriveSuperseded(): void {
    for (const fact of this.#facts.values()) {
      const latestId = this.#byFingerprint.get(fingerprintKey(fact.fingerprint))
      if (latestId !== fact.id && fact.status !== 'superseded') {
        this.#facts.set(fact.id, { ...fact, status: 'superseded' })
      }
    }
  }

  #append(fact: NegativeFact): void {
    const { savings: _omitted, ...stored } = fact
    const line: StoredLine = { v: STORE_VERSION, fact: stored }
    appendFileSync(this.#file, `${JSON.stringify(line)}\n`, { mode: 0o600 })
  }

  #applyHit(id: string, mode: 'warn' | 'block'): void {
    const previous = this.#savings.get(id) ?? ZERO_SAVINGS
    // A `warn` hit is emitted after the duplicate call executed and failed,
    // so it counts both the observation and the warning. A `block` hit is a
    // pre-execution deny — the only proven avoided execution.
    this.#savings.set(id, mode === 'warn'
      ? {
        ...previous,
        duplicateFailuresObserved: previous.duplicateFailuresObserved + 1,
        warningsEmitted: previous.warningsEmitted + 1,
      }
      : { ...previous, callsDenied: previous.callsDenied + 1 })
  }

  #transition(fact: NegativeFact, status: 'stale' | 'resolved', transition: FactTransition): NegativeFact {
    const updated: NegativeFact = {
      ...fact,
      status,
      updatedAt: new Date().toISOString(),
      lastTransition: transition,
    }
    this.#append(updated)
    this.#facts.set(updated.id, updated)
    return updated
  }

  #exposed(fact: NegativeFact): NegativeFact {
    const savings = this.#savings.get(fact.id) ?? ZERO_SAVINGS
    return structuredClone({ ...fact, savings })
  }

  /**
   * Record a disproven path. A repeat while the fact still intercepts
   * appends a new evidence version on the SAME fact id (so savings and
   * reports stay on one logical fact); only a fact that was resolved first
   * starts a new id, and the old one is then derived `superseded`.
   */
  recordNegativeFact(input: NegativeFactInput): NegativeFact {
    if (input.kind !== input.fingerprint.kind) {
      throw new TypeError(`fact kind ${input.kind} must match fingerprint kind ${input.fingerprint.kind}`)
    }
    if (!input.evidence.some(witness => witness.role === 'outcome')) {
      throw new TypeError('a negative fact requires at least one outcome witness')
    }
    const fingerprint = normalizeFingerprint(input.fingerprint)
    const key = fingerprintKey(fingerprint)
    const existingId = this.#byFingerprint.get(key)
    const existing = existingId === undefined ? undefined : this.#facts.get(existingId)
    if (existing !== undefined && (existing.status === 'active' || existing.status === 'stale')) {
      const updated: NegativeFact = {
        ...existing,
        kind: input.kind,
        claim: input.claim,
        evidence: input.evidence,
        fingerprint,
        status: 'active',
        updatedAt: new Date().toISOString(),
      }
      if (input.retryCondition !== undefined) updated.retryCondition = input.retryCondition
      else delete updated.retryCondition
      delete updated.lastTransition
      this.#append(updated)
      this.#facts.set(updated.id, updated)
      return this.#exposed(updated)
    }
    const now = new Date().toISOString()
    const fact: NegativeFact = {
      ...input,
      fingerprint,
      id: randomUUID(),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      savings: ZERO_SAVINGS,
    }
    this.#append(fact)
    this.#facts.set(fact.id, fact)
    this.#byFingerprint.set(key, fact.id)
    this.#deriveSuperseded()
    return this.#exposed(fact)
  }

  /**
   * Find the intercepting fact for a pending attempt. Applicability is
   * derived from the CURRENT evidence on every query: a fact (active or
   * stale) whose precondition witnesses no longer match is reported
   * `stale-allow` (read-through: an active one is transitioned to stale for
   * the record); a stale fact whose original evidence has returned
   * intercepts again with the ordinary verdict.
   */
  queryRelevantFacts(attempt: AttemptContext): FactMatch[] {
    const id = this.#byFingerprint.get(fingerprintKey(normalizeFingerprint(attempt.fingerprint)))
    if (id === undefined) return []
    const fact = this.#facts.get(id)
    if (fact === undefined) return []
    if (fact.status === 'resolved' || fact.status === 'superseded') return []
    const staleWitnesses = mismatchedWitnessKinds(fact, attempt.preconditionNow)
    if (staleWitnesses.length > 0) {
      if (fact.status === 'active') {
        const staled = this.#transition(fact, 'stale', {
          kind: 'stale',
          at: new Date().toISOString(),
          staleWitnesses,
        })
        return [{ fact: this.#exposed(staled), verdict: 'stale-allow' }]
      }
      return [{ fact: this.#exposed(fact), verdict: 'stale-allow' }]
    }
    return [{ fact: this.#exposed(fact), verdict: retryVerdict(fact.retryCondition, new Date().toISOString()) }]
  }

  /**
   * Transition every active fact whose precondition witness has a positively
   * different current value. Only known differences invalidate.
   */
  invalidateFacts(current: PreconditionEvidence[], via?: string): InvalidatedFact[] {
    const invalidated: InvalidatedFact[] = []
    const at = new Date().toISOString()
    for (const fact of this.#facts.values()) {
      if (fact.status !== 'active') continue
      const staleWitnesses = mismatchedWitnessKinds(fact, current)
      if (staleWitnesses.length === 0) continue
      this.#transition(fact, 'stale', { kind: 'stale', at, staleWitnesses, ...(via !== undefined ? { via } : {}) })
      invalidated.push({ id: fact.id, staleWitnesses })
    }
    return invalidated
  }

  /** Mark the current fact for a fingerprint resolved (a later retry succeeded). */
  markResolved(fingerprint: Fingerprint, via?: string): NegativeFact | undefined {
    const id = this.#byFingerprint.get(fingerprintKey(normalizeFingerprint(fingerprint)))
    if (id === undefined) return undefined
    const fact = this.#facts.get(id)
    if (fact === undefined) return undefined
    if (fact.status === 'resolved' || fact.status === 'superseded') return this.#exposed(fact)
    return this.#exposed(this.#transition(fact, 'resolved', {
      kind: 'resolved',
      at: new Date().toISOString(),
      ...(via !== undefined ? { via } : {}),
    }))
  }

  /** Count one interception; called by the plugin after warn/block. */
  recordHit(id: string, mode: 'warn' | 'block'): void {
    if (!this.#facts.has(id)) return
    this.#applyHit(id, mode)
    const line: StoredLine = { v: STORE_VERSION, hit: { factId: id, mode, at: new Date().toISOString() } }
    appendFileSync(this.#file, `${JSON.stringify(line)}\n`, { mode: 0o600 })
  }

  summarizeSavings(): SavingsSummary {
    let duplicateFailuresObserved = 0
    let warningsEmitted = 0
    let callsDenied = 0
    let factsHit = 0
    for (const savings of this.#savings.values()) {
      if (savings.warningsEmitted + savings.callsDenied > 0) factsHit += 1
      duplicateFailuresObserved += savings.duplicateFailuresObserved
      warningsEmitted += savings.warningsEmitted
      callsDenied += savings.callsDenied
    }
    return { factsHit, duplicateFailuresObserved, warningsEmitted, callsDenied }
  }

  /** Current derived view: latest line per id, superseded derived, savings merged. */
  facts(): NegativeFact[] {
    return [...this.#facts.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(fact => this.#exposed(fact))
  }

  /** The current fact for a canonical fingerprint, if any (store-adapter reads). */
  findByFingerprint(fingerprint: Fingerprint): NegativeFact | undefined {
    const id = this.#byFingerprint.get(fingerprintKey(normalizeFingerprint(fingerprint)))
    if (id === undefined) return undefined
    const fact = this.#facts.get(id)
    return fact === undefined ? undefined : this.#exposed(fact)
  }

  /** Apply a state transition to one fact by id (store-adapter batch support). */
  transitionById(id: string, transition: FactTransition): NegativeFact | undefined {
    const fact = this.#facts.get(id)
    if (fact === undefined) return undefined
    if (fact.status === 'resolved' || fact.status === 'superseded') return this.#exposed(fact)
    return this.#exposed(this.#transition(fact, transition.kind, transition))
  }
}
