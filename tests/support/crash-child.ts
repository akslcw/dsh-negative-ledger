/**
 * Crash-child process for the M4 dual-process acceptance tests. Controlled
 * entirely through marker files (no IPC pipes, sandbox-friendly): each phase
 * writes a marker at a precisely defined point and then sleeps until the
 * parent kills it. Exit code 0 = clean finish, 1 = error, 2 = barrier timeout.
 * @module dsh-negative-ledger/tests/support/crash-child
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../../src/sqlite-driver.ts'
import { SqliteLedgerStore } from '../../src/store-sqlite.ts'
import type { AttemptDecisionResult } from '../../src/store.ts'

const phase = process.argv[2]!
const dir = process.argv[3]!
const markerDir = process.argv[4]!
const rest = process.argv.slice(5)

function marker(name: string): void {
  writeFileSync(join(markerDir, name), String(process.pid))
}

function report(payload: unknown): void {
  writeFileSync(join(markerDir, `${process.pid}.json`), JSON.stringify(payload))
}

function sleepForever(): void {
  setInterval(() => {}, 60_000)
}

async function waitForGo(timeoutMs = 15000): Promise<void> {
  const go = join(markerDir, 'go')
  const deadline = Date.now() + timeoutMs
  while (!existsSync(go)) {
    if (Date.now() > deadline) process.exit(2)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const commandInput = (commandLine: string): { kind: 'command_failed'; scope: string; fingerprint: string; claim: string; evidence: Array<{ role: 'outcome'; kind: 'command-exit'; exitCode: number; stderrSignature: string }> } => ({
  kind: 'command_failed',
  scope: '',
  fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine }),
  claim: 'command exited 1 (bash)',
  evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'x' }],
})

try {
  if (phase === 'a1-record') {
    const operationId = rest[0]!; const commandLine = rest[1]!
    const store = new SqliteLedgerStore({ dir })
    const fact = await store.recordFact(commandInput(commandLine), { operationId })
    report({ id: fact.fact.id, revision: fact.revision })
    await store.close()
    process.exit(0)
  }

  if (phase === 'a2-lease') {
    const leaseId = rest[0]!; const owner = rest[1]!; const factId = rest[2]!
    const store = new SqliteLedgerStore({ dir })
    await waitForGo()
    const result: AttemptDecisionResult = await store.commitAttemptDecision({
      factId,
      expectedRevision: 1,
      decision: 'verify-retry',
      meta: { operationId: `v-${process.pid}` },
      leaseRequest: { leaseId, owner, ttlMs: 60_000 },
    })
    report(result)
    await store.close()
    process.exit(0)
  }

  if (phase === 'mid-tx') {
    const db = openDatabase(join(dir, 'ledger.db'))
    marker('ready')
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`INSERT INTO facts (id, scope, kind, fingerprint, claim, evidence, status, is_current, revision, created_at, updated_at)
      VALUES ('crash-f1','','command_failed','{}','c','[]','active',1,1,'t','t')`).run()
    marker('in-tx')
    sleepForever()
  }

  if (phase === 'after-commit') {
    const operationId = rest[0]!
    const store = new SqliteLedgerStore({ dir })
    await store.recordFact(commandInput('npm install'), { operationId, toolCallId: 'call-restart' })
    marker('committed')
    await store.close()
    sleepForever()
  }

  if (phase === 'lease-hold') {
    const leaseId = rest[0]!; const owner = rest[1]!
    const store = new SqliteLedgerStore({ dir })
    const seed = await store.recordFact(commandInput('npm install'), { operationId: `seed-${process.pid}` })
    await store.commitAttemptDecision({
      factId: seed.fact.id,
      expectedRevision: 1,
      decision: 'verify-retry',
      meta: { operationId: `v-${process.pid}` },
      leaseRequest: { leaseId, owner, ttlMs: 50 },
    })
    marker('holding')
    await store.close()
    sleepForever()
  }

  if (phase === 'mid-settle') {
    const leaseId = rest[0]!; const owner = rest[1]!
    const store = new SqliteLedgerStore({ dir })
    const seed = await store.recordFact(commandInput('npm install'), { operationId: `seed-${process.pid}` })
    await store.commitAttemptDecision({
      factId: seed.fact.id,
      expectedRevision: 1,
      decision: 'verify-retry',
      meta: { operationId: `v-${process.pid}` },
      leaseRequest: { leaseId, owner, ttlMs: 60_000 },
    })
    const db = openDatabase(join(dir, 'ledger.db'))
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE retry_leases SET outcome = 'succeeded', settled_at = 'x' WHERE lease_id = ?`).run(leaseId)
    marker('mid-settle')
    sleepForever()
  }

  if (phase === 'mid-import') {
    const db = openDatabase(join(dir, 'ledger.db'))
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`INSERT INTO facts (id, scope, kind, fingerprint, claim, evidence, status, is_current, revision, created_at, updated_at)
      VALUES ('import-f1','','command_failed','{"kind":"command_failed","tool":"bash","commandLine":"partial"}','c','[]','active',1,1,'t','t')`).run()
    marker('mid-import')
    sleepForever()
  }

  appendFileSync(join(markerDir, 'errors.log'), `unknown phase ${phase}\n`)
  process.exit(1)
} catch (error) {
  appendFileSync(join(markerDir, 'errors.log'), `${String(error)}\n`)
  process.exit(1)
}
