/**
 * CLI tests: runCli is pure and asynchronous, so every command is exercised
 * in-process with a temp ledger (no subprocess, sandbox-safe), over both
 * backends and the auto-detection path.
 * @module dsh-negative-ledger/tests/cli
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { NegativeLedger } from '../src/engine.ts'
import { SqliteLedgerStore } from '../src/store-sqlite.ts'
import { runCli } from '../src/cli.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'negledger-cli-'))
}

function seed(dir: string): { commandId: string; fileId: string } {
  const ledger = new NegativeLedger({ dir })
  const command = ledger.recordNegativeFact({
    kind: 'command_failed',
    fingerprint: { kind: 'command_failed', tool: 'bash', commandLine: 'npm install', cwd: '/repo' },
    claim: 'npm install hangs',
    evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'ETIMEDOUT' }],
  })
  const file = ledger.recordNegativeFact({
    kind: 'file_missing',
    fingerprint: { kind: 'file_missing', path: '/repo/missing.txt', cwd: '/repo' },
    claim: 'file does not exist: /repo/missing.txt',
    evidence: [
      { role: 'outcome', kind: 'error-code', code: 'FS_NOT_FOUND' },
      { role: 'precondition', kind: 'file-state', path: '/repo/missing.txt', observed: 'absent' },
    ],
  })
  ledger.recordHit(command.id, 'warn')
  ledger.recordHit(command.id, 'block')
  ledger.recordHit(file.id, 'warn')
  ledger.invalidateFacts([
    { role: 'precondition', kind: 'file-state', path: '/repo/missing.txt', observed: 'present', version: 'v1' },
  ])
  return { commandId: command.id, fileId: file.id }
}

describe('runCli', () => {
  it('prints usage on no arguments and unknown commands', async () => {
    const noArgs = await runCli([])
    assert.equal(noArgs.code, 1)
    assert.ok(noArgs.lines[0]?.startsWith('usage:'))

    const unknown = await runCli(['frobnicate'])
    assert.equal(unknown.code, 1)
    assert.ok(unknown.lines.join('\n').includes('unknown command "frobnicate"'))
  })

  it('rejects unknown options and unknown backends', async () => {
    const result = await runCli(['--verbose', 'list'])
    assert.equal(result.code, 1)
    assert.ok(result.lines[0]?.includes('unknown option --verbose'))

    const badBackend = await runCli(['--backend', 'oracle', 'list'])
    assert.equal(badBackend.code, 1)
    assert.ok(badBackend.lines[0]?.includes('unknown backend "oracle"'))
  })

  it('lists facts with status, kind, id, and claim', async () => {
    const dir = tempDir()
    seed(dir)
    const result = await runCli(['--dir', dir, 'list'])
    assert.equal(result.code, 0)
    assert.equal(result.lines.length, 2)
    assert.ok(result.lines[0]?.includes('command_failed'))
    assert.ok(result.lines[0]?.includes('npm install hangs'))
    assert.ok(result.lines[1]?.includes('stale'))
    assert.ok(result.lines[1]?.includes('file_missing'))
    rmSync(dir, { recursive: true, force: true })
  })

  it('shows one fact as pretty JSON and fails loud for unknown ids', async () => {
    const dir = tempDir()
    const { commandId } = seed(dir)
    const shown = await runCli(['--dir', dir, 'show', commandId])
    assert.equal(shown.code, 0)
    assert.ok(shown.lines.join('\n').includes('"status": "active"'))

    const missing = await runCli(['--dir', dir, 'show', 'nope'])
    assert.equal(missing.code, 1)
    assert.ok(missing.lines[0]?.includes('no fact with id nope'))

    const noId = await runCli(['show'])
    assert.equal(noId.code, 1)
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists only stale facts', async () => {
    const dir = tempDir()
    seed(dir)
    const result = await runCli(['--dir', dir, 'stale'])
    assert.equal(result.code, 0)
    assert.equal(result.lines.length, 1)
    assert.ok(result.lines[0]?.includes('file does not exist'))
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports honest counters without token estimates', async () => {
    const dir = tempDir()
    seed(dir)
    const result = await runCli(['--dir', dir, 'stats'])
    assert.equal(result.code, 0)
    const text = result.lines.join('\n')
    assert.ok(text.includes('facts: 2 (active 1, stale 1, resolved 0, superseded 0)'))
    assert.ok(text.includes('duplicate failures observed: 2'))
    assert.ok(text.includes('warnings emitted: 2'))
    assert.ok(text.includes('calls denied: 1'))
    assert.ok(text.includes('hit: command_failed — warnings 1, denied 1'))
    assert.ok(text.includes('hit: file_missing — warnings 1, denied 0'))
    assert.ok(!text.includes('tokens'))
    rmSync(dir, { recursive: true, force: true })
  })

  it('fails loud on a corrupt ledger', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'ledger.jsonl'), '{"v":9,"fact":{}}\n')
    const result = await runCli(['--dir', dir, 'list'])
    assert.equal(result.code, 1)
    assert.ok(result.lines[0]?.includes('cannot open ledger'))
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads the sqlite backend via the flag and by auto-detection', async () => {
    const dir = tempDir()
    const store = new SqliteLedgerStore({ dir })
    const fact = await store.recordFact({
      kind: 'command_failed',
      scope: '',
      fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine: 'npm test' }),
      claim: 'sqlite fact',
      evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'x' }],
    }, { operationId: 'seed' })
    await store.commitAttemptDecision({ factId: fact.fact.id, expectedRevision: 1, decision: 'deny', meta: { operationId: 'd-1' } })
    await store.close()
    // Explicit flag.
    const byFlag = await runCli(['--dir', dir, '--backend', 'sqlite', 'stats'])
    assert.equal(byFlag.code, 0)
    assert.ok(byFlag.lines.join('\n').includes('facts: 1 (active 1, stale 0, resolved 0, superseded 0)'))
    assert.ok(byFlag.lines.join('\n').includes('calls denied: 1'))
    // Auto-detection: ledger.db exists → sqlite wins without the flag.
    const detected = await runCli(['--dir', dir, 'list'])
    assert.equal(detected.code, 0)
    assert.ok(detected.lines[0]?.includes('sqlite fact'))
    rmSync(dir, { recursive: true, force: true })
  })
})
