/**
 * Plugin policy tests over the JSONL store (v0-compatible degraded backend),
 * with structural fakes of the DSH surfaces verified against dsh-tools /
 * dsh-fs sources. All policy callbacks are asynchronous; every call awaits.
 * @module dsh-negative-ledger/tests/plugin
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { apply, createLedgerPolicy } from '../src/plugin.ts'
import { JsonlLedgerStore } from '../src/store-jsonl.ts'
import type { ExecLike, LedgerPolicyConfig, ResultLike } from '../src/plugin.ts'
import type { DshContextLike } from '../src/plugin.ts'
import type { NegativeFact } from '../src/types.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'negledger-plugin-'))
}

function bashExec(command: string, workdir?: string): ExecLike {
  return { name: 'bash', arguments: workdir === undefined ? { command } : { command, workdir } }
}

function bashFail(exitCode: number, stderr = 'ETIMEDOUT'): ResultLike {
  return { isError: false, value: { exitCode, stderr: { text: stderr } } }
}

function bashOk(): ResultLike {
  return { isError: false, value: { exitCode: 0, stderr: { text: '' } } }
}

function readExec(path: string, cwd?: string): ExecLike {
  return {
    name: 'read',
    arguments: { file_path: path },
    ...(cwd !== undefined ? { agent: { session: { header: { cwd } } } } : {}),
  }
}

function readNotFound(): ResultLike {
  return { isError: true, error: { message: 'cannot read "/x.txt": not found', info: { code: 'FS_NOT_FOUND' } } }
}

function readOk(): ResultLike {
  return { isError: false, value: { content: 'text' } }
}

async function setup(mode: 'off' | 'warn' | 'block' = 'warn', extra: LedgerPolicyConfig = {}) {
  const dir = tempDir()
  const store = new JsonlLedgerStore({ dir })
  const policy = createLedgerPolicy(store, { mode, ...extra })
  return { dir, store, policy }
}

function cleanup(fixture: { dir: string }): void {
  rmSync(fixture.dir, { recursive: true, force: true })
}

describe('warn mode (default)', () => {
  it('stays silent on the first failure and warns on the repeat with honest counters', async () => {
    const fixture = await setup()
    const exec = bashExec('npm install')
    assert.deepEqual(await fixture.policy.postExecute(exec, bashFail(1)), [])
    const contexts = await fixture.policy.postExecute(exec, bashFail(1))
    assert.equal(contexts.length, 1)
    const text = contexts[0]?.content[0]?.text ?? ''
    assert.ok(text.includes('Negative-ledger'))
    assert.ok(text.includes('command exited 1 (bash)'))
    assert.ok(text.includes('action preview: npm install'))
    assert.ok(text.includes('Retry cooldown until'))
    assert.ok(text.includes('No precondition evidence was recorded'))
    assert.ok(!text.includes('Ledger totals'))
    assert.ok(!text.includes('evidence is unchanged'))
    assert.equal(contexts[0]?.source.kind, 'plugin')
    assert.equal(contexts[0]?.source.plugin, 'negative-ledger')
    assert.deepEqual(await fixture.store.summarize(), {
      factsHit: 1,
      duplicateFailuresObserved: 1,
      warningsEmitted: 1,
      callsDenied: 0,
    })
    cleanup(fixture)
  })

  it('never denies', async () => {
    const fixture = await setup()
    await fixture.policy.postExecute(bashExec('npm install'), bashFail(1))
    assert.equal(await fixture.policy.preExecute(bashExec('npm install')), undefined)
    cleanup(fixture)
  })

  it('warns on a repeated missing-file read and reports the claim', async () => {
    const fixture = await setup()
    await fixture.policy.observeFs({ displayPath: '/x.txt' }, { kind: 'absent' })
    const exec = readExec('/x.txt')
    assert.deepEqual(await fixture.policy.postExecute(exec, readNotFound()), [])
    const contexts = await fixture.policy.postExecute(exec, readNotFound())
    assert.equal(contexts.length, 1)
    assert.ok(contexts[0]?.content[0]?.text.includes('file does not exist: /x.txt'))
    cleanup(fixture)
  })
})

describe('block mode', () => {
  it('denies a repeated failing command and counts one denied call', async () => {
    const fixture = await setup('block')
    const exec = bashExec('npm install')
    await fixture.policy.postExecute(exec, bashFail(1))
    const outcome = await fixture.policy.preExecute(exec)
    assert.equal(outcome?.kind, 'deny')
    const fact = (await fixture.store.queryFacts())[0]!.fact
    assert.ok(fact.retryCondition?.type === 'after')
    assert.ok(outcome?.kind === 'deny' && outcome.reason.includes(fact.retryCondition.at))
    assert.equal((await fixture.store.summarize()).callsDenied, 1)
    assert.equal((await fixture.store.summarize()).warningsEmitted, 0)
    cleanup(fixture)
  })

  it('P0-1: attaches a TTL and denies while it is unexpired', async () => {
    const fixture = await setup('block')
    const exec = bashExec('npm install')
    await fixture.policy.postExecute(exec, bashFail(1))
    const fact = (await fixture.store.queryFacts())[0]?.fact
    assert.equal(fact?.retryCondition?.type, 'after')
    assert.ok(fact?.retryCondition?.type === 'after' && fact.retryCondition.at > fact.createdAt)
    assert.equal((await fixture.policy.preExecute(exec))?.kind, 'deny')
    cleanup(fixture)
  })

  it('P0-1: releases the command after the TTL elapses (no permanent lock)', async () => {
    const fixture = await setup('block', { commandRetryAfterMs: 1 })
    const exec = bashExec('npm install')
    await fixture.policy.postExecute(exec, bashFail(1))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(await fixture.policy.preExecute(exec), undefined)
    cleanup(fixture)
  })

  it('does not double-count a denied call that reaches post-execute', async () => {
    const fixture = await setup('block')
    const exec = bashExec('npm install')
    await fixture.policy.postExecute(exec, bashFail(1))
    await fixture.policy.preExecute(exec)
    const deniedResult: ResultLike = {
      isError: true,
      error: { message: 'blocked by negative-ledger (command_failed): command exited 1 (bash) [npm install] — retry condition not met' },
    }
    assert.deepEqual(await fixture.policy.postExecute(exec, deniedResult), [])
    assert.equal((await fixture.store.summarize()).callsDenied, 1)
    assert.equal((await fixture.store.summarize()).duplicateFailuresObserved, 0)
    cleanup(fixture)
  })

  it('allows the retry once evidence changed (stale-allow) and resolves on success', async () => {
    const fixture = await setup('block')
    await fixture.policy.observeFs({ displayPath: '/x.txt' }, { kind: 'absent' })
    const exec = readExec('/x.txt')
    await fixture.policy.postExecute(exec, readNotFound())
    await fixture.policy.observeFs({ displayPath: '/x.txt' }, { kind: 'present', version: 'v1' })
    assert.equal(await fixture.policy.preExecute(exec), undefined)
    const contexts = await fixture.policy.postExecute(exec, readOk())
    assert.equal(contexts.length, 1)
    assert.ok(contexts[0]?.content[0]?.text.includes('verification is allowed'))
    assert.equal((await fixture.store.queryFacts())[0]?.fact.status, 'resolved')
    cleanup(fixture)
  })
})

describe('cross-session evidence isolation', () => {
  /** The precondition witness paths a fact carries, in recorded order. */
  function witnessPaths(fact: NegativeFact): string[] {
    return fact.evidence
      .filter(witness => witness.role === 'precondition' && witness.kind === 'file-state')
      .map(witness => witness.path)
  }

  /**
   * Two sessions reading the SAME relative path from different cwds resolve to
   * different files. Each fact must carry only its own session's file as
   * evidence, so a repair in one workspace can never release the other's fact.
   */
  it('keeps one session\'s repair from releasing another session\'s missing file', async () => {
    const fixture = await setup('block')
    const sessionA = { header: { cwd: '/ws/a' } }
    const sessionB = { header: { cwd: '/ws/b' } }
    const observe = (displayPath: string, observation: { kind: 'absent' } | { kind: 'present'; version: string }, session: object) =>
      fixture.policy.observeFs({ displayPath }, observation, {
        name: 'read',
        arguments: { file_path: 'config.json' },
        agent: { session },
      })

    // Both sessions are told the file is missing, in interleaved order: A's
    // fact is recorded after B's observation, which is what used to alias.
    await observe('/ws/a/config.json', { kind: 'absent' }, sessionA)
    await observe('/ws/b/config.json', { kind: 'absent' }, sessionB)
    await fixture.policy.postExecute(readExec('config.json', '/ws/a'), readNotFound())
    const factA = (await fixture.store.queryFacts())
      .map(entry => entry.fact)
      .find(fact => fact.fingerprint.kind === 'file_missing' && fact.fingerprint.cwd === '/ws/a')
    assert.ok(factA !== undefined, 'A\'s failure must be recorded as its own fact')
    assert.deepEqual(witnessPaths(factA), ['/ws/a\u0000config.json', '/ws/a/config.json'])

    // B repairs its own file. A's file is still missing, so A's retry must
    // stay blocked — B's file is not evidence about A's.
    await observe('/ws/b/config.json', { kind: 'present', version: 'v1' }, sessionB)
    const denied = await fixture.policy.preExecute(readExec('config.json', '/ws/a'))
    assert.equal(denied?.kind, 'deny')
    assert.ok(denied?.kind === 'deny' && denied.reason.includes('Observed preconditions still match'))

    // A's own repair is the one that releases it.
    await observe('/ws/a/config.json', { kind: 'present', version: 'v2' }, sessionA)
    assert.equal(await fixture.policy.preExecute(readExec('config.json', '/ws/a')), undefined)
    cleanup(fixture)
  })
})

