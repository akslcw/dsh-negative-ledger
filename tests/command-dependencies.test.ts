/**
 * P2 command dependencies: declared, exact-match file dependencies for command
 * facts. Covers the freshness window, the no-backfill guarantee, anonymous
 * concurrency, cwd isolation, strict config validation (clone immutability,
 * UNC paths), and lease competition — over both store backends.
 *
 * Each fixture owns one temp dir and one ordered teardown (drain → close →
 * remove), so the suite is safe on Windows as well.
 * @module dsh-negative-ledger/tests/command-dependencies
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { TestContext } from 'node:test'
import { createLedgerPolicy } from '../src/plugin.ts'
import type { CommandDependency, ExecLike, LedgerPolicyConfig, PolicyCallbacks, ResultLike } from '../src/plugin.ts'
import { JsonlLedgerStore } from '../src/store-jsonl.ts'
import { SqliteLedgerStore } from '../src/store-sqlite.ts'
import type { FactInput, LedgerStore } from '../src/store.ts'
import type { NegativeFact, PreconditionEvidence } from '../src/types.ts'

const fail: ResultLike = { isError: false, value: { exitCode: 1, stderr: { text: 'boom' } } }
const ok: ResultLike = { isError: false, value: { exitCode: 0, stderr: { text: '' } } }

/** The precondition witnesses a fact carries (command facts also carry outcome ones). */
function preconditionsOf(fact: NegativeFact): PreconditionEvidence[] {
  return fact.evidence.filter((witness): witness is PreconditionEvidence => witness.role === 'precondition')
}

function fileStateOf(fact: NegativeFact, path: string): PreconditionEvidence | undefined {
  return preconditionsOf(fact).find(witness => witness.kind === 'file-state' && witness.path === path)
}

/** The version a recorded failure SUBMITTED for one declared file, if any. */
function declaredVersion(input: FactInput, path: string): string | undefined {
  for (const witness of input.evidence) {
    if (witness.role === 'precondition' && witness.kind === 'file-state' && witness.path === path && witness.observed === 'present') {
      return witness.version
    }
  }
  return undefined
}

/** The recorded version of a `present` file witness, or undefined when absent/missing. */
function witnessVersion(fact: NegativeFact, path: string): string | undefined {
  const witness = fileStateOf(fact, path)
  return witness?.kind === 'file-state' && witness.observed === 'present' ? witness.version : undefined
}

