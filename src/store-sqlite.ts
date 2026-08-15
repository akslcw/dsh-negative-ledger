/**
 * SqliteLedgerStore: the transactional store behind LedgerStore v3
 * (DESIGN-SQLITE.md §2–§6). M2 scope: schema + migrations, record/read/
 * summarize/reconcile, JSONL import. Atomic decision/lease paths
 * (commitAttemptDecision, transitionFacts, settleLease) land in M3 and are
 * explicit failures here.
 *
 * All SQLite engine calls go through sqlite-driver.ts so the release swap to
 * better-sqlite3 rewrites that module alone.
 *
 * @module dsh-negative-ledger/store-sqlite
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeFingerprint } from './pure.ts'
import { openDatabase } from './sqlite-driver.ts'
import type { SqliteDatabase } from './sqlite-driver.ts'
import type {
  Evidence,
  Fingerprint,
  NegativeFact,
  RetryCondition,
  Savings,
  SavingsSummary,
} from './types.ts'
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

/** The DESIGN-SQLITE.md §2 schema, verbatim. */
const SCHEMA_DDL = `
CREATE TABLE schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE facts (
  id               TEXT PRIMARY KEY,
  scope            TEXT NOT NULL,
  kind             TEXT NOT NULL,
  fingerprint      TEXT NOT NULL,
  claim            TEXT NOT NULL,
  evidence         TEXT NOT NULL,
  retry_condition  TEXT,
  status           TEXT NOT NULL CHECK (status IN ('active','stale','resolved','superseded')),
  is_current       INTEGER NOT NULL DEFAULT 1,
  revision         INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_transition  TEXT
);
CREATE UNIQUE INDEX idx_facts_current_key
  ON facts (scope, kind, fingerprint)
  WHERE is_current = 1;
CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  result_json  TEXT,
  created_at   TEXT NOT NULL
);
CREATE TABLE events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL UNIQUE,
  operation_id    TEXT NOT NULL,
  operation_kind  TEXT NOT NULL,
  at              TEXT NOT NULL,
  kind            TEXT NOT NULL,
  fact_id         TEXT NOT NULL REFERENCES facts(id),
  scope           TEXT NOT NULL,
  tool_call_id    TEXT,
  actor           TEXT,
  payload         TEXT NOT NULL,
  causation_id    TEXT
);
CREATE UNIQUE INDEX idx_events_fact_call_opkind
  ON events (fact_id, tool_call_id, operation_kind)
  WHERE tool_call_id IS NOT NULL;
CREATE TABLE counters (
  fact_id                     TEXT PRIMARY KEY REFERENCES facts(id),
  duplicate_failures_observed INTEGER NOT NULL DEFAULT 0,
  warnings_emitted            INTEGER NOT NULL DEFAULT 0,
  calls_denied                INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE retry_leases (
  lease_id       TEXT PRIMARY KEY,
  fact_id        TEXT NOT NULL REFERENCES facts(id),
  owner          TEXT NOT NULL,
  fact_revision  INTEGER NOT NULL,
  granted_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  outcome        TEXT,
  settled_at     TEXT
);
CREATE UNIQUE INDEX idx_one_active_lease
  ON retry_leases (fact_id)
  WHERE outcome IS NULL;
CREATE INDEX idx_leases_expiry ON retry_leases (expires_at);
`

const ZERO_SAVINGS: Savings = { duplicateFailuresObserved: 0, warningsEmitted: 0, callsDenied: 0 }

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function nowIso(): string {
  return new Date().toISOString()
}

function eventIdFor(operationId: string, factId: string, kind: string): string {
  return `ev_${sha256(`${operationId}|${factId}|${kind}`)}`
}

/** Join the scope back into a stored (scope-free) fingerprint for the v0 view. */
function fingerprintWithScope(kind: string, scope: string, fingerprintJson: string): Fingerprint {
  const parsed = JSON.parse(fingerprintJson) as Record<string, unknown>
  if (kind === 'command_failed' || kind === 'file_missing') {
    return { ...parsed, cwd: scope } as Fingerprint
  }
  return parsed as Fingerprint
}

/** Canonical scope-free fingerprint JSON for storage and keys. */
function canonicalStoredFingerprint(input: FactInput): string {
  const parsed = JSON.parse(input.fingerprint) as Record<string, unknown>
  const joined = normalizeFingerprint({ ...parsed, cwd: input.scope } as Fingerprint)
  if (joined.kind === 'command_failed' || joined.kind === 'file_missing') {
    const { cwd: _omitted, ...rest } = joined as Fingerprint & { cwd: string }
    return JSON.stringify(rest)
  }
  return JSON.stringify(joined)
}

export interface SqliteLedgerStoreOptions {
  /** Directory holding `ledger.db`; created on demand (0700). */
  dir?: string
}

interface Migration {
  version: number
  up(db: SqliteDatabase): void
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(SCHEMA_DDL)
    },
  },
]

