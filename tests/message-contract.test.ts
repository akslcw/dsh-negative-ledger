/**
 * Regression guard for DSH's durable `user/message` contract (issue #2).
 *
 * DSH persists every `additionalContexts` entry verbatim as a `user/message`
 * event and re-validates it when the session is loaded. Its restore validator
 * (`assertMessageEventShape` in `@deepseek-ai/dsh-session`) requires an
 * identified message: a non-empty `id`, `role: 'user'`, a source with a
 * non-empty `kind`, and array content. A context that misses identity is
 * written happily and only makes the whole session unloadable on restart, so
 * every producer — warning, stale note, and in-progress advisory — must be
 * checked at the boundary this plugin owns.
 * @module dsh-negative-ledger/tests/message-contract
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createLedgerPolicy } from '../src/plugin.ts'
import { JsonlLedgerStore } from '../src/store-jsonl.ts'
import { SqliteLedgerStore } from '../src/store-sqlite.ts'
import type { ContextMessage, ExecLike, ResultLike } from '../src/plugin.ts'
import type { FactInput } from '../src/store.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'negledger-message-contract-'))
}

function bashExec(command: string, callId?: string): ExecLike {
  return { name: 'bash', arguments: { command }, ...(callId === undefined ? {} : { callId }) }
}

function bashFail(exitCode: number): ResultLike {
  return { isError: false, value: { exitCode, stderr: { text: 'ETIMEDOUT' } } }
}

function bashOk(): ResultLike {
  return { isError: false, value: { exitCode: 0, stderr: { text: '' } } }
}

function readExec(path: string): ExecLike {
  return { name: 'read', arguments: { file_path: path } }
}

function readNotFound(): ResultLike {
  return { isError: true, error: { message: 'cannot read "/x.txt": not found', info: { code: 'FS_NOT_FOUND' } } }
}

function readOk(): ResultLike {
  return { isError: false, value: { content: 'text' } }
}

function allowFact(commandLine: string): FactInput {
  return {
    kind: 'command_failed',
    scope: '',
    fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine }),
    claim: 'command exited 1 (bash)',
    evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'x' }],
    retryCondition: { type: 'after', at: '2000-01-01T00:00:00.000Z' },
  }
}

/**
 * The invariants DSH's restore validator applies to a persisted
 * `user/message` event (see `assertMessageEventShape`). Kept structural so the
 * suite runs without a DSH install; `smoke/real-dsh-p2.ts` additionally feeds
 * the emitted contexts through the real validator.
 */
function assertIdentifiedUserMessage(context: ContextMessage, label: string): void {
  const candidate = context as ContextMessage & { readonly id?: unknown; readonly role?: unknown }
  assert.equal(typeof candidate.id, 'string', `${label}: user message must carry a string id`)
  assert.notEqual(candidate.id, '', `${label}: user message id must be non-empty`)
  assert.equal(candidate.role, 'user', `${label}: user message role must be 'user'`)
  assert.equal(typeof context.source, 'object', `${label}: user message source must be an object`)
  assert.equal(typeof context.source.kind, 'string', `${label}: source.kind must be a string`)
  assert.notEqual(context.source.kind, '', `${label}: source.kind must be non-empty`)
  assert.ok(Array.isArray(context.content), `${label}: content must be an array`)
}

/** Distinct ids matter: DSH keys identity on them, so a shared id aliases messages. */
function assertDistinctIds(contexts: readonly ContextMessage[]): void {
  const ids = contexts.map(context => (context as ContextMessage & { readonly id?: unknown }).id)
  assert.equal(new Set(ids).size, contexts.length, 'every context must carry its own id')
}

describe('DSH user/message contract', () => {
  it('stamps identity on the repeat-failure warning', async () => {
    const dir = tempDir()
    const policy = createLedgerPolicy(new JsonlLedgerStore({ dir }))
    const exec = bashExec('npm install')
    await policy.postExecute(exec, bashFail(1))
    const contexts = await policy.postExecute(exec, bashFail(1))
    assert.equal(contexts.length, 1)
    assertIdentifiedUserMessage(contexts[0]!, 'warnMessage')
    rmSync(dir, { recursive: true, force: true })
  })

  it('stamps identity on the evidence-changed note', async () => {
    const dir = tempDir()
    const store = new JsonlLedgerStore({ dir })
    const policy = createLedgerPolicy(store, { mode: 'block' })
    await policy.observeFs({ displayPath: '/x.txt' }, { kind: 'absent' })
    const exec = readExec('/x.txt')
    await policy.postExecute(exec, readNotFound())
    await policy.observeFs({ displayPath: '/x.txt' }, { kind: 'present', version: 'v1' })
    const contexts = await policy.postExecute(exec, readOk())
    assert.equal(contexts.length, 1)
    assert.ok(contexts[0]!.content[0]!.text.includes('verification is allowed'))
    assertIdentifiedUserMessage(contexts[0]!, 'staleNote')
    rmSync(dir, { recursive: true, force: true })
  })

  it('stamps identity on the in-progress advisory', async () => {
    const dir = tempDir()
    const storeA = new SqliteLedgerStore({ dir })
    const storeB = new SqliteLedgerStore({ dir })
    const policyA = createLedgerPolicy(storeA, { mode: 'warn' })
    const policyB = createLedgerPolicy(storeB, { mode: 'warn' })
    try {
      await storeA.recordFact(allowFact('npm test'), { operationId: 'seed' })
      const exec = bashExec('npm test', 'call-npm-test')
      // A takes the verification lease; B is the non-holder, and its
      // pre-execute pass is what records the in-progress advisory.
      assert.equal(await policyA.preExecute(exec), undefined)
      assert.equal(await policyB.preExecute(exec), undefined)
      const contexts = await policyB.postExecute(exec, bashFail(2))
      const advisory = contexts.find(context =>
        context.content[0]?.text.includes('another agent is verifying this path'))
      assert.ok(advisory !== undefined, 'non-holder must receive the in-progress advisory')
      assertIdentifiedUserMessage(advisory, 'inProgressMessage')
    } finally {
      await storeA.close()
      await storeB.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives every emitted context its own id', async () => {
    const dir = tempDir()
    const policy = createLedgerPolicy(new JsonlLedgerStore({ dir }), { warningRepeatAfterMs: 0 })
    const exec = bashExec('npm install')
    await policy.postExecute(exec, bashFail(1))
    const first = await policy.postExecute(exec, bashFail(1))
    const second = await policy.postExecute(exec, bashFail(1))
    assert.equal(first.length + second.length, 2, 'both repeats must warn with suppression disabled')
    assertDistinctIds([...first, ...second])
    rmSync(dir, { recursive: true, force: true })
  })
})