for (const backend of ['jsonl', 'sqlite'] as const) describe(`command dependencies (${backend})`, () => {
  function makeStore(dir: string): LedgerStore {
    return backend === 'sqlite' ? new SqliteLedgerStore({ dir }) : new JsonlLedgerStore({ dir })
  }

  function fixture(
    t: TestContext,
    config: LedgerPolicyConfig | ((ctx: { dir: string; dep: string; rule: (o?: Partial<CommandDependency>) => CommandDependency }) => LedgerPolicyConfig) = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), `ledger-cmddep-${backend}-`))
    const dep = join(dir, 'package-lock.json')
    const session = { header: { cwd: dir } }
    let serial = 0
    const exec = (overrides: { command?: string; cwd?: string; workdir?: string; callId?: string; session?: object; agent?: boolean } = {}): ExecLike => ({
      name: 'bash',
      arguments: {
        command: overrides.command ?? 'npm ci',
        ...(overrides.workdir === undefined ? {} : { workdir: overrides.workdir }),
      },
      ...(overrides.agent === false
        ? {}
        : { agent: { session: overrides.session ?? (overrides.cwd === undefined ? session : { header: { cwd: overrides.cwd } }) } }),
      // `callId: ''` stands in for a harness execution carrying no id at all.
      ...(overrides.callId === undefined
        ? { callId: `call-${++serial}` }
        : overrides.callId === '' ? {} : { callId: overrides.callId }),
    })
    const rule = (overrides: Partial<CommandDependency> = {}): CommandDependency =>
      ({ tool: 'bash', commandLine: 'npm ci', cwd: dir, files: [dep], ...overrides })
    const settings: LedgerPolicyConfig = {
      mode: 'block',
      commandRetryAfterMs: 600_000,
      ...(typeof config === 'function' ? config({ dir, dep, rule }) : config),
    }
    const stores: LedgerStore[] = []
    const policies: PolicyCallbacks[] = []
    // attach() opens another store+policy over the same directory — a fresh
    // observation cache, as a second process would have.
    const attach = (overrides: LedgerPolicyConfig = {}): { store: LedgerStore; policy: PolicyCallbacks } => {
      const store = makeStore(dir)
      const policy = createLedgerPolicy(store, { ...settings, ...overrides })
      stores.push(store)
      policies.push(policy)
      return { store, policy }
    }
    const primary = attach()
    // attachPolicy() is a second policy over the SAME store (lease competition).
    const attachPolicy = (overrides: LedgerPolicyConfig = {}): PolicyCallbacks => {
      const policy = createLedgerPolicy(primary.store, { ...settings, ...overrides })
      policies.push(policy)
      return policy
    }
    t.after(async () => {
      for (const policy of policies) await policy.drain()
      for (const store of stores.reverse()) await store.close()
      rmSync(dir, { recursive: true, force: true })
    })
    return { dir, dep, store: primary.store, policy: primary.policy, attach, attachPolicy, exec, rule }
  }

  /** Record one failed `npm ci` that passed pre-execution, and return the current fact. */
  async function recordFailure(f: ReturnType<typeof fixture>, exec: ExecLike): Promise<NegativeFact> {
    await f.policy.preExecute(exec)
    await f.policy.postExecute(exec, fail)
    return (await f.store.queryFacts())[0]!.fact
  }

  it('releases a blocked retry before the TTL once a declared dependency changes', async t => {
    const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()] }))
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    const fact = await recordFailure(f, f.exec())
    assert.equal(fact.status, 'active')
    assert.equal(witnessVersion(fact, f.dep), 'v1')
    // Unchanged dependency: still blocked, with the TTL as the only release.
    const denied = await f.policy.preExecute(f.exec())
    assert.equal(denied?.kind, 'deny')
    // The same dependency observed again at a new version is a real change.
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v2' })
    assert.equal(await f.policy.preExecute(f.exec()), undefined)
  })

  it('does not release on an unrelated observation', async t => {
    const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()] }))
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    await recordFailure(f, f.exec())
    await f.policy.observeFs({ displayPath: join(f.dir, 'unrelated.txt') }, { kind: 'present', version: 'v9' })
    const denied = await f.policy.preExecute(f.exec())
    assert.equal(denied?.kind, 'deny')
    // The declared dependency itself is unchanged, so the honest reason is
    // "still match" — not the incomplete-evidence one.
    assert.ok(denied?.kind === 'deny' && denied.reason.includes('Observed preconditions still match'))
  })

  it('treats an unknown dependency (fresh cache) as unknown, not as changed', async t => {
    const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()] }))
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    const fact = await recordFailure(f, f.exec())
    assert.equal(witnessVersion(fact, f.dep), 'v1')
    // A second policy that never observed this file cannot claim it changed.
    const observer = f.attach()
    const denied = await observer.policy.preExecute(f.exec())
    assert.equal(denied?.kind, 'deny')
    assert.ok(denied?.kind === 'deny' && denied.reason.includes('no change has been confirmed'))
    // NEVER observed in this context is a different message from expired: the
    // file is still named, but the reason is "nothing was recorded here", not
    // "what was recorded aged out".
    assert.ok(denied?.kind === 'deny' && denied.reason.includes(`no observation of ${f.dep}`))
    assert.ok(denied?.kind === 'deny' && !denied.reason.includes('is no longer fresh'))
  })

  it('treats an expired dependency observation as unknown until it is re-observed', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 10) })
    const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()], commandEvidenceMaxAgeMs: 60_000 }))
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    const fact = await recordFailure(f, f.exec())
    assert.equal(witnessVersion(fact, f.dep), 'v1')
    t.mock.timers.tick(61_000)
    const denied = await f.policy.preExecute(f.exec())
    assert.equal(denied?.kind, 'deny')
    assert.ok(denied?.kind === 'deny' && denied.reason.includes('no change has been confirmed'))
    // An EXPIRED observation is reported as exactly that: the file is named,
    // re-reading it is suggested, and no release is promised.
    assert.ok(denied?.kind === 'deny' && denied.reason.includes(f.dep))
    assert.ok(denied?.kind === 'deny' && denied.reason.includes('is no longer fresh'))
    assert.ok(denied?.kind === 'deny' && denied.reason.includes('may confirm a change and enable an early retry'))
    assert.ok(denied?.kind === 'deny' && !denied.reason.includes('cannot release the retry early'))
    // Fresh evidence releases it again — expiry alone changes nothing durable.
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v2' })
    assert.equal(await f.policy.preExecute(f.exec()), undefined)
  })

  it('stays denied within the TTL when a dependency changes and changes back', async t => {
    const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()] }))
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    await recordFailure(f, f.exec())
    // A transient change marks the fact stale in the store...
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v2' })
    assert.equal((await f.store.queryFacts())[0]?.fact.status, 'stale')
    // ...but reverting to the recorded version leaves nothing to release on:
    // a stale STATUS is not mismatched EVIDENCE.
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    const denied = await f.policy.preExecute(f.exec())
    assert.equal(denied?.kind, 'deny')
    assert.ok(denied?.kind === 'deny' && denied.reason.includes('Observed preconditions still match'))
  })

  it('releases the verification lease and leaves the fact unresolved when a retry is cancelled', async t => {
    const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()] }))
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    assert.equal((await recordFailure(f, f.exec())).status, 'active')
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v2' })
    const retry = f.exec()
    assert.equal(await f.policy.preExecute(retry), undefined)
    // Cancellation proves no failure, so the retry records nothing at all.
    const cancelled: ResultLike = { isError: true, error: { message: 'cancelled by the user', info: { code: 'ABORTED' } } }
    assert.deepEqual(await f.policy.postExecute(retry, cancelled), [])
    const after = (await f.store.queryFacts())[0]!.fact
    assert.equal(after.status, 'stale')
    assert.equal(witnessVersion(after, f.dep), 'v1')
    // The lease was released, not held: the next retry can apply for one
    // instead of being told a verification is already in progress.
    assert.equal(await f.policy.preExecute(f.exec()), undefined)
  })

  it('attaches the withdrawal note when the read-through path marks the repair stale', async t => {
    const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()] }))
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    await recordFailure(f, f.exec())
    // Hold the observation's invalidation pass at its first store read, so the
    // pre-dispatch read-through is deterministically the path that transitions
    // the fact. The 250ms backstop only guarantees the pass never stays stuck.
    const realQueryFacts = f.store.queryFacts.bind(f.store)
    let heldPass: (() => void) | undefined
    let holdNextRead = true
    f.store.queryFacts = async (...args: Parameters<LedgerStore['queryFacts']>) => {
      if (holdNextRead) {
        holdNextRead = false
        await new Promise<void>(resolve => { heldPass = resolve; setTimeout(resolve, 250) })
      }
      return realQueryFacts(...args)
    }
    void f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v2' })
    const retry = f.exec()
    assert.equal(await f.policy.preExecute(retry), undefined)
    // The read-through, not the pass, committed the staleness the lease was
    // granted on — and the lease must still report that it was.
    assert.equal((await f.store.queryFacts())[0]?.fact.status, 'stale')
    heldPass?.()
    await f.policy.drain()
    const contexts = await f.policy.postExecute(retry, ok)
    assert.equal(contexts.length, 1)
    assert.ok(contexts[0]?.content[0]?.text.includes('recorded preconditions changed'))
    assert.ok(contexts[0]?.content[0]?.text.includes('verification is allowed, but success is not guaranteed'))
    assert.equal((await f.store.queryFacts())[0]?.fact.status, 'resolved')
  })

  it('attaches the withdrawal note when the invalidation pass marked the repair stale first', async t => {
    const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()] }))
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    await recordFailure(f, f.exec())
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v2' })
    assert.equal((await f.store.queryFacts())[0]?.fact.status, 'stale')
    const retry = f.exec()
    assert.equal(await f.policy.preExecute(retry), undefined)
    const contexts = await f.policy.postExecute(retry, ok)
    assert.equal(contexts.length, 1)
    assert.ok(contexts[0]?.content[0]?.text.includes('recorded preconditions changed'))
    assert.equal((await f.store.queryFacts())[0]?.fact.status, 'resolved')
  })

  it('never backfills a dependency observed after the command was dispatched', async t => {
    const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()] }))
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    const exec = f.exec()
    await f.policy.preExecute(exec)
    // The command's own run changes the file before it settles.
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v2' })
    await f.policy.postExecute(exec, fail)
    const fact = (await f.store.queryFacts())[0]!.fact
    assert.equal(witnessVersion(fact, f.dep), 'v1')
  })

  it('records no command precondition without a pre-execution snapshot', async t => {
    const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()] }))
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    await f.policy.postExecute(f.exec(), fail)
    const fact = (await f.store.queryFacts())[0]!.fact
    assert.equal(preconditionsOf(fact).length, 0)
    // Without evidence, a later change cannot release it either.
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v2' })
    assert.equal((await f.policy.preExecute(f.exec()))?.kind, 'deny')
  })

  it('keeps concurrent anonymous invocations of one command apart', async t => {
    const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()] }))
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    const first = f.exec({ callId: '' })
    const second = f.exec({ callId: '' })
    await f.policy.preExecute(first)
    await f.policy.preExecute(second)
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v2' })
    await f.policy.postExecute(first, fail)
    assert.equal(witnessVersion((await f.store.queryFacts())[0]!.fact, f.dep), 'v1')
    // Sharing one snapshot would leave the second call with no evidence at all.
    await f.policy.postExecute(second, fail)
    const after = (await f.store.queryFacts())[0]!.fact
    assert.equal(witnessVersion(after, f.dep), 'v1')
    assert.equal(preconditionsOf(after).length, 1)
  })

  it('degrades to outcome + TTL when post-execute sees a different object', async t => {
    const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()] }))
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    const dispatched = f.exec({ callId: '' })
    await f.policy.preExecute(dispatched)
    // Same values, different object: identity is gone, so nothing is claimed.
    const settled: ExecLike = { name: 'bash', arguments: { command: 'npm ci' }, agent: { session: { header: { cwd: f.dir } } } }
    await f.policy.postExecute(settled, fail)
    const fact = (await f.store.queryFacts())[0]!.fact
    assert.equal(preconditionsOf(fact).length, 0)
  })

  it('keeps one call id apart across sessions', async t => {
    const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()] }))
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    // Two sessions issuing the SAME call id for the same command, with a
    // dependency change in between: neither may consume the other's snapshot.
    // The store treats a repeated call id as an idempotent replay (by design),
    // so the DURABLE effect is not the assertion — what each call submitted is.
    const submitted: (string | undefined)[] = []
    const record = f.store.recordFact.bind(f.store)
    f.store.recordFact = async (input, meta) => {
      submitted.push(declaredVersion(input, f.dep))
      return record(input, meta)
    }
    const first = f.exec({ session: { header: { cwd: f.dir } }, callId: 'shared' })
    await f.policy.preExecute(first)
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v2' })
    const second = f.exec({ session: { header: { cwd: f.dir } }, callId: 'shared' })
    await f.policy.preExecute(second)
    await f.policy.postExecute(first, fail)
    await f.policy.postExecute(second, fail)
    assert.deepEqual(submitted, ['v1', 'v2'])
  })

  it('falls back to execution-object identity when there is no session object', async t => {
    const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()] }))
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    const anonymous = (callId: string) => f.exec({ agent: false, workdir: f.dir, callId })
    const dispatched = anonymous('no-session')
    await f.policy.preExecute(dispatched)
    // A different object with the same call id has no identity: no backfill.
    await f.policy.postExecute(anonymous('no-session'), fail)
    assert.equal(preconditionsOf((await f.store.queryFacts())[0]!.fact).length, 0)
    // The object that did freeze keeps its own evidence.
    const settled = anonymous('no-session-2')
    await f.policy.preExecute(settled)
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v2' })
    await f.policy.postExecute(settled, fail)
    assert.equal(witnessVersion((await f.store.queryFacts())[0]!.fact, f.dep), 'v1')
  })

  it('drops a leftover snapshot when a reused call settles after the dependency expired', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 10) })
    const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()], commandEvidenceMaxAgeMs: 60_000 }))
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    // First dispatch freezes v1 and never settles, leaving it on the call key.
    await f.policy.preExecute(f.exec({ callId: 'reused' }))
    t.mock.timers.tick(61_000)
    const settled = f.exec({ callId: 'reused' })
    await f.policy.preExecute(settled)
    await f.policy.postExecute(settled, fail)
    // The now-expired v1 must not reappear as this call's evidence.
    assert.equal(preconditionsOf((await f.store.queryFacts())[0]!.fact).length, 0)
    assert.equal((await f.policy.preExecute(f.exec()))?.kind, 'deny')
  })

  it('re-records the snapshot version on a failed verification retry, then resolves on success', async t => {
    const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()] }))
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    await recordFailure(f, f.exec())
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v2' })
    const retry = f.exec()
    assert.equal(await f.policy.preExecute(retry), undefined)
    await f.policy.postExecute(retry, fail)
    const afterRetry = (await f.store.queryFacts())[0]!.fact
    assert.equal(afterRetry.status, 'active')
    assert.equal(witnessVersion(afterRetry, f.dep), 'v2')
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v3' })
    const success = f.exec()
    assert.equal(await f.policy.preExecute(success), undefined)
    await f.policy.postExecute(success, ok)
    assert.equal((await f.store.queryFacts())[0]?.fact.status, 'resolved')
  })

  it('matches only the declared tool, command line, and effective cwd', async t => {
    const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()] }))
    await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
    const nested = join(f.dir, 'nested')
    const workdirMatch = f.exec({ cwd: nested, workdir: f.dir })
    const otherCwd = f.exec({ cwd: nested })
    const otherCommand = f.exec({ command: 'npm install' })
    for (const exec of [workdirMatch, otherCwd, otherCommand]) await recordFailure(f, exec)
    const facts = await f.store.queryFacts()
    const index = new Map(facts.map(entry => {
      const fingerprint = entry.fact.fingerprint
      const key = fingerprint.kind === 'command_failed' ? `${fingerprint.cwd}|${fingerprint.commandLine}` : entry.fact.id
      return [key, entry.fact]
    }))
    // `workdir` decides the effective cwd: the session cwd is irrelevant.
    assert.equal(preconditionsOf(index.get(`${f.dir}|npm ci`)!).length, 1)
    assert.equal(preconditionsOf(index.get(`${nested}|npm ci`)!).length, 0)
    assert.equal(preconditionsOf(index.get(`${f.dir}|npm install`)!).length, 0)
  })

  if (backend === 'sqlite') {
    it('settles concurrent anonymous commands by execution identity, not by tool name', async t => {
      const f = fixture(t, { commandRetryAfterMs: 1 })
      const first = f.exec({ command: 'npm ci', callId: '' })
      const second = f.exec({ command: 'npm install', callId: '' })
      await f.policy.postExecute(first, fail)
      await f.policy.postExecute(second, fail)
      await new Promise(resolve => setTimeout(resolve, 20))
      // Both calls now hold their own verification lease.
      assert.equal(await f.policy.preExecute(first), undefined)
      assert.equal(await f.policy.preExecute(second), undefined)
      await f.policy.postExecute(second, ok)
      const afterSecond = new Map((await f.store.queryFacts()).map(entry => {
        const fingerprint = entry.fact.fingerprint
        return [fingerprint.kind === 'command_failed' ? fingerprint.commandLine : '', entry.fact.status]
      }))
      assert.equal(afterSecond.get('npm install'), 'resolved')
      assert.equal(afterSecond.get('npm ci'), 'active')
      // Completing them in reverse dispatch order must still settle both.
      await f.policy.postExecute(first, ok)
      const afterFirst = new Map((await f.store.queryFacts()).map(entry => {
        const fingerprint = entry.fact.fingerprint
        return [fingerprint.kind === 'command_failed' ? fingerprint.commandLine : '', entry.fact.status]
      }))
      assert.equal(afterFirst.get('npm ci'), 'resolved')
      assert.equal(afterFirst.get('npm install'), 'resolved')
    })

    it('grants a released command\'s verification lease to exactly one policy', async t => {
      const f = fixture(t, ctx => ({ commandDependencies: [ctx.rule()] }))
      const observer = f.attachPolicy()
      await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
      await observer.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v1' })
      await recordFailure(f, f.exec())
      await f.policy.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v2' })
      await observer.observeFs({ displayPath: f.dep }, { kind: 'present', version: 'v2' })
      assert.equal(await f.policy.preExecute(f.exec()), undefined)
      const loser = await observer.preExecute(f.exec())
      assert.equal(loser?.kind, 'deny')
      assert.ok(loser?.kind === 'deny' && loser.reason.includes('in progress'))
    })
  }
})