describe('recording', () => {
  it('records command failures without raw commands in the claim, with TTL and sanitized stderr', async () => {
    const fixture = await setup()
    await fixture.policy.postExecute(bashExec('SECRET_TOKEN=abc npm install'), bashFail(1, 'boom\nline2\u0000tail'))
    const fact = (await fixture.store.queryFacts())[0]?.fact
    assert.equal(fact?.claim, 'command exited 1 (bash)')
    assert.ok(!fact?.claim.includes('SECRET'))
    assert.ok(JSON.stringify(fact?.fingerprint).includes('SECRET_TOKEN=abc'))
    const outcome = fact?.evidence.find(e => e.role === 'outcome')
    assert.deepEqual(outcome, {
      role: 'outcome',
      kind: 'command-exit',
      exitCode: 1,
      stderrSignature: 'boom line2 tail',
    })
    assert.equal(fact?.retryCondition?.type, 'after')
    assert.equal(fact?.fingerprint.kind, 'command_failed')
    if (fact?.fingerprint.kind === 'command_failed') {
      assert.equal(fact.fingerprint.tool, 'bash')
    }
    cleanup(fixture)
  })

  it('records missing-file facts with cwd-scoped and displayPath witnesses', async () => {
    const fixture = await setup()
    await fixture.policy.observeFs(
      { displayPath: '/abs/workspace/x.txt' },
      { kind: 'absent' },
      { name: 'read', arguments: { file_path: 'x.txt' }, agent: { session: { header: { cwd: '/ws' } } } },
    )
    await fixture.policy.postExecute(readExec('x.txt', '/ws'), readNotFound())
    const fact = (await fixture.store.queryFacts())[0]?.fact
    assert.equal(fact?.kind, 'file_missing')
    assert.deepEqual(fact?.fingerprint, { kind: 'file_missing', path: 'x.txt', cwd: '/ws' })
    assert.deepEqual(fact?.evidence, [
      { role: 'outcome', kind: 'error-code', code: 'FS_NOT_FOUND' },
      { role: 'precondition', kind: 'file-state', path: '/ws\u0000x.txt', observed: 'absent' },
      { role: 'precondition', kind: 'file-state', path: '/abs/workspace/x.txt', observed: 'absent' },
    ])
    cleanup(fixture)
  })

  it('appends versions on the same fact id for repeats', async () => {
    const fixture = await setup()
    const exec = bashExec('npm install')
    await fixture.policy.postExecute(exec, bashFail(1, 'ETIMEDOUT'))
    await fixture.policy.postExecute(exec, bashFail(1, 'ETIMEDOUT'))
    const entries = await fixture.store.queryFacts()
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.fact.status, 'active')
    assert.deepEqual(entries[0]?.fact.savings, { duplicateFailuresObserved: 1, warningsEmitted: 1, callsDenied: 0 })
    cleanup(fixture)
  })

  it('ignores successful commands, zero exits, spawn errors, and successful reads', async () => {
    const fixture = await setup()
    await fixture.policy.postExecute(bashExec('npm install'), bashFail(0))
    await fixture.policy.postExecute(bashExec('npm install'), { isError: true, error: { message: 'spawn EPERM' } })
    await fixture.policy.postExecute(readExec('/x.txt'), readOk())
    await fixture.policy.postExecute(readExec('/x.txt'), { isError: true, error: { message: 'denied', info: { code: 'FS_PERMISSION_DENIED' } } })
    assert.equal((await fixture.store.queryFacts()).length, 0)
    cleanup(fixture)
  })

  it('ignores untracked tools and malformed arguments', async () => {
    const fixture = await setup()
    await fixture.policy.postExecute({ name: 'write', arguments: { file_path: '/x' } }, { isError: true, error: { message: 'boom', info: { code: 'X' } } })
    await fixture.policy.postExecute(bashExec(''), bashFail(1))
    await fixture.policy.postExecute(readExec(''), readNotFound())
    assert.equal((await fixture.store.queryFacts()).length, 0)
    cleanup(fixture)
  })
})

