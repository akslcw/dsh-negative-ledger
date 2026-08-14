/**
 * Engine behavior tests: recording, per-query evidence derivation,
 * interception verdicts, conservative invalidation with audit transitions,
 * resolution, honest counters, and persistence.
 * @module dsh-negative-ledger/tests/engine
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { NegativeLedger, fingerprintKey, normalizeCommandLine } from '../src/engine.ts'
import type { AttemptContext, NegativeFactInput, PreconditionEvidence, QueryVerdict, RetryCondition } from '../src/types.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'negledger-'))
}

const MIRROR_ENV: PreconditionEvidence =
  { role: 'precondition', kind: 'env-state', key: 'NPM_CONFIG_REGISTRY', valueHash: 'hash-mirror' }
const OFFICIAL_ENV: PreconditionEvidence =
  { role: 'precondition', kind: 'env-state', key: 'NPM_CONFIG_REGISTRY', valueHash: 'hash-official' }

function commandInput(overrides: Partial<NegativeFactInput> = {}): NegativeFactInput {
  return {
    kind: 'command_failed',
    fingerprint: { kind: 'command_failed', tool: 'bash', commandLine: 'npm   install', cwd: '/repo' },
    claim: 'npm install hangs under the npmmirror registry',
    evidence: [
      { role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'ETIMEDOUT' },
      MIRROR_ENV,
    ],
    ...overrides,
  }
}

function attemptFor(input: NegativeFactInput, preconditionNow: PreconditionEvidence[] = []): AttemptContext {
  return { kind: input.kind, fingerprint: input.fingerprint, preconditionNow }
}

describe('recordNegativeFact', () => {
  it('assigns identity, active status, timestamps, and zero savings', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const fact = ledger.recordNegativeFact(commandInput())
    assert.ok(fact.id.length > 0)
    assert.equal(fact.status, 'active')
    assert.equal(fact.createdAt, fact.updatedAt)
    assert.deepEqual(fact.savings, { duplicateFailuresObserved: 0, warningsEmitted: 0, callsDenied: 0 })
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('trims but preserves inner whitespace in command fingerprints (no collision)', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const spaced = ledger.recordNegativeFact(commandInput({
      fingerprint: { kind: 'command_failed', tool: 'bash', commandLine: 'printf "a  b"', cwd: '/repo' },
      claim: 'spaced',
    }))
    const collapsed = ledger.recordNegativeFact(commandInput({
      fingerprint: { kind: 'command_failed', tool: 'bash', commandLine: 'printf "a b"', cwd: '/repo' },
      claim: 'collapsed',
    }))
    assert.notEqual(spaced.id, collapsed.id)
    assert.equal(ledger.facts().length, 2)
    const trimmed = ledger.recordNegativeFact(commandInput({
      fingerprint: { kind: 'command_failed', tool: 'bash', commandLine: '  npm   install  ', cwd: '/repo' },
    }))
    assert.equal(trimmed.id, ledger.facts().find(f => f.claim === 'npm install hangs under the npmmirror registry')?.id)
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('rejects a fact without an outcome witness', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const input = commandInput({ evidence: [MIRROR_ENV] })
    assert.throws(() => ledger.recordNegativeFact(input), /at least one outcome witness/)
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('rejects kind/fingerprint mismatch', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const input = commandInput({
      fingerprint: { kind: 'api_unavailable', endpoint: 'https://api.example.test' },
    })
    assert.throws(() => ledger.recordNegativeFact(input), /must match fingerprint kind/)
    rmSync(ledger.dir, { recursive: true, force: true })
  })
})

describe('fingerprint helpers', () => {
  it('trims command lines without collapsing whitespace', () => {
    assert.equal(normalizeCommandLine('  npm   install --force  '), 'npm   install --force')
  })

  it('excludes undefined fields from the key', () => {
    const withEnv: Parameters<typeof fingerprintKey>[0] =
      { kind: 'command_failed', tool: 'bash', commandLine: 'x', cwd: '/c', envHash: 'e' }
    const withoutEnv: Parameters<typeof fingerprintKey>[0] =
      { kind: 'command_failed', tool: 'bash', commandLine: 'x', cwd: '/c' }
    assert.notEqual(fingerprintKey(withEnv), fingerprintKey(withoutEnv))
    assert.equal(fingerprintKey(withoutEnv), fingerprintKey({
      kind: 'command_failed', tool: 'bash', commandLine: 'x', cwd: '/c',
    }))
  })
})

describe('queryRelevantFacts', () => {
  it('returns no match when nothing is recorded', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const input = commandInput()
    assert.deepEqual(ledger.queryRelevantFacts(attemptFor(input, [MIRROR_ENV])), [])
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('warns when evidence still matches and no retry condition is set', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const input = commandInput()
    ledger.recordNegativeFact(input)
    const matches = ledger.queryRelevantFacts(attemptFor(input, [MIRROR_ENV]))
    assert.equal(matches.length, 1)
    assert.equal(matches[0]?.verdict, 'warn')
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('blocks on never, manual, and after-not-yet; allows after-met and satisfied anyOf', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const cases: Array<{ condition: RetryCondition; expected: QueryVerdict }> = [
      { condition: { type: 'never' }, expected: 'block' },
      { condition: { type: 'manual' }, expected: 'block' },
      { condition: { type: 'after', at: '2999-01-01T00:00:00.000Z' }, expected: 'block' },
      { condition: { type: 'after', at: '2000-01-01T00:00:00.000Z' }, expected: 'allow' },
      { condition: { type: 'anyOf', conditions: [{ type: 'manual' }, { type: 'never' }] }, expected: 'block' },
      { condition: { type: 'anyOf', conditions: [{ type: 'never' }] }, expected: 'block' },
      { condition: { type: 'anyOf', conditions: [{ type: 'after', at: '2000-01-01T00:00:00.000Z' }] }, expected: 'allow' },
    ]
    for (const { condition, expected } of cases) {
      const input = commandInput({ retryCondition: condition })
      ledger.recordNegativeFact(input)
      const matches = ledger.queryRelevantFacts(attemptFor(input, [MIRROR_ENV]))
      assert.equal(matches[0]?.verdict, expected, JSON.stringify(condition))
    }
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('read-through: mismatched evidence stales an active fact and allows the retry', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const input = commandInput()
    ledger.recordNegativeFact(input)
    const matches = ledger.queryRelevantFacts(attemptFor(input, [OFFICIAL_ENV]))
    assert.equal(matches[0]?.verdict, 'stale-allow')
    assert.equal(ledger.facts()[0]?.status, 'stale')
    assert.deepEqual(ledger.facts()[0]?.lastTransition, {
      kind: 'stale',
      at: ledger.facts()[0]?.lastTransition?.at,
      staleWitnesses: ['env-state'],
    })
    // Evidence STILL mismatched: stays stale-allow without re-transitioning.
    const again = ledger.queryRelevantFacts(attemptFor(input, [OFFICIAL_ENV]))
    assert.equal(again[0]?.verdict, 'stale-allow')
    assert.equal(ledger.facts()[0]?.status, 'stale')
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('per-query derivation: a stale fact intercepts again when its original evidence returns', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const input = commandInput()
    ledger.recordNegativeFact(input)
    ledger.queryRelevantFacts(attemptFor(input, [OFFICIAL_ENV]))
    assert.equal(ledger.facts()[0]?.status, 'stale')
    // The original registry is back: the negative conclusion applies again.
    const matches = ledger.queryRelevantFacts(attemptFor(input, [MIRROR_ENV]))
    assert.equal(matches[0]?.verdict, 'warn')
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('stops intercepting after resolution', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const input = commandInput()
    ledger.recordNegativeFact(input)
    ledger.markResolved(input.fingerprint)
    assert.deepEqual(ledger.queryRelevantFacts(attemptFor(input, [MIRROR_ENV])), [])
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('appends a new evidence version on the same fact id for a repeat', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const first = ledger.recordNegativeFact(commandInput())
    ledger.recordHit(first.id, 'warn')
    const second = ledger.recordNegativeFact(commandInput({ claim: 'retried under a new registry and failed again' }))
    assert.equal(second.id, first.id)
    assert.equal(second.status, 'active')
    assert.equal(second.lastTransition, undefined)
    assert.ok(second.updatedAt >= first.updatedAt)
    assert.equal(ledger.facts().length, 1)
    assert.deepEqual(ledger.facts()[0]?.savings, { duplicateFailuresObserved: 1, warningsEmitted: 1, callsDenied: 0 })
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('starts a new fact id only after the previous one was resolved', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const first = ledger.recordNegativeFact(commandInput())
    ledger.markResolved(first.fingerprint)
    const second = ledger.recordNegativeFact(commandInput())
    assert.notEqual(second.id, first.id)
    const byId = new Map(ledger.facts().map(f => [f.id, f]))
    assert.equal(byId.get(first.id)?.status, 'superseded')
    assert.equal(byId.get(second.id)?.status, 'active')
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('does not touch savings counters', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const input = commandInput()
    ledger.recordNegativeFact(input)
    ledger.queryRelevantFacts(attemptFor(input, [MIRROR_ENV]))
    assert.equal(ledger.summarizeSavings().warningsEmitted, 0)
    rmSync(ledger.dir, { recursive: true, force: true })
  })
})

describe('invalidateFacts', () => {
  it('stales only facts with a positively different witness, reporting kinds and audit', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const changed = ledger.recordNegativeFact(commandInput({ claim: 'first' }))
    const untouched = ledger.recordNegativeFact(commandInput({
      fingerprint: { kind: 'command_failed', tool: 'bash', commandLine: 'npm test', cwd: '/repo' },
      claim: 'second',
      evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'FAILED' }],
    }))
    const invalidated = ledger.invalidateFacts([OFFICIAL_ENV], 'call-9')
    assert.deepEqual(invalidated.map(i => i.id), [changed.id])
    assert.deepEqual(invalidated[0]?.staleWitnesses, ['env-state'])
    assert.equal(ledger.facts().find(f => f.id === changed.id)?.status, 'stale')
    assert.equal(ledger.facts().find(f => f.id === changed.id)?.lastTransition?.via, 'call-9')
    assert.equal(ledger.facts().find(f => f.id === untouched.id)?.status, 'active')
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('keeps facts active when the current value is identical or unknown', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const input = commandInput()
    ledger.recordNegativeFact(input)
    assert.deepEqual(ledger.invalidateFacts([MIRROR_ENV]), [])
    assert.deepEqual(ledger.invalidateFacts([]), [])
    assert.equal(ledger.facts()[0]?.status, 'active')
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('ignores facts that are not active', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const input = commandInput()
    ledger.recordNegativeFact(input)
    ledger.markResolved(input.fingerprint)
    assert.deepEqual(ledger.invalidateFacts([OFFICIAL_ENV]), [])
    rmSync(ledger.dir, { recursive: true, force: true })
  })
})

describe('markResolved', () => {
  it('resolves an active fact with an audit transition', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const input = commandInput()
    const fact = ledger.recordNegativeFact(input)
    const resolved = ledger.markResolved(input.fingerprint, 'call-42')
    assert.equal(resolved?.id, fact.id)
    assert.equal(resolved?.status, 'resolved')
    assert.deepEqual(resolved?.lastTransition, { kind: 'resolved', at: resolved.lastTransition?.at, via: 'call-42' })
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('returns undefined for an unknown fingerprint and the fact for an already-resolved one', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const input = commandInput()
    assert.equal(ledger.markResolved(input.fingerprint), undefined)
    ledger.recordNegativeFact(input)
    ledger.markResolved(input.fingerprint)
    assert.equal(ledger.markResolved(input.fingerprint)?.status, 'resolved')
    rmSync(ledger.dir, { recursive: true, force: true })
  })
})

describe('recordHit and summarizeSavings', () => {
  it('counts warnings as observed duplicates and denies as avoided calls', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const first = ledger.recordNegativeFact(commandInput())
    const second = ledger.recordNegativeFact(commandInput({
      fingerprint: { kind: 'command_failed', tool: 'bash', commandLine: 'npm test', cwd: '/repo' },
    }))
    ledger.recordHit(first.id, 'warn')
    ledger.recordHit(first.id, 'block')
    ledger.recordHit(second.id, 'warn')
    ledger.recordHit('unknown-id', 'warn')
    const summary = ledger.summarizeSavings()
    assert.deepEqual(summary, {
      factsHit: 2,
      duplicateFailuresObserved: 2,
      warningsEmitted: 2,
      callsDenied: 1,
    })
    assert.deepEqual(ledger.facts().find(f => f.id === first.id)?.savings, {
      duplicateFailuresObserved: 1,
      warningsEmitted: 1,
      callsDenied: 1,
    })
    rmSync(ledger.dir, { recursive: true, force: true })
  })
})

describe('persistence', () => {
  it('round-trips facts, derived supersession, transitions, and hit counters', () => {
    const dir = tempDir()
    const ledger = new NegativeLedger({ dir })
    const input = commandInput()
    ledger.recordNegativeFact(input)
    const newer = ledger.recordNegativeFact(commandInput({ claim: 'second attempt also failed' }))
    ledger.invalidateFacts([OFFICIAL_ENV], 'call-1')
    ledger.recordHit(newer.id, 'warn')
    const reloaded = new NegativeLedger({ dir })
    const before = new Map(ledger.facts().map(f => [f.id, f]))
    const after = new Map(reloaded.facts().map(f => [f.id, f]))
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort())
    for (const [id, fact] of after) {
      assert.equal(fact.status, before.get(id)?.status)
      assert.deepEqual(fact.lastTransition, before.get(id)?.lastTransition)
    }
    assert.equal(after.get(newer.id)?.status, 'stale')
    assert.deepEqual(reloaded.summarizeSavings(), {
      factsHit: 1,
      duplicateFailuresObserved: 1,
      warningsEmitted: 1,
      callsDenied: 0,
    })
    rmSync(dir, { recursive: true, force: true })
  })

  it('fails loud on an unsupported line version', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'ledger.jsonl'), '{"v":9,"fact":{}}\n')
    assert.throws(() => new NegativeLedger({ dir }), /version 9, expected 1/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('fails loud on a malformed line', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'ledger.jsonl'), '{"v":1,\n')
    assert.throws(() => new NegativeLedger({ dir }), /not valid JSON/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('fails loud on a line carrying neither a fact nor a hit', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'ledger.jsonl'), '{"v":1,"mystery":true}\n')
    assert.throws(() => new NegativeLedger({ dir }), /neither a fact nor a hit/)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('file-state witnesses', () => {
  function missingFileInput(cwd = ''): NegativeFactInput {
    return {
      kind: 'file_missing',
      fingerprint: { kind: 'file_missing', path: '/repo/missing.txt', cwd },
      claim: 'file does not exist: /repo/missing.txt',
      evidence: [
        { role: 'outcome', kind: 'error-code', code: 'FS_NOT_FOUND' },
        { role: 'precondition', kind: 'file-state', path: '/repo/missing.txt', observed: 'absent' },
      ],
    }
  }

  it('invalidates an absent witness when the file appears', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const fact = ledger.recordNegativeFact(missingFileInput())
    const invalidated = ledger.invalidateFacts([
      { role: 'precondition', kind: 'file-state', path: '/repo/missing.txt', observed: 'present', version: 'v1' },
    ])
    assert.deepEqual(invalidated.map(i => i.id), [fact.id])
    assert.deepEqual(invalidated[0]?.staleWitnesses, ['file-state'])
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('invalidates a present witness when its version changes', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const fact = ledger.recordNegativeFact({
      kind: 'file_missing',
      fingerprint: { kind: 'file_missing', path: '/repo/cfg.txt', cwd: '' },
      claim: 'config unusable',
      evidence: [
        { role: 'outcome', kind: 'error-code', code: 'FS_NOT_FOUND' },
        { role: 'precondition', kind: 'file-state', path: '/repo/cfg.txt', observed: 'present', version: 'v1' },
      ],
    })
    const invalidated = ledger.invalidateFacts([
      { role: 'precondition', kind: 'file-state', path: '/repo/cfg.txt', observed: 'present', version: 'v2' },
    ])
    assert.equal(invalidated.length, 1)
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('keeps an absent witness active while the file stays absent', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    ledger.recordNegativeFact(missingFileInput())
    assert.deepEqual(ledger.invalidateFacts([
      { role: 'precondition', kind: 'file-state', path: '/repo/missing.txt', observed: 'absent' },
    ]), [])
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('scopes file fingerprints by cwd: identical relative paths do not collide', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const projectA = ledger.recordNegativeFact({
      kind: 'file_missing',
      fingerprint: { kind: 'file_missing', path: 'config.json', cwd: '/project-a' },
      claim: 'missing in A',
      evidence: [{ role: 'outcome', kind: 'error-code', code: 'FS_NOT_FOUND' }],
    })
    const projectB = ledger.recordNegativeFact({
      kind: 'file_missing',
      fingerprint: { kind: 'file_missing', path: 'config.json', cwd: '/project-b' },
      claim: 'missing in B',
      evidence: [{ role: 'outcome', kind: 'error-code', code: 'FS_NOT_FOUND' }],
    })
    assert.notEqual(projectA.id, projectB.id)
    assert.deepEqual(ledger.queryRelevantFacts({
      kind: 'file_missing',
      fingerprint: { kind: 'file_missing', path: 'config.json', cwd: '/project-b' },
      preconditionNow: [],
    })[0]?.verdict, 'warn')
    rmSync(ledger.dir, { recursive: true, force: true })
  })

  it('accepts an error-code outcome witness', () => {
    const ledger = new NegativeLedger({ dir: tempDir() })
    const fact = ledger.recordNegativeFact(missingFileInput())
    const matches = ledger.queryRelevantFacts({
      kind: 'file_missing',
      fingerprint: { kind: 'file_missing', path: '/repo/missing.txt', cwd: '' },
      preconditionNow: [
        { role: 'precondition', kind: 'file-state', path: '/repo/missing.txt', observed: 'absent' },
      ],
    })
    assert.equal(matches[0]?.verdict, 'warn')
    assert.equal(fact.evidence[0]?.role, 'outcome')
    rmSync(ledger.dir, { recursive: true, force: true })
  })
})
