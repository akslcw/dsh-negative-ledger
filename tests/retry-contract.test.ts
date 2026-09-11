import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { createLedgerPolicy } from '../src/plugin.ts'
import type { ExecLike, LedgerPolicyConfig, ResultLike } from '../src/plugin.ts'
import { JsonlLedgerStore } from '../src/store-jsonl.ts'
import { SqliteLedgerStore } from '../src/store-sqlite.ts'

const fail = (error = 'missing config'): ResultLike => ({ isError: false, value: { exitCode: 1, stderr: { text: error } } })
const ok: ResultLike = { isError: false, value: { exitCode: 0 } }
const missing: ResultLike = { isError: true, error: { info: { code: 'FS_NOT_FOUND' } } }
const text = (contexts: Awaited<ReturnType<ReturnType<typeof createLedgerPolicy>['postExecute']>>) => contexts.map(c => c.content.map(v => v.text).join('\n')).join('\n')

for (const backend of ['jsonl', 'sqlite'] as const) describe(`retry contract (${backend})`, () => {
  function fixture(t: { after(fn: () => Promise<void>): void }, config: LedgerPolicyConfig = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-contract-'))
    const store = backend === 'sqlite' ? new SqliteLedgerStore({ dir }) : new JsonlLedgerStore({ dir })
    const policy = createLedgerPolicy(store, config)
    t.after(async () => { await policy.drain(); await store.close(); rmSync(dir, { recursive: true, force: true }) })
    const session = { header: { cwd: dir } }
    let serial = 0
    const exec = (): ExecLike => ({ name: 'bash', arguments: { command: 'check-config' }, agent: { session }, callId: `call-${++serial}` })
    return { dir, store, policy, exec }
  }

  it('characterizes the P2 gap: a repaired command is still denied until TTL expires', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 10) })
    const f = fixture(t, { mode: 'block', commandRetryAfterMs: 5000 })
    const flag = join(f.dir, 'config.txt')
    const probe = () => spawnSync(process.execPath, ['-e', 'process.exit(require("node:fs").existsSync(process.argv[1]) ? 0 : 1)', flag]).status
    assert.equal(probe(), 1)
    await f.policy.postExecute(f.exec(), fail())
    writeFileSync(flag, 'fixed')
    await f.policy.observeFs({ displayPath: flag }, { kind: 'present', version: 'fixed' })
    assert.equal(probe(), 0, 'the command can actually succeed after the repair')
    const denied = await f.policy.preExecute(f.exec())
    assert.equal(denied?.kind, 'deny')
    assert.ok(denied?.kind === 'deny' && denied.reason.includes('No precondition evidence'))
    assert.ok(denied?.kind === 'deny' && denied.reason.includes('2026-09-10T00:00:05.000Z'))
    assert.equal((await f.store.queryFacts())[0]?.fact.status, 'active')
    t.mock.timers.tick(5000)
    const retry = f.exec()
    assert.equal(await f.policy.preExecute(retry), undefined)
    await f.policy.postExecute(retry, ok)
    assert.equal((await f.store.queryFacts())[0]?.fact.status, 'resolved')
  })

  it('suppresses repeated warnings without suppressing failure counts or altering results', async t => {
    const f = fixture(t)
    const result = fail()
    const before = structuredClone(result)
    await f.policy.postExecute(f.exec(), result)
    assert.match(text(await f.policy.postExecute(f.exec(), result)), /Advisory only/)
    assert.deepEqual(await f.policy.postExecute(f.exec(), result), [])
    assert.deepEqual(result, before)
    assert.deepEqual(await f.store.summarize(), { factsHit: 1, duplicateFailuresObserved: 2, warningsEmitted: 1, callsDenied: 0 })
  })

  it('allows independently testing text changes with suppression disabled', async t => {
    const f = fixture(t, { warningRepeatAfterMs: 0 })
    await f.policy.postExecute(f.exec(), fail())
    assert.equal((await f.policy.postExecute(f.exec(), fail())).length, 1)
    assert.equal((await f.policy.postExecute(f.exec(), fail())).length, 1)
    assert.equal((await f.store.summarize()).warningsEmitted, 2)
  })

  it('warns again after the notification interval despite a sliding command TTL', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 10) })
    const f = fixture(t, { warningRepeatAfterMs: 1000 })
    await f.policy.postExecute(f.exec(), fail())
    assert.equal((await f.policy.postExecute(f.exec(), fail())).length, 1)
    t.mock.timers.tick(500)
    assert.deepEqual(await f.policy.postExecute(f.exec(), fail()), [])
    t.mock.timers.tick(500)
    assert.equal((await f.policy.postExecute(f.exec(), fail())).length, 1)
  })

  it('does not hide a changed error or another session warning', async t => {
    const f = fixture(t)
    await f.policy.postExecute(f.exec(), fail())
    await f.policy.postExecute(f.exec(), fail())
    assert.equal((await f.policy.postExecute(f.exec(), fail('permission denied'))).length, 1)
    const another = { ...f.exec(), agent: { session: { header: { cwd: f.dir } } } }
    assert.equal((await f.policy.postExecute(another, fail('permission denied'))).length, 1)
  })

  it('reports missing current evidence honestly while retaining the existing conservative verdict', async t => {
    const f = fixture(t, { mode: 'block' })
    const exec: ExecLike = { name: 'read', arguments: { file_path: '/missing.txt' }, callId: 'missing' }
    await f.policy.postExecute(exec, missing)
    const unknown = await f.policy.preExecute({ ...exec, callId: 'unknown' })
    assert.ok(unknown?.kind === 'deny' && unknown.reason.includes('evidence is incomplete'))
    await f.policy.observeFs({ displayPath: '/missing.txt' }, { kind: 'absent' })
    const same = await f.policy.preExecute({ ...exec, callId: 'same' })
    assert.ok(same?.kind === 'deny' && same.reason.includes('Observed preconditions still match'))
    await f.policy.observeFs({ displayPath: '/unrelated.txt' }, { kind: 'present', version: 'v1' })
    assert.equal((await f.policy.preExecute({ ...exec, callId: 'unrelated' }))?.kind, 'deny')
    await f.policy.observeFs({ displayPath: '/missing.txt' }, { kind: 'present', version: 'v1' })
    const retry = { ...exec, callId: 'retry' }
    assert.equal(await f.policy.preExecute(retry), undefined)
    await f.policy.postExecute(retry, { isError: false, value: 'content' })
    assert.equal((await f.store.queryFacts())[0]?.fact.status, 'resolved')
  })

  it('reports the deadline persisted by the latest failure, not the previous deadline', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 10) })
    const f = fixture(t, { commandRetryAfterMs: 5000 })
    await f.policy.postExecute(f.exec(), fail())
    t.mock.timers.tick(4000)
    const warning = text(await f.policy.postExecute(f.exec(), fail()))
    const fact = (await f.store.queryFacts())[0]!.fact
    assert.ok(fact.retryCondition?.type === 'after')
    assert.equal(fact.retryCondition.at, '2026-09-10T00:00:09.000Z')
    assert.ok(warning.includes(fact.retryCondition.at))
  })

  it('does not suppress a concurrent warning when the pending warning commit fails', async t => {
    const f = fixture(t)
    await f.policy.postExecute(f.exec(), fail())
    const commit = f.store.commitAttemptDecision.bind(f.store)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    let first = true
    f.store.commitAttemptDecision = async request => {
      if (first && request.decision === 'observe-warn') {
        first = false
        enter()
        await blocked
        return { kind: 'unavailable', reason: 'injected store failure' }
      }
      return commit(request)
    }
    const a = f.policy.postExecute(f.exec(), fail())
    await entered
    const b = f.policy.postExecute(f.exec(), fail())
    // Give B time to encounter the pending reservation before A is released.
    await new Promise<void>(resolve => setImmediate(resolve))
    release()
    const [aMessages, bMessages] = await Promise.all([a, b])
    assert.equal(aMessages.length, 0)
    assert.equal(bMessages.length, 1)
    assert.equal((await f.store.summarize()).warningsEmitted, 1)
  })

  it('resets suppression after a successful attempt', async t => {
    const f = fixture(t)
    await f.policy.postExecute(f.exec(), fail())
    await f.policy.postExecute(f.exec(), fail())
    await f.policy.postExecute(f.exec(), ok)
    await f.policy.postExecute(f.exec(), fail())
    assert.equal((await f.policy.postExecute(f.exec(), fail())).length, 1)
  })
})
