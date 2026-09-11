/**
 * SQLite-backend plugin integration tests: the M3 wiring over the real
 * transactional store, covering both enforcement modes and the
 * holder/non-holder settlement rules.
 * @module dsh-negative-ledger/tests/plugin-sqlite
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createLedgerPolicy } from '../src/plugin.ts'
import { SqliteLedgerStore } from '../src/store-sqlite.ts'
import type { ExecLike, ResultLike } from '../src/plugin.ts'
import type { FactInput } from '../src/store.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'negledger-plugin-sqlite-'))
}

function bashExec(command: string): ExecLike {
  return { name: 'bash', arguments: { command }, callId: `call-${command}` }
}

function bashFail(exitCode: number): ResultLike {
  return { isError: false, value: { exitCode, stderr: { text: 'ETIMEDOUT' } } }
}

function bashOk(): ResultLike {
  return { isError: false, value: { exitCode: 0, stderr: { text: '' } } }
}

function allowFact(commandLine: string): FactInput {
  return {
    kind: 'command_failed',
    scope: '',
    fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine }),
    claim: `command exited 1 (bash)`,
    evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'x' }],
    retryCondition: { type: 'after', at: '2000-01-01T00:00:00.000Z' },
  }
}

async function twoPolicies(modeA: 'warn' | 'block', modeB: 'warn' | 'block') {
  const dir = tempDir()
  const storeA = new SqliteLedgerStore({ dir })
  const storeB = new SqliteLedgerStore({ dir })
  const policyA = createLedgerPolicy(storeA, { mode: modeA })
  const policyB = createLedgerPolicy(storeB, { mode: modeB })
  return { dir, storeA, storeB, policyA, policyB }
}

describe('plugin over the SQLite store', () => {
  it('warn mode warns on a repeat and records honest SQLite counters', async () => {
    const { dir, storeA, storeB, policyA } = await twoPolicies('warn', 'warn')
    const exec = bashExec('npm install')
    assert.deepEqual(await policyA.postExecute(exec, bashFail(1)), [])
    const contexts = await policyA.postExecute(exec, bashFail(1))
    assert.equal(contexts.length, 1)
    assert.ok(contexts[0]?.content[0]?.text.includes('Retry cooldown until'))
    assert.deepEqual(await storeA.summarize(), {
      factsHit: 1,
      duplicateFailuresObserved: 1,
      warningsEmitted: 1,
      callsDenied: 0,
    })
    await storeA.close()
    await storeB.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('block mode: the lease loser is denied with the in-progress reason; the holder settles', async () => {
    const { dir, storeA, storeB, policyA, policyB } = await twoPolicies('block', 'block')
    await storeA.recordFact(allowFact('npm test'), { operationId: 'seed' })
    const exec = bashExec('npm test')
    assert.equal(await policyA.preExecute(exec), undefined)
    const denied = await policyB.preExecute(exec)
    assert.equal(denied?.kind, 'deny')
    assert.ok(denied?.kind === 'deny' && denied.reason.includes('verification retry already in progress'))
    assert.equal((await storeA.queryFacts())[0]?.lease?.owner, exec.callId)
    await policyA.postExecute(exec, bashOk())
    assert.equal((await storeA.queryFacts())[0]?.fact.status, 'resolved')
    await storeA.close()
    await storeB.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('warn mode: the loser runs but only observes; only the holder settles', async () => {
    const { dir, storeA, storeB, policyA, policyB } = await twoPolicies('warn', 'warn')
    await storeA.recordFact(allowFact('npm test'), { operationId: 'seed' })
    const exec = bashExec('npm test')
    assert.equal(await policyA.preExecute(exec), undefined)
    assert.equal(await policyB.preExecute(exec), undefined)
    // Non-holder failure: observed, never recorded (store rejects the write).
    const contexts = await policyB.postExecute(exec, bashFail(2))
    assert.ok(contexts.some(c => c.content[0]?.text.includes('another agent is verifying this path')))
    const before = (await storeB.queryFacts())[0]
    assert.equal(before?.fact.claim, 'command exited 1 (bash)')
    assert.equal(before?.revision, 1)
    assert.equal(before?.fact.status, 'active')
    // Holder succeeds: settlement applies.
    await policyA.postExecute(exec, bashOk())
    const after = (await storeA.queryFacts())[0]
    assert.equal(after?.fact.status, 'resolved')
    assert.equal(after?.revision, 2)
    await storeA.close()
    await storeB.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a non-holder success cannot resolve a leased fact', async () => {
    const { dir, storeA, storeB, policyA, policyB } = await twoPolicies('warn', 'warn')
    await storeA.recordFact(allowFact('npm test'), { operationId: 'seed' })
    const exec = bashExec('npm test')
    assert.equal(await policyA.preExecute(exec), undefined)
    assert.equal(await policyB.preExecute(exec), undefined)
    await policyB.postExecute(exec, bashOk())
    const stillActive = (await storeA.queryFacts())[0]
    assert.equal(stillActive?.fact.status, 'active')
    assert.equal(stillActive?.revision, 1)
    await policyA.postExecute(exec, bashOk())
    assert.equal((await storeA.queryFacts())[0]?.fact.status, 'resolved')
    await storeA.close()
    await storeB.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('cross-session evidence isolation (SQLite store)', () => {
  function readExec(path: string, cwd: string): ExecLike {
    return { name: 'read', arguments: { file_path: path }, agent: { session: { header: { cwd } } } }
  }

  const readNotFound: ResultLike = {
    isError: true,
    error: { message: 'cannot read: not found', info: { code: 'FS_NOT_FOUND' } },
  }

  /** The precondition witness paths a fact carries, in recorded order. */
  function witnessPaths(fact: { evidence: readonly unknown[] }): string[] {
    return (fact.evidence as { role: string; kind: string; path: string }[])
      .filter(witness => witness.role === 'precondition' && witness.kind === 'file-state')
      .map(witness => witness.path)
  }

  it('keeps one session\'s repair from releasing another session\'s missing file', async () => {
    const dir = tempDir()
    const store = new SqliteLedgerStore({ dir })
    const policy = createLedgerPolicy(store, { mode: 'block' })
    const sessionA = { header: { cwd: '/ws/a' } }
    const sessionB = { header: { cwd: '/ws/b' } }
    const observe = (displayPath: string, observation: { kind: 'absent' } | { kind: 'present'; version: string }, session: object) =>
      policy.observeFs({ displayPath }, observation, {
        name: 'read',
        arguments: { file_path: 'config.json' },
        agent: { session },
      })
    try {
      // Interleaved: A's fact is recorded after B observed its own file.
      await observe('/ws/a/config.json', { kind: 'absent' }, sessionA)
      await observe('/ws/b/config.json', { kind: 'absent' }, sessionB)
      await policy.postExecute(readExec('config.json', '/ws/a'), readNotFound)
      const factA = (await store.queryFacts())
        .map(entry => entry.fact)
        .find(fact => fact.fingerprint.kind === 'file_missing' && fact.fingerprint.cwd === '/ws/a')
      assert.ok(factA !== undefined, 'A\'s failure must be recorded as its own fact')
      assert.deepEqual(witnessPaths(factA), ['/ws/a\u0000config.json', '/ws/a/config.json'])

      // B's repair is not evidence about A's file.
      await observe('/ws/b/config.json', { kind: 'present', version: 'v1' }, sessionB)
      const denied = await policy.preExecute(readExec('config.json', '/ws/a'))
      assert.equal(denied?.kind, 'deny')
      assert.ok(denied?.kind === 'deny' && denied.reason.includes('Observed preconditions still match'))

      // A's own repair releases A's fact.
      await observe('/ws/a/config.json', { kind: 'present', version: 'v2' }, sessionA)
      assert.equal(await policy.preExecute(readExec('config.json', '/ws/a')), undefined)
    } finally {
      await policy.drain()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
