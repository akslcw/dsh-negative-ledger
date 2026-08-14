/**
 * LedgerStore v3 interface equivalence tests over the JSONL adapter: the
 * adapter must expose exactly the v0 engine behavior through the new seam,
 * including scope splitting and the documented degraded/unsupported paths.
 * @module dsh-negative-ledger/tests/store-jsonl
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { NegativeLedger } from '../src/engine.ts'
import { JsonlLedgerStore } from '../src/store-jsonl.ts'
import type { FactInput } from '../src/store.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'negledger-store-'))
}

function commandInput(scope: string, commandLine = 'npm install'): FactInput {
  return {
    kind: 'command_failed',
    scope,
    fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine }),
    claim: `command exited 1 (bash)`,
    evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'ETIMEDOUT' }],
  }
}

describe('JsonlLedgerStore (LedgerStore v3 equivalence)', () => {
  it('round-trips a recorded fact through getFact with scope re-attached', async () => {
    const dir = tempDir()
    const store = new JsonlLedgerStore({ dir })
    await store.recordFact(commandInput('/repo'), { operationId: 'op-1' })
    const entry = await store.getFact('/repo', 'command_failed', JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine: 'npm install' }))
    assert.equal(entry?.fact.claim, 'command exited 1 (bash)')
    assert.equal(entry?.fact.fingerprint.kind, 'command_failed')
    if (entry?.fact.fingerprint.kind === 'command_failed') {
      assert.equal(entry.fact.fingerprint.cwd, '/repo')
      assert.equal(entry.fact.fingerprint.tool, 'bash')
    }
    assert.equal(entry?.revision, 1)
    assert.equal(entry?.lease, undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  it('isolates identical fingerprints across scopes and filters queries by scope', async () => {
    const dir = tempDir()
    const store = new JsonlLedgerStore({ dir })
    await store.recordFact(commandInput('/project-a'), { operationId: 'op-a' })
    await store.recordFact(commandInput('/project-b'), { operationId: 'op-b' })
    assert.equal((await store.queryFacts()).length, 2)
    const inA = await store.queryFacts({ scope: '/project-a' })
    assert.equal(inA.length, 1)
    if (inA[0]?.fact.fingerprint.kind === 'command_failed') {
      assert.equal(inA[0].fact.fingerprint.cwd, '/project-a')
    }
    assert.equal((await store.queryFacts({ scope: '/project-c' })).length, 0)
    rmSync(dir, { recursive: true, force: true })
  })

  it('summarizes globally and per scope', async () => {
    const dir = tempDir()
    const store = new JsonlLedgerStore({ dir })
    const a = await store.recordFact(commandInput('/a'), { operationId: 'op-a' })
    const b = await store.recordFact(commandInput('/b', 'npm test'), { operationId: 'op-b' })
    await store.commitAttemptDecision({ factId: a.fact.id, expectedRevision: 1, decision: 'observe-warn', meta: { operationId: 'd-a' } })
    await store.commitAttemptDecision({ factId: b.fact.id, expectedRevision: 1, decision: 'deny', meta: { operationId: 'd-b' } })
    assert.deepEqual(await store.summarize(), {
      factsHit: 2,
      duplicateFailuresObserved: 1,
      warningsEmitted: 1,
      callsDenied: 1,
    })
    assert.deepEqual(await store.summarize('/a'), {
      factsHit: 1,
      duplicateFailuresObserved: 1,
      warningsEmitted: 1,
      callsDenied: 0,
    })
    rmSync(dir, { recursive: true, force: true })
  })

  it('grants an unconditional local lease on verify-retry and settles it', async () => {
    const dir = tempDir()
    const store = new JsonlLedgerStore({ dir })
    const fact = await store.recordFact(commandInput('/repo'), { operationId: 'op-1' })
    const denied = await store.commitAttemptDecision({ factId: fact.fact.id, expectedRevision: 1, decision: 'deny', meta: { operationId: 'd-1' } })
    assert.equal(denied.kind, 'applied')
    const retried = await store.commitAttemptDecision({
      factId: fact.fact.id,
      expectedRevision: 1,
      decision: 'verify-retry',
      meta: { operationId: 'v-1' },
      leaseRequest: { leaseId: 'L-1', owner: 'agent-1', ttlMs: 60000 },
    })
    assert.equal(retried.kind, 'applied')
    assert.equal(retried.kind === 'applied' ? retried.lease?.leaseId : undefined, 'L-1')
    assert.equal(await store.settleLease({ kind: 'succeeded', leaseId: 'L-1', owner: 'agent-1', meta: { operationId: 's-1' } }), 'applied')
    assert.deepEqual(await store.summarize(), {
      factsHit: 1,
      duplicateFailuresObserved: 0,
      warningsEmitted: 0,
      callsDenied: 1,
    })
    rmSync(dir, { recursive: true, force: true })
  })

  it('degrades batch transitions and rejects unknown leases; importJsonl stays unsupported', async () => {
    const dir = tempDir()
    const store = new JsonlLedgerStore({ dir })
    const fact = await store.recordFact(commandInput('/repo'), { operationId: 'op-1' })
    const transitioned = await store.transitionFacts([
      { id: fact.fact.id, expectedRevision: 1, transition: { kind: 'stale', at: new Date().toISOString(), staleWitnesses: ['env-state'] } },
    ], { operationId: 't-1' })
    assert.equal(transitioned[0]?.fact.status, 'stale')
    assert.equal(await store.settleLease({ kind: 'released', leaseId: 'unknown', owner: 'a', meta: { operationId: 's-1' } }), 'not-active')
    await assert.rejects(() => store.importJsonl(join(dir, 'x.jsonl')), /unsupported in the JSONL store/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('produces JSONL byte-compatible with the v0 engine', async () => {
    const dir = tempDir()
    const store = new JsonlLedgerStore({ dir })
    await store.recordFact(commandInput('/repo', 'npm   install'), { operationId: 'op-1' })
    const engine = new NegativeLedger({ dir })
    const facts = engine.facts()
    assert.equal(facts.length, 1)
    assert.equal(facts[0]?.status, 'active')
    if (facts[0]?.fingerprint.kind === 'command_failed') {
      assert.equal(facts[0].fingerprint.commandLine, 'npm   install')
      assert.equal(facts[0].fingerprint.cwd, '/repo')
    }
    rmSync(dir, { recursive: true, force: true })
  })
})