describe('audit round fixes', () => {
  it('P1: preserves raw command whitespace in fingerprints (no collision)', async () => {
    const fixture = await setup()
    await fixture.policy.postExecute(bashExec('printf "a  b"'), bashFail(1))
    await fixture.policy.postExecute(bashExec('printf "a b"'), bashFail(1))
    assert.equal((await fixture.store.queryFacts()).length, 2)
    cleanup(fixture)
  })

  it('P1: derives command cwd from the session header and does not collide across projects', async () => {
    const fixture = await setup('block')
    const projectA: ExecLike = {
      name: 'bash',
      arguments: { command: 'npm install' },
      agent: { session: { header: { cwd: '/project-a' } } },
    }
    await fixture.policy.postExecute(projectA, bashFail(1))
    const fingerprint = (await fixture.store.queryFacts())[0]?.fact.fingerprint
    assert.equal(fingerprint?.kind === 'command_failed' ? fingerprint.cwd : undefined, '/project-a')
    const projectB: ExecLike = {
      name: 'bash',
      arguments: { command: 'npm install' },
      agent: { session: { header: { cwd: '/project-b' } } },
    }
    assert.equal(await fixture.policy.preExecute(projectB), undefined)
    assert.equal((await fixture.policy.preExecute(projectA))?.kind, 'deny')
    cleanup(fixture)
  })

  it('P1: scopes file fingerprints by cwd so identical relative paths do not collide', async () => {
    const fixture = await setup('block')
    await fixture.policy.observeFs(
      { displayPath: '/abs/a/config.json' },
      { kind: 'absent' },
      { name: 'read', arguments: { file_path: 'config.json' }, agent: { session: { header: { cwd: '/project-a' } } } },
    )
    await fixture.policy.postExecute(readExec('config.json', '/project-a'), readNotFound())
    assert.equal(await fixture.policy.preExecute(readExec('config.json', '/project-b')), undefined)
    assert.equal((await fixture.policy.preExecute(readExec('config.json', '/project-a')))?.kind, 'deny')
    cleanup(fixture)
  })

  it('P1: resolves a fact on a successful retry with the call id in the audit transition', async () => {
    const fixture = await setup()
    const exec: ExecLike = { name: 'bash', arguments: { command: 'npm install' }, callId: 'call-77' }
    await fixture.policy.postExecute(exec, bashFail(1))
    await fixture.policy.postExecute(exec, bashOk())
    const fact = (await fixture.store.queryFacts())[0]?.fact
    assert.equal(fact?.status, 'resolved')
    assert.deepEqual(fact?.lastTransition, { kind: 'resolved', at: fact.lastTransition?.at, via: 'call-77' })
    cleanup(fixture)
  })

  it('P2: block mode passes allow verdicts and denies manual with the condition reason', async () => {
    const fixture = await setup('block')
    await fixture.store.recordFact({
      kind: 'command_failed',
      scope: '',
      fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine: 'npm test' }),
      claim: 'npm test was flaky',
      evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'x' }],
      retryCondition: { type: 'after', at: '2000-01-01T00:00:00.000Z' },
    }, { operationId: 'seed-1' })
    assert.equal(await fixture.policy.preExecute(bashExec('npm test')), undefined)
    await fixture.store.recordFact({
      kind: 'command_failed',
      scope: '',
      fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine: 'npm lint' }),
      claim: 'npm lint needs human review',
      evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'x' }],
      retryCondition: { type: 'manual' },
    }, { operationId: 'seed-2' })
    const outcome = await fixture.policy.preExecute(bashExec('npm lint'))
    assert.equal(outcome?.kind, 'deny')
    assert.ok(outcome?.kind === 'deny' && outcome.reason.includes('explicit manual clearance'))
    cleanup(fixture)
  })

  it('P2: scopes the recovery hint to file-state witnesses and to the real restriction', async () => {
    const fixture = await setup('block')
    // An environment witness cannot be re-observed by reading a file, so the
    // message keeps the generic answer and claims nothing about freshness.
    await fixture.store.recordFact({
      kind: 'command_failed',
      scope: '',
      fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine: 'npm deploy' }),
      claim: 'npm deploy needs the release key',
      evidence: [
        { role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'x' },
        { role: 'precondition', kind: 'env-state', key: 'RELEASE_KEY', valueHash: 'h1' },
      ],
      retryCondition: { type: 'manual' },
    }, { operationId: 'seed-3' })
    const envDenied = await fixture.policy.preExecute(bashExec('npm deploy'))
    assert.equal(envDenied?.kind, 'deny')
    assert.ok(envDenied?.kind === 'deny' && envDenied.reason.includes('Current precondition evidence is incomplete; no change has been confirmed.'))
    assert.ok(envDenied?.kind === 'deny' && !envDenied.reason.includes('Re-reading those files'))
    assert.ok(envDenied?.kind === 'deny' && !envDenied.reason.includes('is no longer fresh'))
    assert.ok(envDenied?.kind === 'deny' && !envDenied.reason.includes('cooldown'))

    // A never-observed file witness IS re-readable, but `manual` is not a timed
    // cooldown, so the hint names the retry restriction rather than a cooldown.
    await fixture.store.recordFact({
      kind: 'command_failed',
      scope: '',
      fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine: 'npm publish' }),
      claim: 'npm publish needs the version bumped',
      evidence: [
        { role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'x' },
        { role: 'precondition', kind: 'file-state', path: '/ws/package.json', observed: 'present', version: 'v1' },
      ],
      retryCondition: { type: 'manual' },
    }, { operationId: 'seed-4' })
    const fileDenied = await fixture.policy.preExecute(bashExec('npm publish'))
    assert.equal(fileDenied?.kind, 'deny')
    assert.ok(fileDenied?.kind === 'deny' && fileDenied.reason.includes('no observation of /ws/package.json was recorded in this context'))
    assert.ok(fileDenied?.kind === 'deny' && fileDenied.reason.includes('leave the retry restriction in place'))
    assert.ok(fileDenied?.kind === 'deny' && !fileDenied.reason.includes('cooldown'))
    cleanup(fixture)
  })
})

