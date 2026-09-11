/**
 * Summarizer measurement tests: the corrected false-block accounting.
 *
 * The point of these tests is that an uncollected probe renders as
 * "unassessed" and never as a zero, because the old deny-then-later-success
 * oracle could not tell a correct pre-repair denial from a wrong one.
 * @module dsh-negative-ledger/tests/benchmark-summarize
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  counterfactualFalseBlocks,
  denialBasesOf,
  emptyCellMetrics,
  evaluateGates,
  groupTotals,
} from '../benchmark/summarize.ts'
import type { CellMetrics, DecisionTimeRun } from '../benchmark/summarize.ts'

const run = (blockedByLedgerCalls: number, counterfactuallySuccessfulDenials?: number): DecisionTimeRun => ({
  policy: { blockedByLedgerCalls },
  decisionTimeTruth: counterfactuallySuccessfulDenials === undefined
    ? undefined
    : { assessed: true, counterfactuallySuccessfulDenials },
})

describe('benchmark counterfactual false blocks', () => {
  it('sums decision-time truth when every run that denied carries it', () => {
    assert.equal(counterfactualFalseBlocks([run(1, 0), run(2, 1), run(0, 0)]), 1)
  })

  it('reports unassessed rather than zero when a denying run lacks decision-time truth', () => {
    assert.equal(counterfactualFalseBlocks([run(1, 0), run(3)]), null)
    assert.equal(counterfactualFalseBlocks([{ policy: { blockedByLedgerCalls: 1 }, decisionTimeTruth: { assessed: false } }]), null)
  })

  it('treats an assessed run with no count as unassessed, not as zero', () => {
    assert.equal(counterfactualFalseBlocks([{ policy: { blockedByLedgerCalls: 1 }, decisionTimeTruth: { assessed: true } }]), null)
  })

  it('keeps a deny-free run at zero without requiring a probe', () => {
    // Nothing was denied, so there is nothing that could have been denied wrongly.
    assert.equal(counterfactualFalseBlocks([run(0), run(1, 0)]), 0)
  })
})

describe('benchmark deny basis tally', () => {
  const call = (errorText: string): { name: string; args: null; ok: boolean; isError: boolean; errorText: string } =>
    ({ name: 'bash', args: null, ok: false, isError: true, errorText })

  it('re-derives the tally for runs collected before the field existed', () => {
    const old = {
      toolCalls: [
        call('blocked by negative-ledger (command_failed): exits — Observed preconditions still match.'),
        call('blocked by negative-ledger (file_missing): missing — No precondition evidence was recorded.'),
        call('[exit code: 1]'),
      ],
    }
    assert.deepEqual(denialBasesOf(old), { 'evidence-unchanged': 1, 'no-evidence-recorded': 1 })
  })

  it('prefers the collector-written tally when the run has one', () => {
    const run = { denialBases: { 'lease-in-progress': 2 }, toolCalls: [call('blocked by negative-ledger (command_failed): exits — Observed preconditions still match.')] }
    assert.deepEqual(denialBasesOf(run), { 'lease-in-progress': 2 })
  })
})

function cellWithBlockDenials(overrides: Partial<CellMetrics>): CellMetrics {
  const cell = emptyCellMetrics()
  cell.iterations = 1
  cell.successCount = 1
  cell.completionRate = 1
  return Object.assign(cell, overrides)
}

describe('benchmark G2 gate status', () => {
  const g2Of = (cells: Map<string, CellMetrics>): ReturnType<typeof evaluateGates>[number] => {
    const gate = evaluateGates(cells, []).find(candidate => candidate.name.startsWith('G2'))
    assert.ok(gate !== undefined)
    return gate
  }

  it('is unassessed — never PASS — when contract violations are zero but the probe was not run', () => {
    const cells = new Map([
      ['s1/block', cellWithBlockDenials({ contractViolatingDenials: 0, counterfactuallySuccessfulDenials: null, unassessedDenialRuns: 1 })],
    ])
    const gate = g2Of(cells)
    assert.equal(gate.status, 'unassessed')
    assert.equal(gate.passed, false)
    assert.match(gate.detail, /未评估/)
    assert.match(gate.detail, /不记 0/)
  })

  it('fails on a contract violation and on an assessed false block', () => {
    const violation = g2Of(new Map([['s1/block', cellWithBlockDenials({ contractViolatingDenials: 2 })]]))
    assert.equal(violation.status, 'fail')
    const falseBlock = g2Of(new Map([['s1/block', cellWithBlockDenials({ counterfactuallySuccessfulDenials: 1 })]]))
    assert.equal(falseBlock.status, 'fail')
  })

  it('passes only when both halves are known to be zero', () => {
    const gate = g2Of(new Map([['s1/block', cellWithBlockDenials({ counterfactuallySuccessfulDenials: 0 })]]))
    assert.equal(gate.status, 'pass')
    assert.equal(gate.passed, true)
  })

  it('reports the observational deny-then-success count without counting it as a gate', () => {
    const gate = g2Of(new Map([['s1/block', cellWithBlockDenials({ counterfactuallySuccessfulDenials: 0, deniedThenLaterSucceeded: 4 })]]))
    assert.equal(gate.status, 'pass')
    assert.match(gate.detail, /观察项「deny 后同指纹成功」=4/)
    assert.match(gate.detail, /不计入门槛/)
  })
})

describe('benchmark group totals', () => {
  it('propagates unassessed cells to the group instead of summing only what was assessed', () => {
    const cells = new Map([
      ['s1/block', cellWithBlockDenials({ contractViolatingDenials: 1, counterfactuallySuccessfulDenials: 0 })],
      ['s2/block', cellWithBlockDenials({ counterfactuallySuccessfulDenials: null, unassessedDenialRuns: 1 })],
    ])
    const total = groupTotals(cells, 'block')
    assert.equal(total.counterfactuallySuccessfulDenials, null)
    assert.equal(total.contractViolatingDenials, 1)
    assert.equal(total.unassessedDenialRuns, 1)
  })

  it('reports a fully assessed group as a number and tallies deny bases', () => {
    const cells = new Map([
      ['s1/block', cellWithBlockDenials({ counterfactuallySuccessfulDenials: 0, denialBases: { 'evidence-unchanged': 2 } })],
      ['s2/block', cellWithBlockDenials({ counterfactuallySuccessfulDenials: 1, denialBases: { 'no-evidence-recorded': 1 } })],
    ])
    const total = groupTotals(cells, 'block')
    assert.equal(total.counterfactuallySuccessfulDenials, 1)
    assert.deepEqual(total.denialBases, { 'evidence-unchanged': 2, 'no-evidence-recorded': 1 })
  })
})