export class SqliteLedgerStore implements LedgerStore {
  readonly dir: string
  readonly #file: string
  readonly #db: SqliteDatabase

  constructor(options: SqliteLedgerStoreOptions = {}) {
    this.dir = options.dir ?? join(process.cwd(), '.ledger')
    this.#file = join(this.dir, 'ledger.db')
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    this.#db = openDatabase(this.#file)
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec('PRAGMA busy_timeout = 100')
    this.#db.exec('PRAGMA foreign_keys = ON')
    this.#migrate()
  }

  #migrate(): void {
    let version = this.#readVersion()
    for (const migration of MIGRATIONS) {
      if (migration.version <= version) continue
      for (let attempt = 0; ; attempt += 1) {
        this.#db.exec('BEGIN IMMEDIATE')
        try {
          migration.up(this.#db)
          const appliedAt = nowIso()
          this.#db.prepare('INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)').run(migration.version, appliedAt)
          this.#db.exec(`PRAGMA user_version = ${migration.version}`)
          this.#db.exec('COMMIT')
          version = migration.version
          break
        } catch (error) {
          try { this.#db.exec('ROLLBACK') } catch { /* keep the original error */ }
          // A sibling process may have won the migration race for a brand-new
          // database: re-read the version and treat an already-applied
          // migration as done; retry transient locks a bounded number of times.
          if (/already exists|database is locked|SQLITE_BUSY/.test(String(error)) && attempt < 5) {
            version = this.#readVersion()
            if (migration.version <= version) break
            continue
          }
          throw error
        }
      }
    }
  }

  #readVersion(): number {
    const row = this.#db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
    return row?.user_version ?? 0
  }

