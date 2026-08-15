/**
 * M4 dual-process acceptance tests: real sibling processes racing one
 * database (A1/A2), kill-point crash recovery (A4), restart idempotency, and
 * the WAL/busy postures. Child processes are controlled by marker files, not
 * timing: each phase writes a marker at its precise point and sleeps until
 * the parent kills it (stdio ignored — sandbox-compatible).
 * @module dsh-negative-ledger/tests/m4-acceptance
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createLedgerPolicy } from '../src/plugin.ts'
import { openDatabase } from '../src/sqlite-driver.ts'
import { SqliteLedgerStore } from '../src/store-sqlite.ts'

const CHILD = join(import.meta.dirname, 'support', 'crash-child.ts')

function phaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'negledger-m4-'))
}

function spawnChild(dir: string, phase: string, args: string[]): ChildProcess {
  return spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CHILD, phase, dir, dir, ...args], {
    stdio: 'ignore',
  })
}

async function waitForFile(path: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`marker ${path} never appeared`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function waitExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode)
  return new Promise(resolve => child.once('exit', code => resolve(code)))
}

function kill(child: ChildProcess): void {
  child.kill()
}

function childReport(dir: string, pid: number | undefined): unknown {
  if (pid === undefined) throw new Error('child pid missing')
  return JSON.parse(readFileSync(join(dir, `${pid}.json`), 'utf8'))
}

describe('M4 dual-process acceptance', () => {
  it('A1: two real processes recording the same failure leave one current fact', async () => {
    const dir = phaseDir()
    const a = spawnChild(dir, 'a1-record', ['op-a', 'npm install'])
    const b = spawnChild(dir, 'a1-record', ['op-b', 'npm install'])
    assert.equal(await waitExit(a), 0)
    assert.equal(await waitExit(b), 0)
    const store = new SqliteLedgerStore({ dir })
    const facts = await store.queryFacts()
    assert.equal(facts.length, 1)
    assert.equal(facts[0]?.revision, 2)
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('A2: two real processes verify-retry race to exactly one active lease', async () => {
    const dir = phaseDir()
    const seeder = new SqliteLedgerStore({ dir })
    const seed = await seeder.recordFact({
      kind: 'command_failed',
      scope: '',
      fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine: 'npm test' }),
      claim: 'c',
      evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'x' }],
      retryCondition: { type: 'after', at: '2000-01-01T00:00:00.000Z' },
    }, { operationId: 'seed' })
    await seeder.close()
    const a = spawnChild(dir, 'a2-lease', ['L-a', 'agent-a', seed.fact.id])
    const b = spawnChild(dir, 'a2-lease', ['L-b', 'agent-b', seed.fact.id])
    writeFileSync(join(dir, 'go'), 'go')
    assert.equal(await waitExit(a), 0)
    assert.equal(await waitExit(b), 0)
    const results = [childReport(dir, a.pid), childReport(dir, b.pid)] as Array<{ kind: string }>
    assert.equal(results.filter(r => r.kind === 'applied').length, 1)
    assert.equal(results.filter(r => r.kind === 'in-progress').length, 1)
    const store = new SqliteLedgerStore({ dir })
    const facts = await store.queryFacts()
    assert.equal(facts[0]?.lease?.owner.startsWith('agent-'), true)
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('A4: kill before and inside a transaction — rolled back, integrity ok', async () => {
    const dir = phaseDir()
    const child = spawnChild(dir, 'mid-tx', [])
    await waitForFile(join(dir, 'ready'))
    kill(child)
    await waitExit(child)
    const store = new SqliteLedgerStore({ dir })
    await store.open()
    assert.equal((await store.queryFacts()).length, 0)

    const child2 = spawnChild(dir, 'mid-tx', [])
    await waitForFile(join(dir, 'in-tx'))
    kill(child2)
    await waitExit(child2)
    const reopened = new SqliteLedgerStore({ dir })
    await reopened.open()
    assert.equal((await reopened.queryFacts()).length, 0)
    const db = openDatabase(join(dir, 'ledger.db'))
    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
    db.close()
    await store.close()
    await reopened.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('A4: kill after commit, before the response — committed state survives and replay is idempotent', async () => {
    const dir = phaseDir()
    const child = spawnChild(dir, 'after-commit', ['op-committed'])
    await waitForFile(join(dir, 'committed'))
    kill(child)
    await waitExit(child)
    const store = new SqliteLedgerStore({ dir })
    await store.open()
    assert.equal((await store.queryFacts()).length, 1)
    // Restart idempotency: the same operationId replays the receipt...
    const replay = await store.recordFact({
      kind: 'command_failed',
      scope: '',
      fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine: 'npm install' }),
      claim: 'command exited 1 (bash)',
      evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'x' }],
    }, { operationId: 'op-committed', toolCallId: 'call-restart' })
    assert.equal(replay.revision, 1)
    // ...and the same toolCallId with a fresh operationId cannot append a version.
    const fresh = await store.recordFact({
      kind: 'command_failed',
      scope: '',
      fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine: 'npm install' }),
      claim: 'command exited 1 (bash)',
      evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'x' }],
    }, { operationId: 'op-fresh', toolCallId: 'call-restart' })
    assert.equal(fresh.revision, 1)
    assert.equal((await store.queryFacts()).length, 1)
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('A4: kill while holding a lease — the orphan lease expires and is taken over', async () => {
    const dir = phaseDir()
    const child = spawnChild(dir, 'lease-hold', ['L-orphan', 'agent-orphan'])
    await waitForFile(join(dir, 'holding'))
    kill(child)
    await waitExit(child)
    const store = new SqliteLedgerStore({ dir })
    await store.open()
    const facts = await store.queryFacts()
    assert.equal(facts[0]?.lease?.owner, 'agent-orphan')
    await new Promise(resolve => setTimeout(resolve, 120))
    const takeover = await store.commitAttemptDecision({
      factId: facts[0]!.fact.id,
      expectedRevision: facts[0]!.revision,
      decision: 'verify-retry',
      meta: { operationId: 'takeover' },
      leaseRequest: { leaseId: 'L-next', owner: 'agent-next', ttlMs: 60_000 },
    })
    assert.equal(takeover.kind, 'applied')
    assert.equal((await store.queryFacts())[0]?.lease?.owner, 'agent-next')
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('A4: kill mid-settle — the transaction rolls back and the holder can settle again', async () => {
    const dir = phaseDir()
    const child = spawnChild(dir, 'mid-settle', ['L-settle', 'agent-holder'])
    await waitForFile(join(dir, 'mid-settle'))
    kill(child)
    await waitExit(child)
    const store = new SqliteLedgerStore({ dir })
    await store.open()
    const facts = await store.queryFacts()
    assert.equal(facts[0]?.fact.status, 'active')
    assert.equal(facts[0]?.lease?.leaseId, 'L-settle')
    const settled = await store.settleLease({ kind: 'succeeded', leaseId: 'L-settle', owner: 'agent-holder', meta: { operationId: 'settle-after-crash' } })
    assert.equal(settled, 'applied')
    assert.equal((await store.queryFacts())[0]?.fact.status, 'resolved')
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('A4: kill mid-import — the partial batch rolls back and a real importJsonl still works', async () => {
    const dir = phaseDir()
    // Seed the schema first so the child's raw transaction has tables to hit.
    const schema = new SqliteLedgerStore({ dir })
    await schema.close()
    const child = spawnChild(dir, 'mid-import', [])
    await waitForFile(join(dir, 'mid-import'))
    kill(child)
    await waitExit(child)
    const store = new SqliteLedgerStore({ dir })
    await store.open()
    assert.equal((await store.queryFacts()).length, 0)
    // A real v0 fixture import into the same database still succeeds.
    const fixtureDir = mkdtempSync(join(tmpdir(), 'negledger-m4-fixture-'))
    const { JsonlLedgerStore } = await import('../src/store-jsonl.ts')
    const jsonl = new JsonlLedgerStore({ dir: fixtureDir })
    await jsonl.recordFact({
      kind: 'command_failed',
      scope: '/fixture',
      fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine: 'npm install' }),
      claim: 'fixture fact',
      evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'x' }],
    }, { operationId: 'fixture-op' })
    const report = await store.importJsonl(join(fixtureDir, 'ledger.jsonl'))
    assert.equal(report.facts, 1)
    assert.equal((await store.queryFacts()).length, 1)
    await store.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  it('WAL busy posture: a held write lock makes decisions unavailable, then recoverable', async () => {
    const dir = phaseDir()
    const store = new SqliteLedgerStore({ dir })
    const fact = await store.recordFact({
      kind: 'command_failed',
      scope: '',
      fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine: 'npm test' }),
      claim: 'c',
      evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'x' }],
    }, { operationId: 'seed' })
    const blocker = openDatabase(join(dir, 'ledger.db'))
    blocker.exec('BEGIN IMMEDIATE')
    blocker.prepare(`UPDATE counters SET calls_denied = calls_denied + 1 WHERE fact_id = ?`).run('nobody')
    const decision = await store.commitAttemptDecision({
      factId: fact.fact.id,
      expectedRevision: 1,
      decision: 'observe-warn',
      meta: { operationId: 'busy-1' },
    })
    assert.equal(decision.kind, 'unavailable')
    assert.ok(decision.kind === 'unavailable' && decision.reason.includes('busy'))
    blocker.exec('ROLLBACK')
    blocker.close()
    // After release, the same decision succeeds.
    const after = await store.commitAttemptDecision({
      factId: fact.fact.id,
      expectedRevision: 1,
      decision: 'observe-warn',
      meta: { operationId: 'busy-2' },
    })
    assert.equal(after.kind, 'applied')
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('block mode denies fail-closed and warn mode proceeds when the store is unavailable', async () => {
    const dir = phaseDir()
    const store = new SqliteLedgerStore({ dir })
    await store.recordFact({
      kind: 'command_failed',
      scope: '',
      fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine: 'npm test' }),
      claim: 'c',
      evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'x' }],
      retryCondition: { type: 'manual' },
    }, { operationId: 'seed' })
    const blocker = openDatabase(join(dir, 'ledger.db'))
    blocker.exec('BEGIN IMMEDIATE')
    blocker.prepare(`UPDATE counters SET calls_denied = calls_denied + 1 WHERE fact_id = ?`).run('nobody')
    const blockPolicy = createLedgerPolicy(store, { mode: 'block', storeBusyDeadlineMs: 300 })
    const warnPolicy = createLedgerPolicy(store, { mode: 'warn', storeBusyDeadlineMs: 300 })
    const exec = { name: 'bash', arguments: { command: 'npm test' }, callId: 'call-busy' }
    const denied = await blockPolicy.preExecute(exec)
    assert.equal(denied?.kind, 'deny')
    assert.ok(denied?.kind === 'deny' && denied.reason.includes('fail-closed'))
    assert.equal(await warnPolicy.preExecute(exec), undefined)
    blocker.exec('ROLLBACK')
    blocker.close()
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