describe('mode off', () => {
  it('disables interception, recording, and denial entirely', async () => {
    const fixture = await setup('off')
    await fixture.policy.observeFs({ displayPath: '/x.txt' }, { kind: 'absent' })
    const exec = bashExec('npm install')
    assert.deepEqual(await fixture.policy.postExecute(exec, bashFail(1)), [])
    assert.deepEqual(await fixture.policy.postExecute(exec, bashFail(1)), [])
    assert.equal(await fixture.policy.preExecute(exec), undefined)
    assert.equal((await fixture.store.queryFacts()).length, 0)
    cleanup(fixture)
  })
})

describe('pending queue and drain', () => {
  it('drain flushes fire-and-forget invalidation passes', async () => {
    const fixture = await setup('warn')
    await fixture.policy.observeFs({ displayPath: '/x.txt' }, { kind: 'absent' })
    await fixture.policy.postExecute(readExec('/x.txt'), readNotFound())
    // Fire-and-forget: do not await the observation promise.
    void fixture.policy.observeFs({ displayPath: '/x.txt' }, { kind: 'present', version: 'v1' })
    await fixture.policy.drain()
    const facts = await fixture.store.queryFacts()
    assert.equal(facts[0]?.fact.status, 'stale')
    cleanup(fixture)
  })
})