  #tx<T>(body: () => T): T {
    try {
      this.#db.exec('BEGIN IMMEDIATE')
    } catch (error) {
      if (/database is locked|SQLITE_BUSY/.test(String(error))) {
        throw new Error('store-busy: the database is locked by another writer')
      }
      throw error
    }
    try {
      const result = body()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.#db.exec('ROLLBACK') } catch { /* keep the original error */ }
      if (/database is locked|SQLITE_BUSY/.test(String(error))) {
        throw new Error('store-busy: the database is locked by another writer')
      }
      throw error
    }
  }

  #rowToFact(row: Record<string, unknown>): NegativeFact {
    const kind = String(row.kind)
    const scope = String(row.scope)
    const savings: Savings = {
      duplicateFailuresObserved: Number(row.duplicate_failures_observed ?? 0),
      warningsEmitted: Number(row.warnings_emitted ?? 0),
      callsDenied: Number(row.calls_denied ?? 0),
    }
    const fact: NegativeFact = {
      id: String(row.id),
      kind: kind as NegativeFact['kind'],
      fingerprint: fingerprintWithScope(kind, scope, String(row.fingerprint)),
      claim: String(row.claim),
      evidence: JSON.parse(String(row.evidence)) as Evidence[],
      status: row.status as NegativeFact['status'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      savings,
    }
    if (row.retry_condition !== null && row.retry_condition !== undefined) {
      fact.retryCondition = JSON.parse(String(row.retry_condition)) as RetryCondition
    }
    if (row.last_transition !== null && row.last_transition !== undefined && String(row.last_transition) !== '') {
      fact.lastTransition = JSON.parse(String(row.last_transition))
    }
    return fact
  }

  #storeFact(row: Record<string, unknown>): StoreFact {
    const fact = this.#rowToFact(row)
    const lease = this.#db.prepare(
      `SELECT lease_id, owner, expires_at FROM retry_leases WHERE fact_id = ? AND outcome IS NULL`,
    ).get(fact.id) as { lease_id: string; owner: string; expires_at: string } | undefined
    return {
      fact,
      revision: Number(row.revision),
      ...(lease !== undefined ? { lease: { leaseId: lease.lease_id, owner: lease.owner, expiresAt: lease.expires_at } } : {}),
    }
  }

  /**
   * Insert one audit event. The OR IGNORE absorbs ONLY the operation-level
   * idempotency index (same fact + toolCallId + operation_kind) — event_id
   * collisions cannot occur here because the operations receipt check above
   * guarantees a fresh operationId. Returns the number of inserted rows.
   */
  #insertEvent(input: {
    operationId: string
    operationKind: string
    kind: string
    factId: string
    scope: string
    at: string
    payload: unknown
    toolCallId?: string | undefined
    actor?: string | undefined
  }): number {
    const result = this.#db.prepare(
      `INSERT OR IGNORE INTO events (event_id, operation_id, operation_kind, at, kind, fact_id, scope, tool_call_id, actor, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventIdFor(input.operationId, input.factId, input.kind),
      input.operationId,
      input.operationKind,
      input.at,
      input.kind,
      input.factId,
      input.scope,
      input.toolCallId ?? null,
      input.actor ?? null,
      JSON.stringify(input.payload),
    )
    return Number(result.changes)
  }

  #upsertCounter(factId: string, mode: 'observe-warn' | 'deny'): void {
    if (mode === 'observe-warn') {
      this.#db.prepare(
        `INSERT INTO counters (fact_id, duplicate_failures_observed, warnings_emitted) VALUES (?, 1, 1)
         ON CONFLICT(fact_id) DO UPDATE SET
           duplicate_failures_observed = duplicate_failures_observed + 1,
           warnings_emitted = warnings_emitted + 1`,
      ).run(factId)
    } else {
      this.#db.prepare(
        `INSERT INTO counters (fact_id, calls_denied) VALUES (?, 1)
         ON CONFLICT(fact_id) DO UPDATE SET calls_denied = calls_denied + 1`,
      ).run(factId)
    }
  }

  /** Lease issuance inside the decision transaction (the only entry that grants leases). */
  #acquireLeaseInTx(factRow: Record<string, unknown>, request: AttemptDecisionRequest & {
    leaseRequest: NonNullable<AttemptDecisionRequest['leaseRequest']>
  }): AttemptDecisionResult {
    const factId = String(factRow.id)
    const same = this.#db.prepare(`SELECT owner, expires_at FROM retry_leases WHERE lease_id = ?`)
      .get(request.leaseRequest.leaseId) as { owner: string; expires_at: string } | undefined
    if (same !== undefined) {
      if (same.owner !== request.leaseRequest.owner) {
        throw new Error(`lease ${request.leaseRequest.leaseId} belongs to ${same.owner}`)
      }
      return { kind: 'applied', lease: { leaseId: request.leaseRequest.leaseId, expiresAt: same.expires_at } }
    }
    const active = this.#db.prepare(`SELECT lease_id, owner, expires_at FROM retry_leases WHERE fact_id = ? AND outcome IS NULL`)
      .get(factId) as { lease_id: string; owner: string; expires_at: string } | undefined
    const now = nowIso()
    if (active !== undefined && active.expires_at > now) {
      return { kind: 'in-progress', owner: active.owner, expiresAt: active.expires_at }
    }
    if (active !== undefined) {
      // Takeover: expiry is a takeover threshold, never a verdict invalidation
      // by itself — only this successor marks the old lease expired.
      this.#db.prepare(`UPDATE retry_leases SET outcome = 'expired', settled_at = ? WHERE lease_id = ?`)
        .run(now, active.lease_id)
    }
    const expiresAt = new Date(Date.now() + request.leaseRequest.ttlMs).toISOString()
    this.#db.prepare(
      `INSERT INTO retry_leases (lease_id, fact_id, owner, fact_revision, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(request.leaseRequest.leaseId, factId, request.leaseRequest.owner, Number(factRow.revision), now, expiresAt)
    this.#insertEvent({
      operationId: request.meta.operationId,
      operationKind: 'attempt_decision',
      kind: 'retry_granted',
      factId,
      scope: String(factRow.scope),
      at: now,
      payload: { leaseId: request.leaseRequest.leaseId, expiresAt },
      toolCallId: request.meta.toolCallId,
      actor: request.meta.actor,
    })
    return { kind: 'applied', lease: { leaseId: request.leaseRequest.leaseId, expiresAt } }
  }

  async open(): Promise<void> {
    // Initialization (PRAGMAs, migrations, integrity) ran at construction for
    // the synchronous driver; verify the is_current invariant explicitly.
    const violations = this.#db.prepare(
      `SELECT scope, kind, fingerprint, COUNT(*) AS n FROM facts WHERE is_current = 1
       GROUP BY scope, kind, fingerprint HAVING n > 1`,
    ).all()
    if (violations.length > 0) {
      throw new Error(`sqlite ledger invariant violated: ${violations.length} key(s) with multiple current facts — run reconcile`)
    }
  }

  async close(): Promise<void> {
    this.#db.close()
  }

  async getFact(scope: string, kind: FactInput['kind'], fingerprint: string): Promise<StoreFact | undefined> {
    const row = this.#db.prepare(
      `SELECT f.*, c.duplicate_failures_observed, c.warnings_emitted, c.calls_denied
       FROM facts f LEFT JOIN counters c ON c.fact_id = f.id
       WHERE f.scope = ? AND f.kind = ? AND f.fingerprint = ? AND f.is_current = 1`,
    ).get(scope, kind, fingerprint)
    return row === undefined ? undefined : this.#storeFact(row)
  }

  async queryFacts(filter?: { scope?: string }): Promise<StoreFact[]> {
    const rows = filter?.scope === undefined
      ? this.#db.prepare(
        `SELECT f.*, c.duplicate_failures_observed, c.warnings_emitted, c.calls_denied
         FROM facts f LEFT JOIN counters c ON c.fact_id = f.id
         WHERE f.is_current = 1 ORDER BY f.created_at`,
      ).all()
      : this.#db.prepare(
        `SELECT f.*, c.duplicate_failures_observed, c.warnings_emitted, c.calls_denied
         FROM facts f LEFT JOIN counters c ON c.fact_id = f.id
         WHERE f.is_current = 1 AND f.scope = ? ORDER BY f.created_at`,
      ).all(filter.scope)
    return rows.map(row => this.#storeFact(row))
  }

  async recordFact(input: FactInput, meta: OperationMeta): Promise<StoreFact> {
    const fingerprint = canonicalStoredFingerprint(input)
    const requestHash = sha256(JSON.stringify({
      kind: input.kind, scope: input.scope, fingerprint, claim: input.claim,
      evidence: input.evidence, retryCondition: input.retryCondition ?? null,
    }))
    return this.#tx(() => {
      const receipt = this.#db.prepare(
        `SELECT request_hash, result_json FROM operations WHERE operation_id = ?`,
      ).get(meta.operationId) as { request_hash: string; result_json: string | null } | undefined
      if (receipt !== undefined) {
        if (receipt.request_hash !== requestHash) {
          throw new Error(`operation-replay-conflict: operation ${meta.operationId} carries different content`)
        }
        if (receipt.result_json !== null) return JSON.parse(receipt.result_json) as StoreFact
        throw new Error(`operation-replay-conflict: operation ${meta.operationId} has no stored result`)
      }
      const current = this.#db.prepare(
        `SELECT id, status FROM facts WHERE scope = ? AND kind = ? AND fingerprint = ? AND is_current = 1`,
      ).get(input.scope, input.kind, fingerprint) as { id: string; status: string } | undefined
      // A fact under an active verification lease may only change through its
      // holder's settleLease — this is what keeps non-holders (and the holder)
      // from bypassing settlement via recordFact.
      if (current !== undefined) {
        const activeLease = this.#db.prepare(
          `SELECT lease_id FROM retry_leases WHERE fact_id = ? AND outcome IS NULL`,
        ).get(current.id)
        if (activeLease !== undefined) {
          throw new Error(`fact ${current.id} has an active verification lease — settle it via settleLease instead of recordFact`)
        }
        // Operation-level idempotency: the same (fact, toolCallId, record_failure)
        // must not append a second version, even under a fresh operationId.
        if (meta.toolCallId !== undefined) {
          const prior = this.#db.prepare(
            `SELECT 1 FROM events WHERE fact_id = ? AND tool_call_id = ? AND operation_kind = 'record_failure'`,
          ).get(current.id, meta.toolCallId)
          if (prior !== undefined) {
            const row = this.#db.prepare(
              `SELECT f.*, c.duplicate_failures_observed, c.warnings_emitted, c.calls_denied
               FROM facts f LEFT JOIN counters c ON c.fact_id = f.id WHERE f.id = ?`,
            ).get(current.id)!
            const storeFact = this.#storeFact(row)
            this.#db.prepare(`INSERT INTO operations (operation_id, request_hash, result_json, created_at) VALUES (?, ?, ?, ?)`)
              .run(meta.operationId, requestHash, JSON.stringify(storeFact), nowIso())
            return storeFact
          }
        }
      }
      const at = nowIso()
      const appendVersion = (factId: string): { fact: NegativeFact; eventKind: string } => {
        this.#db.prepare(
          `UPDATE facts SET claim = ?, evidence = ?, retry_condition = ?, status = 'active',
             revision = revision + 1, updated_at = ?, last_transition = NULL WHERE id = ?`,
        ).run(input.claim, JSON.stringify(input.evidence), input.retryCondition === undefined ? null : JSON.stringify(input.retryCondition), at, factId)
        return {
          fact: this.#rowToFact({
            ...this.#db.prepare(`SELECT * FROM facts WHERE id = ?`).get(factId)!,
            duplicate_failures_observed: 0, warnings_emitted: 0, calls_denied: 0,
          }),
          eventKind: 'fact_updated',
        }
      }
      let fact: NegativeFact
      let eventKind: string
      if (current !== undefined && (current.status === 'active' || current.status === 'stale')) {
        const appended = appendVersion(current.id)
        fact = appended.fact
        eventKind = appended.eventKind
      } else {
        if (current !== undefined) {
          this.#db.prepare(`UPDATE facts SET is_current = 0, status = 'superseded' WHERE id = ?`).run(current.id)
        }
        const id = randomUUID()
        try {
          this.#db.prepare(
            `INSERT INTO facts (id, scope, kind, fingerprint, claim, evidence, retry_condition, status, is_current, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, 1, ?, ?)`,
          ).run(id, input.scope, input.kind, fingerprint, input.claim, JSON.stringify(input.evidence),
            input.retryCondition === undefined ? null : JSON.stringify(input.retryCondition), at, at)
          fact = {
            id,
            kind: input.kind,
            fingerprint: fingerprintWithScope(input.kind, input.scope, fingerprint),
            claim: input.claim,
            evidence: input.evidence,
            status: 'active',
            createdAt: at,
            updatedAt: at,
            savings: ZERO_SAVINGS,
          }
          if (input.retryCondition !== undefined) fact.retryCondition = input.retryCondition
          eventKind = 'fact_recorded'
        } catch (error) {
          // A sibling process won the first-insert race for this key: the
          // design's upgrade path turns this record into a version append.
          if (!/UNIQUE constraint failed: idx_facts_current_key|UNIQUE constraint failed: facts\.scope/.test(String(error))) throw error
          const raced = this.#db.prepare(
            `SELECT id, status FROM facts WHERE scope = ? AND kind = ? AND fingerprint = ? AND is_current = 1`,
          ).get(input.scope, input.kind, fingerprint) as { id: string; status: string } | undefined
          if (raced === undefined || (raced.status !== 'active' && raced.status !== 'stale')) throw error
          const appended = appendVersion(raced.id)
          fact = appended.fact
          eventKind = appended.eventKind
        }
      }
      this.#insertEvent({
        operationId: meta.operationId, operationKind: 'record_failure', kind: eventKind,
        factId: fact.id, scope: input.scope, at, payload: { claim: input.claim },
        toolCallId: meta.toolCallId, actor: meta.actor,
      })
      const storeFact: StoreFact = { fact, revision: this.#db.prepare(`SELECT revision FROM facts WHERE id = ?`).get(fact.id)!.revision as number }
      this.#db.prepare(`INSERT INTO operations (operation_id, request_hash, result_json, created_at) VALUES (?, ?, ?, ?)`)
        .run(meta.operationId, requestHash, JSON.stringify(storeFact), at)
      return storeFact
    })
  }

  async commitAttemptDecision(request: AttemptDecisionRequest): Promise<AttemptDecisionResult> {
    const requestHash = sha256(JSON.stringify({
      factId: request.factId,
      expectedRevision: request.expectedRevision,
      decision: request.decision,
      leaseRequest: request.leaseRequest ?? null,
    }))
    try {
      return this.#tx(() => {
      const receipt = this.#db.prepare(`SELECT request_hash, result_json FROM operations WHERE operation_id = ?`)
        .get(request.meta.operationId) as { request_hash: string; result_json: string | null } | undefined
      if (receipt !== undefined) {
        if (receipt.request_hash !== requestHash) {
          throw new Error(`operation-replay-conflict: operation ${request.meta.operationId} carries different content`)
        }
        if (receipt.result_json !== null) return JSON.parse(receipt.result_json) as AttemptDecisionResult
        throw new Error(`operation-replay-conflict: operation ${request.meta.operationId} has no stored result`)
      }
      const factRow = this.#db.prepare(`SELECT * FROM facts WHERE id = ? AND is_current = 1`)
        .get(request.factId) as Record<string, unknown> | undefined
      if (factRow === undefined) return { kind: 'unavailable', reason: `fact ${request.factId} not found` }
      if (Number(factRow.revision) !== request.expectedRevision) return { kind: 'conflict' }
      const at = nowIso()
      const scope = String(factRow.scope)
      let result: AttemptDecisionResult
      if (request.decision === 'deny') {
        const inserted = this.#insertEvent({
          operationId: request.meta.operationId, operationKind: 'attempt_decision', kind: 'attempt_denied',
          factId: request.factId, scope, at, payload: {}, toolCallId: request.meta.toolCallId, actor: request.meta.actor,
        })
        if (inserted > 0) this.#upsertCounter(request.factId, 'deny')
        result = { kind: 'applied' }
      } else if (request.decision === 'observe-warn') {
        const inserted = this.#insertEvent({
          operationId: request.meta.operationId, operationKind: 'attempt_decision', kind: 'attempt_observed',
          factId: request.factId, scope, at, payload: {}, toolCallId: request.meta.toolCallId, actor: request.meta.actor,
        })
        if (inserted > 0) this.#upsertCounter(request.factId, 'observe-warn')
        result = { kind: 'applied' }
      } else {
        if (request.leaseRequest === undefined) throw new Error('verify-retry requires a leaseRequest')
        result = this.#acquireLeaseInTx(factRow, request as AttemptDecisionRequest & {
          leaseRequest: NonNullable<AttemptDecisionRequest['leaseRequest']>
        })
      }
      // Only successful decisions receive a receipt; conflict/unavailable stay
      // receipt-free (a later retry must re-evaluate, not replay).
      this.#db.prepare(`INSERT INTO operations (operation_id, request_hash, result_json, created_at) VALUES (?, ?, ?, ?)`)
        .run(request.meta.operationId, requestHash, JSON.stringify(result), at)
      return result
    })
    } catch (error) {
      if (/store-busy/.test(String(error))) return { kind: 'unavailable', reason: 'store busy' }
      throw error
    }
  }

  async transitionFacts(batch: FactTransitionItem[], meta: OperationMeta): Promise<StoreFact[]> {
    const requestHash = sha256(JSON.stringify(batch))
    return this.#tx(() => {
      const receipt = this.#db.prepare(`SELECT request_hash, result_json FROM operations WHERE operation_id = ?`)
        .get(meta.operationId) as { request_hash: string; result_json: string | null } | undefined
      if (receipt !== undefined) {
        if (receipt.request_hash !== requestHash) {
          throw new Error(`operation-replay-conflict: operation ${meta.operationId} carries different content`)
        }
        if (receipt.result_json !== null) return JSON.parse(receipt.result_json) as StoreFact[]
        throw new Error(`operation-replay-conflict: operation ${meta.operationId} has no stored result`)
      }
      // Validate every item first: one conflict fails the whole batch (no partial commit).
      const rows: Array<Record<string, unknown>> = []
      for (const item of batch) {
        const row = this.#db.prepare(`SELECT * FROM facts WHERE id = ? AND is_current = 1`).get(item.id) as Record<string, unknown> | undefined
        if (row === undefined) throw new Error(`fact ${item.id} not found`)
        if (Number(row.revision) !== item.expectedRevision) {
          throw new Error(`revision conflict on fact ${item.id}: expected ${item.expectedRevision}, current ${String(row.revision)}`)
        }
        rows.push(row)
      }
      const at = nowIso()
      const updated: StoreFact[] = []
      for (let index = 0; index < batch.length; index += 1) {
        const item = batch[index]!
        const row = rows[index]!
        if (item.transition.kind === 'stale') {
          this.#db.prepare(
            `UPDATE facts SET status = 'stale', revision = revision + 1, updated_at = ?, last_transition = ? WHERE id = ?`,
          ).run(at, JSON.stringify(item.transition), item.id)
          this.#insertEvent({
            operationId: meta.operationId, operationKind: 'transition_evidence', kind: 'evidence_changed',
            factId: item.id, scope: String(row.scope), at,
            payload: { staleWitnesses: item.transition.staleWitnesses ?? [] },
            toolCallId: meta.toolCallId, actor: meta.actor,
          })
        } else {
          this.#db.prepare(
            `UPDATE facts SET status = 'resolved', revision = revision + 1, updated_at = ?, last_transition = ? WHERE id = ?`,
          ).run(at, JSON.stringify(item.transition), item.id)
          this.#insertEvent({
            operationId: meta.operationId, operationKind: 'transition_evidence', kind: 'fact_resolved',
            factId: item.id, scope: String(row.scope), at, payload: {},
            toolCallId: meta.toolCallId, actor: meta.actor,
          })
        }
        const refreshed = this.#db.prepare(
          `SELECT f.*, c.duplicate_failures_observed, c.warnings_emitted, c.calls_denied
           FROM facts f LEFT JOIN counters c ON c.fact_id = f.id WHERE f.id = ?`,
        ).get(item.id)!
        updated.push(this.#storeFact(refreshed))
      }
      this.#db.prepare(`INSERT INTO operations (operation_id, request_hash, result_json, created_at) VALUES (?, ?, ?, ?)`)
        .run(meta.operationId, requestHash, JSON.stringify(updated), at)
      return updated
    })
  }

  async settleLease(request: LeaseSettlement): Promise<SettleResult> {
    const requestHash = sha256(JSON.stringify({
      kind: request.kind,
      leaseId: request.leaseId,
      owner: request.owner,
      fact: request.kind === 'failed' ? request.fact : null,
    }))
    return this.#tx(() => {
      const receipt = this.#db.prepare(`SELECT request_hash, result_json FROM operations WHERE operation_id = ?`)
        .get(request.meta.operationId) as { request_hash: string; result_json: string | null } | undefined
      if (receipt !== undefined) {
        if (receipt.request_hash !== requestHash) {
          throw new Error(`operation-replay-conflict: operation ${request.meta.operationId} carries different content`)
        }
        if (receipt.result_json !== null) return JSON.parse(receipt.result_json) as SettleResult
        throw new Error(`operation-replay-conflict: operation ${request.meta.operationId} has no stored result`)
      }
      const lease = this.#db.prepare(`SELECT * FROM retry_leases WHERE lease_id = ?`)
        .get(request.leaseId) as Record<string, unknown> | undefined
      if (lease === undefined) return 'not-active'
      if (String(lease.owner) !== request.owner) return 'not-active'
      if (lease.outcome !== null) return 'not-active'
      const factRow = this.#db.prepare(`SELECT * FROM facts WHERE id = ? AND is_current = 1`)
        .get(String(lease.fact_id)) as Record<string, unknown> | undefined
      if (factRow === undefined) return 'not-active'
      if (Number(factRow.revision) !== Number(lease.fact_revision)) return 'revision-conflict'
      const at = nowIso()
      const scope = String(factRow.scope)
      if (request.kind === 'released') {
        this.#db.prepare(`UPDATE retry_leases SET outcome = 'released', settled_at = ? WHERE lease_id = ?`).run(at, request.leaseId)
      } else if (request.kind === 'succeeded') {
        this.#db.prepare(`UPDATE retry_leases SET outcome = 'succeeded', settled_at = ? WHERE lease_id = ?`).run(at, request.leaseId)
        this.#db.prepare(
          `UPDATE facts SET status = 'resolved', revision = revision + 1, updated_at = ?, last_transition = ? WHERE id = ?`,
        ).run(at, JSON.stringify({ kind: 'resolved', at, via: request.meta.toolCallId }), String(lease.fact_id))
      } else {
        // failed: append a new evidence version on the SAME fact — the only
        // path that may update a fact while its lease is active.
        const fingerprint = canonicalStoredFingerprint(request.fact)
        if (request.fact.scope !== scope || fingerprint !== String(factRow.fingerprint)) {
          throw new Error('settlement fact does not match the leased fact')
        }
        this.#db.prepare(`UPDATE retry_leases SET outcome = 'failed', settled_at = ? WHERE lease_id = ?`).run(at, request.leaseId)
        this.#db.prepare(
          `UPDATE facts SET claim = ?, evidence = ?, retry_condition = ?, status = 'active',
             revision = revision + 1, updated_at = ?, last_transition = NULL WHERE id = ?`,
        ).run(request.fact.claim, JSON.stringify(request.fact.evidence),
          request.fact.retryCondition === undefined ? null : JSON.stringify(request.fact.retryCondition),
          at, String(lease.fact_id))
      }
      this.#insertEvent({
        operationId: request.meta.operationId, operationKind: 'retry_settle', kind: 'retry_settled',
        factId: String(lease.fact_id), scope, at, payload: { outcome: request.kind, leaseId: request.leaseId },
        toolCallId: request.meta.toolCallId, actor: request.meta.actor,
      })
      this.#db.prepare(`INSERT INTO operations (operation_id, request_hash, result_json, created_at) VALUES (?, ?, ?, ?)`)
        .run(request.meta.operationId, requestHash, JSON.stringify('applied' satisfies SettleResult), at)
      return 'applied'
    })
  }

  async summarize(scope?: string): Promise<SavingsSummary> {
    const rows = scope === undefined
      ? this.#db.prepare(
        `SELECT COUNT(*) AS hits,
                COALESCE(SUM(duplicate_failures_observed), 0) AS dup,
                COALESCE(SUM(warnings_emitted), 0) AS warned,
                COALESCE(SUM(calls_denied), 0) AS denied
         FROM counters WHERE warnings_emitted + calls_denied > 0`,
      ).all()
      : this.#db.prepare(
        `SELECT COUNT(*) AS hits,
                COALESCE(SUM(c.duplicate_failures_observed), 0) AS dup,
                COALESCE(SUM(c.warnings_emitted), 0) AS warned,
                COALESCE(SUM(c.calls_denied), 0) AS denied
         FROM counters c JOIN facts f ON f.id = c.fact_id
         WHERE f.scope = ? AND (c.warnings_emitted + c.calls_denied) > 0`,
      ).all(scope)
    const row = rows[0] ?? { hits: 0, dup: 0, warned: 0, denied: 0 }
    return {
      factsHit: Number(row.hits),
      duplicateFailuresObserved: Number(row.dup),
      warningsEmitted: Number(row.warned),
      callsDenied: Number(row.denied),
    }
  }

  async reconcile(): Promise<void> {
    this.#tx(() => {
      this.#db.exec('DELETE FROM counters')
      this.#db.exec(
        `INSERT INTO counters (fact_id, duplicate_failures_observed, warnings_emitted, calls_denied)
         SELECT fact_id,
                SUM(CASE WHEN kind = 'attempt_observed' THEN 1 ELSE 0 END),
                SUM(CASE WHEN kind = 'attempt_observed' THEN 1 ELSE 0 END),
                SUM(CASE WHEN kind = 'attempt_denied' THEN 1 ELSE 0 END)
         FROM events
         WHERE kind IN ('attempt_observed', 'attempt_denied')
         GROUP BY fact_id`,
      )
    })
  }

  async importJsonl(path: string): Promise<ImportReport> {
    const lines = readFileSync(path, 'utf8').split('\n')
    const report: ImportReport = { lines: 0, facts: 0, foldedVersions: 0, currentSwitches: 0, hits: 0, skipped: 0, failures: [] }
    return this.#tx(() => {
      const seenFactIds = new Set<string>()
      const keyCurrentId = new Map<string, string>()
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]?.trim() ?? ''
        if (line === '') continue
        report.lines += 1
        let parsed: { v?: unknown; fact?: Record<string, unknown>; hit?: { factId: string; mode: string } }
        try {
          parsed = JSON.parse(line) as { v?: unknown; fact?: Record<string, unknown>; hit?: { factId: string; mode: string } }
        } catch {
          report.failures.push(`line ${index + 1}: not valid JSON`)
          continue
        }
        if (parsed.v !== 1) {
          report.failures.push(`line ${index + 1}: version ${String(parsed.v)}`)
          continue
        }
        if (parsed.fact !== undefined) {
          const stored = parsed.fact
          const kind = String(stored.kind)
          const v0Fingerprint = stored.fingerprint as Fingerprint & { cwd?: string }
          const scope = v0Fingerprint.cwd ?? ''
          const { cwd: _omitted, ...rest } = v0Fingerprint as Fingerprint & { cwd: string }
          const fingerprint = JSON.stringify(rest)
          const id = String(stored.id)
          const key = `${scope}\u0000${kind}\u0000${fingerprint}`
          const at = String(stored.updated_at ?? stored.created_at ?? nowIso())
          const firstForId = !seenFactIds.has(id)
          seenFactIds.add(id)
          if (firstForId) {
            const currentId = keyCurrentId.get(key)
            if (currentId !== undefined) {
              this.#db.prepare(`UPDATE facts SET is_current = 0, status = 'superseded' WHERE id = ?`).run(currentId)
              report.currentSwitches += 1
            }
            this.#db.prepare(
              `INSERT INTO facts (id, scope, kind, fingerprint, claim, evidence, retry_condition, status, is_current, revision, created_at, updated_at, last_transition)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
            ).run(id, scope, kind, fingerprint, String(stored.claim ?? ''), JSON.stringify(stored.evidence ?? []),
              stored.retryCondition === undefined ? null : JSON.stringify(stored.retryCondition),
              String(stored.status ?? 'active'), String(stored.createdAt ?? at), at,
              stored.lastTransition === undefined ? null : JSON.stringify(stored.lastTransition))
            keyCurrentId.set(key, id)
            report.facts += 1
          } else {
            this.#db.prepare(
              `UPDATE facts SET claim = ?, evidence = ?, retry_condition = ?, status = ?,
                 revision = revision + 1, updated_at = ?, last_transition = ? WHERE id = ?`,
            ).run(String(stored.claim ?? ''), JSON.stringify(stored.evidence ?? []),
              stored.retryCondition === undefined ? null : JSON.stringify(stored.retryCondition),
              String(stored.status ?? 'active'), at,
              stored.lastTransition === undefined ? null : JSON.stringify(stored.lastTransition), id)
            report.foldedVersions += 1
          }
          this.#db.prepare(
            `INSERT OR IGNORE INTO events (event_id, operation_id, operation_kind, at, kind, fact_id, scope, payload)
             VALUES (?, ?, 'import', ?, ?, ?, ?, ?)`,
          ).run(`import:${sha256(line)}`, `import:${sha256(line)}`, at, firstForId ? 'fact_recorded' : 'fact_updated', id, scope, JSON.stringify({}))
        } else if (parsed.hit !== undefined) {
          const factId = parsed.hit.factId
          const exists = this.#db.prepare(`SELECT 1 FROM facts WHERE id = ?`).get(factId)
          if (exists === undefined) {
            report.failures.push(`line ${index + 1}: hit references unknown fact ${factId}`)
            continue
          }
          const mode = parsed.hit.mode
          if (mode !== 'warn' && mode !== 'block') {
            report.failures.push(`line ${index + 1}: unknown hit mode ${String(mode)}`)
            continue
          }
          const eventId = `import:${sha256(line)}`
          const inserted = this.#db.prepare(
            `INSERT OR IGNORE INTO events (event_id, operation_id, operation_kind, at, kind, fact_id, scope, payload)
             VALUES (?, ?, 'import', ?, ?, ?, (SELECT scope FROM facts WHERE id = ?), ?)`,
          ).run(eventId, eventId, parsed.hit && 'at' in parsed.hit ? String((parsed.hit as { at?: string }).at ?? nowIso()) : nowIso(),
            mode === 'warn' ? 'attempt_observed' : 'attempt_denied', factId, factId, JSON.stringify({}))
          if (Number(inserted.changes) === 0) {
            report.skipped += 1
            continue
          }
          if (mode === 'warn') {
            this.#db.prepare(
              `INSERT INTO counters (fact_id, duplicate_failures_observed, warnings_emitted) VALUES (?, 1, 1)
               ON CONFLICT(fact_id) DO UPDATE SET duplicate_failures_observed = duplicate_failures_observed + 1, warnings_emitted = warnings_emitted + 1`,
            ).run(factId)
          } else {
            this.#db.prepare(
              `INSERT INTO counters (fact_id, calls_denied) VALUES (?, 1)
               ON CONFLICT(fact_id) DO UPDATE SET calls_denied = calls_denied + 1`,
            ).run(factId)
          }
          report.hits += 1
        } else {
          report.failures.push(`line ${index + 1}: neither fact nor hit`)
        }
      }
      if (report.failures.length > 0) {
        throw new Error(`importJsonl failed: ${report.failures.length} invalid line(s), first: ${report.failures[0]}`)
      }
      return report
    })
  }
}