describe('command dependency config validation', () => {
  const base: CommandDependency = { tool: 'bash', commandLine: 'npm ci', cwd: '/repo', files: ['/repo/package-lock.json'] }

  it('rejects duplicates, empty file lists, relative paths, and invalid ages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-cmddep-config-'))
    const store = new JsonlLedgerStore({ dir })
    const mount = (config: LedgerPolicyConfig) => createLedgerPolicy(store, config)
    assert.throws(() => mount({ commandDependencies: [base, { ...base }] }), /duplicate commandDependencies/)
    assert.throws(() => mount({ commandDependencies: [base, { ...base, files: ['/repo/other.json'] }] }), /duplicate commandDependencies/)
    assert.throws(() => mount({ commandDependencies: [{ ...base, files: [] }] }), /non-empty array/)
    assert.throws(() => mount({ commandDependencies: [{ ...base, files: ['package-lock.json'] }] }), /absolute displayPaths/)
    assert.throws(() => mount({ commandDependencies: [{ ...base, files: ['C:lock.json'] }] }), /absolute displayPaths/)
    assert.throws(() => mount({ commandDependencies: [{ ...base, files: [123 as unknown as string] }] }), /non-empty string/)
    assert.throws(() => mount({ commandDependencies: [{ ...base, commandLine: '' }] }), /commandLine/)
    assert.throws(() => mount({ commandDependencies: [null as unknown as CommandDependency] }), /expected an object/)
    assert.throws(() => mount({ commandDependencies: 'nope' as unknown as CommandDependency[] }), /expected an array/)
    assert.throws(() => mount({ commandEvidenceMaxAgeMs: 0 }), /commandEvidenceMaxAgeMs/)
    assert.throws(() => mount({ commandEvidenceMaxAgeMs: 1.5 }), /commandEvidenceMaxAgeMs/)
    // Windows drive and UNC displayPaths are absolute on the benchmark host.
    assert.doesNotThrow(() => mount({ commandDependencies: [{ ...base, files: ['C:\\repo\\package-lock.json'] }] }))
    assert.doesNotThrow(() => mount({ commandDependencies: [{ ...base, files: ['\\\\server\\share\\package-lock.json'] }] }))
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('clones the declared rules so later mutation cannot widen them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-cmddep-clone-'))
    const store = new JsonlLedgerStore({ dir })
    const files = ['/repo/package-lock.json']
    const rule: CommandDependency = { tool: 'bash', commandLine: 'npm ci', cwd: '/repo', files }
    const policy = createLedgerPolicy(store, { mode: 'block', commandDependencies: [rule] })
    // Mutating the caller's array and rule after mount must change nothing.
    files.push('/etc/shadow')
    rule.files = []
    rule.commandLine = 'rm -rf /'
    await policy.observeFs({ displayPath: '/repo/package-lock.json' }, { kind: 'present', version: 'v1' })
    await policy.observeFs({ displayPath: '/etc/shadow' }, { kind: 'present', version: 'v9' })
    const exec: ExecLike = { name: 'bash', arguments: { command: 'npm ci' }, agent: { session: { header: { cwd: '/repo' } } }, callId: 'call-1' }
    await policy.preExecute(exec)
    await policy.postExecute(exec, fail)
    const fact = (await store.queryFacts())[0]!.fact
    assert.equal(preconditionsOf(fact).length, 1)
    assert.equal(witnessVersion(fact, '/repo/package-lock.json'), 'v1')
    assert.equal(fileStateOf(fact, '/etc/shadow'), undefined)
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