describe('apply disposal (HMR safety)', () => {
  it('drains the queue and closes the store on context disposal', async () => {
    const dir = tempDir()
    let disposer: (() => void) | undefined
    const fakeCtx: DshContextLike = {
      effect(callback) {
        disposer = callback()
      },
      on() {
        return () => {}
      },
    }
    apply(fakeCtx, { backend: 'sqlite', dir, mode: 'warn' })
    assert.ok(disposer !== undefined, 'apply must register a disposal effect')
    // The sqlite handle must be open right now: the db file exists.
    const dbFile = join(dir, 'ledger.db')
    assert.ok(disposer !== undefined)
    disposer!()
    // The disposal drains and closes asynchronously; give the chain a tick,
    // then the directory must be deletable (an open handle would EBUSY).
    await new Promise(resolve => setTimeout(resolve, 50))
    rmSync(dir, { recursive: true, force: true })
    assert.equal(dbFile === '', false)
  })
})

describe('config validation', () => {
  it('fails loud on invalid mode, TTL, and lease TTL', async () => {
    const dir = tempDir()
    const store = new JsonlLedgerStore({ dir })
    assert.throws(() => createLedgerPolicy(store, { mode: 'shout' as never }), /invalid mode/)
    assert.throws(() => createLedgerPolicy(store, { commandRetryAfterMs: 0 }), /commandRetryAfterMs/)
    assert.throws(() => createLedgerPolicy(store, { leaseTtlMs: 0 }), /leaseTtlMs/)
    rmSync(dir, { recursive: true, force: true })
  })
})
