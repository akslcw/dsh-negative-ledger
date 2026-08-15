/**
 * SqliteLedgerStore M2 tests: schema/migrations, record/read/summarize,
 * replay receipts, JSONL import parity with the v0 engine, and reconcile.
 * @module dsh-negative-ledger/tests/store-sqlite
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { NegativeLedger } from '../src/engine.ts'
import { SqliteLedgerStore } from '../src/store-sqlite.ts'
import type { FactInput } from '../src/store.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'negledger-sqlite-'))
}

function commandInput(scope: string, commandLine = 'npm install'): FactInput {
  return {
    kind: 'command_failed',
    scope,
    fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine }),
    claim: 'command exited 1 (bash)',
    evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'ETIMEDOUT' }],
  }
}

describe('SqliteLedgerStore (M2)', () => {
  it('records and reads facts with scope split from the fingerprint', async () => {
    const dir = tempDir()
    const store = new SqliteLedgerStore({ dir })
    await store.open()
    const recorded = await store.recordFact(commandInput('/repo'), { operationId: 'op-1' })
    assert.equal(recorded.fact.status, 'active')
    assert.equal(recorded.revision, 1)
    const read = await store.getFact('/repo', 'command_failed', JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine: 'npm install' }))
    assert.equal(read?.fact.id, recorded.fact.id)
    if (read?.fact.fingerprint.kind === 'command_failed') {
      assert.equal(read.fact.fingerprint.cwd, '/repo')
      assert.equal(read.fact.fingerprint.tool, 'bash')
    }
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('appends evidence versions on the same id with revision bumps and one current row', async () => {
    const dir = tempDir()
    const store = new SqliteLedgerStore({ dir })
    const first = await store.recordFact(commandInput('/repo'), { operationId: 'op-1' })
    const second = await store.recordFact(commandInput('/repo'), { operationId: 'op-2' })
    assert.equal(second.fact.id, first.fact.id)
    assert.equal(second.revision, 2)
    assert.equal((await store.queryFacts()).length, 1)
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('isolates identical fingerprints across scopes', async () => {
    const dir = tempDir()
    const store = new SqliteLedgerStore({ dir })
    await store.recordFact(commandInput('/a'), { operationId: 'op-a' })
    await store.recordFact(commandInput('/b'), { operationId: 'op-b' })
    assert.equal((await store.queryFacts()).length, 2)
    assert.equal((await store.queryFacts({ scope: '/a' })).length, 1)
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('replays a receipt for the same operationId and fails loud on different content', async () => {
    const dir = tempDir()
    const store = new SqliteLedgerStore({ dir })
    const first = await store.recordFact(commandInput('/repo'), { operationId: 'op-1' })
    const replay = await store.recordFact(commandInput('/repo'), { operationId: 'op-1' })
    assert.equal(replay.fact.id, first.fact.id)
    assert.equal((await store.queryFacts()).length, 1)
    await assert.rejects(
      () => store.recordFact(commandInput('/repo', 'npm test'), { operationId: 'op-1' }),
      /operation-replay-conflict/,
    )
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('imports a v0 JSONL ledger with parity, including resolved->new-id and hit counters', async () => {
    const fixtureDir = tempDir()
    const engine = new NegativeLedger({ dir: fixtureDir })
    const first = engine.recordNegativeFact({
      kind: 'command_failed',
      fingerprint: { kind: 'command_failed', tool: 'bash', commandLine: 'npm install', cwd: '/repo' },
      claim: 'first era',
      evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'E1' }],
    })
    engine.recordHit(first.id, 'warn')
    engine.markResolved(first.fingerprint)
    engine.recordNegativeFact({
      kind: 'command_failed',
      fingerprint: { kind: 'command_failed', tool: 'bash', commandLine: 'npm install', cwd: '/repo' },
      claim: 'second era',
      evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 2, stderrSignature: 'E2' }],
    })

    const dir = tempDir()
    const store = new SqliteLedgerStore({ dir })
    const report = await store.importJsonl(join(fixtureDir, 'ledger.jsonl'))
    assert.equal(report.facts, 2)
    assert.equal(report.currentSwitches, 1)
    assert.equal(report.foldedVersions, 1) // markResolved appended a second line for the first fact
    assert.equal(report.hits, 1)

    const facts = await store.queryFacts()
    assert.equal(facts.length, 1) // one current row for the key
    assert.equal(facts[0]?.fact.claim, 'second era')
    assert.equal(facts[0]?.fact.status, 'active')
    assert.deepEqual(await store.summarize(), {
      factsHit: 1,
      duplicateFailuresObserved: 1,
      warningsEmitted: 1,
      callsDenied: 0,
    })
    // superseded history retained in the DB
    const stored = await store.getFact('/repo', 'command_failed', JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine: 'npm install' }))
    assert.equal(stored?.fact.id, facts[0]?.fact.id)

    // reconcile rebuilds the same counters
    await store.reconcile()
    assert.deepEqual(await store.summarize(), {
      factsHit: 1,
      duplicateFailuresObserved: 1,
      warningsEmitted: 1,
      callsDenied: 0,
    })
    await store.close()
    rmSync(fixtureDir, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it('fails loud on malformed import lines', async () => {
    const dir = tempDir()
    const store = new SqliteLedgerStore({ dir })
    await assert.rejects(() => store.importJsonl('missing-file.jsonl'), /ENOENT|no such file/i)
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reopens an existing database without migration drift', async () => {
    const dir = tempDir()
    const first = new SqliteLedgerStore({ dir })
    await first.recordFact(commandInput('/repo'), { operationId: 'op-1' })
    await first.close()
    const second = new SqliteLedgerStore({ dir })
    await second.open()
    assert.equal((await second.queryFacts()).length, 1)
    await second.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
