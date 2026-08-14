/**
 * M3 acceptance tests over SqliteLedgerStore: atomic decision entry, lease
 * competition (A2-block/warn/allow), operation receipts (A3), the
 * no-bypass-via-recordFact guard, batch transitions, and the settle state
 * machine. Real multi-process concurrency is M4; here two connections to the
 * same database interleave, which exercises the same transactions.
 * @module dsh-negative-ledger/tests/store-sqlite-m3
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { SqliteLedgerStore } from '../src/store-sqlite.ts'
import type { FactInput } from '../src/store.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'negledger-m3-'))
}

function commandInput(scope = '/repo', commandLine = 'npm install'): FactInput {
  return {
    kind: 'command_failed',
    scope,
    fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine }),
    claim: 'command exited 1 (bash)',
    evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'ETIMEDOUT' }],
  }
}

async function record(store: SqliteLedgerStore, operationId: string, input: FactInput = commandInput()) {
  return store.recordFact(input, { operationId })
}

describe('M3 acceptance', () => {
  it('A1: two connections recording the same failure yield one current fact', async () => {
    const dir = tempDir()
    const a = new SqliteLedgerStore({ dir })
    const b = new SqliteLedgerStore({ dir })
    const first = await record(a, 'op-1')
    const second = await record(b, 'op-2')
    assert.equal(second.fact.id, first.fact.id)
    assert.equal(second.revision, 2)
    const current = await a.queryFacts()
    assert.equal(current.length, 1)
    assert.equal(current[0]?.revision, 2)
    await a.close()
    await b.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('A2-block: ten concurrent verify-retries grant exactly one lease', async () => {
    const dir = tempDir()
    const a = new SqliteLedgerStore({ dir })
    const b = new SqliteLedgerStore({ dir })
    const fact = await record(a, 'op-f')
    let applied = 0
    let inProgress = 0
    for (let i = 0; i < 10; i += 1) {
      const store = i % 2 === 0 ? a : b
      const result = await store.commitAttemptDecision({
        factId: fact.fact.id,
        expectedRevision: 1,
        decision: 'verify-retry',
        meta: { operationId: `v-${i}`, toolCallId: `call-${i}` },
        leaseRequest: { leaseId: `L-${i}`, owner: `agent-${i}`, ttlMs: 60_000 },
      })
      if (result.kind === 'applied') applied += 1
      if (result.kind === 'in-progress') inProgress += 1
    }
    assert.equal(applied, 1)
    assert.equal(inProgress, 9)
    const current = await a.queryFacts()
    assert.equal(current[0]?.lease?.owner, 'agent-0')
    await a.close()
    await b.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('A2-warn: only the lease holder settles with state authority', async () => {
    const dir = tempDir()
    const store = new SqliteLedgerStore({ dir })
    const fact = await record(store, 'op-f')
    const granted = await store.commitAttemptDecision({
      factId: fact.fact.id,
      expectedRevision: 1,
      decision: 'verify-retry',
      meta: { operationId: 'v-h' },
      leaseRequest: { leaseId: 'L-h', owner: 'holder', ttlMs: 60_000 },
    })
    assert.equal(granted.kind, 'applied')
    // Non-holders: settle fails, fact unchanged.
    assert.equal(await store.settleLease({ kind: 'succeeded', leaseId: 'L-h', owner: 'other', meta: { operationId: 's-1' } }), 'not-active')
    assert.equal((await store.queryFacts())[0]?.fact.status, 'active')
    // Holder: applied, fact resolved.
    assert.equal(await store.settleLease({ kind: 'succeeded', leaseId: 'L-h', owner: 'holder', meta: { operationId: 's-2' } }), 'applied')
    assert.equal((await store.queryFacts())[0]?.fact.status, 'resolved')
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('A2-allow: an expired lease is taken over by exactly one successor', async () => {
    const dir = tempDir()
    const store = new SqliteLedgerStore({ dir })
    const fact = await record(store, 'op-f')
    await store.commitAttemptDecision({
      factId: fact.fact.id,
      expectedRevision: 1,
      decision: 'verify-retry',
      meta: { operationId: 'v-1' },
      leaseRequest: { leaseId: 'L-1', owner: 'agent-1', ttlMs: 1 },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    const takeover = await store.commitAttemptDecision({
      factId: fact.fact.id,
      expectedRevision: 1,
      decision: 'verify-retry',
      meta: { operationId: 'v-2' },
      leaseRequest: { leaseId: 'L-2', owner: 'agent-2', ttlMs: 60_000 },
    })
    assert.equal(takeover.kind, 'applied')
    assert.equal(takeover.kind === 'applied' ? takeover.lease?.leaseId : undefined, 'L-2')
    const third = await store.commitAttemptDecision({
      factId: fact.fact.id,
      expectedRevision: 1,
      decision: 'verify-retry',
      meta: { operationId: 'v-3' },
      leaseRequest: { leaseId: 'L-3', owner: 'agent-3', ttlMs: 60_000 },
    })
    assert.equal(third.kind, 'in-progress')
    assert.equal((await store.queryFacts())[0]?.lease?.owner, 'agent-2')
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('A3: same toolCallId cannot double count or append a second version; receipts replay original results', async () => {
    const dir = tempDir()
    const store = new SqliteLedgerStore({ dir })
    const fact = await store.recordFact(commandInput(), { operationId: 'op-1', toolCallId: 'call-1' })
    await store.commitAttemptDecision({ factId: fact.fact.id, expectedRevision: 1, decision: 'observe-warn', meta: { operationId: 'd-1', toolCallId: 'call-1' } })
    // New operationId, same toolCallId: operation-level index blocks the recount.
    await store.commitAttemptDecision({ factId: fact.fact.id, expectedRevision: 1, decision: 'observe-warn', meta: { operationId: 'd-2', toolCallId: 'call-1' } })
    assert.deepEqual(await store.summarize(), { factsHit: 1, duplicateFailuresObserved: 1, warningsEmitted: 1, callsDenied: 0 })
    // Same toolCallId record replay does not append a version.
    const replayed = await store.recordFact(commandInput(), { operationId: 'op-2', toolCallId: 'call-1' })
    assert.equal(replayed.revision, 1)
    assert.equal((await store.queryFacts()).length, 1)
    // Receipt replay returns the ORIGINAL decision result.
    const replay = await store.commitAttemptDecision({ factId: fact.fact.id, expectedRevision: 1, decision: 'observe-warn', meta: { operationId: 'd-1', toolCallId: 'call-1' } })
    assert.equal(replay.kind, 'applied')
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects recordFact while a lease is active (no settlement bypass)', async () => {
    const dir = tempDir()
    const store = new SqliteLedgerStore({ dir })
    const fact = await record(store, 'op-f')
    await store.transitionFacts([
      { id: fact.fact.id, expectedRevision: 1, transition: { kind: 'stale', at: new Date().toISOString(), staleWitnesses: ['file-state'] } },
    ], { operationId: 't-1' })
    await store.commitAttemptDecision({
      factId: fact.fact.id,
      expectedRevision: 2,
      decision: 'verify-retry',
      meta: { operationId: 'v-1' },
      leaseRequest: { leaseId: 'L-1', owner: 'holder', ttlMs: 60_000 },
    })
    await assert.rejects(
      () => store.recordFact(commandInput(), { operationId: 'op-bypass' }),
      /active verification lease/,
    )
    // The holder's failed retry must go through settlement with fresh evidence.
    const failedInput = commandInput('/repo')
    failedInput.claim = 'failed again with new evidence'
    assert.equal(await store.settleLease({ kind: 'failed', leaseId: 'L-1', owner: 'holder', fact: failedInput, meta: { operationId: 's-1' } }), 'applied')
    const current = (await store.queryFacts())[0]
    assert.equal(current?.fact.status, 'active')
    assert.equal(current?.fact.claim, 'failed again with new evidence')
    assert.equal(current?.revision, 3)
    // Lease settled: recordFact is legal again.
    await assert.doesNotReject(() => store.recordFact(commandInput(), { operationId: 'op-after' }))
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('transitionFacts is all-or-nothing on revision conflicts', async () => {
    const dir = tempDir()
    const store = new SqliteLedgerStore({ dir })
    const one = await record(store, 'op-1', commandInput('/repo', 'npm install'))
    const two = await record(store, 'op-2', commandInput('/repo', 'npm test'))
    await assert.rejects(
      () => store.transitionFacts([
        { id: one.fact.id, expectedRevision: 1, transition: { kind: 'stale', at: new Date().toISOString(), staleWitnesses: ['env-state'] } },
        { id: two.fact.id, expectedRevision: 99, transition: { kind: 'stale', at: new Date().toISOString(), staleWitnesses: ['env-state'] } },
      ], { operationId: 't-1' }),
      /revision conflict/,
    )
    const facts = await store.queryFacts()
    assert.equal(facts.every(entry => entry.fact.status === 'active'), true)
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('settle released leaves the fact untouched and frees the lease', async () => {
    const dir = tempDir()
    const store = new SqliteLedgerStore({ dir })
    const fact = await record(store, 'op-f')
    await store.commitAttemptDecision({
      factId: fact.fact.id,
      expectedRevision: 1,
      decision: 'verify-retry',
      meta: { operationId: 'v-1' },
      leaseRequest: { leaseId: 'L-1', owner: 'agent-1', ttlMs: 60_000 },
    })
    assert.equal(await store.settleLease({ kind: 'released', leaseId: 'L-1', owner: 'agent-1', meta: { operationId: 's-1' } }), 'applied')
    assert.equal((await store.queryFacts())[0]?.fact.status, 'active')
    const next = await store.commitAttemptDecision({
      factId: fact.fact.id,
      expectedRevision: 1,
      decision: 'verify-retry',
      meta: { operationId: 'v-2' },
      leaseRequest: { leaseId: 'L-2', owner: 'agent-2', ttlMs: 60_000 },
    })
    assert.equal(next.kind, 'applied')
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
